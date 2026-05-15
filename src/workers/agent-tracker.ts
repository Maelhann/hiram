import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// AgentTracker — centralized lifecycle tracking for all running agents.
//
// Every agent run (architect, warden, worker) gets a unique ID, an
// AbortController for cancellation, and state tracking. The Supervisor and
// CLI use the tracker to list running agents, kill stuck ones, and enforce
// wall-clock timeouts.
// ---------------------------------------------------------------------------

export type TrackedAgentType = 'architect' | 'warden' | 'worker';
export type TrackedAgentStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timeout';

export interface TrackedAgent {
  id: string;
  type: TrackedAgentType;
  label?: string;        // warden label or worker type
  ticketKey?: string;
  startedAt: number;     // Date.now()
  status: TrackedAgentStatus;
  endedAt?: number;
  error?: string;
  abortController: AbortController;
}

/** Snapshot returned to callers (no AbortController exposed). */
export interface AgentSnapshot {
  id: string;
  type: TrackedAgentType;
  label?: string;
  ticketKey?: string;
  startedAt: number;
  status: TrackedAgentStatus;
  durationMs: number;
  error?: string;
}

export class AgentTracker {
  private agents = new Map<string, TrackedAgent>();

  /** Register a new agent run. Returns the agent ID and AbortController signal. */
  register(opts: {
    type: TrackedAgentType;
    label?: string;
    ticketKey?: string;
  }): { id: string; signal: AbortSignal; abort: () => void } {
    const id = crypto.randomUUID();
    const ac = new AbortController();

    this.agents.set(id, {
      id,
      type: opts.type,
      label: opts.label,
      ticketKey: opts.ticketKey,
      startedAt: Date.now(),
      status: 'running',
      abortController: ac,
    });

    return {
      id,
      signal: ac.signal,
      abort: () => this.kill(id),
    };
  }

  /** Mark an agent as completed. */
  complete(id: string): void {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return;
    agent.status = 'completed';
    agent.endedAt = Date.now();
  }

  /** Mark an agent as failed. */
  fail(id: string, error?: string): void {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return;
    agent.status = 'failed';
    agent.endedAt = Date.now();
    agent.error = error;
  }

  /** Kill a running agent by aborting its signal. */
  kill(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return false;
    agent.abortController.abort();
    agent.status = 'killed';
    agent.endedAt = Date.now();
    return true;
  }

  /** Mark an agent as timed out (a specific kind of kill). */
  timeout(id: string): void {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return;
    agent.abortController.abort();
    agent.status = 'timeout';
    agent.endedAt = Date.now();
  }

  /** List all currently running agents. */
  running(): AgentSnapshot[] {
    return this.snapshot((a) => a.status === 'running');
  }

  /** List all tracked agents (including finished). */
  all(): AgentSnapshot[] {
    return this.snapshot();
  }

  /** Get a single agent by ID. */
  get(id: string): AgentSnapshot | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    return toSnapshot(agent);
  }

  /** Kill all running agents. Used during daemon shutdown. */
  killAll(): number {
    let killed = 0;
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') {
        agent.abortController.abort();
        agent.status = 'killed';
        agent.endedAt = Date.now();
        killed++;
      }
    }
    return killed;
  }

  /** Prune finished agents older than maxAge (default 1 hour). */
  prune(maxAgeMs = 3_600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, agent] of this.agents) {
      if (agent.status !== 'running' && (agent.endedAt ?? 0) < cutoff) {
        this.agents.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /** Count of currently running agents. */
  get activeCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') count++;
    }
    return count;
  }

  private snapshot(filter?: (a: TrackedAgent) => boolean): AgentSnapshot[] {
    const results: AgentSnapshot[] = [];
    for (const agent of this.agents.values()) {
      if (!filter || filter(agent)) {
        results.push(toSnapshot(agent));
      }
    }
    return results.sort((a, b) => a.startedAt - b.startedAt);
  }
}

function toSnapshot(agent: TrackedAgent): AgentSnapshot {
  return {
    id: agent.id,
    type: agent.type,
    label: agent.label,
    ticketKey: agent.ticketKey,
    startedAt: agent.startedAt,
    status: agent.status,
    durationMs: (agent.endedAt ?? Date.now()) - agent.startedAt,
    error: agent.error,
  };
}
