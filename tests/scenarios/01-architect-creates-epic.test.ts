// ---------------------------------------------------------------------------
// Scenario 01 — Architect creates structured work from an instruction.
//
// Input: "Launch a new URL shortener SaaS"
// Expected: Multiple issues created with warden labels, structured hierarchy.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from 'vitest';
import { TestHarness } from '../helpers/harness.js';

describe('Scenario 01: Architect creates structured work', () => {
  let harness: TestHarness;

  afterAll(async () => {
    harness?.printState();
    await harness?.teardown();
  });

  it('should create issues with warden labels from a high-level instruction', async () => {
    harness = await TestHarness.create();

    // Act — give the Architect a high-level instruction.
    await harness.architect.handleInstruction(
      'Launch a new URL shortener SaaS. Break this into issues and assign each to the appropriate warden using labels (warden:dev, warden:ops, warden:content, etc.).',
    );

    // Assert — issues were created.
    const allIssues = [...harness.jira.issues.values()];
    expect(allIssues.length).toBeGreaterThanOrEqual(3);

    // At least some issues should have warden labels.
    const wardenLabels = new Set<string>();
    for (const issue of allIssues) {
      for (const label of issue.fields.labels) {
        if (label.startsWith('warden:')) {
          wardenLabels.add(label);
        }
      }
    }
    expect(wardenLabels.size).toBeGreaterThanOrEqual(2);

    // Assert — metrics: multiple issues created.
    harness.metrics.assertPluginInvoked('atlassian.create_issue', { min: 3 });
  });
});
