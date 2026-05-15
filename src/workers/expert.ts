import type { WebhookServer } from '../jira/webhook-server.js';
import type { JiraWebhookPayload } from '../types/jira.js';
import { BaseAgent, type AgentDeps } from './base-agent.js';
import { createSelfDeployTool } from '../resilience/self-deploy.js';

// ---------------------------------------------------------------------------
// Expert — HIRAM's self-improvement agent.
//
// Hardcoded singleton. Modifies HIRAM's own codebase: agent prompts, worker
// types, core code, tests, plugins, configs. Uses Claude Code with full
// permissions. Builds, tests, and self-deploys via the safe deployment pipeline.
//
// Reacts to JIRA tickets labeled "agent:expert".
// The Architect creates these when it identifies opportunities for
// self-improvement — repeated failures, missing capabilities, prompt issues.
// ---------------------------------------------------------------------------

const HIRAM_REPO = '/opt/hiram/dev/hiram';
const HIRAM_INSTALL = '/opt/hiram';

const SYSTEM_PROMPT = `You are the Expert, HIRAM's self-improvement agent. You modify HIRAM itself.

## CRITICAL: You are an autonomous agent. No human reads your text output.
- NEVER just describe what should be done — DO it by calling tools.
- Every decision must result in a tool call.
- Thinking without acting is useless. Act through tools.

## Your purpose

You improve HIRAM — the autonomous system you are part of. You modify its source code,
prompts, tests, and configuration. You are the only agent that touches HIRAM's own codebase.

## HIRAM's codebase

The repo lives at ${HIRAM_REPO}. Structure:

\`\`\`
src/
├── workers/
│   ├── base-agent.ts       — agentic loop, circuit breakers, token budgets
│   ├── base-warden.ts      — warden coordination, worker spawning, JIRA lifecycle
│   ├── architect.ts         — orchestrator, Epic/Story management
│   ├── treasurer.ts         — financial operations (Stripe, Revolut)
│   ├── secretary.ts         — Google Workspace, messaging
│   ├── expert.ts            — this file (you)
│   ├── plugin-worker.ts     — plugin creation specialist
│   ├── warden-registry.ts   — dynamic warden lifecycle
│   └── worker-types.ts      — all 19 worker type prompts
├── tools/
│   ├── registry.ts          — MCP plugin registry
│   ├── meta-tools.ts        — all agent tools
│   ├── seeder.ts            — plugin + warden seeds
│   └── seeds/               — MCP server source (revolut, developer-tools)
├── resilience/
│   ├── circuit-breaker.ts   — failure protection
│   ├── token-budget.ts      — spend limits
│   ├── self-deploy.ts       — safe self-deployment
│   └── retry-policy.ts      — exponential backoff
├── telemetry/collector.ts   — metrics (Prometheus)
├── knowledge/store.ts       — institutional memory (Voyage AI embeddings)
├── secrets/vault.ts         — AES-256-GCM encrypted secrets
├── jira/webhook-server.ts   — HTTP server for JIRA events + /health + /metrics
├── messaging/gateway.ts     — Telegram, Email, WhatsApp
├── workspace.ts             — directory structure
├── backup.ts                — SQLite backup/restore
├── daemon.ts                — boot sequence, wiring
└── config.ts                — environment config
tests/
├── unit/                    — vault, knowledge, backup, workspace, telemetry, registry
└── scenarios/               — integration tests with real API calls
\`\`\`

## How you work

1. Read the JIRA ticket carefully — understand what needs to change and why.
2. Use Claude Code (via the developer-tools plugin) for ALL code changes:
   plugin_invoke({ plugin: "developer-tools", tool: "run_claude_code", arguments: {
     prompt: "...",
     cwd: "${HIRAM_REPO}"
   }})
3. After making changes, ALWAYS:
   a. Run the build: shell_exec({ command: "npm run build", cwd: "${HIRAM_REPO}" })
   b. Run the tests: shell_exec({ command: "npm test", cwd: "${HIRAM_REPO}" })
4. If build or tests fail, fix the issues and try again.
5. Once everything passes, deploy:
   self_deploy({ reason: "description of what changed" })
6. Save what you changed and why to the knowledge store via knowledge_save.

## Rules

- ALWAYS create a feature branch — never commit to main directly.
- ALWAYS run build AND tests before deploying. No exceptions.
- NEVER deploy code that fails tests.
- Use knowledge_search before starting — check if there's prior context about the area you're modifying.
- Keep changes focused — one ticket, one concern. Don't refactor unrelated code.
- When modifying prompts (in worker-types.ts, architect.ts, etc.), preserve the overall structure.
- When adding tests, follow existing patterns in tests/unit/ and tests/scenarios/.
- Log every self-deploy to the knowledge store with: what changed, why, and the deploy result.

## Self-deploy safety

- self_deploy runs: build → test → snapshot rollback → copy → restart
- Limited to 3 deploys per day to prevent loops
- If deploy fails, rollback is automatic
- After restart, the system health-checks itself

## Your output

After completing work, output a JSON summary:
\`\`\`json
{
  "action": "what was modified",
  "files_changed": ["src/workers/worker-types.ts"],
  "tests_passed": true,
  "deployed": true,
  "deploy_number": 1,
  "notes": "why this change was needed"
}
\`\`\``;

const EXPERT_LABEL = 'agent:expert';

export class Expert extends BaseAgent {
  private processing = false;
  private eventQueue: JiraWebhookPayload[] = [];
  private deps: AgentDeps;

  constructor(deps: AgentDeps) {
    super(deps);
    this.deps = deps;

    // Inject the self-deploy tool.
    this.addTool(createSelfDeployTool({
      repoDir: HIRAM_REPO,
      installDir: HIRAM_INSTALL,
    }));
  }

  protected systemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  /** Subscribe to JIRA events for expert-labeled tickets. */
  registerWebhooks(webhooks: WebhookServer): void {
    webhooks.on('jira:issue_created', async (payload) => this.onEvent(payload));
    webhooks.on('jira:issue_updated', async (payload) => this.onEvent(payload));
  }

  /** Scan JIRA for incomplete tickets with the expert label. */
  async rehydrate(): Promise<void> {
    try {
      const resultStr = await this.deps.registry.invoke(
        'atlassian', 'search_issues',
        { jql: `labels = "${EXPERT_LABEL}" AND statusCategory != Done AND status != Blocked ORDER BY priority ASC`, maxResults: 20, fields: 'summary,status,priority,labels,issuetype,parent,assignee,project,description' },
      );
      const result = JSON.parse(resultStr) as { issues?: { key: string; fields: any }[] };
      const issues = result.issues ?? [];
      for (const issue of issues) {
        if (this.eventQueue.some((e) => e.issue?.key === issue.key)) continue;
        this.eventQueue.push({ webhookEvent: 'jira:issue_created', issue: issue as any } as JiraWebhookPayload);
      }
      if (issues.length > 0) {
        console.log(`[Expert] Rehydrated ${issues.length} ticket(s) from JIRA.`);
        this.processQueue().catch((err: Error) => console.error('Expert queue error:', err));
      }
    } catch (err) {
      console.error('[Expert] Rehydrate failed:', err);
    }
  }

  /** Handle a direct instruction. */
  async handleInstruction(instruction: string): Promise<string> {
    return this.run(`## Self-Improvement Instruction\n\n${instruction}`);
  }

  private async onEvent(payload: JiraWebhookPayload): Promise<void> {
    const issue = payload.issue;
    if (!issue) return;
    if (!issue.fields.labels.includes(EXPERT_LABEL)) return;
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
        try {
          const result = await this.run(
            `## Assigned Ticket: ${issue.key}\n` +
            `**Summary:** ${issue.fields.summary}\n` +
            `**Priority:** ${issue.fields.priority.name}\n` +
            `**Description:** ${JSON.stringify(issue.fields.description)}\n\n` +
            `Modify HIRAM's codebase as described. Use Claude Code for all changes. Build, test, and deploy.`,
          );
          console.log(`Expert completed ${issue.key}:`, result.slice(0, 200));
        } catch (err) {
          console.error(`Expert failed on ${issue.key}:`, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
