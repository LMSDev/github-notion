const core = require("@actions/core");

//==============================================================================

/* ================================================================================

	notion-github-sync.
  
  Glitch example: https://glitch.com/edit/#!/notion-github-sync
  Find the official Notion API client @ https://github.com/makenotion/notion-sdk-js/

================================================================================ */

const { Client } = require("@notionhq/client")
const dotenv = require("dotenv")
const { Octokit } = require("octokit")
const _ = require("lodash")

console.log("Hello world")

dotenv.config()
console.log("PAT is", core.getInput('pat'));
const octokit = new Octokit({ auth: core.getInput('pat') })
const notion = new Client({ auth: core.getInput('token') })

const databaseId = core.getInput('dbID')
const OPERATION_BATCH_SIZE = 10

/**
 * Local map to store  GitHub issue ID to its Notion pageId.
 * { [issueId: string]: string }
 */
const gitHubIssuesIdToNotionPageId = {}

/**
 * Initialize local data store.
 * Then sync with GitHub.
 */
setInitialGitHubToNotionIdMap().then(syncNotionDatabaseWithGitHub)

/**
 * Get and set the initial data store with issues currently in the database.
 */
async function setInitialGitHubToNotionIdMap() {
  const currentIssues = await getIssuesFromNotionDatabase()
  for (const { pageId, issueNumber } of currentIssues) {
    gitHubIssuesIdToNotionPageId[issueNumber] = pageId
  }
}

async function syncNotionDatabaseWithGitHub() {
  // Get all issues currently in the provided GitHub repository.
  console.log("\nFetching issues from Notion DB...")
  const issues = await getGitHubIssuesForRepository()
  console.log(`Fetched ${issues.length} issues from GitHub repository.`)

  // DEBUG
  for (const issue of issues) {
    console.log(JSON.stringify(issue));
  }

  // Group issues into those that need to be created or updated in the Notion database.
  const { pagesToCreate, pagesToUpdate } = getNotionOperations(issues)

  // Create pages for new issues.
  console.log(`\n${pagesToCreate.length} new issues to add to Notion.`)
  await createPages(pagesToCreate)

  // Updates pages for existing issues.
  console.log(`\n${pagesToUpdate.length} issues to update in Notion.`)
  await updatePages(pagesToUpdate)

  // Success!
  console.log("\n✅ Notion database is synced with GitHub.")
}

/**
 * Gets pages from the Notion database.
 *
 * @returns {Promise<Array<{ pageId: string, issueNumber: number }>>}
 */
async function getIssuesFromNotionDatabase() {
  const pages = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    })
    pages.push(...results)
    if (!next_cursor) {
      break
    }
    cursor = next_cursor
  }
  console.log(`${pages.length} issues successfully fetched from Notion.`)
  return pages.map(page => {
    return {
      pageId: page.id,
      issueNumber: page.properties["Number"].number,
    }
  })
}

/**
 * Gets issues from a GitHub repository. Pull requests are omitted.
 *
 * https://docs.github.com/en/rest/guides/traversing-with-pagination
 * https://docs.github.com/en/rest/reference/issues
 *
 * @returns {Promise<Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>>}
 */
async function getGitHubIssuesForRepository() {
  console.log("Owner is", process.env.GITHUB_REPOSITORY.split("/")[0]);
  console.log("Repo is", process.env.GITHUB_REPOSITORY.split("/")[1]);
  const issues = []
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner: process.env.GITHUB_REPOSITORY.split("/")[0],
    repo: process.env.GITHUB_REPOSITORY.split("/")[1],
    state: "all",
    per_page: 100,
  })
  for await (const { data } of iterator) {
    for (const issue of data) {
      if (!issue.pull_request) {
        issues.push({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          comment_count: issue.comments,
          url: issue.html_url,
          description: issue.body, // New stuff.
          labels: issue.labels.map(label => label.name),
          reporter: {
            login: issue.user.login,
            url: issue.user.html_url
          },
          assignee: issue.assignee ? {
            login: issue.assignee.login,
            url: issue.assignee.html_url
          } : null,
        })
      }
    }
  }
  return issues
}

/**
 * Determines which issues already exist in the Notion database.
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} issues
 * @returns {{
 *   pagesToCreate: Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>;
 *   pagesToUpdate: Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>
 * }}
 */
function getNotionOperations(issues) {
  const pagesToCreate = []
  const pagesToUpdate = []
  for (const issue of issues) {
    const pageId = gitHubIssuesIdToNotionPageId[issue.number]
    if (pageId) {
      pagesToUpdate.push({
        ...issue,
        pageId,
      })
    } else {
      pagesToCreate.push(issue)
    }
  }
  return { pagesToCreate, pagesToUpdate }
}

/**
 * Creates new pages in Notion.
 *
 * https://developers.notion.com/reference/post-page
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} pagesToCreate
 */
async function createPages(pagesToCreate) {
  const pagesToCreateChunks = _.chunk(pagesToCreate, OPERATION_BATCH_SIZE)
  for (const pagesToCreateBatch of pagesToCreateChunks) {
    await Promise.all(
      pagesToCreateBatch.map(issue =>
        notion.pages.create({
          parent: { database_id: databaseId },
          properties: getPropertiesFromIssue(issue),
        })
      )
    )
    console.log(`Completed batch size: ${pagesToCreateBatch.length}`)
  }
}

/**
 * Updates provided pages in Notion.
 *
 * https://developers.notion.com/reference/patch-page
 *
 * @param {Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} pagesToUpdate
 */
async function updatePages(pagesToUpdate) {
  const pagesToUpdateChunks = _.chunk(pagesToUpdate, OPERATION_BATCH_SIZE)
  for (const pagesToUpdateBatch of pagesToUpdateChunks) {
    await Promise.all(
      pagesToUpdateBatch.map(({ pageId, ...issue }) =>
        notion.pages.update({
          page_id: pageId,
          properties: getPropertiesFromIssue(issue),
        })
      )
    )
    console.log(`Completed batch size: ${pagesToUpdateBatch.length}`)
  }
}

//*========================================================================
// Helpers
//*========================================================================

/**
 * Returns the GitHub issue to conform to this database's schema properties.
 *
 * @param {{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }} issue
 */
function getPropertiesFromIssue(issue) {
  const { title, number, state, comment_count, url, description } = issue
  const labelNames = issue.labels.flatMap(i => [{ name: i }]);
  console.log(labelNames);

  return {
    Name: {
      title: [{ type: "text", text: { content: title } }],
    },
    "Number": {
      number,
    },
    State: {
      select: { name: state },
    },
    "Number of Comments": {
      number: comment_count,
    },
    "Issue URL": {
      url,
    },
    "Labels": {
      multi_select: labelNames
    },
    "Assignee": {
      select: issue.assignee ? { name: issue.assignee.login } : null
    },
    "Description": {
      rich_text: [{ text: { content: description } }],
    }
  }
}