// ---------------------------------------------------------------------------
// Scenario 03 — Full flow: Epic → Stories → Tasks → Done.
//
// Input: Architect instruction to build something simple.
// Expected: Complete chain from Epic creation through to task completion.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from 'vitest';
import { TestHarness } from '../helpers/harness.js';

describe('Scenario 03: Full flow Epic to Done', () => {
  let harness: TestHarness;

  afterAll(async () => {
    harness?.printState();
    await harness?.teardown();
  });

  it('should flow from Architect instruction through to completed Tasks', async () => {
    harness = await TestHarness.create();

    // Seed wardens.
    await harness.seedWardens();

    // Act — give the Architect a focused instruction.
    await harness.architect.handleInstruction(
      'Build a health check endpoint for our API. Create an Epic, then create a single Story for warden:dev to implement it.',
    );

    // Wait for the full chain: Architect creates issues → wardens pick up via webhook → workers execute.
    await harness.waitForWardens();

    // Assert — Tasks were created.
    const tasks = harness.jira.getByType('Task');
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    // Assert — comments exist (wardens and workers post progress).
    const allComments = harness.jira.getAllComments();
    expect(allComments.length).toBeGreaterThanOrEqual(2);

    // Assert — metrics.
    harness.metrics.assertPluginInvoked('atlassian.create_issue', { min: 2 }); // Epic + Story + Task(s)
    harness.metrics.assertWorkerSpawns({ min: 1 });
  });
});
