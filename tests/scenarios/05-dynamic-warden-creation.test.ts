// ---------------------------------------------------------------------------
// Scenario 05 — Dynamic warden creation mid-execution.
//
// Input: Architect instruction to create a new warden and assign it work.
// Expected: warden_create called, new warden registered, Story created with
//           the new warden's label.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from 'vitest';
import { TestHarness } from '../helpers/harness.js';

describe('Scenario 05: Dynamic warden creation', () => {
  let harness: TestHarness;

  afterAll(async () => {
    harness?.printState();
    await harness?.teardown();
  });

  it('should create a new warden and assign it work', async () => {
    harness = await TestHarness.create();

    // Act — instruct the Architect to create a new warden domain.
    await harness.architect.handleInstruction(
      'We need a new warden to handle legal compliance work. ' +
      'Create a warden with label "warden:legal" and a prompt about reviewing terms of service and privacy policies. ' +
      'Then create an Epic and a Story assigned to this new warden to review our Terms of Service.',
    );

    // Assert — warden was created in the registry.
    const legalWarden = harness.wardenRegistry.getByLabel('warden:legal');
    expect(legalWarden).toBeDefined();
    expect(legalWarden?.name).toBeTruthy();

    // Assert — a Story was created with the warden:legal label.
    const stories = harness.jira.getByType('Story');
    const legalStories = stories.filter((s) =>
      s.fields.labels.includes('warden:legal'),
    );
    expect(legalStories.length).toBeGreaterThanOrEqual(1);

    // Assert — metrics.
    harness.metrics.assertToolCalled('warden_create', { min: 1 });
    harness.metrics.assertPluginInvoked('atlassian.create_issue', { min: 2 }); // Epic + Story
  });
});
