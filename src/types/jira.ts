// ---------------------------------------------------------------------------
// JIRA Cloud REST API v3 — TypeScript types for the entities we use.
// ---------------------------------------------------------------------------

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
}

export interface JiraPriority {
  id: string;
  name: string;      // e.g. "Highest", "High", "Medium", "Low", "Lowest"
  iconUrl?: string;
}

export interface JiraStatus {
  id: string;
  name: string;       // e.g. "To Do", "In Progress", "Done"
  statusCategory: {
    id: number;
    key: string;       // "new" | "indeterminate" | "done"
    name: string;
  };
}

export interface JiraIssueType {
  id: string;
  name: string;        // e.g. "Story", "Task", "Bug", "Epic", "Sub-task"
  subtask: boolean;
}

export interface JiraProject {
  id: string;
  key: string;         // e.g. "HIRAM"
  name: string;
  projectTypeKey: string;
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body: unknown;       // Atlassian Document Format (ADF) or plain string
  created: string;
  updated: string;
}

export interface JiraIssueLink {
  id: string;
  type: {
    id: string;
    name: string;      // e.g. "Blocks"
    inward: string;    // e.g. "is blocked by"
    outward: string;   // e.g. "blocks"
  };
  inwardIssue?: { key: string; fields: { summary: string; status: JiraStatus } };
  outwardIssue?: { key: string; fields: { summary: string; status: JiraStatus } };
}

export interface JiraIssue {
  id: string;
  key: string;           // e.g. "HIRAM-42"
  self: string;
  fields: {
    summary: string;
    description: unknown; // ADF or null
    status: JiraStatus;
    priority: JiraPriority;
    issuetype: JiraIssueType;
    project: JiraProject;
    assignee: JiraUser | null;
    reporter: JiraUser;
    labels: string[];
    created: string;
    updated: string;
    parent?: { key: string; fields: { summary: string } };
    subtasks?: { key: string; fields: { summary: string; status: JiraStatus } }[];
    issuelinks?: JiraIssueLink[];
    comment?: { comments: JiraComment[]; total: number };
    [key: string]: unknown;
  };
}

export interface JiraTransition {
  id: string;
  name: string;          // e.g. "In Progress", "Done"
  to: JiraStatus;
}

export interface JiraSearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

// ---------------------------------------------------------------------------
// Webhook payload types — events pushed from JIRA to HIRAM
// ---------------------------------------------------------------------------

export type JiraWebhookEventType =
  | 'jira:issue_created'
  | 'jira:issue_updated'
  | 'jira:issue_deleted'
  | 'comment_created'
  | 'comment_updated'
  | 'comment_deleted'
  | 'issuelink_created'
  | 'issuelink_deleted';

export interface JiraChangelogItem {
  field: string;         // e.g. "status", "priority", "assignee"
  fieldtype: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface JiraWebhookPayload {
  webhookEvent: JiraWebhookEventType;
  timestamp: number;
  user: JiraUser;
  issue?: JiraIssue;
  comment?: JiraComment;
  changelog?: {
    id: string;
    items: JiraChangelogItem[];
  };
  issueLink?: JiraIssueLink;
}
