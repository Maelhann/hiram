// ---------------------------------------------------------------------------
// Scenario 04 — Blocked Story triggers Architect to unblock.
//
// Setup: Seed board with an Epic and 2 Stories. Transition Story A to Blocked.
// Expected: Architect investigates and takes corrective action.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from 'vitest';
import { TestHarness } from '../helpers/harness.js';

describe('Scenario 04: Blocked Story triggers unblock', () => {
  let harness: TestHarness;

  afterAll(async () => {
    harness?.printState();
    await harness?.teardown();
  });

  it('should investigate the blocker and take corrective action', async () => {
    harness = await TestHarness.create();

    // Seed the board with an Epic and two Stories.
    harness.jira.seed([
      {
        key: 'TEST-1',
        fields: {
          summary: 'Launch payment integration',
          issuetype: { id: '1', name: 'Epic', subtask: false },
          labels: [],
          status: { id: '1', name: 'In Progress', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
          priority: { id: '2', name: 'High' },
          project: { id: '1', key: 'TEST', name: 'Test Project', projectTypeKey: 'software' },
        } as any,
      },
      {
        key: 'TEST-2',
        fields: {
          summary: 'Implement Stripe checkout flow',
          issuetype: { id: '2', name: 'Story', subtask: false },
          labels: ['warden:dev'],
          status: { id: '1', name: 'Blocked', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
          priority: { id: '2', name: 'High' },
          project: { id: '1', key: 'TEST', name: 'Test Project', projectTypeKey: 'software' },
          parent: { key: 'TEST-1', fields: { summary: 'Launch payment integration' } },
          description: 'Blocked because Stripe API keys are not configured in the vault.',
        } as any,
      },
      {
        key: 'TEST-3',
        fields: {
          summary: 'Design payment confirmation page',
          issuetype: { id: '3', name: 'Story', subtask: false },
          labels: ['warden:content'],
          status: { id: '1', name: 'To Do', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
          priority: { id: '3', name: 'Medium' },
          project: { id: '1', key: 'TEST', name: 'Test Project', projectTypeKey: 'software' },
          parent: { key: 'TEST-1', fields: { summary: 'Launch payment integration' } },
        } as any,
      },
    ]);

    // Fire webhook — Story TEST-2 status changed to Blocked.
    harness.dispatchWebhook({
      webhookEvent: 'jira:issue_updated',
      timestamp: Date.now(),
      user: { accountId: 'system', displayName: 'HIRAM', active: true },
      issue: harness.jira.issues.get('TEST-2')! as any,
      changelog: {
        id: '1',
        items: [{
          field: 'status',
          fieldtype: 'jira',
          from: null,
          fromString: 'In Progress',
          to: null,
          toString: 'Blocked',
        }],
      },
    });

    // Wait for the Architect to finish processing the event.
    await harness.waitForIdle(60_000);

    // Assert — Architect should have taken some action:
    // Either created a new Story to resolve the blocker, added a comment, or reprioritized.
    const allComments = harness.jira.getAllComments();
    const newIssues = [...harness.jira.issues.values()].filter((i) =>
      !['TEST-1', 'TEST-2', 'TEST-3'].includes(i.key),
    );

    // At least a comment on the blocked Story OR a new issue created.
    const architectActed = allComments.length > 0 || newIssues.length > 0;
    expect(architectActed).toBe(true);

    // Assert — metrics: at least one JIRA tool was called for investigation.
    const totalInvocations = [...harness.metrics.pluginInvocations.values()].reduce((a, b) => a + b, 0);
    expect(totalInvocations).toBeGreaterThanOrEqual(1);
  });
});
