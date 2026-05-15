// ---------------------------------------------------------------------------
// JIRA Tools MCP Server — direct JIRA REST API access via Basic auth.
//
// Replaces the Atlassian remote MCP which only exposes graph queries.
// Provides the standard JIRA operations that agents need:
//   search_issues, create_issue, get_issue, add_comment,
//   transition_issue, get_transitions, update_issue, delete_issue
//
// Auth: Basic (email:api_token) from environment variables.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const JIRA_BASE = process.env.JIRA_BASE_URL || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN || '';
const AUTH_HEADER = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`;

async function jiraFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const url = `${JIRA_BASE}/rest/api/3${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: AUTH_HEADER,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`JIRA ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** Convert plain text to Atlassian Document Format, handling newlines and long text. */
function textToAdf(text: string): { type: string; version: number; content: { type: string; content: { type: string; text: string }[] }[] } {
  const lines = text.split('\n');
  const paragraphs: { type: string; content: { type: string; text: string }[] }[] = [];
  for (const line of lines) {
    if (line.length <= 8000) {
      paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: line || ' ' }] });
    } else {
      for (let i = 0; i < line.length; i += 8000) {
        paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: line.slice(i, i + 8000) }] });
      }
    }
  }
  return { type: 'doc', version: 1, content: paragraphs.slice(0, 100) };
}

const server = new McpServer({ name: 'jira-tools', version: '1.0.0' });

// -- Search ----------------------------------------------------------------

server.tool(
  'search_issues',
  'Search JIRA issues using JQL. Returns issue keys, summaries, statuses, labels, and other fields.',
  {
    jql: z.string().describe('JQL query string'),
    maxResults: z.number().optional().describe('Max results (default 50)'),
    fields: z.string().optional().describe('Comma-separated field names (default: summary,status,priority,labels,issuetype,parent,assignee,comment,project)'),
  },
  async ({ jql, maxResults, fields }) => {
    // JIRA Cloud deprecated /search — use /search/jql (POST) instead.
    const fieldList = (fields ?? 'summary,status,priority,labels,issuetype,parent,assignee,comment,project').split(',').map(f => f.trim());
    const result = await jiraFetch('/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: maxResults ?? 50,
        fields: fieldList,
      }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// -- Get issue -------------------------------------------------------------

server.tool(
  'get_issue',
  'Get a single JIRA issue by key.',
  {
    issueKey: z.string().describe('Issue key (e.g. HIRAM-1)'),
  },
  async ({ issueKey }) => {
    const result = await jiraFetch(`/issue/${issueKey}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// -- Create issue ----------------------------------------------------------

server.tool(
  'create_issue',
  'Create a new JIRA issue (Epic, Story, Task, Bug).',
  {
    project: z.string().optional().describe('Project key (default: auto-detect from first project)'),
    issueType: z.string().describe('Issue type: Epic, Story, Task, Bug, Sub-task'),
    summary: z.string().describe('Issue summary/title'),
    description: z.string().optional().describe('Issue description (plain text, will be converted to Atlassian Document Format)'),
    priority: z.string().optional().describe('Priority: Highest, High, Medium, Low, Lowest'),
    labels: z.array(z.string()).optional().describe('Labels to add'),
    parentKey: z.string().optional().describe('Parent issue key (for Stories under Epics, Sub-tasks under Stories)'),
  },
  async ({ project, issueType, summary, description, priority, labels, parentKey }) => {
    // Auto-detect project if not provided.
    let projectKey = project;
    if (!projectKey) {
      const projects = await jiraFetch('/project') as { key: string }[];
      projectKey = projects[0]?.key;
      if (!projectKey) throw new Error('No JIRA projects found');
    }

    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary,
    };

    if (description) {
      fields.description = textToAdf(description);
    }
    if (priority) fields.priority = { name: priority };
    if (labels && labels.length > 0) fields.labels = labels;
    if (parentKey) fields.parent = { key: parentKey };

    const result = await jiraFetch('/issue', {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// -- Update issue ----------------------------------------------------------

server.tool(
  'update_issue',
  'Update fields on an existing JIRA issue.',
  {
    issueKey: z.string().describe('Issue key'),
    summary: z.string().optional().describe('New summary'),
    description: z.string().optional().describe('New description'),
    labels: z.array(z.string()).optional().describe('Replace labels'),
    priority: z.string().optional().describe('New priority'),
  },
  async ({ issueKey, summary, description, labels, priority }) => {
    const fields: Record<string, unknown> = {};
    if (summary) fields.summary = summary;
    if (description) {
      fields.description = textToAdf(description);
    }
    if (labels) fields.labels = labels;
    if (priority) fields.priority = { name: priority };

    await jiraFetch(`/issue/${issueKey}`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, issueKey }) }] };
  },
);

// -- Add comment -----------------------------------------------------------

server.tool(
  'add_comment',
  'Add a comment to a JIRA issue.',
  {
    issueKey: z.string().describe('Issue key'),
    body: z.string().describe('Comment text'),
  },
  async ({ issueKey, body }) => {
    const result = await jiraFetch(`/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: textToAdf(body),
      }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// -- Transitions -----------------------------------------------------------

server.tool(
  'get_transitions',
  'Get available status transitions for a JIRA issue.',
  {
    issueKey: z.string().describe('Issue key'),
  },
  async ({ issueKey }) => {
    const result = await jiraFetch(`/issue/${issueKey}/transitions`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'transition_issue',
  'Change the status of a JIRA issue by performing a transition.',
  {
    issueKey: z.string().describe('Issue key'),
    transitionId: z.string().describe('Transition ID (get from get_transitions)'),
    comment: z.string().optional().describe('Optional comment to add during transition'),
  },
  async ({ issueKey, transitionId, comment }) => {
    const body: Record<string, unknown> = {
      transition: { id: transitionId },
    };
    if (comment) {
      body.update = {
        comment: [{
          add: {
            body: {
              type: 'doc', version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
            },
          },
        }],
      };
    }
    await jiraFetch(`/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, issueKey, transitionId }) }] };
  },
);

// -- Delete issue ----------------------------------------------------------

server.tool(
  'delete_issue',
  'Delete a JIRA issue. Use with caution.',
  {
    issueKey: z.string().describe('Issue key to delete'),
  },
  async ({ issueKey }) => {
    await jiraFetch(`/issue/${issueKey}`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, deleted: issueKey }) }] };
  },
);

// -- Create project --------------------------------------------------------

server.tool(
  'create_project',
  'Create a new JIRA project. Use this to give each product its own board and ticket namespace (e.g. PULSE-1, ORDO-1).',
  {
    key: z.string().describe('Project key — short uppercase code, max 10 chars (e.g. "PULSE", "ORDO")'),
    name: z.string().describe('Project name (e.g. "PulseCheck")'),
    leadAccountId: z.string().optional().describe('Account ID of the project lead (default: current user)'),
  },
  async ({ key, name, leadAccountId }) => {
    // Get current user's account ID if not provided.
    let lead = leadAccountId;
    if (!lead) {
      const me = await jiraFetch('/myself') as { accountId: string };
      lead = me.accountId;
    }
    const result = await jiraFetch('/project', {
      method: 'POST',
      body: JSON.stringify({
        key: key.toUpperCase(),
        name,
        projectTypeKey: 'software',
        // Use the Scrum Classic template — includes Epic, Story, Task, Bug, Sub-task.
        // Without this, new team-managed projects only get Task + Sub-task.
        projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic',
        leadAccountId: lead,
      }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// -- List projects ---------------------------------------------------------

server.tool(
  'list_projects',
  'List all JIRA projects accessible to this account.',
  {},
  async () => {
    const result = await jiraFetch('/project');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// -- Start -----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// Keep alive and log any fatal errors.
process.stdin.resume();
process.on('uncaughtException', (err) => {
  process.stderr.write(`[jira-tools] uncaughtException: ${err.message}\n${err.stack}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[jira-tools] unhandledRejection: ${reason}\n`);
});
