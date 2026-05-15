import type { WebhookServer } from '../jira/webhook-server.js';
import type { JiraWebhookPayload } from '../types/jira.js';
import { BaseAgent, type AgentDeps } from './base-agent.js';

// ---------------------------------------------------------------------------
// Secretary — the founder's personal assistant.
//
// Hardcoded singleton agent that manages the founder's Google Workspace:
// email, calendar, contacts, drive, documents. Acts AS the founder —
// sends emails in their name, manages their agenda, organizes their files.
//
// Reacts to JIRA tickets labeled "agent:secretary" and can be invoked
// directly by the Architect.
//
// Uses the "google-workspace" private plugin for all Google API operations.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Secretary, the personal assistant of the founder in the HIRAM autonomous system.
You manage the founder's professional online presence and workspace.

## Your identity

You act AS the founder. When you send an email, it comes from them. When you schedule a meeting,
it's on their calendar. You represent them professionally and accurately.

## Google Workspace access

All Google Workspace tools are available through the "google-workspace" plugin:
  plugin_invoke({ plugin: "google-workspace", tool: "<tool_name>", arguments: { ... } })

Use plugin_list_tools({ plugin: "google-workspace" }) to discover all available tools.

### Key capabilities

**Gmail:**
- Search and read emails
- Compose and send emails as the founder
- Reply to and forward emails
- Manage labels and organize inbox
- Draft emails for review

**Calendar:**
- View the founder's schedule and check availability
- Create, update, and cancel events
- Manage meeting invitations (accept, decline, tentative)
- Set up recurring events
- Avoid scheduling conflicts

**Drive:**
- Search, upload, and organize files
- Create and share folders
- Manage sharing permissions

**Docs:**
- Create and edit documents
- Format content

**Contacts:**
- Look up contact information
- Create and update contacts
- Manage contact groups

## Rules

1. **Professional tone.** Every email and communication must be professional, clear, and
   consistent with the founder's voice. Use knowledge_search to look up any saved communication
   preferences or email templates.

2. **Calendar hygiene.** Never double-book. Always check availability before scheduling.
   Respect the founder's working hours and timezone preferences (save these via knowledge_save
   when you learn them).

3. **Email triage.** When asked to manage the inbox:
   - Flag urgent items (from key contacts, containing deadlines, financial matters)
   - Draft replies where appropriate
   - Summarize what needs the founder's personal attention
   - Archive or label routine items

4. **Privacy.** Never share the founder's personal information, calendar details, or email
   content with other agents unless explicitly authorized in the ticket.

5. **Knowledge accumulation.** Use knowledge_save to remember:
   - Contact preferences (how the founder addresses specific people)
   - Recurring meetings and their patterns
   - Email templates and communication styles
   - Important contacts and their roles
   - Timezone and scheduling preferences

6. **Report everything.** After completing work, add a JIRA comment (via the "atlassian" plugin)
   summarizing what you did — emails sent, meetings scheduled, files organized.

7. **Respect dependencies.** If a ticket description contains "DEPENDS ON: PROJ-XX", you MUST
   check that ticket's status before proceeding. Use plugin_invoke to get_issue on the dependency.
   If it is NOT Done, add a comment "Waiting for PROJ-XX to complete" and transition your ticket
   to Blocked (call get_transitions first to find the right ID). Do NOT send launch announcements, celebration emails, or
   notifications about a product unless the deployment/build ticket is actually Done.
   This is critical — announcing something that isn't live yet is worse than not announcing at all.

## JIRA interaction

JIRA is accessed via the "atlassian" plugin:
  plugin_invoke({ plugin: "atlassian", tool: "<tool_name>", arguments: { ... } })

## Your output

After completing work, output a JSON summary:
\`\`\`json
{
  "action": "what was done",
  "details": {
    "emails_sent": 0,
    "events_created": 0,
    "files_organized": 0
  },
  "notes": "relevant context"
}
\`\`\``;

const SECRETARY_LABEL = 'agent:secretary';

export class Secretary extends BaseAgent {
  private processing = false;
  private eventQueue: JiraWebhookPayload[] = [];
  private deps: AgentDeps;

  constructor(deps: AgentDeps) {
    super(deps);
    this.deps = deps;
  }

  protected systemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  /** Subscribe to JIRA events for secretary-labeled tickets. */
  registerWebhooks(webhooks: WebhookServer): void {
    webhooks.on('jira:issue_created', async (payload) => this.onEvent(payload));
    webhooks.on('jira:issue_updated', async (payload) => this.onEvent(payload));
  }

  /** Scan JIRA for incomplete tickets with the secretary label. */
  async rehydrate(): Promise<void> {
    try {
      const resultStr = await this.deps.registry.invoke(
        'atlassian', 'search_issues',
        { jql: `labels = "${SECRETARY_LABEL}" AND statusCategory != Done AND status != Blocked ORDER BY priority ASC`, maxResults: 20, fields: 'summary,status,priority,labels,issuetype,parent,assignee,project,description' },
      );
      const result = JSON.parse(resultStr) as { issues?: { key: string; fields: any }[] };
      const issues = result.issues ?? [];
      for (const issue of issues) {
        if (this.eventQueue.some((e) => e.issue?.key === issue.key)) continue;
        this.eventQueue.push({ webhookEvent: 'jira:issue_created', issue: issue as any } as JiraWebhookPayload);
      }
      if (issues.length > 0) {
        console.log(`[Secretary] Rehydrated ${issues.length} ticket(s) from JIRA.`);
        this.processQueue().catch((err: Error) => console.error('Secretary queue error:', err));
      }
    } catch (err) {
      console.error('[Secretary] Rehydrate failed:', err);
    }
  }

  /** Handle a direct instruction from the founder or Architect. */
  async handleInstruction(instruction: string): Promise<string> {
    return this.run(`## Instruction\n\n${instruction}`);
  }

  /** Handle a conversational message from the founder via a messaging channel. */
  async handleMessage(channel: string, text: string): Promise<string> {
    return this.run(
      `## Message from the founder (via ${channel})\n\n${text}\n\n` +
      `Respond conversationally and concisely. This is a direct message, not a JIRA ticket. ` +
      `If the founder is asking you to do something, do it and confirm. ` +
      `If they're asking a question, answer it. Keep the response short enough for a chat message.\n\n` +
      `Tone: competent and composed, with a dry, understated wit — like a seasoned butler ` +
      `who has seen empires rise and fall but still irons the napkins. Never force a joke, ` +
      `but a well-placed quip is welcome. You are the calm, capable one in the room.`,
    );
  }

  private async onEvent(payload: JiraWebhookPayload): Promise<void> {
    const issue = payload.issue;
    if (!issue) return;
    if (!issue.fields.labels.includes(SECRETARY_LABEL)) return;
    if (issue.fields.status.statusCategory.key === 'done') return;

    if (this.eventQueue.some((e) => e.issue?.key === issue.key)) return;

    this.eventQueue.push(payload);
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.eventQueue.length > 0) {
        const payload = this.eventQueue.shift()!;
        const issue = payload.issue!;
        // Mechanical dependency check — skip if DEPENDS ON ticket isn't Done.
        if (issue.fields.description) {
          const descText = JSON.stringify(issue.fields.description);
          const depMatch = descText.match(/DEPENDS ON:\s*([A-Z]+-\d+)/);
          if (depMatch) {
            try {
              const depResult = await this.deps.registry.invoke('atlassian', 'get_issue', { issueKey: depMatch[1] });
              const depStatus = (JSON.parse(depResult) as { fields: { status: { name: string } } }).fields.status.name;
              if (depStatus !== 'Done') {
                console.log(`[Secretary] ${issue.key} blocked: depends on ${depMatch[1]} (${depStatus})`);
                await this.deps.registry.invoke('atlassian', 'add_comment', {
                  issueKey: issue.key, body: `Blocked — waiting for ${depMatch[1]} (currently: ${depStatus}).`,
                });
                // Transition to Blocked by name — IDs differ per project.
                try {
                  const trStr = await this.deps.registry.invoke('atlassian', 'get_transitions', { issueKey: issue.key });
                  const transitions = (JSON.parse(trStr) as { transitions?: { id: string; name: string }[] }).transitions ?? [];
                  const blocked = transitions.find(t => t.name.toLowerCase() === 'blocked');
                  if (blocked) await this.deps.registry.invoke('atlassian', 'transition_issue', { issueKey: issue.key, transitionId: blocked.id });
                } catch {}
                continue;
              }
            } catch {}
          }
        }
        try {
          const result = await this.run(
            `## Assigned Ticket: ${issue.key}\n` +
            `**Summary:** ${issue.fields.summary}\n` +
            `**Priority:** ${issue.fields.priority.name}\n` +
            `**Description:** ${JSON.stringify(issue.fields.description)}\n\n` +
            `Process this request. Discover available Google Workspace tools with plugin_list_tools first if needed, then execute and report via JIRA.`,
          );
          console.log(`Secretary completed ${issue.key}:`, result.slice(0, 200));
        } catch (err) {
          console.error(`Secretary failed on ${issue.key}:`, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
