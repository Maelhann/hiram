// ---------------------------------------------------------------------------
// MockJiraBoard — in-memory JIRA simulation for integration tests.
//
// Supports: issue CRUD, transitions, comments, JQL search, links.
// Fires webhook callbacks on transitions so agents react in tests.
// ---------------------------------------------------------------------------

import type { JiraWebhookPayload, JiraIssue, JiraStatus, JiraIssueType } from '../../src/types/jira.js';

export interface MockIssue {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: JiraStatus;
    priority: { id: string; name: string };
    issuetype: JiraIssueType;
    project: { id: string; key: string; name: string; projectTypeKey: string };
    assignee: null;
    reporter: { accountId: string; displayName: string; active: boolean };
    labels: string[];
    created: string;
    updated: string;
    parent?: { key: string; fields: { summary: string } };
    subtasks?: { key: string; fields: { summary: string; status: JiraStatus } }[];
    issuelinks?: [];
    comment?: { comments: { id: string; author: { accountId: string; displayName: string; active: boolean }; body: string; created: string; updated: string }[]; total: number };
    [key: string]: unknown;
  };
  id: string;
  self: string;
}

const STATUS_CATEGORIES: Record<string, { id: number; key: string; name: string }> = {
  'To Do': { id: 2, key: 'new', name: 'To Do' },
  'In Progress': { id: 4, key: 'indeterminate', name: 'In Progress' },
  'In Review': { id: 4, key: 'indeterminate', name: 'In Progress' },
  'Blocked': { id: 4, key: 'indeterminate', name: 'In Progress' },
  'Done': { id: 3, key: 'done', name: 'Done' },
};

const TRANSITIONS: Record<string, string[]> = {
  'To Do': ['In Progress', 'Blocked', 'Done'],
  'In Progress': ['In Review', 'Blocked', 'Done', 'To Do'],
  'In Review': ['Done', 'In Progress', 'Blocked'],
  'Blocked': ['To Do', 'In Progress'],
  'Done': ['To Do'],
};

type WebhookCallback = (payload: JiraWebhookPayload) => void;

export class MockJiraBoard {
  issues = new Map<string, MockIssue>();
  private counter = 0;
  private projectKey = 'TEST';
  private onWebhook: WebhookCallback | null = null;

  /** Register a callback to fire when issues change (for webhook simulation). */
  setWebhookCallback(cb: WebhookCallback): void {
    this.onWebhook = cb;
  }

  // -----------------------------------------------------------------------
  // Issue CRUD
  // -----------------------------------------------------------------------

  createIssue(rawArgs: Record<string, unknown>): string {
    // The model may send args in flat format or nested Atlassian format: { fields: { ... } }
    const fields = rawArgs.fields as Record<string, unknown> | undefined;
    const args: Record<string, unknown> = fields ? { ...rawArgs, ...this.flattenFields(fields) } : rawArgs;

    console.log(`[MOCK-JIRA] createIssue args: issue_type=${args.issue_type}, issueType=${args.issueType}, issuetype=${args.issuetype}, summary=${(args.summary as string)?.slice(0, 50)}`);

    this.counter++;
    const key = `${this.projectKey}-${this.counter}`;
    const issueType = (args.issue_type ?? args.issueType ?? args.issuetype ?? 'Task') as string;
    const parentKey = (args.parent_key ?? args.parentKey ?? args.parent) as string | undefined;
    const parent = parentKey ? this.issues.get(parentKey) : undefined;

    const status = this.makeStatus('To Do');
    const issue: MockIssue = {
      key,
      id: String(this.counter),
      self: `https://mock.atlassian.net/rest/api/3/issue/${key}`,
      fields: {
        summary: (args.summary as string) ?? 'Untitled',
        description: args.description ?? null,
        status,
        priority: { id: '3', name: (args.priority as string) ?? 'Medium' },
        issuetype: {
          id: String(this.counter),
          name: issueType,
          subtask: issueType === 'Sub-task',
        },
        project: { id: '1', key: args.project_key as string ?? this.projectKey, name: 'Test Project', projectTypeKey: 'software' },
        assignee: null,
        reporter: { accountId: 'system', displayName: 'HIRAM', active: true },
        labels: (args.labels as string[]) ?? [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        parent: parent ? { key: parent.key, fields: { summary: parent.fields.summary } } : undefined,
        subtasks: [],
        issuelinks: [],
        comment: { comments: [], total: 0 },
      },
    };

    this.issues.set(key, issue);

    // Add as child of parent.
    if (parent) {
      parent.fields.subtasks = parent.fields.subtasks ?? [];
      parent.fields.subtasks.push({ key, fields: { summary: issue.fields.summary, status } });
    }

    this.fireWebhook('jira:issue_created', issue);
    return JSON.stringify({ key, id: issue.id, self: issue.self });
  }

  getIssue(args: Record<string, unknown>): string {
    const key = (args.issue_key ?? args.issueKey) as string;
    const issue = this.issues.get(key);
    if (!issue) return JSON.stringify({ error: `Issue not found: ${key}` });
    return JSON.stringify(issue);
  }

  updateIssue(args: Record<string, unknown>): string {
    const key = (args.issue_key ?? args.issueKey) as string;
    const issue = this.issues.get(key);
    if (!issue) return JSON.stringify({ error: `Issue not found: ${key}` });

    if (args.summary) issue.fields.summary = args.summary as string;
    if (args.description) issue.fields.description = args.description;
    if (args.priority) issue.fields.priority = { id: '3', name: args.priority as string };
    if (args.labels) issue.fields.labels = args.labels as string[];
    issue.fields.updated = new Date().toISOString();

    this.fireWebhook('jira:issue_updated', issue);
    return JSON.stringify({ ok: true });
  }

  // -----------------------------------------------------------------------
  // Transitions
  // -----------------------------------------------------------------------

  getTransitions(args: Record<string, unknown>): string {
    const key = (args.issue_key ?? args.issueKey) as string;
    const issue = this.issues.get(key);
    if (!issue) return JSON.stringify({ transitions: [] });

    const current = issue.fields.status.name;
    const available = TRANSITIONS[current] ?? [];
    return JSON.stringify({
      transitions: available.map((name, i) => ({
        id: String(i + 1),
        name,
        to: this.makeStatus(name),
      })),
    });
  }

  transitionIssue(args: Record<string, unknown>): string {
    const key = (args.issue_key ?? args.issueKey) as string;
    const transitionId = (args.transition_id ?? args.transitionId) as string;
    const issue = this.issues.get(key);
    if (!issue) return JSON.stringify({ error: `Issue not found: ${key}` });

    // Resolve transition ID to target status name.
    const current = issue.fields.status.name;
    const available = TRANSITIONS[current] ?? [];
    const idx = parseInt(transitionId, 10) - 1;
    const targetStatus = available[idx];
    if (!targetStatus) return JSON.stringify({ error: `Invalid transition: ${transitionId}` });

    const oldStatus = issue.fields.status.name;
    issue.fields.status = this.makeStatus(targetStatus);
    issue.fields.updated = new Date().toISOString();

    this.fireWebhook('jira:issue_updated', issue, [{
      field: 'status',
      fieldtype: 'jira',
      from: null,
      fromString: oldStatus,
      to: null,
      toString: targetStatus,
    }]);

    return JSON.stringify({ ok: true });
  }

  // -----------------------------------------------------------------------
  // Comments
  // -----------------------------------------------------------------------

  addComment(args: Record<string, unknown>): string {
    const key = (args.issue_key ?? args.issueKey) as string;
    const body = (args.body as string) ?? '';
    const issue = this.issues.get(key);
    if (!issue) return JSON.stringify({ error: `Issue not found: ${key}` });

    const comment = {
      id: String(Date.now()),
      author: { accountId: 'system', displayName: 'HIRAM', active: true },
      body,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    issue.fields.comment = issue.fields.comment ?? { comments: [], total: 0 };
    issue.fields.comment.comments.push(comment);
    issue.fields.comment.total++;

    return JSON.stringify({ id: comment.id });
  }

  // -----------------------------------------------------------------------
  // Search (basic JQL)
  // -----------------------------------------------------------------------

  searchJql(args: Record<string, unknown>): string {
    const jql = ((args.jql as string) ?? '').toLowerCase();
    const maxResults = (args.maxResults as number) ?? (args.max_results as number) ?? 50;
    let results = [...this.issues.values()];

    // Parse basic JQL filters.
    const labelMatch = jql.match(/labels\s*=\s*"([^"]+)"/);
    if (labelMatch) {
      results = results.filter((i) => i.fields.labels.includes(labelMatch[1]));
    }

    const statusNotMatch = jql.match(/statuscategory\s*!=\s*(\w+)/);
    if (statusNotMatch) {
      const cat = statusNotMatch[1].toLowerCase();
      results = results.filter((i) => i.fields.status.statusCategory.key !== cat);
    }

    const statusMatch = jql.match(/status\s*=\s*"([^"]+)"/);
    if (statusMatch) {
      results = results.filter((i) => i.fields.status.name.toLowerCase() === statusMatch[1].toLowerCase());
    }

    const typeMatch = jql.match(/issuetype\s*=\s*"([^"]+)"/);
    if (typeMatch) {
      results = results.filter((i) => i.fields.issuetype.name.toLowerCase() === typeMatch[1].toLowerCase());
    }

    const parentMatch = jql.match(/parent\s*=\s*"?([A-Z]+-\d+)"?/);
    if (parentMatch) {
      results = results.filter((i) => i.fields.parent?.key === parentMatch[1]);
    }

    const projectMatch = jql.match(/project\s*=\s*"?(\w+)"?/);
    if (projectMatch) {
      results = results.filter((i) => i.fields.project.key.toLowerCase() === projectMatch[1].toLowerCase());
    }

    return JSON.stringify({
      startAt: 0,
      maxResults,
      total: results.length,
      issues: results.slice(0, maxResults),
    });
  }

  // -----------------------------------------------------------------------
  // Seed & Assert
  // -----------------------------------------------------------------------

  seed(issues: Partial<MockIssue>[]): void {
    for (const partial of issues) {
      this.counter++;
      const key = partial.key ?? `${this.projectKey}-${this.counter}`;
      const issue: MockIssue = {
        key,
        id: String(this.counter),
        self: `https://mock.atlassian.net/rest/api/3/issue/${key}`,
        fields: {
          summary: partial.fields?.summary ?? 'Seeded issue',
          description: partial.fields?.description ?? null,
          status: partial.fields?.status ?? this.makeStatus('To Do'),
          priority: partial.fields?.priority ?? { id: '3', name: 'Medium' },
          issuetype: partial.fields?.issuetype ?? { id: '1', name: 'Story', subtask: false },
          project: partial.fields?.project ?? { id: '1', key: this.projectKey, name: 'Test Project', projectTypeKey: 'software' },
          assignee: null,
          reporter: { accountId: 'system', displayName: 'HIRAM', active: true },
          labels: partial.fields?.labels ?? [],
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          parent: partial.fields?.parent,
          subtasks: partial.fields?.subtasks ?? [],
          issuelinks: [],
          comment: { comments: [], total: 0 },
        },
      };
      this.issues.set(key, issue);
    }
  }

  /** Get all issues of a given type. */
  getByType(typeName: string): MockIssue[] {
    return [...this.issues.values()].filter((i) => i.fields.issuetype.name === typeName);
  }

  /** Get all issues with a given status. */
  getByStatus(statusName: string): MockIssue[] {
    return [...this.issues.values()].filter((i) => i.fields.status.name === statusName);
  }

  /** Get children of a parent issue. */
  getChildren(parentKey: string): MockIssue[] {
    return [...this.issues.values()].filter((i) => i.fields.parent?.key === parentKey);
  }

  /** Get all comments across all issues. */
  getAllComments(): { key: string; body: string }[] {
    const result: { key: string; body: string }[] = [];
    for (const [key, issue] of this.issues) {
      for (const c of issue.fields.comment?.comments ?? []) {
        result.push({ key, body: c.body });
      }
    }
    return result;
  }

  /** Print board state for debugging. */
  printBoard(): void {
    console.log('\n--- JIRA Board State ---');
    for (const [key, issue] of this.issues) {
      const parent = issue.fields.parent ? ` (under ${issue.fields.parent.key})` : '';
      const labels = issue.fields.labels.length ? ` [${issue.fields.labels.join(', ')}]` : '';
      console.log(`  ${key} | ${issue.fields.issuetype.name.padEnd(8)} | ${issue.fields.status.name.padEnd(12)} | ${issue.fields.summary}${parent}${labels}`);
    }
    console.log(`  Comments: ${this.getAllComments().length} total`);
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Route an atlassian plugin_invoke call to the right method.
  // -----------------------------------------------------------------------

  handleToolCall(toolName: string, args: Record<string, unknown>): string {
    // Normalize tool names — the model may use various aliases.
    const normalized = toolName
      .replace(/^jira_/, '')       // jira_search → search
      .replace(/^atlassian_/, ''); // atlassian_create_issue → create_issue

    switch (normalized) {
      case 'create_issue': return this.createIssue(args);
      case 'get_issue': case 'issue_get': return this.getIssue(args);
      case 'update_issue': return this.updateIssue(args);
      case 'get_transitions': return this.getTransitions(args);
      case 'transition_issue': case 'transition': return this.transitionIssue(args);
      case 'add_comment': case 'comment': return this.addComment(args);
      case 'search_issues': case 'search': case 'search_jql': case 'jql_search': return this.searchJql(args);
      case 'list_projects': return JSON.stringify([{ key: this.projectKey, name: 'Test Project' }]);
      case 'link_issues': case 'create_link': return JSON.stringify({ ok: true });
      case 'assign_issue': case 'assign': return JSON.stringify({ ok: true });
      default: return JSON.stringify({ error: `Unknown JIRA tool: ${toolName}` });
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Flatten the nested Atlassian API format into flat args.
   * { project: { key: "X" }, issuetype: { name: "Story" }, summary: "...", priority: { name: "High" }, labels: [...], parent: { key: "X-1" } }
   * → { project_key: "X", issue_type: "Story", summary: "...", priority: "High", labels: [...], parent_key: "X-1" }
   */
  private flattenFields(fields: Record<string, unknown>): Record<string, unknown> {
    const flat: Record<string, unknown> = {};
    if (fields.summary) flat.summary = fields.summary;
    if (fields.description) flat.description = fields.description;
    if (fields.labels) flat.labels = fields.labels;

    const project = fields.project as Record<string, unknown> | undefined;
    if (project?.key) flat.project_key = project.key;

    const issuetype = fields.issuetype as Record<string, unknown> | undefined;
    if (issuetype?.name) flat.issue_type = issuetype.name;

    const priority = fields.priority as Record<string, unknown> | undefined;
    if (priority?.name) flat.priority = priority.name;

    const parent = fields.parent as Record<string, unknown> | undefined;
    if (parent?.key) flat.parent_key = parent.key;

    const assignee = fields.assignee as Record<string, unknown> | undefined;
    if (assignee?.accountId) flat.assignee_id = assignee.accountId;

    return flat;
  }

  private makeStatus(name: string): JiraStatus {
    const cat = STATUS_CATEGORIES[name] ?? STATUS_CATEGORIES['To Do'];
    return { id: String(Object.keys(STATUS_CATEGORIES).indexOf(name) + 1), name, statusCategory: cat };
  }

  private fireWebhook(
    event: JiraWebhookPayload['webhookEvent'],
    issue: MockIssue,
    changelogItems?: JiraWebhookPayload['changelog'],
  ): void {
    if (!this.onWebhook) return;
    this.onWebhook({
      webhookEvent: event,
      timestamp: Date.now(),
      user: { accountId: 'system', displayName: 'HIRAM', active: true },
      issue: issue as unknown as JiraIssue,
      changelog: changelogItems ? { id: String(Date.now()), items: changelogItems as unknown as JiraWebhookPayload['changelog'] extends undefined ? never : NonNullable<JiraWebhookPayload['changelog']>['items'] } : undefined,
    });
  }
}
