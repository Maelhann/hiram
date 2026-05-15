import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// TranscriptRecorder — captures every API call, tool execution, and event
// delivery during E2E tests for post-run audit.
//
// Persists to SQLite (same DB as the daemon). Exports to JSON files.
// Opt-in via AgentDeps.transcriptRecorder — zero overhead when absent.
// ---------------------------------------------------------------------------

export interface ApiCallRecord {
  agentType: string;
  ticketKey?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string;
  toolCallsRequested: string[];
  turnIndex: number;
  latencyMs: number;
}

export interface ToolExecRecord {
  agentType: string;
  ticketKey?: string;
  toolName: string;
  input: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface EventDeliveryRecord {
  listenerName: string;
  targets: string[];
  deliveryStatus: Record<string, string>;
  eventId: string;
}

const MAX_FIELD_SIZE = 10_240; // 10KB truncation for input/result

function truncate(s: string): string {
  return s.length > MAX_FIELD_SIZE ? s.slice(0, MAX_FIELD_SIZE) + '…[truncated]' : s;
}

export class TranscriptRecorder {
  constructor(private db: Database.Database) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS e2e_api_calls (
        id                  TEXT PRIMARY KEY,
        timestamp           TEXT NOT NULL DEFAULT (datetime('now')),
        agent_type          TEXT NOT NULL,
        ticket_key          TEXT,
        model               TEXT NOT NULL,
        input_tokens        INTEGER NOT NULL,
        output_tokens       INTEGER NOT NULL,
        cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
        stop_reason         TEXT NOT NULL,
        tool_calls_requested TEXT NOT NULL DEFAULT '[]',
        turn_index          INTEGER NOT NULL,
        latency_ms          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS e2e_tool_execs (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
        agent_type  TEXT NOT NULL,
        ticket_key  TEXT,
        tool_name   TEXT NOT NULL,
        input       TEXT NOT NULL,
        result      TEXT NOT NULL,
        is_error    INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS e2e_events (
        id              TEXT PRIMARY KEY,
        timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
        listener_name   TEXT NOT NULL,
        targets         TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        event_id        TEXT NOT NULL
      );
    `);
  }

  recordApiCall(record: ApiCallRecord): void {
    try {
      this.db.prepare(
        `INSERT INTO e2e_api_calls (id, agent_type, ticket_key, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, stop_reason, tool_calls_requested, turn_index, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(), record.agentType, record.ticketKey ?? null,
        record.model, record.inputTokens, record.outputTokens,
        record.cacheReadTokens, record.cacheWriteTokens,
        record.stopReason, JSON.stringify(record.toolCallsRequested),
        record.turnIndex, record.latencyMs,
      );
    } catch { /* never block the agent loop */ }
  }

  recordToolExec(record: ToolExecRecord): void {
    try {
      this.db.prepare(
        `INSERT INTO e2e_tool_execs (id, agent_type, ticket_key, tool_name, input, result, is_error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(), record.agentType, record.ticketKey ?? null,
        record.toolName, truncate(record.input), truncate(record.result),
        record.isError ? 1 : 0, record.durationMs,
      );
    } catch { /* never block the agent loop */ }
  }

  recordEvent(record: EventDeliveryRecord): void {
    try {
      this.db.prepare(
        `INSERT INTO e2e_events (id, listener_name, targets, delivery_status, event_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(), record.listenerName,
        JSON.stringify(record.targets), JSON.stringify(record.deliveryStatus),
        record.eventId,
      );
    } catch { /* never block */ }
  }

  getSummary(): {
    apiCalls: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCacheRead: number;
    toolExecutions: number;
    toolErrors: number;
    events: number;
    estimatedCostUsd: number;
    perAgent: Record<string, { apiCalls: number; tokensIn: number; tokensOut: number }>;
  } {
    const api = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(input_tokens),0) as tin, COALESCE(SUM(output_tokens),0) as tout,
       COALESCE(SUM(cache_read_tokens),0) as cread FROM e2e_api_calls`,
    ).get() as { count: number; tin: number; tout: number; cread: number };

    const tools = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(is_error),0) as errors FROM e2e_tool_execs`,
    ).get() as { count: number; errors: number };

    const events = this.db.prepare(`SELECT COUNT(*) as count FROM e2e_events`).get() as { count: number };

    // Per-agent breakdown.
    const perAgent: Record<string, { apiCalls: number; tokensIn: number; tokensOut: number }> = {};
    const rows = this.db.prepare(
      `SELECT agent_type, COUNT(*) as calls, SUM(input_tokens) as tin, SUM(output_tokens) as tout
       FROM e2e_api_calls GROUP BY agent_type`,
    ).all() as { agent_type: string; calls: number; tin: number; tout: number }[];
    for (const row of rows) {
      perAgent[row.agent_type] = { apiCalls: row.calls, tokensIn: row.tin, tokensOut: row.tout };
    }

    // Rough cost estimate: Sonnet input $3/M, output $15/M, cache read $0.30/M.
    const costIn = (api.tin / 1_000_000) * 3;
    const costOut = (api.tout / 1_000_000) * 15;
    const costCache = (api.cread / 1_000_000) * 0.30;

    return {
      apiCalls: api.count,
      totalTokensIn: api.tin,
      totalTokensOut: api.tout,
      totalCacheRead: api.cread,
      toolExecutions: tools.count,
      toolErrors: tools.errors,
      events: events.count,
      estimatedCostUsd: costIn + costOut + costCache,
      perAgent,
    };
  }

  exportJson(testName: string, outputDir: string): void {
    const dir = path.join(outputDir, testName);
    fs.mkdirSync(dir, { recursive: true });

    const apiCalls = this.db.prepare(`SELECT * FROM e2e_api_calls ORDER BY timestamp`).all();
    fs.writeFileSync(path.join(dir, 'api-calls.json'), JSON.stringify(apiCalls, null, 2));

    const toolExecs = this.db.prepare(`SELECT * FROM e2e_tool_execs ORDER BY timestamp`).all();
    fs.writeFileSync(path.join(dir, 'tool-execs.json'), JSON.stringify(toolExecs, null, 2));

    const events = this.db.prepare(`SELECT * FROM e2e_events ORDER BY timestamp`).all();
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events, null, 2));

    const summary = this.getSummary();
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
      testName,
      exportedAt: new Date().toISOString(),
      ...summary,
    }, null, 2));

    console.log(`Transcript exported to ${dir}/`);
  }
}
