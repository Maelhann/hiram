// ---------------------------------------------------------------------------
// Scenario 02 — Warden picks up a Story and spawns workers.
//
// Setup: Seed board with 1 Story (warden:dev label, status "To Do").
// Input: Fire webhook for the Story.
// Expected: Story transitions through workflow. At least 1 Task created.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from 'vitest';
import { TestHarness } from '../helpers/harness.js';

describe('Scenario 02: Warden picks up a Story', () => {
  let harness: TestHarness;

  afterAll(async () => {
    harness?.printState();
    await harness?.teardown();
  });

  it('should pick up the Story, spawn workers, and create Tasks', async () => {
    harness = await TestHarness.create();

    // Seed the dev warden.
    await harness.wardenRegistry.create({
      name: 'Development Warden',
      label: 'warden:dev',
      wardenPrompt: `You are the Development Warden. You handle software engineering work.
Use get_worker_type("developer") to get the system prompt for a developer worker.
Call run_worker to execute the task. When done, call transition({ status: "Done" }).
Keep it simple — spawn one developer worker for this task.`,
    });
    await harness.wardenRegistry.start();

    // Seed the board with a Story.
    harness.jira.seed([{
      key: 'TEST-100',
      fields: {
        summary: 'Add a /health endpoint that returns { status: "ok" }',
        issuetype: { id: '1', name: 'Story', subtask: false },
        labels: ['warden:dev'],
        status: { id: '1', name: 'To Do', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
        priority: { id: '3', name: 'Medium' },
        project: { id: '1', key: 'TEST', name: 'Test Project', projectTypeKey: 'software' },
      } as any,
    }]);

    // Fire webhook — this should trigger the dev warden.
    harness.dispatchWebhook({
      webhookEvent: 'jira:issue_created',
      timestamp: Date.now(),
      user: { accountId: 'system', displayName: 'HIRAM', active: true },
      issue: harness.jira.issues.get('TEST-100')! as any,
    });

    // Wait for the warden to finish processing.
    await harness.waitForWardens();

    // Assert — board state.
    const story = harness.jira.issues.get('TEST-100');
    expect(story).toBeDefined();

    // Tasks should have been created under the Story.
    const tasks = harness.jira.getByType('Task');
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // At least some Tasks should be children of the Story.
    const childTasks = harness.jira.getChildren('TEST-100');
    expect(childTasks.length).toBeGreaterThanOrEqual(1);

    // Assert — metrics.
    harness.metrics.assertWorkerSpawns({ min: 1 });
    harness.metrics.assertPluginInvoked('atlassian.create_issue', { min: 1 }); // Task(s) created
  });
});
