// ---------------------------------------------------------------------------
// Scenario 07 — Multi-warden coordination.
//
// Input: Architect instruction requiring work from multiple wardens.
// Expected: Epic with Stories assigned to at least 3 different wardens.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from 'vitest';
import { TestHarness } from '../helpers/harness.js';

describe('Scenario 07: Multi-warden coordination', () => {
  let harness: TestHarness;

  afterAll(async () => {
    harness?.printState();
    await harness?.teardown();
  });

  it('should create Stories for multiple wardens', async () => {
    harness = await TestHarness.create();

    // Seed all wardens so the Architect knows they exist.
    await harness.seedWardens();

    // Act — give the Architect a cross-cutting instruction.
    await harness.architect.handleInstruction(
      'Launch a landing page for our new product. This requires: ' +
      '1. Writing the landing page copy (warden:content), ' +
      '2. Building and deploying the page (warden:dev and warden:ops), ' +
      '3. Setting up monitoring for the new page (warden:monitor). ' +
      'Create an Epic and Stories for each warden.',
    );

    // Assert — board state.
    const epics = harness.jira.getByType('Epic');
    expect(epics.length).toBeGreaterThanOrEqual(1);

    const stories = harness.jira.getByType('Story');
    expect(stories.length).toBeGreaterThanOrEqual(3);

    // Collect distinct warden labels across all Stories.
    const wardenLabels = new Set<string>();
    for (const story of stories) {
      for (const label of story.fields.labels) {
        if (label.startsWith('warden:')) {
          wardenLabels.add(label);
        }
      }
    }

    // Should assign to at least 3 different wardens.
    expect(wardenLabels.size).toBeGreaterThanOrEqual(3);

    // Assert — metrics.
    harness.metrics.assertPluginInvoked('atlassian.create_issue', { min: 4 }); // 1 Epic + 3+ Stories
  });
});
