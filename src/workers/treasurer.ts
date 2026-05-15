import type { WebhookServer } from '../jira/webhook-server.js';
import type { JiraWebhookPayload } from '../types/jira.js';
import { BaseAgent, type AgentDeps } from './base-agent.js';

// ---------------------------------------------------------------------------
// Treasurer — the system's financial controller.
//
// Hardcoded singleton. Handles Stripe operations directly via the public
// "stripe" plugin. For bank payments (Revolut), the Treasurer creates a
// detailed payment request and notifies the founder via the Secretary's
// contact channels. The founder executes the payment manually and updates
// the JIRA ticket.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Treasurer, the financial controller of the HIRAM autonomous system.
You manage all monetary operations for the system.

## CRITICAL: You are an autonomous agent. No human reads your text output.
- NEVER just describe what should be done — DO it by calling tools.
- Every decision must result in a tool call.

## How to access financial tools

### Stripe (public plugin — full access)
Plugin name: "stripe"

You have full Stripe access via plugin_invoke. Use for:
- Customer management, payment processing, invoicing
- Products, prices, subscriptions, payment links
- Refunds, disputes, balance checks

Example:
  plugin_invoke({ plugin: "stripe", tool: "list_customers", arguments: { limit: 10 } })

### Bank payments (manual — notify the founder)
For bank transfers, invoice payments, or any non-Stripe payment:
1. Create a detailed payment request as a JIRA comment on the ticket:
   - Amount, currency, recipient, bank details (if known), reason, deadline
2. Notify the founder via the Secretary's contact channels:
   - Use plugin_invoke on "google-workspace" to send an email, OR
   - Add a high-priority comment so the founder sees it on the board
3. Set the ticket status to "Blocked" — waiting for manual payment
4. The founder will execute the payment and update the JIRA ticket when done

## Rules
1. ALWAYS check Stripe balance before creating payment intents.
2. NEVER create charges exceeding 500 EUR/USD without explicit authorization in the ticket description.
3. Log every financial action as a JIRA comment with amount, currency, recipient, and reason.
4. For recurring costs, prefer Stripe subscriptions over manual payments.
5. For non-Stripe payments, always notify the founder with full details.
6. Use knowledge_save to record vendor information, pricing agreements, and payment patterns.
7. Report all financial summaries in structured JSON.

## Your output

After completing financial work, output a JSON summary:
\`\`\`json
{
  "action": "what financial operation was performed",
  "amount": "123.45",
  "currency": "EUR",
  "recipient": "who received the payment",
  "method": "stripe | manual_payment_requested",
  "reference": "transaction/invoice ID or JIRA ticket key",
  "status": "success | failure | pending_manual_payment"
}
\`\`\``;

const TREASURER_LABEL = 'agent:treasurer';

export class Treasurer extends BaseAgent {
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

  registerWebhooks(webhooks: WebhookServer): void {
    webhooks.on('jira:issue_created', async (payload) => this.onEvent(payload));
    webhooks.on('jira:issue_updated', async (payload) => this.onEvent(payload));
  }

  /** Scan JIRA for incomplete tickets with the treasurer label. */
  async rehydrate(): Promise<void> {
    try {
      const resultStr = await this.deps.registry.invoke(
        'atlassian', 'search_issues',
        { jql: `labels = "${TREASURER_LABEL}" AND statusCategory != Done AND status != Blocked ORDER BY priority ASC`, maxResults: 20, fields: 'summary,status,priority,labels,issuetype,parent,assignee,project,description' },
      );
      const result = JSON.parse(resultStr) as { issues?: { key: string; fields: any }[] };
      const issues = result.issues ?? [];
      for (const issue of issues) {
        if (this.eventQueue.some((e) => e.issue?.key === issue.key)) continue;
        this.eventQueue.push({ webhookEvent: 'jira:issue_created', issue: issue as any } as JiraWebhookPayload);
      }
      if (issues.length > 0) {
        console.log(`[Treasurer] Rehydrated ${issues.length} ticket(s) from JIRA.`);
        this.processQueue().catch((err) => console.error('Treasurer queue error:', err));
      }
    } catch (err) {
      console.error('[Treasurer] Rehydrate failed:', err);
    }
  }

  async handleInstruction(instruction: string): Promise<string> {
    return this.run(`## Financial Instruction\n\n${instruction}`);
  }

  private async onEvent(payload: JiraWebhookPayload): Promise<void> {
    const issue = payload.issue;
    if (!issue) return;
    if (!issue.fields.labels.includes(TREASURER_LABEL)) return;
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
                console.log(`[Treasurer] ${issue.key} blocked: depends on ${depMatch[1]} (${depStatus})`);
                await this.deps.registry.invoke('atlassian', 'add_comment', {
                  issueKey: issue.key, body: `Blocked — waiting for ${depMatch[1]} (currently: ${depStatus}).`,
                });
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
          await this.run(
            `## Assigned Ticket: ${issue.key}\n` +
            `**Summary:** ${issue.fields.summary}\n` +
            `**Priority:** ${issue.fields.priority.name}\n` +
            `**Description:** ${JSON.stringify(issue.fields.description)}\n\n` +
            `Process this financial request. Use Stripe for card/online payments. For bank transfers, create a payment request and notify the founder.`,
          );
        } catch (err) {
          console.error(`Treasurer failed on ${issue.key}:`, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
