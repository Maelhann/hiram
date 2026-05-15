import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MetaTool } from '../tools/meta-tools.js';

// ---------------------------------------------------------------------------
// EventBus — external signal intake with fan-out delivery and persistence.
//
// Events are persisted to SQLite BEFORE delivery. Each event targets one or
// more named handlers (agents/wardens). Delivery is tracked per-handler.
// Failed deliveries are retried on the next boot cycle.
//
// Event sources:
//   - webhook: an HTTP endpoint that receives POST payloads
//   - cron: a scheduled expression (runs on interval)
//   - poll: periodically calls a URL and diffs the response
//
// Handlers subscribe by name. A listener declares which handlers receive
// its events via the `targets` field. If no targets are declared, the
// event goes to the "architect" handler (backward-compatible default).
// ---------------------------------------------------------------------------

export type EventSource = 'webhook' | 'cron' | 'poll';

interface ListenerRecord {
  id: string;
  name: string;
  source: EventSource;
  config: string;    // JSON
  handler: string;   // prompt template with {{payload}} placeholder
  targets: string;   // JSON string[] — handler names to fan out to
  active: number;
  created_by: string;
  created_at: string;
}

export interface EventListener {
  id: string;
  name: string;
  source: EventSource;
  config: WebhookConfig | CronConfig | PollConfig;
  handler: string;
  targets: string[];
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export interface WebhookConfig {
  /** URL path to listen on (e.g. "/events/stripe"). */
  path: string;
}

export interface CronConfig {
  /** Cron expression (e.g. "every 6h", "every 24h"). */
  expression: string;
}

export interface PollConfig {
  /** URL to poll. */
  url: string;
  /** Poll interval in seconds. */
  intervalSeconds: number;
  /** HTTP headers to include. */
  headers?: Record<string, string>;
}

/** A named handler that receives event prompts. */
export type EventHandler = (prompt: string) => Promise<void>;

const MAX_RETRY_ATTEMPTS = 5;

export class EventBus {
  private handlers = new Map<string, EventHandler>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private cronTimers = new Map<string, ReturnType<typeof setInterval>>();
  private pollCache = new Map<string, string>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private transcriptRecorder?: { recordEvent: (r: { listenerName: string; targets: string[]; deliveryStatus: Record<string, string>; eventId: string }) => void };

  constructor(private db: Database.Database) {
    // Ensure the targets column exists (migration for existing DBs).
    try {
      this.db.exec(`ALTER TABLE event_listeners ADD COLUMN targets TEXT NOT NULL DEFAULT '["architect"]'`);
    } catch {
      // Column already exists.
    }
  }

  // -----------------------------------------------------------------------
  // Handler registration — agents and wardens subscribe by name
  // -----------------------------------------------------------------------

  /** Attach a transcript recorder (for E2E tests). */
  setTranscriptRecorder(recorder: typeof this.transcriptRecorder): void {
    this.transcriptRecorder = recorder;
  }

  /** Register a named handler. Multiple handlers can coexist. */
  subscribe(name: string, handler: EventHandler): void {
    this.handlers.set(name, handler);
  }

  /** Remove a handler. */
  unsubscribe(name: string): void {
    this.handlers.delete(name);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start all active listeners and the retry loop. */
  start(): void {
    const listeners = this.listAll().filter((l) => l.active);
    for (const listener of listeners) {
      this.activate(listener);
    }

    // Retry undelivered events from the journal every 60 seconds.
    this.retryTimer = setInterval(() => this.retryPending(), 60_000);

    // Immediately retry anything left from last boot.
    this.retryPending().catch(console.error);

    if (listeners.length > 0) {
      console.log(`EventBus: started ${listeners.length} listener(s), ${this.handlers.size} handler(s).`);
    }
  }

  /** Stop all running listeners and the retry loop. */
  stop(): void {
    for (const [, timer] of this.pollTimers) clearInterval(timer);
    for (const [, timer] of this.cronTimers) clearInterval(timer);
    this.pollTimers.clear();
    this.cronTimers.clear();
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  create(opts: {
    name: string;
    source: EventSource;
    config: WebhookConfig | CronConfig | PollConfig;
    handler: string;
    targets?: string[];
    createdBy?: string;
  }): EventListener {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const targets = opts.targets ?? ['architect'];
    this.db.prepare(
      `INSERT INTO event_listeners (id, name, source, config, handler, targets, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, opts.name, opts.source, JSON.stringify(opts.config), opts.handler, JSON.stringify(targets), opts.createdBy ?? 'system', now);

    const listener = this.get(id)!;
    this.activate(listener);
    return listener;
  }

  get(id: string): EventListener | undefined {
    const row = this.db.prepare(`SELECT * FROM event_listeners WHERE id = ?`).get(id) as ListenerRecord | undefined;
    return row ? toListener(row) : undefined;
  }

  getByName(name: string): EventListener | undefined {
    const row = this.db.prepare(`SELECT * FROM event_listeners WHERE name = ?`).get(name) as ListenerRecord | undefined;
    return row ? toListener(row) : undefined;
  }

  listAll(): EventListener[] {
    const rows = this.db.prepare(`SELECT * FROM event_listeners ORDER BY name`).all() as ListenerRecord[];
    return rows.map(toListener);
  }

  remove(name: string): void {
    this.deactivateByName(name);
    this.db.prepare(`DELETE FROM event_listeners WHERE name = ?`).run(name);
  }

  deactivateByName(name: string): void {
    this.db.prepare(`UPDATE event_listeners SET active = 0 WHERE name = ?`).run(name);
    const timer = this.pollTimers.get(name) ?? this.cronTimers.get(name);
    if (timer) clearInterval(timer);
    this.pollTimers.delete(name);
    this.cronTimers.delete(name);
  }

  // -----------------------------------------------------------------------
  // Webhook intake
  // -----------------------------------------------------------------------

  async handleWebhook(path: string, payload: unknown): Promise<boolean> {
    const listeners = this.listAll().filter(
      (l) => l.active && l.source === 'webhook' && (l.config as WebhookConfig).path === path,
    );
    if (listeners.length === 0) return false;

    for (const listener of listeners) {
      const prompt = listener.handler.replace('{{payload}}', JSON.stringify(payload));
      await this.fire(listener.name, prompt, listener.targets);
    }
    return true;
  }

  getWebhookPaths(): string[] {
    return this.listAll()
      .filter((l) => l.active && l.source === 'webhook')
      .map((l) => (l.config as WebhookConfig).path);
  }

  // -----------------------------------------------------------------------
  // Activation (cron / poll timers)
  // -----------------------------------------------------------------------

  private activate(listener: EventListener): void {
    switch (listener.source) {
      case 'cron': {
        const cfg = listener.config as CronConfig;
        const interval = parseCronInterval(cfg.expression);
        if (interval > 0) {
          const timer = setInterval(() => {
            const prompt = listener.handler.replace('{{payload}}', JSON.stringify({ trigger: 'scheduled', time: new Date().toISOString() }));
            this.fire(listener.name, prompt, listener.targets).catch(console.error);
          }, interval);
          this.cronTimers.set(listener.name, timer);
        }
        break;
      }
      case 'poll': {
        const cfg = listener.config as PollConfig;
        const timer = setInterval(async () => {
          try {
            const res = await fetch(cfg.url, { headers: cfg.headers });
            const body = await res.text();
            const hash = simpleHash(body);
            const prev = this.pollCache.get(listener.name);

            if (prev && prev !== hash) {
              const prompt = listener.handler.replace('{{payload}}', JSON.stringify({
                trigger: 'content_changed',
                url: cfg.url,
                previous_hash: prev,
                current_hash: hash,
                body: body.slice(0, 5000),
              }));
              await this.fire(listener.name, prompt, listener.targets);
            }

            this.pollCache.set(listener.name, hash);
          } catch (err) {
            console.error(`[EventBus] Poll "${listener.name}" failed:`, err);
          }
        }, cfg.intervalSeconds * 1000);
        this.pollTimers.set(listener.name, timer);
        break;
      }
      case 'webhook':
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Fire — persist to journal, then deliver to all targets
  // -----------------------------------------------------------------------

  private async fire(listenerName: string, prompt: string, targets: string[]): Promise<void> {
    const eventId = crypto.randomUUID();
    const fullPrompt = `## External Event: ${listenerName}\n\n${prompt}`;

    // Persist BEFORE delivery — event survives crashes.
    this.db.prepare(
      `INSERT INTO event_journal (id, listener, prompt, targets, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
    ).run(eventId, listenerName, fullPrompt, JSON.stringify(targets));

    console.log(`[EventBus] Event "${listenerName}" persisted (${eventId.slice(0, 8)}), delivering to: ${targets.join(', ')}`);

    await this.deliver(eventId, fullPrompt, targets);
  }

  /** Attempt delivery to all targets. Updates journal status. */
  private async deliver(eventId: string, prompt: string, targets: string[]): Promise<void> {
    const delivered: string[] = [];
    const failed: string[] = [];

    // Fan-out: deliver to all targets concurrently.
    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const handler = this.handlers.get(target);
        if (!handler) {
          console.warn(`[EventBus] No handler for target "${target}" — skipping`);
          failed.push(target);
          return;
        }
        await handler(prompt);
        delivered.push(target);
      }),
    );

    // Collect failures from rejected promises.
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        const target = targets[i];
        if (!failed.includes(target)) failed.push(target);
        console.error(`[EventBus] Delivery to "${target}" failed:`, r.reason);
      }
    }

    // Update journal.
    const allDelivered = delivered.length === targets.length;
    const status = allDelivered ? 'delivered' : (delivered.length > 0 ? 'partial' : 'pending');

    this.db.prepare(
      `UPDATE event_journal SET delivered = ?, failed = ?, status = ?, attempts = attempts + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(JSON.stringify(delivered), JSON.stringify(failed), status, eventId);

    // Transcript recording (E2E tests only).
    if (this.transcriptRecorder) {
      const deliveryStatus: Record<string, string> = {};
      for (const t of delivered) deliveryStatus[t] = 'delivered';
      for (const t of failed) deliveryStatus[t] = 'failed';
      try {
        this.transcriptRecorder.recordEvent({
          listenerName: prompt.split('\n')[0].replace('## External Event: ', ''),
          targets,
          deliveryStatus,
          eventId,
        });
      } catch { /* never block */ }
    }

    if (allDelivered) {
      console.log(`[EventBus] Event ${eventId.slice(0, 8)} delivered to all ${targets.length} target(s)`);
    } else if (failed.length > 0) {
      console.warn(`[EventBus] Event ${eventId.slice(0, 8)}: ${delivered.length} delivered, ${failed.length} failed (will retry)`);
    }
  }

  // -----------------------------------------------------------------------
  // Retry loop — picks up pending/partial events from the journal
  // -----------------------------------------------------------------------

  private async retryPending(): Promise<void> {
    const rows = this.db.prepare(
      `SELECT * FROM event_journal WHERE status IN ('pending', 'partial') AND attempts < ? ORDER BY created_at`,
    ).all(MAX_RETRY_ATTEMPTS) as {
      id: string; listener: string; prompt: string; targets: string;
      delivered: string; failed: string; attempts: number;
    }[];

    if (rows.length === 0) return;

    console.log(`[EventBus] Retrying ${rows.length} undelivered event(s)...`);

    for (const row of rows) {
      const allTargets = JSON.parse(row.targets) as string[];
      const alreadyDelivered = JSON.parse(row.delivered) as string[];
      // Only retry targets that haven't been delivered yet.
      const remaining = allTargets.filter(t => !alreadyDelivered.includes(t));

      if (remaining.length === 0) {
        this.db.prepare(`UPDATE event_journal SET status = 'delivered', updated_at = datetime('now') WHERE id = ?`).run(row.id);
        continue;
      }

      await this.deliver(row.id, row.prompt, remaining);
    }

    // Mark events that exceeded retry limit as dead.
    this.db.prepare(
      `UPDATE event_journal SET status = 'dead', updated_at = datetime('now')
       WHERE status IN ('pending', 'partial') AND attempts >= ?`,
    ).run(MAX_RETRY_ATTEMPTS);

    const dead = this.db.prepare(`SELECT COUNT(*) as count FROM event_journal WHERE status = 'dead'`).get() as { count: number };
    if (dead.count > 0) {
      console.warn(`[EventBus] ${dead.count} event(s) in dead-letter queue (exceeded ${MAX_RETRY_ATTEMPTS} attempts)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Meta-tools
// ---------------------------------------------------------------------------

export function createEventTools(bus: EventBus): MetaTool[] {
  return [
    listenerCreate(bus),
    listenerList(bus),
    listenerRemove(bus),
  ];
}

function listenerCreate(bus: EventBus): MetaTool {
  return {
    spec: {
      name: 'listener_create',
      description:
        'Create an event listener that triggers handlers when an external signal arrives. ' +
        'Three source types:\n' +
        '- "webhook": registers an HTTP path (e.g. "/events/stripe") that accepts POST payloads\n' +
        '- "cron": runs on a schedule (e.g. "every 6h", "every 24h", "every 7d")\n' +
        '- "poll": periodically fetches a URL and fires when the content changes\n\n' +
        'The handler is a prompt template. Use {{payload}} as a placeholder for the event data.\n' +
        'Targets specify which agents/wardens receive the event (e.g. ["architect", "treasurer"]).',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Unique listener name' },
          source: { type: 'string', enum: ['webhook', 'cron', 'poll'], description: 'Event source type' },
          path: { type: 'string', description: 'For webhook: URL path (e.g. "/events/stripe")' },
          expression: { type: 'string', description: 'For cron: schedule expression' },
          url: { type: 'string', description: 'For poll: URL to watch' },
          interval_seconds: { type: 'number', description: 'For poll: check interval' },
          headers: { type: 'object', description: 'For poll: HTTP headers' },
          handler: { type: 'string', description: 'Prompt template. Use {{payload}} for event data.' },
          targets: { type: 'array', items: { type: 'string' }, description: 'Handler names to deliver to (default: ["architect"])' },
        },
        required: ['name', 'source', 'handler'],
      },
    },
    async handle(input) {
      try {
        let config: WebhookConfig | CronConfig | PollConfig;
        switch (input.source as EventSource) {
          case 'webhook': config = { path: input.path as string }; break;
          case 'cron': config = { expression: input.expression as string }; break;
          case 'poll': config = { url: input.url as string, intervalSeconds: input.interval_seconds as number, headers: input.headers as Record<string, string> | undefined }; break;
          default: return JSON.stringify({ ok: false, error: `Unknown source: ${input.source}` });
        }
        const listener = bus.create({
          name: input.name as string,
          source: input.source as EventSource,
          config,
          handler: input.handler as string,
          targets: input.targets as string[] | undefined,
          createdBy: 'agent',
        });
        return JSON.stringify({ ok: true, id: listener.id, name: listener.name, targets: listener.targets });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function listenerList(bus: EventBus): MetaTool {
  return {
    spec: {
      name: 'listener_list',
      description: 'List all event listeners with their status and targets.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    async handle() {
      const listeners = bus.listAll();
      return JSON.stringify({
        ok: true,
        count: listeners.length,
        listeners: listeners.map((l) => ({
          name: l.name, source: l.source, targets: l.targets, active: l.active, created_by: l.createdBy,
        })),
      });
    },
  };
}

function listenerRemove(bus: EventBus): MetaTool {
  return {
    spec: {
      name: 'listener_remove',
      description: 'Remove an event listener.',
      input_schema: {
        type: 'object' as const,
        properties: { name: { type: 'string', description: 'Listener name to remove' } },
        required: ['name'],
      },
    },
    async handle(input) {
      try {
        bus.remove(input.name as string);
        return JSON.stringify({ ok: true, name: input.name });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toListener(row: ListenerRecord): EventListener {
  let targets: string[];
  try { targets = JSON.parse(row.targets); } catch { targets = ['architect']; }
  return {
    id: row.id,
    name: row.name,
    source: row.source as EventSource,
    config: JSON.parse(row.config),
    handler: row.handler,
    targets,
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function parseCronInterval(expr: string): number {
  const match = expr.match(/every\s+(\d+)\s*(m|h|d)/i);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: return 0;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}
