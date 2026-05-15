import type { WebhookServer } from '../jira/webhook-server.js';
import type { JiraIssue, JiraWebhookPayload } from '../types/jira.js';
import type { MetaTool } from '../tools/meta-tools.js';
import { BaseAgent, type AgentDeps, type RunOptions, tokenBudget } from './base-agent.js';
import { PERSISTENT_RETRY, STANDARD_RETRY } from '../resilience/retry-policy.js';

// ---------------------------------------------------------------------------
// BaseWarden — concurrent ticket coordinator.
//
// A Warden never does work itself. It watches JIRA for tickets matching its
// label, picks them up, and spawns TicketRunners to process them concurrently
// (up to maxConcurrency). Each TicketRunner owns a fresh agent instance with
// isolated state — its own metaTools, workspace, and JIRA tools.
//
// Within each ticket, the warden can spawn multiple workers in parallel
// (run_worker is marked concurrent: true).
// ---------------------------------------------------------------------------

const WARDEN_SYSTEM_PREAMBLE = `You are a Warden in the HIRAM autonomous system.
You are a coordinator — you NEVER do work directly.

## CRITICAL: You are an autonomous agent. No human reads your text output.
- NEVER just describe what should be done — DO it by calling tools.
- Every decision must result in a tool call: run_worker, comment, transition, knowledge_save.
- If you can't proceed, use comment to explain why and transition to Blocked.
- Thinking without acting is useless. Your text output is invisible. Only tool calls matter.

## Tool selection guidance
- For web research: use the built-in \`web_search\` tool. It's native to Claude — fast, structured, no plugin needed.
- For browser testing of YOUR OWN deployed products: use Playwright (via plugin_invoke on "playwright"). Opens a real browser to verify pages load, click buttons, fill forms.
- Do NOT use Playwright for general web research — use web_search instead. Playwright is for QA testing only.

Instead you:

1. Read the JIRA ticket you've been assigned carefully.
2. Review any prior knowledge provided (lessons learned, gotchas, patterns from previous work).
3. Decide what kind of worker is needed for this task.
4. Call \`run_worker\` with a system_prompt that defines the worker's expertise, and a prompt with detailed task instructions. Include any relevant knowledge in the worker's prompt.
5. You can spawn MULTIPLE workers concurrently in a single turn — just call \`run_worker\` multiple times. They will execute in parallel.
6. Inspect the workers' outputs critically. Check that the work is correct and complete.
7. If the output is unsatisfactory, call \`run_worker\` again — you can use the same or a different system_prompt depending on what's needed.
8. Repeat until the work meets your quality bar.
9. Use \`comment\` throughout to post progress updates on your Story ticket — what you've done, what's next, any blockers.
10. IMPORTANT: After completing the ticket, use \`knowledge_save\` to record any lessons learned, discoveries, gotchas, or patterns that would help a future agent working on similar tasks.

You can spawn different types of workers for different aspects of the same ticket.
For example, one worker to research, another to implement, another to review.
Each \`run_worker\` call creates a fresh agent with the identity you define.
Workers also have their own \`comment\` tool to post updates on their Task tickets.

## Your tools
- \`comment({ body: "..." })\` — post a progress update on your current Story ticket
- \`transition({ status: "In Progress" })\` — move your Story through the workflow (e.g. "In Progress", "In Review", "Done"). Transitioning to "Done" notifies the Architect.
- \`run_worker({ ... })\` — spawn a worker to execute a Task (workers also have \`comment\` and \`transition\` on their Task tickets). You can call this multiple times in one turn — workers run in parallel.
- \`get_worker_type("name")\` / \`list_worker_types()\` — discover worker types
- \`plugin_invoke\` / \`plugin_list_tools\` — access JIRA, plugins, and integrations
- \`knowledge_search\` / \`knowledge_save\` — read and write institutional knowledge
- \`secret_get\` / \`secret_set\` — access the encrypted vault

## JIRA tool reference (exact argument names — use these, not variations)
- get_issue({ issueKey: "PROJ-1" })
- search_issues({ jql: "...", maxResults: 50, fields: "summary,status,..." })
- create_issue({ project: "PROJ", issueType: "Story", summary: "...", description: "...", labels: [...], parentKey: "PROJ-1" })
- add_comment({ issueKey: "PROJ-1", body: "..." })
- get_transitions({ issueKey: "PROJ-1" })
- transition_issue({ issueKey: "PROJ-1", transitionId: "31" })
- update_issue({ issueKey: "PROJ-1", summary: "...", labels: [...] })
IMPORTANT: The parameter is \`issueKey\` (camelCase), NOT \`issue_key\`. Always call get_transitions before transition_issue — IDs differ per project.

`;

/** A generic worker whose system prompt is set by the warden at spawn time. */
class DynamicWorker extends BaseAgent {
  constructor(deps: AgentDeps, private prompt: string) {
    super(deps);
  }
  protected systemPrompt(): string {
    return this.prompt;
  }
}

/** A per-ticket agent whose system prompt is the warden's combined prompt. */
class TicketAgent extends BaseAgent {
  constructor(deps: AgentDeps, private sysPrompt: string) {
    super(deps);
  }
  protected systemPrompt(): string {
    return this.sysPrompt;
  }
}

/** Optional callback fired every time run_worker is called. Set by test harness. */
let onWorkerSpawn: (() => void) | null = null;
export function setOnWorkerSpawn(cb: (() => void) | null): void {
  onWorkerSpawn = cb;
}

// ---------------------------------------------------------------------------
// TicketRunner — isolated per-ticket execution context.
//
// Owns a fresh TicketAgent with its own metaTools array.
// Ticket-scoped tools (comment, transition, run_worker) are bound via
// closures that capture the ticket, not shared warden state.
// ---------------------------------------------------------------------------

class TicketRunner {
  readonly ticket: JiraIssue;
  private agent: TicketAgent;
  private deps: AgentDeps;
  private label: string;

  constructor(opts: {
    ticket: JiraIssue;
    deps: AgentDeps;
    wardenLabel: string;
    systemPrompt: string;
  }) {
    this.ticket = opts.ticket;
    this.deps = opts.deps;
    this.label = opts.wardenLabel;
    this.agent = new TicketAgent(opts.deps, opts.systemPrompt);

    // Inject ticket-scoped tools into this agent's tool belt.
    this.agent.addTool(this.buildCommentTool());
    this.agent.addTool(this.buildTransitionTool());
    this.agent.addTool(this.buildRunWorkerTool());
  }

  /** Attach a transcript recorder to the ticket agent. */
  setTranscriptRecorder(recorder: AgentDeps['transcriptRecorder']): void {
    this.agent.setTranscriptRecorder(recorder);
  }

  /** Extract plain text from an ADF description, then check for DEPENDS ON: PROJ-XX. */
  private async checkDependency(issue: JiraIssue): Promise<boolean> {
    if (!issue.fields.description) return true; // no description = no dependency
    const descText = JSON.stringify(issue.fields.description);
    const match = descText.match(/DEPENDS ON:\s*([A-Z]+-\d+)/);
    if (!match) return true; // no dependency clause
    const depKey = match[1];
    try {
      const result = await this.deps.registry.invoke('atlassian', 'get_issue', { issueKey: depKey });
      const depIssue = JSON.parse(result) as { fields: { status: { name: string } } };
      if (depIssue.fields.status.name === 'Done') return true;
      // Dependency not done — block this ticket.
      console.log(`[${this.label}] ${issue.key} blocked: depends on ${depKey} (status: ${depIssue.fields.status.name})`);
      await this.jiraComment(issue.key, `Blocked — waiting for ${depKey} to reach Done (currently: ${depIssue.fields.status.name}).`);
      await this.jiraTransition(issue.key, 'Blocked');
      return false;
    } catch (err) {
      console.warn(`[${this.label}] ${issue.key} dependency check failed for ${depKey}:`, err);
      return true; // can't verify, proceed anyway
    }
  }

  async execute(): Promise<void> {
    const issue = this.ticket;
    const ticketStart = Date.now();
    this.deps.telemetry?.gauge(`warden.${this.label}.active_tickets`, 1);

    // Check dependency before starting — if blocked, transition and bail.
    const depOk = await this.checkDependency(issue);
    if (!depOk) {
      this.deps.telemetry?.gauge(`warden.${this.label}.active_tickets`, 0);
      return;
    }

    let scratchPath: string | undefined;
    if (this.deps.workspace) {
      scratchPath = await this.deps.workspace.createScratch(issue.key);
    }

    const tracked = this.deps.tracker?.register({
      type: 'warden',
      label: this.label,
      ticketKey: issue.key,
    });

    try {
      await this.jiraTransition(issue.key, 'In Progress');
      await this.jiraComment(issue.key, `Warden [${this.label}] has picked up this ticket and is starting work.`);
      console.log(`[${this.label}] TicketRunner starting for ${issue.key}`);

      const prompt = await this.buildTicketPrompt(issue);
      const runOpts: RunOptions = {
        signal: tracked?.signal,
        timeoutMs: 2 * 60 * 60_000,
        retryOptions: PERSISTENT_RETRY,
      };
      const result = await this.agent.run(prompt, issue.key, runOpts);

      // The warden's agentic loop has ended. Ensure the ticket is closed out.
      // The agent SHOULD have called transition("Done") itself, but if it
      // didn't (e.g. ended on end_turn without a final tool call), we do it.
      const durationMin = Math.round((Date.now() - ticketStart) / 60_000);
      await this.jiraComment(issue.key,
        `Warden [${this.label}] has completed work on this ticket (${durationMin}min).\n\n` +
        `Final output:\n${result.slice(0, 2000)}`,
      );
      await this.jiraTransition(issue.key, 'Done');
      console.log(`[${this.label}] Ticket ${issue.key} completed (${durationMin}min).`);

      // Unblock dependents directly — the webhook handler in daemon.ts is
      // the primary mechanism, but this ensures it works even without a tunnel.
      try {
        await this.unblockDependentsDirectly(issue);
      } catch (err) {
        console.warn(`[${this.label}] Unblock dependents failed:`, err);
      }

      this.deps.telemetry?.inc('warden.tickets_processed');
      tracked && this.deps.tracker?.complete(tracked.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.label}] Ticket ${issue.key} failed:`, msg);
      await this.jiraComment(issue.key, `Work failed: ${msg}`).catch(() => {});
      await this.jiraTransition(issue.key, 'Blocked').catch(() => {});
      this.deps.telemetry?.inc('warden.ticket_errors');
      tracked && this.deps.tracker?.fail(tracked.id, msg);
    } finally {
      this.deps.telemetry?.record('warden.ticket_duration_ms', Date.now() - ticketStart);
      if (this.deps.workspace && scratchPath) {
        await this.deps.workspace.cleanScratch(issue.key).catch(() => {});
      }
      tokenBudget.clearTicket(issue.key);
    }
  }

  // -- JIRA helpers --------------------------------------------------------

  private async jiraComment(issueKey: string, body: string): Promise<void> {
    try {
      await this.deps.registry.invoke('atlassian', 'add_comment', { issueKey, body });
    } catch { /* non-critical */ }
  }

  private async jiraTransition(issueKey: string, targetStatus: string): Promise<void> {
    try {
      const transitionsStr = await this.deps.registry.invoke('atlassian', 'get_transitions', { issueKey });
      const parsed = JSON.parse(transitionsStr) as { transitions?: { id: string; name: string; to?: { name: string } }[] };
      const match = (parsed.transitions ?? []).find(
        (t) => t.name.toLowerCase() === targetStatus.toLowerCase() ||
               t.to?.name.toLowerCase() === targetStatus.toLowerCase(),
      );
      if (match) {
        await this.deps.registry.invoke('atlassian', 'transition_issue', { issueKey, transitionId: match.id });
      }
    } catch { /* skip silently */ }
  }

  // -- Dependency unblocking fallback --------------------------------------

  /** Direct fallback: unblock dependents if the webhook doesn't arrive. */
  private async unblockDependentsDirectly(doneIssue: JiraIssue): Promise<void> {
    const doneKey = doneIssue.key;
    const projectKey = doneIssue.fields.project?.key;
    if (!projectKey) return;

    const jql = `project = ${projectKey} AND statusCategory != Done AND text ~ "DEPENDS ON: ${doneKey}"`;
    const resultStr = await this.deps.registry.invoke('atlassian', 'search_issues', {
      jql, maxResults: 20, fields: 'summary,status,description',
    });
    const result = JSON.parse(resultStr) as { issues?: { key: string; fields: { summary: string; status: { name: string }; description?: unknown } }[] };
    const candidates = result.issues ?? [];

    let found = 0;
    for (const candidate of candidates) {
      const descText = JSON.stringify(candidate.fields.description ?? '');
      if (!descText.includes(`DEPENDS ON: ${doneKey}`)) continue;

      // Ensure ticket is in To Do (may already be — that's fine).
      if (candidate.fields.status.name !== 'To Do') {
        try {
          const trStr = await this.deps.registry.invoke('atlassian', 'get_transitions', { issueKey: candidate.key });
          const transitions = (JSON.parse(trStr) as { transitions?: { id: string; name: string }[] }).transitions ?? [];
          const toTodo = transitions.find(t => t.name.toLowerCase() === 'to do');
          if (toTodo) await this.deps.registry.invoke('atlassian', 'transition_issue', { issueKey: candidate.key, transitionId: toTodo.id });
        } catch {}
      }
      await this.deps.registry.invoke('atlassian', 'add_comment', {
        issueKey: candidate.key, body: `✅ Dependency ${doneKey} is Done — this story is now unblocked.`,
      }).catch(() => {});
      console.log(`[${this.label}] Unblocked ${candidate.key} (dependency ${doneKey} is Done)`);
      found++;
    }

    if (found > 0 && this.deps.wardenRegistry) {
      console.log(`[${this.label}] ${found} dependent story(s) ready after ${doneKey}. Rehydrating wardens.`);
      await this.deps.wardenRegistry.rehydrateAll();
    }
  }

  // -- Prompt construction -------------------------------------------------

  private async buildTicketPrompt(issue: JiraIssue): Promise<string> {
    const parts = [
      `## Assigned Ticket: ${issue.key}`,
      `**Summary:** ${issue.fields.summary}`,
      `**Type:** ${issue.fields.issuetype.name}`,
      `**Priority:** ${issue.fields.priority.name}`,
      `**Project:** ${issue.fields.project.key}`,
    ];

    if (issue.fields.parent) {
      parts.push(`**Parent:** ${issue.fields.parent.key} — ${issue.fields.parent.fields.summary}`);
    }

    if (issue.fields.description) {
      const desc = JSON.stringify(issue.fields.description);
      parts.push('', '**Description:**', desc.length > 4000 ? desc.slice(0, 4000) + '... [truncated]' : desc);
    }

    if (issue.fields.labels.length) {
      parts.push(`**Labels:** ${issue.fields.labels.join(', ')}`);
    }

    try {
      const entries = await this.deps.knowledge.search(issue.fields.summary, 5);
      if (entries.length > 0) {
        parts.push('', '## Prior Knowledge (from previous work)');
        for (const entry of entries) {
          const content = entry.content.length > 2000 ? entry.content.slice(0, 2000) + '... [truncated]' : entry.content;
          parts.push(`### ${entry.title}`, content, `_Tags: ${entry.tags.join(', ')} | Source: ${entry.source}_`, '');
        }
      }
    } catch { /* not critical */ }

    if (this.deps.workspace) {
      parts.push('', this.deps.workspace.describeForAgent());
      parts.push(`**Scratch workspace for this ticket:** ${this.deps.workspace.scratch}/${issue.key}/`);
    }

    parts.push(
      '',
      'Read this ticket and any prior knowledge carefully. Decide what kind of worker is needed, craft a system_prompt that defines the worker\'s expertise, and call `run_worker` with detailed instructions. You can call `run_worker` multiple times in one turn to spawn workers in parallel. Include the relevant workspace paths in the worker\'s prompt so it knows where to work. Inspect the result, iterate if needed, report progress via comments, and save any lessons learned via `knowledge_save`.',
    );

    return parts.join('\n');
  }

  // -- Ticket-scoped tools -------------------------------------------------

  private buildCommentTool(): MetaTool {
    const issueKey = this.ticket.key;
    return {
      spec: {
        name: 'comment',
        description: 'Post a comment on your current Story ticket in JIRA.',
        input_schema: {
          type: 'object' as const,
          properties: { body: { type: 'string', description: 'Comment text' } },
          required: ['body'],
        },
      },
      handle: async (input) => {
        try {
          await this.deps.registry.invoke('atlassian', 'add_comment', { issueKey, body: input.body as string });
          return JSON.stringify({ ok: true, story: issueKey });
        } catch (err) {
          return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    };
  }

  private buildTransitionTool(): MetaTool {
    const issueKey = this.ticket.key;
    return {
      spec: {
        name: 'transition',
        description: 'Transition your current Story to a new status in JIRA.',
        input_schema: {
          type: 'object' as const,
          properties: { status: { type: 'string', description: 'Target status (e.g. "In Progress", "In Review", "Done")' } },
          required: ['status'],
        },
      },
      handle: async (input) => {
        try {
          await this.jiraTransition(issueKey, input.status as string);
          return JSON.stringify({ ok: true, story: issueKey, status: input.status });
        } catch (err) {
          return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    };
  }

  private buildRunWorkerTool(): MetaTool {
    const issue = this.ticket;
    return {
      concurrent: true,  // Multiple workers spawn in parallel within one LLM turn.
      spec: {
        name: 'run_worker',
        description:
          'Spawn a worker agent to perform a task. Creates a JIRA Task under the current Story ' +
          'for full traceability. You define the worker\'s identity via system_prompt and its work ' +
          'via prompt. Each call creates a fresh agent. You can call this multiple times in one ' +
          'turn — all workers will execute in parallel.\n\n' +
          'JIRA hierarchy: Epic (Architect) → Story (Warden) → Task (Worker)',
        input_schema: {
          type: 'object' as const,
          properties: {
            task_title: { type: 'string', description: 'Clear JIRA task title.' },
            worker_type: { type: 'string', description: 'Worker type (e.g. "developer", "reviewer", "deployer").' },
            priority: { type: 'string', enum: ['Highest', 'High', 'Medium', 'Low', 'Lowest'] },
            labels: { type: 'array', items: { type: 'string' } },
            system_prompt: { type: 'string', description: 'System prompt defining the worker\'s expertise.' },
            prompt: { type: 'string', description: 'Detailed task instructions.' },
          },
          required: ['task_title', 'worker_type', 'system_prompt', 'prompt'],
        },
      },
      handle: async (input) => {
        const taskTitle = input.task_title as string;
        const workerType = input.worker_type as string;
        const priority = (input.priority as string) ?? issue.fields.priority.name ?? 'Medium';
        const labels = (input.labels as string[]) ?? [];
        const workerSystemPrompt = input.system_prompt as string;
        const prompt = input.prompt as string;

        let taskKey: string | null = null;
        try {
          const resultStr = await this.deps.registry.invoke('atlassian', 'create_issue', {
            issueType: 'Task',
            summary: taskTitle,
            description: `**Parent:** ${issue.key}\n**Worker type:** ${workerType}\n**Priority:** ${priority}\n\n## Task\n\n${prompt}`,
            project: issue.fields.project?.key ?? 'SCRUM',
            priority,
            labels: [`worker:${workerType}`, `parent:${issue.key}`, ...labels],
          });
          taskKey = (JSON.parse(resultStr) as { key?: string }).key ?? null;
        } catch (taskErr) {
          console.warn(`[${this.label}] Task creation failed for ${issue.key}:`, taskErr instanceof Error ? taskErr.message.slice(0, 150) : taskErr);
        }

        const workerTracked = this.deps.tracker?.register({
          type: 'worker',
          label: workerType,
          ticketKey: taskKey ?? undefined,
        });

        console.log(`[${this.label}] Spawning worker "${workerType}" for ${issue.key} (task: ${taskKey ?? 'none'})`);
        const workerStart = Date.now();
        try {
          onWorkerSpawn?.();
          this.deps.telemetry?.inc('worker.spawns');
          this.deps.telemetry?.inc(`worker.spawns_by_type.${workerType}`);
          const worker = new DynamicWorker(this.deps, workerSystemPrompt);

          if (taskKey) {
            const boundTaskKey = taskKey;
            worker.addTool({
              spec: {
                name: 'comment',
                description: 'Post a comment on your Task ticket in JIRA.',
                input_schema: { type: 'object' as const, properties: { body: { type: 'string', description: 'Comment text' } }, required: ['body'] },
              },
              handle: async (ci) => {
                try {
                  await this.deps.registry.invoke('atlassian', 'add_comment', { issueKey: boundTaskKey, body: ci.body as string });
                  return JSON.stringify({ ok: true, task: boundTaskKey });
                } catch (err) { return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
              },
            });
            worker.addTool({
              spec: {
                name: 'transition',
                description: 'Transition your Task ticket to a new status.',
                input_schema: { type: 'object' as const, properties: { status: { type: 'string', description: 'Target status' } }, required: ['status'] },
              },
              handle: async (ti) => {
                try {
                  await this.jiraTransition(boundTaskKey, ti.status as string);
                  return JSON.stringify({ ok: true, task: boundTaskKey, status: ti.status });
                } catch (err) { return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
              },
            });
            await this.jiraTransition(boundTaskKey, 'In Progress');
          }

          const result = await worker.run(prompt, taskKey ?? undefined, {
            signal: workerTracked?.signal,
            timeoutMs: 3 * 60 * 60_000,
            retryOptions: STANDARD_RETRY,
          });

          const durationMin = Math.round((Date.now() - workerStart) / 60_000);
          if (taskKey) {
            await this.jiraComment(taskKey, `Worker completed (${durationMin}min).\n\n${result.slice(0, 3000)}`);
            await this.jiraTransition(taskKey, 'Done');
          }
          console.log(`[${this.label}] Worker "${workerType}" completed for ${issue.key} (${durationMin}min)`);
          this.deps.telemetry?.record('worker.duration_ms', Date.now() - workerStart);
          workerTracked && this.deps.tracker?.complete(workerTracked.id);
          return JSON.stringify({ ok: true, output: result, task: taskKey });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${this.label}] Worker "${workerType}" failed for ${issue.key}:`, msg);
          this.deps.telemetry?.inc('worker.errors');
          this.deps.telemetry?.record('worker.duration_ms', Date.now() - workerStart);
          workerTracked && this.deps.tracker?.fail(workerTracked.id, msg);
          if (taskKey) {
            await this.jiraComment(taskKey, `Worker failed: ${msg}`);
            await this.jiraTransition(taskKey, 'Blocked');
          }
          return JSON.stringify({ ok: false, error: msg, task: taskKey });
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// BaseWarden — the public warden class that wardens extend.
// ---------------------------------------------------------------------------

export abstract class BaseWarden extends BaseAgent {
  private ticketQueue: JiraIssue[] = [];
  private activeRunners = new Map<string, TicketRunner>();
  private maxConcurrency = 5;
  protected deps: AgentDeps;

  constructor(deps: AgentDeps) {
    super(deps);
    this.deps = deps;
  }

  // -----------------------------------------------------------------------
  // Abstract
  // -----------------------------------------------------------------------

  abstract wardenLabel(): string;
  protected abstract wardenPrompt(): string;

  protected systemPrompt(): string {
    return WARDEN_SYSTEM_PREAMBLE + this.wardenPrompt();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  registerWebhooks(webhooks: WebhookServer): void {
    webhooks.on('jira:issue_created', async (payload) => this.onWebhookEvent(payload));
    webhooks.on('jira:issue_updated', async (payload) => this.onWebhookEvent(payload));
  }

  async start(): Promise<void> {
    await this.rehydrate();
  }

  async rehydrate(): Promise<void> {
    try {
      const resultStr = await this.deps.registry.invoke(
        'atlassian', 'search_issues',
        { jql: `labels = "${this.wardenLabel()}" AND statusCategory != Done AND status != Blocked ORDER BY priority ASC, created ASC`, maxResults: 50, fields: 'summary,status,priority,labels,issuetype,parent,assignee,project,description' },
      );
      const result = JSON.parse(resultStr) as { issues?: { key: string; fields: JiraIssue['fields'] }[] };
      const issues = result.issues ?? [];

      for (const issue of issues) {
        if (this.ticketQueue.some((t) => t.key === issue.key)) continue;
        if (this.activeRunners.has(issue.key)) continue;
        this.ticketQueue.push(issue as JiraIssue);
      }

      if (issues.length > 0) {
        console.log(`[${this.wardenLabel()}] Rehydrated ${issues.length} ticket(s) from JIRA.`);
        this.drainQueue();
      }
    } catch (err) {
      console.error(`[${this.wardenLabel()}] Rehydrate failed:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Webhook handling
  // -----------------------------------------------------------------------

  private async onWebhookEvent(payload: JiraWebhookPayload): Promise<void> {
    const issue = payload.issue;
    if (!issue) return;

    const labels = issue.fields.labels ?? [];
    if (!labels.includes(this.wardenLabel())) return;

    const category = issue.fields.status.statusCategory.key;
    if (category === 'done') return;

    // Respect Blocked status — ticket has unmet dependencies. The Architect
    // will transition it to To Do when the dependency is resolved.
    const statusName = issue.fields.status.name?.toLowerCase();
    if (statusName === 'blocked') return;

    if (this.ticketQueue.some((t) => t.key === issue.key)) return;
    if (this.activeRunners.has(issue.key)) return;

    console.log(`[${this.wardenLabel()}] Picked up ticket: ${issue.key} — ${issue.fields.summary}`);
    this.ticketQueue.push(issue);
    this.drainQueue();
  }

  // -----------------------------------------------------------------------
  // Concurrent queue processing — up to maxConcurrency tickets at once
  // -----------------------------------------------------------------------

  private drainQueue(): void {
    while (this.activeRunners.size < this.maxConcurrency && this.ticketQueue.length > 0) {
      const issue = this.ticketQueue.shift()!;
      const runner = new TicketRunner({
        ticket: issue,
        deps: this.deps,
        wardenLabel: this.wardenLabel(),
        systemPrompt: this.systemPrompt(),
      });

      // Propagate transcript recorder if set.
      if (this.transcriptRecorder) {
        runner.setTranscriptRecorder(this.transcriptRecorder);
      }

      this.activeRunners.set(issue.key, runner);

      runner.execute()
        .catch((err) => {
          console.error(`[SELF-HEAL] Warden ${this.wardenLabel()} ticket ${issue.key} crashed:`, err);
          this.deps.telemetry?.inc('warden.ticket_crashes');
        })
        .finally(() => {
          this.activeRunners.delete(issue.key);
          // Fill freed slot.
          this.drainQueue();
        });
    }
  }

  // -----------------------------------------------------------------------
  // State inspection
  // -----------------------------------------------------------------------

  get queueDepth(): number {
    return this.ticketQueue.length;
  }

  get activeTickets(): JiraIssue[] {
    return [...this.activeRunners.values()].map((r) => r.ticket);
  }

  get concurrentTickets(): number {
    return this.activeRunners.size;
  }

  /** Backward-compatible: returns the first active ticket or null. */
  get activeTicket(): JiraIssue | null {
    const first = this.activeRunners.values().next();
    return first.done ? null : first.value.ticket;
  }

  get busy(): boolean {
    return this.activeRunners.size > 0;
  }
}
