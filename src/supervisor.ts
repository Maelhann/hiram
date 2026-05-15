import type { Architect } from './workers/architect.js';
import type { AgentTracker, AgentSnapshot } from './workers/agent-tracker.js';
import type { TelemetryCollector } from './telemetry/collector.js';

// ---------------------------------------------------------------------------
// Supervisor — operational control plane for the HIRAM daemon.
//
// Provides agent lifecycle management, status reporting, and the interface
// used by the CLI server. Holds references to the AgentTracker, Architect,
// and TelemetryCollector.
// ---------------------------------------------------------------------------

export interface SupervisorDeps {
  architect: Architect;
  tracker: AgentTracker;
  telemetry?: TelemetryCollector;
}

export class Supervisor {
  private architect: Architect;
  private tracker: AgentTracker;
  private telemetry?: TelemetryCollector;
  private pruneInterval: ReturnType<typeof setInterval> | undefined;

  constructor(deps: SupervisorDeps) {
    this.architect = deps.architect;
    this.tracker = deps.tracker;
    this.telemetry = deps.telemetry;
  }

  async start(): Promise<void> {
    // Periodically prune finished agent records (every 30 minutes).
    this.pruneInterval = setInterval(() => {
      const pruned = this.tracker.prune();
      if (pruned > 0) {
        console.log(`[Supervisor] Pruned ${pruned} finished agent record(s).`);
      }
    }, 30 * 60_000);
    this.pruneInterval.unref();
  }

  async stop(): Promise<void> {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = undefined;
    }

    // Kill all running agents.
    const killed = this.tracker.killAll();
    if (killed > 0) {
      console.log(`[Supervisor] Killed ${killed} running agent(s) during shutdown.`);
    }
  }

  // -----------------------------------------------------------------------
  // Status & reporting
  // -----------------------------------------------------------------------

  /** Get a snapshot of all running agents. */
  status(): { agents: AgentSnapshot[]; activeCount: number } {
    return {
      agents: this.tracker.running(),
      activeCount: this.tracker.activeCount,
    };
  }

  /** Get full agent history (including finished). */
  history(): AgentSnapshot[] {
    return this.tracker.all();
  }

  /** Get metrics from telemetry. */
  getMetrics(category?: string): Record<string, unknown> {
    if (!this.telemetry) return {};
    return this.telemetry.getAll(category);
  }

  // -----------------------------------------------------------------------
  // Agent control
  // -----------------------------------------------------------------------

  /** Kill a specific running agent by ID. */
  kill(agentId: string): boolean {
    const killed = this.tracker.kill(agentId);
    if (killed) {
      console.log(`[Supervisor] Killed agent ${agentId}`);
      this.telemetry?.inc('supervisor.kills');
    }
    return killed;
  }

  /** Send a message/instruction to the Architect. */
  async handleMessage(message: string): Promise<string> {
    return this.architect.handleInstruction(message);
  }

  /** Trigger the Architect's daily planning cycle. */
  async runDailyPlanning(): Promise<void> {
    await this.architect.reviewBoard();
  }

  /** Get the agent tracker (for direct use by daemon/warden code). */
  getTracker(): AgentTracker {
    return this.tracker;
  }
}
