import type Database from 'better-sqlite3';
import type { MetaTool } from '../tools/meta-tools.js';

// ---------------------------------------------------------------------------
// TelemetryCollector — centralized metrics for the entire HIRAM system.
//
// In-memory counters, gauges, and histograms. Flushed to SQLite every 60s
// for persistence across restarts. Exposed via HTTP and a meta-tool.
// ---------------------------------------------------------------------------

const HISTOGRAM_WINDOW = 100; // keep last N values for percentile calculation
const FLUSH_INTERVAL = 60_000; // flush to SQLite every 60s

export class TelemetryCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();

  constructor(private db: Database.Database) {
    this.restore();
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /** Increment a counter. */
  inc(key: string, amount = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  /** Set a gauge to a point-in-time value. */
  gauge(key: string, value: number): void {
    this.gauges.set(key, value);
  }

  /** Record a value in a histogram (e.g. latency). */
  record(key: string, value: number): void {
    let arr = this.histograms.get(key);
    if (!arr) {
      arr = [];
      this.histograms.set(key, arr);
    }
    arr.push(value);
    // Keep only the last N values.
    if (arr.length > HISTOGRAM_WINDOW) {
      arr.splice(0, arr.length - HISTOGRAM_WINDOW);
    }
  }

  // -----------------------------------------------------------------------
  // Querying
  // -----------------------------------------------------------------------

  /** Get all metrics as a structured object. */
  getAll(category?: string): Record<string, unknown> {
    // Update system gauges.
    this.gauge('system.uptime_s', Math.floor((Date.now() - this.startTime) / 1000));
    const mem = process.memoryUsage();
    this.gauge('system.memory_rss_mb', Math.round(mem.rss / 1024 / 1024));
    this.gauge('system.memory_heap_mb', Math.round(mem.heapUsed / 1024 / 1024));

    const result: Record<string, unknown> = {};

    // Counters.
    for (const [key, value] of this.counters) {
      if (category && !key.startsWith(category)) continue;
      result[key] = value;
    }

    // Gauges.
    for (const [key, value] of this.gauges) {
      if (category && !key.startsWith(category)) continue;
      result[key] = value;
    }

    // Histograms — compute percentiles.
    for (const [key, values] of this.histograms) {
      if (category && !key.startsWith(category)) continue;
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      result[key] = {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      };
    }

    return result;
  }

  /** Get a single counter value. */
  getCounter(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /** Get a summary string for logging. */
  summary(): string {
    const m = this.getAll();
    const lines = ['=== Telemetry Summary ==='];
    for (const [key, value] of Object.entries(m).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof value === 'object') {
        const h = value as Record<string, number>;
        lines.push(`  ${key}: avg=${h.avg}ms p50=${h.p50}ms p95=${h.p95}ms p99=${h.p99}ms (${h.count} samples)`);
      } else {
        lines.push(`  ${key}: ${value}`);
      }
    }
    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private flush(): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO telemetry (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );

    const tx = this.db.transaction(() => {
      for (const [key, value] of this.counters) {
        upsert.run(key, value, now);
      }
      for (const [key, value] of this.gauges) {
        upsert.run(`gauge.${key}`, value, now);
      }
    });
    tx();
  }

  private restore(): void {
    try {
      const rows = this.db
        .prepare(`SELECT key, value FROM telemetry`)
        .all() as { key: string; value: number }[];

      for (const row of rows) {
        if (row.key.startsWith('gauge.')) {
          this.gauges.set(row.key.slice(6), row.value);
        } else {
          this.counters.set(row.key, row.value);
        }
      }
    } catch {
      // Table might not exist yet on first boot.
    }
  }

  // -----------------------------------------------------------------------
  // HTTP handler — for GET /metrics
  // -----------------------------------------------------------------------

  handleMetricsRequest(url: URL): string {
    const category = url.searchParams.get('category') ?? undefined;
    return JSON.stringify(this.getAll(category), null, 2);
  }

  // -----------------------------------------------------------------------
  // Prometheus exposition format — for /metrics/prometheus
  // -----------------------------------------------------------------------

  toPrometheus(): string {
    // Refresh system gauges.
    this.gauge('system.uptime_s', Math.floor((Date.now() - this.startTime) / 1000));
    const mem = process.memoryUsage();
    this.gauge('system.memory_rss_mb', Math.round(mem.rss / 1024 / 1024));
    this.gauge('system.memory_heap_mb', Math.round(mem.heapUsed / 1024 / 1024));

    const lines: string[] = [];

    // Counters.
    for (const [key, value] of this.counters) {
      const name = prometheusName(key);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }

    // Gauges.
    for (const [key, value] of this.gauges) {
      const name = prometheusName(key);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }

    // Histograms → summary with quantiles.
    for (const [key, values] of this.histograms) {
      if (values.length === 0) continue;
      const name = prometheusName(key);
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);

      lines.push(`# TYPE ${name} summary`);
      lines.push(`${name}{quantile="0.5"} ${percentile(sorted, 50)}`);
      lines.push(`${name}{quantile="0.95"} ${percentile(sorted, 95)}`);
      lines.push(`${name}{quantile="0.99"} ${percentile(sorted, 99)}`);
      lines.push(`${name}_sum ${sum}`);
      lines.push(`${name}_count ${sorted.length}`);
    }

    return lines.join('\n') + '\n';
  }
}

// ---------------------------------------------------------------------------
// Meta-tool — get_metrics
// ---------------------------------------------------------------------------

export function createMetricsTool(collector: TelemetryCollector): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'get_metrics',
      description: 'Get system telemetry metrics. Returns token usage, API latency, tool call counts, error rates, queue depths, and system health. Optionally filter by category: "api", "plugin", "webhook", "worker", "warden", "system".',
      input_schema: {
        type: 'object' as const,
        properties: {
          category: { type: 'string', description: 'Optional category filter (e.g. "api", "plugin", "worker")' },
        },
        required: [],
      },
    },
    async handle(input) {
      const metrics = collector.getAll(input.category as string | undefined);
      return JSON.stringify({ ok: true, metrics });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Convert a dot-separated metric key to a valid Prometheus metric name. */
function prometheusName(key: string): string {
  return 'hiram_' + key.replace(/[.\-]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}
