import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MetaTool } from '../tools/meta-tools.js';

// ---------------------------------------------------------------------------
// PolicyStore — durable strategic objectives that drive the system.
//
// Policies are long-standing priorities set by the founder. The Architect
// reads them during planning and creates work to advance them. Progress
// is tracked via policy updates — a running log of what's been done,
// what's blocked, and what's next.
//
// Unlike JIRA tickets (which are discrete units of work), policies are
// persistent strategic directions: "Grow MRR to €10K", "Launch in 3
// new markets by Q3", "Reduce deploy time to under 5 minutes".
// ---------------------------------------------------------------------------

export type PolicyPriority = 'critical' | 'high' | 'medium' | 'low';
export type PolicyStatus = 'active' | 'paused' | 'completed' | 'abandoned';

interface PolicyRecord {
  id: string;
  title: string;
  description: string;
  priority: PolicyPriority;
  status: PolicyStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface PolicyUpdateRecord {
  id: string;
  policy_id: string;
  body: string;
  created_at: string;
}

export interface Policy {
  id: string;
  title: string;
  description: string;
  priority: PolicyPriority;
  status: PolicyStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  updates: { id: string; body: string; createdAt: string }[];
}

export class PolicyStore {
  constructor(private db: Database.Database) {}

  /** Create a new policy. */
  create(opts: {
    title: string;
    description: string;
    priority?: PolicyPriority;
    createdBy?: string;
  }): Policy {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO policies (id, title, description, priority, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, opts.title, opts.description, opts.priority ?? 'medium', opts.createdBy ?? 'founder', now, now);
    return this.get(id)!;
  }

  /** Get a policy with its update history. */
  get(id: string): Policy | undefined {
    const row = this.db.prepare(`SELECT * FROM policies WHERE id = ?`).get(id) as PolicyRecord | undefined;
    if (!row) return undefined;
    const updates = this.db.prepare(
      `SELECT * FROM policy_updates WHERE policy_id = ? ORDER BY created_at ASC`,
    ).all(id) as PolicyUpdateRecord[];
    return toPolicy(row, updates);
  }

  /** List all active policies, ordered by priority. */
  listActive(): Policy[] {
    const rows = this.db.prepare(
      `SELECT * FROM policies WHERE status = 'active'
       ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END`,
    ).all() as PolicyRecord[];
    return rows.map((r) => {
      const updates = this.db.prepare(
        `SELECT * FROM policy_updates WHERE policy_id = ? ORDER BY created_at ASC`,
      ).all(r.id) as PolicyUpdateRecord[];
      return toPolicy(r, updates);
    });
  }

  /** List all policies (including paused/completed). */
  listAll(): Policy[] {
    const rows = this.db.prepare(`SELECT * FROM policies ORDER BY created_at DESC`).all() as PolicyRecord[];
    return rows.map((r) => {
      const updates = this.db.prepare(
        `SELECT * FROM policy_updates WHERE policy_id = ? ORDER BY created_at DESC LIMIT 3`,
      ).all(r.id) as PolicyUpdateRecord[];
      return toPolicy(r, updates);
    });
  }

  /** Add a progress update to a policy. */
  addUpdate(policyId: string, body: string): void {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO policy_updates (id, policy_id, body, created_at) VALUES (?, ?, ?, ?)`,
    ).run(id, policyId, body, now);
    this.db.prepare(`UPDATE policies SET updated_at = ? WHERE id = ?`).run(now, policyId);
  }

  /** Change policy status. */
  setStatus(id: string, status: PolicyStatus): void {
    this.db.prepare(`UPDATE policies SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id);
  }

  /** Update policy fields. */
  update(id: string, opts: { title?: string; description?: string; priority?: PolicyPriority }): void {
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];
    if (opts.title) { sets.push('title = ?'); values.push(opts.title); }
    if (opts.description) { sets.push('description = ?'); values.push(opts.description); }
    if (opts.priority) { sets.push('priority = ?'); values.push(opts.priority); }
    values.push(id);
    this.db.prepare(`UPDATE policies SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Format active policies for injection into the Architect's prompt. */
  formatForArchitect(): string {
    const active = this.listActive();
    if (active.length === 0) return '';

    const lines = ['## Active Policies (strategic priorities from the founder)', ''];
    for (const p of active) {
      lines.push(`### [${p.priority.toUpperCase()}] ${p.title}`);
      lines.push(p.description);
      if (p.updates.length > 0) {
        const latest = p.updates[p.updates.length - 1];
        lines.push(`_Latest update (${latest.createdAt}):_ ${latest.body}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Meta-tools — policy management
// ---------------------------------------------------------------------------

export function createPolicyTools(store: PolicyStore): MetaTool[] {
  return [
    policyCreate(store),
    policyList(store),
    policyUpdate(store),
    policyProgress(store),
    policySetStatus(store),
  ];
}

function policyCreate(store: PolicyStore): MetaTool {
  return {
    spec: {
      name: 'policy_create',
      description: 'Create a new strategic policy / long-standing objective. Policies drive the system\'s priorities and are reviewed by the Architect during every planning cycle.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Policy title (e.g. "Grow MRR to €10K by Q3")' },
          description: { type: 'string', description: 'Detailed description of the objective, success criteria, and constraints.' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Priority level' },
        },
        required: ['title', 'description'],
      },
    },
    async handle(input) {
      try {
        const policy = store.create({
          title: input.title as string,
          description: input.description as string,
          priority: input.priority as PolicyPriority | undefined,
        });
        return JSON.stringify({ ok: true, id: policy.id, title: policy.title });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function policyList(store: PolicyStore): MetaTool {
  return {
    spec: {
      name: 'policy_list',
      description: 'List all policies (strategic objectives). Shows active policies by default with their latest progress updates.',
      input_schema: {
        type: 'object' as const,
        properties: {
          all: { type: 'boolean', description: 'Include paused/completed/abandoned policies (default: active only)' },
        },
        required: [],
      },
    },
    async handle(input) {
      const policies = input.all ? store.listAll() : store.listActive();
      return JSON.stringify({
        ok: true,
        count: policies.length,
        policies: policies.map((p) => ({
          id: p.id,
          title: p.title,
          priority: p.priority,
          status: p.status,
          latest_update: p.updates.length > 0 ? p.updates[p.updates.length - 1].body : null,
          updated_at: p.updatedAt,
        })),
      });
    },
  };
}

function policyUpdate(store: PolicyStore): MetaTool {
  return {
    spec: {
      name: 'policy_update',
      description: 'Update a policy\'s title, description, or priority.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Policy ID' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
        required: ['id'],
      },
    },
    async handle(input) {
      try {
        store.update(input.id as string, {
          title: input.title as string | undefined,
          description: input.description as string | undefined,
          priority: input.priority as PolicyPriority | undefined,
        });
        return JSON.stringify({ ok: true, id: input.id });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function policyProgress(store: PolicyStore): MetaTool {
  return {
    spec: {
      name: 'policy_progress',
      description: 'Log a progress update against a policy. Use this to report what\'s been done, what\'s blocked, or what\'s next toward the objective.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Policy ID' },
          update: { type: 'string', description: 'Progress update (what was done, what\'s next, blockers)' },
        },
        required: ['id', 'update'],
      },
    },
    async handle(input) {
      try {
        store.addUpdate(input.id as string, input.update as string);
        return JSON.stringify({ ok: true, id: input.id });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function policySetStatus(store: PolicyStore): MetaTool {
  return {
    spec: {
      name: 'policy_set_status',
      description: 'Change a policy\'s status (active, paused, completed, abandoned).',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Policy ID' },
          status: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'] },
        },
        required: ['id', 'status'],
      },
    },
    async handle(input) {
      try {
        store.setStatus(input.id as string, input.status as PolicyStatus);
        return JSON.stringify({ ok: true, id: input.id, status: input.status });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPolicy(row: PolicyRecord, updates: PolicyUpdateRecord[]): Policy {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updates: updates.map((u) => ({ id: u.id, body: u.body, createdAt: u.created_at })),
  };
}
