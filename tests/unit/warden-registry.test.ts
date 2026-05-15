import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { WardenRegistry } from '../../src/workers/warden-registry.js';
import { WebhookServer } from '../../src/jira/webhook-server.js';
import { Vault } from '../../src/secrets/vault.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import type { AgentDeps } from '../../src/workers/base-agent.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock registry that doesn't start MCP servers.
class MockPluginRegistryForWardenTest {
  async start() {}
  async stop() {}
  async invoke() { return '{}'; }
  async listTools() { return []; }
  getByName() { return undefined; }
  list() { return []; }
  search() { return []; }
  listWithStatus() { return []; }
  async createCustom() { return {} as any; }
  async install() { return {} as any; }
  async updateCustom() { return {} as any; }
  async remove() {}
  async readSource() { return ''; }
  setTelemetry() {}
}

describe('WardenRegistry persistence', () => {
  let db: Database.Database;
  let webhooks: WebhookServer;
  let tmpDir: string;

  function makeDeps(): AgentDeps {
    return {
      apiKey: 'test-key',
      registry: new MockPluginRegistryForWardenTest() as any,
      vault: new Vault(db, 'test-master'),
      knowledge: new KnowledgeStore(db, new Vault(db, 'test-master')),
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiram-warden-test-'));
    db = initDatabase(':memory:');
    webhooks = new WebhookServer(0);
    await webhooks.start();
  });

  afterEach(async () => {
    await webhooks.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should persist wardens to SQLite', async () => {
    const registry = new WardenRegistry(db, makeDeps(), webhooks);

    await registry.create({ name: 'Dev Warden', label: 'warden:dev', wardenPrompt: 'You handle development.' });
    await registry.create({ name: 'Ops Warden', label: 'warden:ops', wardenPrompt: 'You handle operations.' });

    // Query SQLite directly.
    const rows = db.prepare('SELECT * FROM wardens ORDER BY name').all() as { name: string; label: string; active: number }[];
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe('Dev Warden');
    expect(rows[1].name).toBe('Ops Warden');
    expect(rows[0].active).toBe(1);
  });

  it('should load wardens from SQLite on start', async () => {
    // Insert directly into DB (simulating previous boot).
    db.prepare(
      `INSERT INTO wardens (id, name, label, warden_prompt, active, created_at, updated_at)
       VALUES ('id1', 'Persisted Warden', 'warden:test', 'test prompt', 1, datetime('now'), datetime('now'))`,
    ).run();

    const registry = new WardenRegistry(db, makeDeps(), webhooks);
    const all = registry.listAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Persisted Warden');
    expect(all[0].label).toBe('warden:test');
  });

  it('should deactivate wardens', async () => {
    const registry = new WardenRegistry(db, makeDeps(), webhooks);
    await registry.create({ name: 'Temp Warden', label: 'warden:temp', wardenPrompt: 'temporary' });

    registry.deactivate('warden:temp');

    const config = registry.getByLabel('warden:temp');
    expect(config?.active).toBe(false);

    // Verify in DB.
    const row = db.prepare('SELECT active FROM wardens WHERE label = ?').get('warden:temp') as { active: number };
    expect(row.active).toBe(0);
  });

  it('should reactivate wardens', async () => {
    const registry = new WardenRegistry(db, makeDeps(), webhooks);
    await registry.create({ name: 'Toggle Warden', label: 'warden:toggle', wardenPrompt: 'toggle test' });

    registry.deactivate('warden:toggle');
    expect(registry.getByLabel('warden:toggle')?.active).toBe(false);

    await registry.activate('warden:toggle');
    expect(registry.getByLabel('warden:toggle')?.active).toBe(true);
  });

  it('should update warden prompts', async () => {
    const registry = new WardenRegistry(db, makeDeps(), webhooks);
    await registry.create({ name: 'Updatable', label: 'warden:update', wardenPrompt: 'original prompt' });

    await registry.update('warden:update', { wardenPrompt: 'updated prompt', name: 'Updated Warden' });

    const config = registry.getByLabel('warden:update');
    expect(config?.wardenPrompt).toBe('updated prompt');
    expect(config?.name).toBe('Updated Warden');
  });

  it('should permanently remove wardens', async () => {
    const registry = new WardenRegistry(db, makeDeps(), webhooks);
    await registry.create({ name: 'Doomed', label: 'warden:doomed', wardenPrompt: 'goodbye' });

    registry.remove('warden:doomed');

    expect(registry.getByLabel('warden:doomed')).toBeUndefined();
    const row = db.prepare('SELECT * FROM wardens WHERE label = ?').get('warden:doomed');
    expect(row).toBeUndefined();
  });

  it('should list wardens with runtime status', async () => {
    const registry = new WardenRegistry(db, makeDeps(), webhooks);
    await registry.create({ name: 'Status Warden', label: 'warden:status', wardenPrompt: 'status test' });

    const statuses = registry.listWithStatus();
    expect(statuses.length).toBe(1);
    expect(statuses[0].config.label).toBe('warden:status');
    expect(statuses[0].running).toBeDefined();
    expect(statuses[0].busy).toBeDefined();
    expect(statuses[0].queueDepth).toBeDefined();
  });
});
