// ---------------------------------------------------------------------------
// TestHarness — sets up a complete test environment with real Anthropic API
// calls but mocked JIRA and plugins.
// ---------------------------------------------------------------------------

import 'dotenv/config';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { Vault } from '../../src/secrets/vault.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import { WebhookServer } from '../../src/jira/webhook-server.js';
import { WardenRegistry } from '../../src/workers/warden-registry.js';
import { Architect } from '../../src/workers/architect.js';
import { setModelOverride, type AgentDeps } from '../../src/workers/base-agent.js';
import { setOnWorkerSpawn } from '../../src/workers/base-warden.js';
import { MockJiraBoard } from './mock-jira.js';
import { MockPluginRegistry } from './mock-registry.js';
import { MetricsTracker } from './metrics.js';
import type { JiraWebhookPayload } from '../../src/types/jira.js';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Use Sonnet 4.6 for integration tests — production model.
setModelOverride('claude-sonnet-4-6');

export class TestHarness {
  db!: Database.Database;
  vault!: Vault;
  registry!: MockPluginRegistry;
  knowledge!: KnowledgeStore;
  jira!: MockJiraBoard;
  webhooks!: WebhookServer;
  wardenRegistry!: WardenRegistry;
  architect!: Architect;
  agentDeps!: AgentDeps;
  metrics!: MetricsTracker;

  private tmpDir!: string;
  private webhookPort = 0;

  static async create(): Promise<TestHarness> {
    const harness = new TestHarness();
    await harness.setup();
    return harness;
  }

  private async setup(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set in environment. Cannot run integration tests.');
    }

    // Temp directory for tools.
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiram-test-'));

    // In-memory SQLite.
    this.db = initDatabase(':memory:');

    // Vault with a test master key.
    this.vault = new Vault(this.db, 'test-master-key-for-integration-tests');

    // Knowledge store (no Voyage key — falls back to FTS5).
    this.knowledge = new KnowledgeStore(this.db, this.vault);

    // Mock JIRA board.
    this.jira = new MockJiraBoard();

    // Metrics tracker.
    this.metrics = new MetricsTracker();

    // Wire worker spawn tracking.
    setOnWorkerSpawn(() => this.metrics.recordWorkerSpawn());

    // Mock plugin registry.
    this.registry = new MockPluginRegistry(this.db, this.tmpDir, this.jira, this.metrics);

    // Webhook server on a random port.
    this.webhooks = new WebhookServer(0);

    // Warden registry.
    this.wardenRegistry = new WardenRegistry(this.db, {
      apiKey,
      registry: this.registry,
      vault: this.vault,
      knowledge: this.knowledge,
      wardenRegistry: undefined,
    }, this.webhooks);

    const originalCreate = this.wardenRegistry.create.bind(this.wardenRegistry);
    this.wardenRegistry.create = async (opts) => {
      this.metrics.recordWardenCreation();
      this.metrics.recordToolCall('warden_create');
      return originalCreate(opts);
    };

    // Agent deps.
    this.agentDeps = {
      apiKey,
      registry: this.registry,
      vault: this.vault,
      knowledge: this.knowledge,
      wardenRegistry: this.wardenRegistry,
    };

    // Architect.
    this.architect = new Architect(this.agentDeps);
    this.architect.registerWebhooks(this.webhooks);

    // Wire JIRA webhooks → webhook server.
    this.jira.setWebhookCallback((payload: JiraWebhookPayload) => {
      this.dispatchWebhook(payload);
    });

    // Start webhook server.
    await this.webhooks.start();

    // Capture the assigned port.
    const addr = (this.webhooks as unknown as { server: { address: () => { port: number } } }).server?.address();
    if (addr) this.webhookPort = addr.port;
  }

  /** Dispatch a webhook payload to the webhook server via HTTP. */
  dispatchWebhook(payload: JiraWebhookPayload): void {
    if (!this.webhookPort) return;
    fetch(`http://127.0.0.1:${this.webhookPort}/webhook/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  /** Seed wardens from the standard seed set. */
  async seedWardens(): Promise<void> {
    const { seedWardens } = await import('../../src/tools/seeder.js');
    await seedWardens(this.wardenRegistry);
    await this.wardenRegistry.start();
  }

  /**
   * Wait until the Architect and all wardens finish processing.
   * Polls every second, gives up after maxWait ms.
   */
  async waitForIdle(maxWait = 1_800_000): Promise<void> {
    const start = Date.now();
    // Initial grace period — let webhooks propagate.
    await this.sleep(3000);

    while (Date.now() - start < maxWait) {
      const architectBusy = this.architect.busy;
      const statuses = this.wardenRegistry.listWithStatus();
      const anyWardenBusy = statuses.some((s) => s.busy || s.queueDepth > 0);

      if (!architectBusy && !anyWardenBusy) {
        // Extra grace — an agent might be between operations.
        await this.sleep(2000);
        const recheck = this.wardenRegistry.listWithStatus();
        if (!this.architect.busy && !recheck.some((s) => s.busy || s.queueDepth > 0)) {
          return;
        }
      }
      await this.sleep(1000);
    }

    console.warn('waitForIdle: timed out after', maxWait, 'ms');
  }

  /** @deprecated Use waitForIdle instead. */
  async waitForWardens(maxWait = 240_000): Promise<void> {
    return this.waitForIdle(maxWait);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async teardown(): Promise<void> {
    setOnWorkerSpawn(null);
    this.wardenRegistry.stop();
    await this.webhooks.stop();
    this.db.close();
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /** Print full test state for debugging. */
  printState(): void {
    this.jira.printBoard();
    this.metrics.printSummary();
  }
}
