import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { TelemetryCollector } from '../../src/telemetry/collector.js';

describe('TelemetryCollector', () => {
  let db: Database.Database;
  let tel: TelemetryCollector;

  beforeEach(() => {
    db = initDatabase(':memory:');
    tel = new TelemetryCollector(db);
  });

  it('should increment counters', () => {
    tel.inc('api.calls');
    tel.inc('api.calls');
    tel.inc('api.calls', 5);
    expect(tel.getCounter('api.calls')).toBe(7);
  });

  it('should record and compute histogram percentiles', () => {
    for (let i = 1; i <= 100; i++) {
      tel.record('api.latency_ms', i);
    }

    const all = tel.getAll();
    const hist = all['api.latency_ms'] as Record<string, number>;
    expect(hist.count).toBe(100);
    expect(hist.min).toBe(1);
    expect(hist.max).toBe(100);
    expect(hist.p50).toBe(50);
    expect(hist.p95).toBe(95);
    expect(hist.p99).toBe(99);
  });

  it('should set and read gauges', () => {
    tel.gauge('warden.dev.queue_depth', 5);
    const all = tel.getAll();
    expect(all['warden.dev.queue_depth']).toBe(5);
  });

  it('should filter by category', () => {
    tel.inc('api.calls', 10);
    tel.inc('webhook.events', 5);
    tel.gauge('system.memory_mb', 512);

    const apiOnly = tel.getAll('api');
    expect(apiOnly['api.calls']).toBe(10);
    expect(apiOnly['webhook.events']).toBeUndefined();

    const webhookOnly = tel.getAll('webhook');
    expect(webhookOnly['webhook.events']).toBe(5);
    expect(webhookOnly['api.calls']).toBeUndefined();
  });

  it('should flush to SQLite and restore on new instance', () => {
    tel.inc('api.calls', 42);
    tel.inc('api.tokens_in', 100_000);
    tel.gauge('system.uptime_s', 7200);

    // Manually trigger flush (normally on interval).
    (tel as any).flush();

    // Create a new collector from the same DB — should restore.
    const tel2 = new TelemetryCollector(db);
    expect(tel2.getCounter('api.calls')).toBe(42);
    expect(tel2.getCounter('api.tokens_in')).toBe(100_000);
  });

  it('should produce a summary string', () => {
    tel.inc('api.calls', 5);
    tel.record('api.latency_ms', 100);
    const summary = tel.summary();
    expect(summary).toContain('api.calls');
    expect(summary).toContain('api.latency_ms');
  });

  it('should handle histogram window overflow', () => {
    // Record 200 values — window is 100, should keep last 100.
    for (let i = 0; i < 200; i++) {
      tel.record('test.hist', i);
    }

    const all = tel.getAll();
    const hist = all['test.hist'] as Record<string, number>;
    expect(hist.count).toBe(100);
    expect(hist.min).toBe(100); // first 100 values were evicted
  });

  it('should include system metrics', () => {
    const all = tel.getAll();
    expect(all['system.uptime_s']).toBeDefined();
    expect(all['system.memory_rss_mb']).toBeDefined();
    expect(all['system.memory_heap_mb']).toBeDefined();
  });
});
