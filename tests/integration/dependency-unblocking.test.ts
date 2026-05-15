/**
 * Integration test: Dependency unblocking pipeline.
 *
 * Creates two Stories: A (no dependency) and B (depends on A).
 * Boots the daemon, assigns A to a warden. When A completes,
 * verifies B gets unblocked and picked up by its warden.
 * Both tickets should be Done at the end.
 *
 * Uses real JIRA API + real daemon boot (no mocks).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { boot, type DaemonContext } from '../../src/daemon.js';

const HAS_KEYS = !!(process.env.ANTHROPIC_API_KEY && (process.env.JIRA_EMAIL || process.env.VAULT_ATLASSIAN_EMAIL));

const descFn = HAS_KEYS ? describe : describe.skip;
descFn('Dependency unblocking pipeline', () => {
  let ctx: DaemonContext;
  const PROJECT_KEY = 'TUNBL';
  let epicKey: string;
  let storyAKey: string;
  let storyBKey: string;

  beforeAll(async () => {
    const ts = Date.now();
    // Use a unique backup dir to avoid restoring old backups with a different master key.
    process.env.BACKUP_DIR = `${process.env.TEMP || '/tmp'}/unblock-backups-${ts}`;
    ctx = await boot({
      sqlitePath: `${process.env.TEMP || '/tmp'}/unblock-test-${ts}.db`,
      workspaceRoot: `${process.env.TEMP || '/tmp'}/unblock-workspace-${ts}`,
      skipTunnel: true,
      skipRelayCheck: true,
      skipWebhookRegistration: true,
    });

    // Wait for plugins to stabilise
    await new Promise(r => setTimeout(r, 5000));

    // Create test project
    const meStr = await ctx.pluginRegistry.invoke('atlassian', 'list_projects', {});
    // Check if project exists
    const projects = JSON.parse(meStr) as { key: string }[];
    if (!projects.some(p => p.key === PROJECT_KEY)) {
      await ctx.pluginRegistry.invoke('atlassian', 'create_project', {
        key: PROJECT_KEY, name: 'TestUnblock',
      });
    }

    // Create Epic
    const epicResult = await ctx.pluginRegistry.invoke('atlassian', 'create_issue', {
      project: PROJECT_KEY, issueType: 'Epic',
      summary: '[TEST] Dependency unblocking pipeline',
      labels: ['test-delete'],
    });
    epicKey = JSON.parse(epicResult).key;

    // Story A — no dependency, assigned to research warden
    const storyAResult = await ctx.pluginRegistry.invoke('atlassian', 'create_issue', {
      project: PROJECT_KEY, issueType: 'Story',
      summary: 'Story A: Find the current price of UptimeRobot Pro plan',
      description: 'Use web_search to find UptimeRobot Pro pricing. Report the price. That is all.',
      labels: ['warden:research', 'test-delete'],
      parentKey: epicKey,
    });
    storyAKey = JSON.parse(storyAResult).key;

    // Story B — depends on A, assigned to content warden
    const storyBResult = await ctx.pluginRegistry.invoke('atlassian', 'create_issue', {
      project: PROJECT_KEY, issueType: 'Story',
      summary: 'Story B: Write a one-paragraph summary of UptimeRobot pricing',
      description: `DEPENDS ON: ${storyAKey} — do not start until that story is Done.\n\nOnce the research is done, write a one-paragraph summary. Use knowledge_search to find the research results, then post the summary as a comment on this ticket. That is all.`,
      labels: ['warden:content', 'test-delete'],
      parentKey: epicKey,
    });
    storyBKey = JSON.parse(storyBResult).key;

    console.log(`Created: Epic=${epicKey}, A=${storyAKey}, B=${storyBKey}`);
    console.log(`B depends on A.`);
  }, 300_000); // 5 min — daemon boot + plugin seeding + JIRA ticket creation

  afterAll(async () => {
    // Cleanup: delete issues and project
    for (const key of [storyBKey, storyAKey, epicKey].filter(Boolean)) {
      try { await ctx.pluginRegistry.invoke('atlassian', 'delete_issue', { issueKey: key }); } catch {}
    }
    try { await ctx.pluginRegistry.invoke('atlassian', 'search_issues', {
      jql: `project = ${PROJECT_KEY} AND labels = "test-delete"`, maxResults: 50,
    }).then(r => {
      const issues = (JSON.parse(r).issues || []) as { key: string }[];
      return Promise.all(issues.map(i => ctx.pluginRegistry.invoke('atlassian', 'delete_issue', { issueKey: i.key }).catch(() => {})));
    }); } catch {}
    try {
      // Delete project permanently
      const AUTH = `Basic ${Buffer.from(`${process.env.JIRA_EMAIL || process.env.VAULT_ATLASSIAN_EMAIL}:${process.env.JIRA_API_TOKEN || process.env.VAULT_ATLASSIAN_API_TOKEN}`).toString('base64')}`;
      const BASE = process.env.JIRA_BASE_URL || process.env.VAULT_ATLASSIAN_SITE_URL || 'https://yoursite.atlassian.net';
      await fetch(`${BASE}/rest/api/3/project/${PROJECT_KEY}?enableUndo=false`, {
        method: 'DELETE', headers: { Authorization: AUTH },
      });
    } catch {}
    await ctx.shutdown();
  }, 300_000);

  it('should complete both stories via dependency pipeline', async () => {
    // Rehydrate wardens — they should pick up Story A (not blocked)
    // Story B should be blocked by checkDependency
    await ctx.wardenRegistry.rehydrateAll();

    console.log('Wardens rehydrated. Monitoring...');

    const start = Date.now();
    const MAX_WAIT = 10 * 60_000; // 10 minutes max

    while (Date.now() - start < MAX_WAIT) {
      await new Promise(r => setTimeout(r, 15_000));
      const elapsed = Math.round((Date.now() - start) / 1000);

      // Check status of both stories
      let statusA = '?', statusB = '?';
      try {
        const aStr = await ctx.pluginRegistry.invoke('atlassian', 'get_issue', { issueKey: storyAKey });
        statusA = (JSON.parse(aStr) as { fields: { status: { name: string } } }).fields.status.name;
      } catch {}
      try {
        const bStr = await ctx.pluginRegistry.invoke('atlassian', 'get_issue', { issueKey: storyBKey });
        statusB = (JSON.parse(bStr) as { fields: { status: { name: string } } }).fields.status.name;
      } catch {}

      const wardens = ctx.wardenRegistry.listWithStatus();
      const busyWardens = wardens.filter((w: any) => w.busy).map((w: any) => w.config.label).join(', ');

      console.log(`${elapsed}s — A: ${statusA}, B: ${statusB} | busy: ${busyWardens || 'none'}`);

      // Success: both Done
      if (statusA === 'Done' && statusB === 'Done') {
        console.log(`\n*** BOTH DONE in ${elapsed}s ***`);
        break;
      }

      // If both not done and no wardens busy, try rehydrating
      if (statusA !== 'Done' || statusB !== 'Done') {
        const anyBusy = wardens.some((w: any) => w.busy);
        if (!anyBusy && elapsed > 30) {
          console.log('  No wardens busy — triggering rehydrate...');
          await ctx.wardenRegistry.rehydrateAll();
        }
      }
    }

    // Final verification
    const aStr = await ctx.pluginRegistry.invoke('atlassian', 'get_issue', { issueKey: storyAKey });
    const bStr = await ctx.pluginRegistry.invoke('atlassian', 'get_issue', { issueKey: storyBKey });
    const finalA = (JSON.parse(aStr) as { fields: { status: { name: string } } }).fields.status.name;
    const finalB = (JSON.parse(bStr) as { fields: { status: { name: string } } }).fields.status.name;

    console.log(`Final: A=${finalA}, B=${finalB}`);
    expect(finalA).toBe('Done');
    expect(finalB).toBe('Done');
  }, 600_000);
});
