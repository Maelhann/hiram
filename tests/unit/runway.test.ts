import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { runToolRunway } from '../../src/tools/runway.js';
import { PluginRegistry } from '../../src/tools/registry.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Minimal mock registry that simulates connected plugins with invoke behavior.
class RunwayTestRegistry extends PluginRegistry {
  private mockInvokes = new Map<string, (tool: string, args: Record<string, unknown>) => string>();

  override async start() {}
  override async stop() {}

  mockPlugin(name: string, handler: (tool: string, args: Record<string, unknown>) => string): void {
    this.mockInvokes.set(name, handler);
    // Insert into DB so list() returns it.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    (this as any).db.prepare(
      `INSERT INTO plugins (id, name, description, kind, transport, config, tags, active, created_by, created_at, updated_at)
       VALUES (?, ?, '', 'installed', 'stdio', '{}', '[]', 1, 'test', ?, ?)`,
    ).run(id, name, now, now);
  }

  override listWithStatus() {
    return this.list().map((entry) => ({
      entry,
      connected: this.mockInvokes.has(entry.name),
    }));
  }

  override async invoke(pluginName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const handler = this.mockInvokes.get(pluginName);
    if (!handler) throw new Error(`Plugin not connected: ${pluginName}`);
    return handler(toolName, args);
  }
}

describe('Tool Runway', () => {
  let db: Database.Database;
  let registry: RunwayTestRegistry;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiram-runway-test-'));
    db = initDatabase(':memory:');
    registry = new RunwayTestRegistry(db, tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should pass for healthy plugins', async () => {
    registry.mockPlugin('developer-tools', (tool) => {
      if (tool === 'shell_exec') return JSON.stringify({ ok: true, output: 'hiram-runway-ok' });
      return '{}';
    });
    registry.mockPlugin('stripe', () => JSON.stringify({ ok: true, data: { available: [{ amount: 1000 }] } }));

    const results = await runToolRunway(registry);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    expect(results[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should fail for broken plugins without stopping', async () => {
    registry.mockPlugin('developer-tools', () => { throw new Error('Connection refused'); });
    registry.mockPlugin('stripe', () => JSON.stringify({ ok: true }));

    const results = await runToolRunway(registry);
    expect(results.length).toBe(2);

    const devTools = results.find((r) => r.plugin === 'developer-tools');
    expect(devTools?.status).toBe('fail');
    expect(devTools?.error).toContain('Connection refused');

    const stripe = results.find((r) => r.plugin === 'stripe');
    expect(stripe?.status).toBe('pass');
  });

  it('should skip plugins without a probe defined', async () => {
    registry.mockPlugin('unknown-plugin', () => '{}');

    const results = await runToolRunway(registry);
    const unknown = results.find((r) => r.plugin === 'unknown-plugin');
    expect(unknown?.status).toBe('skip');
  });

  it('should only test connected plugins', async () => {
    // Insert a plugin into DB but don't mock it (not connected).
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO plugins (id, name, description, kind, transport, config, tags, active, created_by, created_at, updated_at)
       VALUES (?, 'disconnected-plugin', '', 'installed', 'stdio', '{}', '[]', 1, 'test', ?, ?)`,
    ).run(id, now, now);

    const results = await runToolRunway(registry);
    expect(results.find((r) => r.plugin === 'disconnected-plugin')).toBeUndefined();
  });

  it('should measure latency', async () => {
    registry.mockPlugin('developer-tools', async () => {
      await new Promise((r) => setTimeout(r, 50));
      return JSON.stringify({ ok: true });
    });

    const results = await runToolRunway(registry);
    const devTools = results.find((r) => r.plugin === 'developer-tools');
    expect(devTools?.latencyMs).toBeGreaterThanOrEqual(40);
  });

  it('should be neutral — no state changes', async () => {
    let invokeCount = 0;
    registry.mockPlugin('stripe', (tool, args) => {
      invokeCount++;
      // Verify it's calling a read-only tool.
      expect(tool).toBe('retrieve_balance');
      expect(args).toEqual({});
      return JSON.stringify({ ok: true });
    });

    await runToolRunway(registry);
    expect(invokeCount).toBe(1); // Called exactly once — no retries, no writes.
  });
});
