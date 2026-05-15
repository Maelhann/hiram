import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { TelemetryCollector } from '../../src/telemetry/collector.js';

describe('Prometheus exposition format', () => {
  let db: Database.Database;
  let tel: TelemetryCollector;

  beforeEach(() => {
    db = initDatabase(':memory:');
    tel = new TelemetryCollector(db);
  });

  it('should output valid Prometheus format for counters', () => {
    tel.inc('api.calls', 42);
    tel.inc('api.errors', 3);

    const output = tel.toPrometheus();
    expect(output).toContain('# TYPE hiram_api_calls counter');
    expect(output).toContain('hiram_api_calls 42');
    expect(output).toContain('# TYPE hiram_api_errors counter');
    expect(output).toContain('hiram_api_errors 3');
  });

  it('should output valid Prometheus format for gauges', () => {
    tel.gauge('warden.dev.queue_depth', 5);

    const output = tel.toPrometheus();
    expect(output).toContain('# TYPE hiram_warden_dev_queue_depth gauge');
    expect(output).toContain('hiram_warden_dev_queue_depth 5');
  });

  it('should output valid Prometheus summary format for histograms', () => {
    for (let i = 1; i <= 100; i++) {
      tel.record('api.latency_ms', i);
    }

    const output = tel.toPrometheus();
    expect(output).toContain('# TYPE hiram_api_latency_ms summary');
    expect(output).toContain('hiram_api_latency_ms{quantile="0.5"} 50');
    expect(output).toContain('hiram_api_latency_ms{quantile="0.95"} 95');
    expect(output).toContain('hiram_api_latency_ms{quantile="0.99"} 99');
    expect(output).toContain('hiram_api_latency_ms_sum 5050');
    expect(output).toContain('hiram_api_latency_ms_count 100');
  });

  it('should include system metrics automatically', () => {
    const output = tel.toPrometheus();
    expect(output).toContain('hiram_system_uptime_s');
    expect(output).toContain('hiram_system_memory_rss_mb');
    expect(output).toContain('hiram_system_memory_heap_mb');
  });

  it('should convert dots and hyphens to underscores in metric names', () => {
    tel.inc('plugin.atlassian.create-issue.calls', 10);

    const output = tel.toPrometheus();
    expect(output).toContain('hiram_plugin_atlassian_create_issue_calls 10');
    // No dots or hyphens in metric names.
    expect(output).not.toMatch(/hiram_[^\s]*\./);
  });

  it('should prefix all metrics with hiram_', () => {
    tel.inc('api.calls', 1);
    tel.gauge('warden.queue', 2);
    tel.record('worker.duration_ms', 100);

    const output = tel.toPrometheus();
    const metricLines = output.split('\n').filter((l) => !l.startsWith('#') && l.trim());
    for (const line of metricLines) {
      expect(line).toMatch(/^hiram_/);
    }
  });

  it('should end with a newline', () => {
    tel.inc('api.calls', 1);
    const output = tel.toPrometheus();
    expect(output.endsWith('\n')).toBe(true);
  });

  it('should handle empty state', () => {
    const output = tel.toPrometheus();
    // Should still have system gauges.
    expect(output).toContain('hiram_system_uptime_s');
    // Should be parseable (no errors).
    expect(output.length).toBeGreaterThan(0);
  });

  it('should handle special characters in metric keys', () => {
    tel.inc('plugin.google-workspace.send_email.calls', 5);
    const output = tel.toPrometheus();
    // Hyphens replaced, result is valid Prometheus name.
    expect(output).toContain('hiram_plugin_google_workspace_send_email_calls 5');
  });
});
