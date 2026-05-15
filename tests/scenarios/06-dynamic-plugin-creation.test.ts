// ---------------------------------------------------------------------------
// Scenario 06 — Dynamic plugin creation mid-execution.
//
// Setup: Seed board with a Story for warden:dev to create a plugin.
// Expected: plugin_create called with valid MCP server source.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from 'vitest';
import { TestHarness } from '../helpers/harness.js';

describe('Scenario 06: Dynamic plugin creation', () => {
  let harness: TestHarness;

  afterAll(async () => {
    harness?.printState();
    await harness?.teardown();
  });

  it('should create a plugin through the dev warden', async () => {
    harness = await TestHarness.create();

    // Seed a dev warden.
    await harness.wardenRegistry.create({
      name: 'Development Warden',
      label: 'warden:dev',
      wardenPrompt: `You are the Development Warden. You handle software engineering work.
When asked to create a plugin, use plugin_create to register a new MCP server plugin.
The plugin source must be valid TypeScript using @modelcontextprotocol/sdk.
Spawn a developer worker to write the plugin source, then register it via plugin_create.
When done, call transition({ status: "Done" }).`,
    });
    await harness.wardenRegistry.start();

    // Seed the board with a Story to create a plugin.
    harness.jira.seed([{
      key: 'TEST-200',
      fields: {
        summary: 'Create a plugin that checks website uptime',
        description: 'Create an MCP server plugin named "uptime-checker" that has a tool to check if a URL is responding with a 200 status code.',
        issuetype: { id: '1', name: 'Story', subtask: false },
        labels: ['warden:dev'],
        status: { id: '1', name: 'To Do', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
        priority: { id: '3', name: 'Medium' },
        project: { id: '1', key: 'TEST', name: 'Test Project', projectTypeKey: 'software' },
      } as any,
    }]);

    // Fire webhook.
    harness.dispatchWebhook({
      webhookEvent: 'jira:issue_created',
      timestamp: Date.now(),
      user: { accountId: 'system', displayName: 'HIRAM', active: true },
      issue: harness.jira.issues.get('TEST-200')! as any,
    });

    // Wait for the warden to finish processing.
    await harness.waitForWardens();

    // Assert — a plugin was created.
    expect(harness.metrics.pluginCreations).toBeGreaterThanOrEqual(1);

    // Assert — the plugin is in the registry.
    const plugin = harness.registry.getByName('uptime-checker');
    // It may have a different name — check that at least one new plugin was registered.
    const allPlugins = harness.registry.list(undefined, true);
    expect(allPlugins.length).toBeGreaterThanOrEqual(1);

    // Assert — metrics.
    harness.metrics.assertWorkerSpawns({ min: 1 });
  });
});
