import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WebhookServer } from '../jira/webhook-server.js';
import type { MetaTool } from '../tools/meta-tools.js';
import type { AgentDeps } from './base-agent.js';
import { BaseWarden } from './base-warden.js';

// ---------------------------------------------------------------------------
// Warden Registry — manages dynamically created wardens.
//
// Wardens are data-driven: a row in SQLite with a label and a warden prompt.
// The registry loads them on boot, instantiates DynamicWarden instances, and
// hooks them up to the webhook server. New wardens can be created at runtime
// by any agent (typically Architect).
//
// Workers are NOT pre-configured — each warden decides what kind of worker
// to spawn per-task via the system_prompt parameter of run_worker.
// ---------------------------------------------------------------------------

// -- DB row type -----------------------------------------------------------

interface WardenRecord {
  id: string;
  name: string;
  label: string;
  warden_prompt: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface WardenConfig {
  id: string;
  name: string;
  label: string;
  wardenPrompt: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// -- DynamicWarden ---------------------------------------------------------

/** A warden instantiated from stored config rather than a hardcoded subclass. */
class DynamicWarden extends BaseWarden {
  constructor(
    deps: AgentDeps,
    private config: WardenConfig,
  ) {
    super(deps);
  }

  wardenLabel(): string {
    return this.config.label;
  }

  protected wardenPrompt(): string {
    return this.config.wardenPrompt;
  }
}

// -- WardenRegistry --------------------------------------------------------

export class WardenRegistry {
  private instances = new Map<string, DynamicWarden>();

  constructor(
    private db: Database.Database,
    private deps: AgentDeps,
    private webhooks: WebhookServer,
  ) {}

  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** Inject a transcript recorder into all wardens (current and future). */
  setTranscriptRecorder(recorder: AgentDeps['transcriptRecorder']): void {
    this.deps.transcriptRecorder = recorder;
    // Also inject into already-running wardens.
    for (const warden of this.instances.values()) {
      warden.setTranscriptRecorder(recorder);
    }
  }

  /** Load all active wardens from SQLite and start them. */
  async start(): Promise<void> {
    const configs = this.listAll().filter((c) => c.active);
    for (const config of configs) {
      await this.instantiate(config);
    }
    if (configs.length > 0) {
      console.log(`WardenRegistry: started ${configs.length} warden(s).`);
    }

    // Health check timer — detect dead wardens every 60s and restart them.
    this.healthTimer = setInterval(() => this.healthCheck(), 60_000);
  }

  /** Stop all running wardens. */
  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.instances.clear();
  }

  /** Detect wardens that should be running but aren't, and restart them. */
  private async healthCheck(): Promise<void> {
    const active = this.listAll().filter((c) => c.active);
    for (const config of active) {
      if (!this.instances.has(config.label)) {
        console.warn(`[SELF-HEAL] Warden "${config.name}" (${config.label}) is not running. Restarting...`);
        try {
          await this.instantiate(config);
          console.log(`[SELF-HEAL] Warden "${config.name}" restarted.`);
        } catch (err) {
          console.error(`[SELF-HEAL] Failed to restart warden "${config.name}":`, err);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  /** Create and start a new warden. Persists to SQLite. */
  async create(opts: {
    name: string;
    label: string;
    wardenPrompt: string;
  }): Promise<WardenConfig> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO wardens (id, name, label, warden_prompt, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, opts.name, opts.label, opts.wardenPrompt, now, now);

    const config: WardenConfig = {
      id,
      name: opts.name,
      label: opts.label,
      wardenPrompt: opts.wardenPrompt,
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.instantiate(config);
    return config;
  }

  /** Update a warden's prompts. Takes effect on the next ticket. */
  async update(label: string, opts: {
    name?: string;
    wardenPrompt?: string;
  }): Promise<WardenConfig> {
    const existing = this.getByLabel(label);
    if (!existing) throw new Error(`Warden not found: ${label}`);

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (opts.name !== undefined) { sets.push('name = ?'); values.push(opts.name); }
    if (opts.wardenPrompt !== undefined) { sets.push('warden_prompt = ?'); values.push(opts.wardenPrompt); }

    values.push(label);
    this.db.prepare(`UPDATE wardens SET ${sets.join(', ')} WHERE label = ?`).run(...values);

    // Re-instantiate with new config.
    this.instances.delete(label);
    const updated = this.getByLabel(label)!;
    if (updated.active) {
      await this.instantiate(updated);
    }

    return updated;
  }

  /** Deactivate a warden. It stops picking up new tickets but finishes current work. */
  deactivate(label: string): void {
    const existing = this.getByLabel(label);
    if (!existing) throw new Error(`Warden not found: ${label}`);

    this.db
      .prepare(`UPDATE wardens SET active = 0, updated_at = ? WHERE label = ?`)
      .run(new Date().toISOString(), label);

    this.instances.delete(label);
  }

  /** Reactivate a deactivated warden. */
  async activate(label: string): Promise<void> {
    const existing = this.getByLabel(label);
    if (!existing) throw new Error(`Warden not found: ${label}`);

    this.db
      .prepare(`UPDATE wardens SET active = 1, updated_at = ? WHERE label = ?`)
      .run(new Date().toISOString(), label);

    const config = this.getByLabel(label)!;
    await this.instantiate(config);
  }

  /** Permanently delete a warden. */
  remove(label: string): void {
    this.instances.delete(label);
    this.db.prepare(`DELETE FROM wardens WHERE label = ?`).run(label);
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  getByLabel(label: string): WardenConfig | undefined {
    const row = this.db
      .prepare(`SELECT * FROM wardens WHERE label = ?`)
      .get(label) as WardenRecord | undefined;
    return row ? toConfig(row) : undefined;
  }

  listAll(): WardenConfig[] {
    const rows = this.db
      .prepare(`SELECT * FROM wardens ORDER BY name`)
      .all() as WardenRecord[];
    return rows.map(toConfig);
  }

  /** List all wardens with runtime status. */
  listWithStatus(): {
    config: WardenConfig;
    running: boolean;
    busy: boolean;
    queueDepth: number;
    concurrentTickets: number;
    activeTickets: string[];
    activeTicket: string | null;
  }[] {
    return this.listAll().map((config) => {
      const instance = this.instances.get(config.label);
      return {
        config,
        running: !!instance,
        busy: instance?.busy ?? false,
        queueDepth: instance?.queueDepth ?? 0,
        concurrentTickets: instance?.concurrentTickets ?? 0,
        activeTickets: instance?.activeTickets.map((t) => t.key) ?? [],
        activeTicket: instance?.activeTicket?.key ?? null,
      };
    });
  }

  /** Force all wardens to re-scan JIRA for new tickets matching their label. */
  async rehydrateAll(): Promise<void> {
    for (const [label, warden] of this.instances) {
      try {
        await warden.rehydrate();
      } catch (err) {
        console.warn(`[WardenRegistry] Rehydrate failed for ${label}:`, err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async instantiate(config: WardenConfig): Promise<void> {
    if (this.instances.has(config.label)) return;

    const warden = new DynamicWarden(this.deps, config);
    warden.registerWebhooks(this.webhooks);
    this.instances.set(config.label, warden);
    await warden.start();
  }
}

// ---------------------------------------------------------------------------
// Meta-tools — let agents create and manage wardens at runtime
// ---------------------------------------------------------------------------

export function createWardenTools(registry: WardenRegistry): MetaTool[] {
  return [
    wardenCreate(registry),
    wardenList(registry),
    wardenUpdate(registry),
    wardenDeactivate(registry),
    wardenActivate(registry),
    wardenRemove(registry),
  ];
}

function wardenCreate(reg: WardenRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'warden_create',
      description:
        'Create and start a new Warden. A Warden is a singleton daemon that watches JIRA for tickets ' +
        'with a specific label, picks them up, spawns workers to execute the work, and reports progress. ' +
        'The warden_prompt defines the warden\'s domain expertise and coordination style. Workers are ' +
        'spawned per-task — the warden decides each worker\'s role dynamically via run_worker.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Human-readable warden name (e.g. "Deploy Warden")' },
          label: { type: 'string', description: 'JIRA label to watch for (e.g. "warden:deploy"). Must be unique.' },
          warden_prompt: {
            type: 'string',
            description: 'System prompt for the warden agent. Describes its domain expertise, what kinds of work it handles, and how it should coordinate workers.',
          },
        },
        required: ['name', 'label', 'warden_prompt'],
      },
    },
    async handle(input) {
      try {
        const config = await reg.create({
          name: input.name as string,
          label: input.label as string,
          wardenPrompt: input.warden_prompt as string,
        });
        return JSON.stringify({
          ok: true,
          warden: { id: config.id, name: config.name, label: config.label },
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function wardenList(reg: WardenRegistry): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'warden_list',
      description: 'List all registered wardens with their status (running, busy, queue depth, active ticket).',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    async handle() {
      const wardens = reg.listWithStatus();
      return JSON.stringify({
        ok: true,
        count: wardens.length,
        wardens: wardens.map((w) => ({
          name: w.config.name,
          label: w.config.label,
          active: w.config.active,
          running: w.running,
          busy: w.busy,
          queueDepth: w.queueDepth,
          concurrentTickets: w.concurrentTickets,
          activeTickets: w.activeTickets,
          activeTicket: w.activeTicket,
        })),
      });
    },
  };
}

function wardenUpdate(reg: WardenRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'warden_update',
      description: 'Update a warden\'s name or prompt. Takes effect on the next ticket.',
      input_schema: {
        type: 'object' as const,
        properties: {
          label: { type: 'string', description: 'Warden label to update' },
          name: { type: 'string', description: 'New name' },
          warden_prompt: { type: 'string', description: 'New warden system prompt' },
        },
        required: ['label'],
      },
    },
    async handle(input) {
      try {
        const config = await reg.update(input.label as string, {
          name: input.name as string | undefined,
          wardenPrompt: input.warden_prompt as string | undefined,
        });
        return JSON.stringify({ ok: true, warden: { name: config.name, label: config.label } });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function wardenDeactivate(reg: WardenRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'warden_deactivate',
      description: 'Deactivate a warden. It stops picking up new tickets but finishes current work.',
      input_schema: {
        type: 'object' as const,
        properties: {
          label: { type: 'string', description: 'Warden label to deactivate' },
        },
        required: ['label'],
      },
    },
    async handle(input) {
      try {
        reg.deactivate(input.label as string);
        return JSON.stringify({ ok: true, label: input.label });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function wardenActivate(reg: WardenRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'warden_activate',
      description: 'Reactivate a previously deactivated warden.',
      input_schema: {
        type: 'object' as const,
        properties: {
          label: { type: 'string', description: 'Warden label to activate' },
        },
        required: ['label'],
      },
    },
    async handle(input) {
      try {
        await reg.activate(input.label as string);
        return JSON.stringify({ ok: true, label: input.label });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function wardenRemove(reg: WardenRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'warden_remove',
      description: 'Permanently delete a warden from the system.',
      input_schema: {
        type: 'object' as const,
        properties: {
          label: { type: 'string', description: 'Warden label to remove' },
        },
        required: ['label'],
      },
    },
    async handle(input) {
      try {
        reg.remove(input.label as string);
        return JSON.stringify({ ok: true, label: input.label });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toConfig(row: WardenRecord): WardenConfig {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    wardenPrompt: row.warden_prompt,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
