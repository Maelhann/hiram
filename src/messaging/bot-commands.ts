import { performance } from 'node:perf_hooks';
import os from 'node:os';
import type { PluginRegistry } from '../tools/registry.js';
import type { WardenRegistry } from '../workers/warden-registry.js';
import type { AgentTracker } from '../workers/agent-tracker.js';
import type { TelemetryCollector } from '../telemetry/collector.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// BotCommands — handles /slash commands from Telegram before they reach the
// Secretary agent loop. Returns formatted text or null for unrecognised cmds.
// ---------------------------------------------------------------------------

export interface BotCommandsDeps {
  pluginRegistry: PluginRegistry;
  wardenRegistry: WardenRegistry;
  tracker: AgentTracker;
  telemetry: TelemetryCollector;
  db: Database.Database;
  version: string;
}

export class BotCommands {
  private bootTime = Date.now();

  constructor(private deps: BotCommandsDeps) {}

  /** Returns a formatted response, or null if the command is unrecognised. */
  async handle(command: string, _args: string): Promise<string | null> {
    switch (command.toLowerCase()) {
      case 'health':
        return this.health();
      case 'report':
        return this.report();
      default:
        return null;
    }
  }

  // -----------------------------------------------------------------------
  // /health — full system health
  // -----------------------------------------------------------------------

  private async health(): Promise<string> {
    const { pluginRegistry, wardenRegistry, tracker, db } = this.deps;
    const lines: string[] = [];
    const flags = { dbOk: true, memWarn: false, pluginWarn: false, wardenWarn: false };

    // -- Database ---------------------------------------------------------
    let dbMs = 0;
    try {
      const t0 = performance.now();
      db.prepare('SELECT 1').get();
      dbMs = Math.round(performance.now() - t0);
    } catch {
      flags.dbOk = false;
    }

    // -- System -----------------------------------------------------------
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (memPercent > 95) flags.memWarn = true;

    const cpu = process.cpuUsage();
    const uptimeMs = Date.now() - this.bootTime;
    const cpuPercent = Math.min(
      100,
      Math.round(((cpu.user + cpu.system) / 1000 / uptimeMs) * 100),
    );

    // -- Plugins ----------------------------------------------------------
    const plugins = pluginRegistry.listWithStatus();
    const pluginsOk = plugins.filter((p) => p.connected).length;
    const pluginsFail = plugins.length - pluginsOk;
    if (pluginsFail > 0) flags.pluginWarn = true;

    // Gather tool counts in parallel (2 s ceiling).
    const toolCounts = new Map<string, number>();
    const countJobs = plugins
      .filter((p) => p.connected)
      .map(async (p) => {
        try {
          const tools = await pluginRegistry.listTools(p.entry.name);
          toolCounts.set(p.entry.name, tools.length);
        } catch {
          toolCounts.set(p.entry.name, -1);
        }
      });
    await Promise.race([
      Promise.all(countJobs),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ]);

    // -- Wardens ----------------------------------------------------------
    const wardens = wardenRegistry.listWithStatus();
    const wardensUp = wardens.filter((w) => w.running).length;
    const wardensDown = wardens.filter((w) => w.config.active && !w.running).length;
    if (wardensDown > 0) flags.wardenWarn = true;

    // -- Overall status ---------------------------------------------------
    const overall: 'healthy' | 'degraded' | 'unhealthy' = !flags.dbOk
      ? 'unhealthy'
      : flags.memWarn || flags.pluginWarn || flags.wardenWarn
        ? 'degraded'
        : 'healthy';
    const icon = overall === 'healthy' ? '🟢' : overall === 'degraded' ? '🟡' : '🔴';
    const label = overall.charAt(0).toUpperCase() + overall.slice(1);

    lines.push('*HIRAM System Health*');
    lines.push('');
    lines.push(`${icon} ${label} | uptime ${fmtDuration(uptimeMs)} | v${this.deps.version}`);
    lines.push('');

    // Core
    lines.push('*Core*');
    lines.push(`${dot(flags.dbOk)} Database — ${dbMs}ms`);
    lines.push(`${dot(memPercent < 80, memPercent < 95)} Memory — ${memPercent}% (${rssMb}MB RSS)`);
    lines.push(`${dot(cpuPercent < 70, cpuPercent < 90)} CPU — ${cpuPercent}%`);
    lines.push(`${dot(true)} Agents — ${tracker.activeCount} running`);
    lines.push('');

    // Plugins
    lines.push(`*Plugins (${pluginsOk}/${plugins.length})*`);
    for (const p of plugins) {
      if (p.connected) {
        const n = toolCounts.get(p.entry.name);
        const suffix = n != null && n >= 0 ? `${n} tools` : 'connected';
        lines.push(`🟢 ${p.entry.name} — ${suffix}`);
      } else {
        lines.push(`🔴 ${p.entry.name} — disconnected`);
      }
    }
    lines.push('');

    // Wardens
    lines.push(`*Wardens (${wardensUp}/${wardens.length})*`);
    for (const w of wardens) {
      if (!w.config.active) {
        lines.push(`🔴 ${w.config.name} — inactive`);
      } else if (!w.running) {
        lines.push(`🔴 ${w.config.name} — stopped`);
      } else if (w.busy) {
        const q = w.queueDepth > 0 ? ` (+${w.queueDepth} queued)` : '';
        const tickets = w.activeTickets.length > 0 ? w.activeTickets.join(', ') : 'busy';
        lines.push(`🟡 ${w.config.name} — ${w.concurrentTickets} active: ${tickets}${q}`);
      } else if (w.queueDepth > 0) {
        lines.push(`🟡 ${w.config.name} — ${w.queueDepth} queued`);
      } else {
        lines.push(`🟢 ${w.config.name} — idle`);
      }
    }

    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // /report — current work and metrics
  // -----------------------------------------------------------------------

  private async report(): Promise<string> {
    const { tracker, wardenRegistry, telemetry } = this.deps;
    const lines: string[] = [];
    const metrics = telemetry.getAll();

    lines.push('*HIRAM Activity Report*');
    lines.push('');

    // Active agents
    const running = tracker.running();
    lines.push(`*Active Agents (${running.length})*`);
    if (running.length === 0) {
      lines.push('All quiet on the western front.');
    } else {
      for (const a of running) {
        const dur = fmtDuration(a.durationMs);
        const ticket = a.ticketKey ? ` ${a.ticketKey}` : '';
        const label = a.label ? ` (${a.label})` : '';
        lines.push(`  ${a.type}${ticket}${label} — ${dur}`);
      }
    }
    lines.push('');

    // Wardens
    const wardens = wardenRegistry.listWithStatus().filter((w) => w.config.active);
    lines.push('*Wardens*');
    for (const w of wardens) {
      if (w.busy) {
        const q = w.queueDepth > 0 ? ` (queue: ${w.queueDepth})` : '';
        const tickets = w.activeTickets.join(', ') || 'busy';
        lines.push(`  ${w.config.name}: ${w.concurrentTickets} active [${tickets}]${q}`);
      } else {
        lines.push(`  ${w.config.name}: idle`);
      }
    }
    lines.push('');

    // Metrics
    lines.push('*Metrics*');
    const apiCalls = num(metrics['api.calls']);
    const tokensIn = num(metrics['api.tokens_in']);
    const tokensOut = num(metrics['api.tokens_out']);
    const pluginCalls = num(metrics['plugin.calls']);
    const errors = num(metrics['api.errors']);

    lines.push(`  API calls: ${fmtNum(apiCalls)}`);
    lines.push(`  Tokens: ${fmtNum(tokensIn)} in / ${fmtNum(tokensOut)} out`);
    lines.push(`  Plugin calls: ${fmtNum(pluginCalls)}`);
    if (errors > 0) lines.push(`  Errors: ${errors}`);
    lines.push('');

    // Recent completions
    const all = tracker.all();
    const finished = all
      .filter((a) => a.status !== 'running')
      .sort((a, b) => b.startedAt + b.durationMs - (a.startedAt + a.durationMs))
      .slice(0, 5);

    if (finished.length > 0) {
      lines.push('*Recent*');
      for (const a of finished) {
        const endedAt = a.startedAt + a.durationMs;
        const ago = fmtDuration(Date.now() - endedAt) + ' ago';
        const ticket = a.ticketKey ? `${a.ticketKey} — ` : '';
        const lbl = a.label ? ` (${a.label})` : '';
        const ic =
          a.status === 'completed' ? '🟢' : a.status === 'failed' ? '🔴' : '🟡';
        lines.push(`  ${ic} ${ticket}${a.status}${lbl} — ${ago}`);
      }
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 🟢/🟡/🔴 dot. Pass one bool for green/red, two for green/yellow/red. */
function dot(good: boolean, acceptable?: boolean): string {
  if (good) return '🟢';
  if (acceptable === undefined) return '🔴';
  return acceptable ? '🟡' : '🔴';
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
