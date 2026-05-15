import { boot } from '../../src/daemon.js';

async function main() {
  const ctx = await boot({
    sqlitePath: '/tmp/research-test.db',
    workspaceRoot: '/tmp/research-workspace',
    skipTunnel: true,
    skipRelayCheck: true,
    skipWebhookRegistration: true,
  });

  // Wait for plugins to stabilize.
  console.log('Plugins stabilizing (5s)...');
  await new Promise(r => setTimeout(r, 5000));

  // Verify atlassian + brave-search work before creating ticket.
  try {
    await ctx.pluginRegistry.invoke('atlassian', 'list_projects', {});
    console.log('JIRA: OK');
  } catch (e) {
    console.error('JIRA BROKEN:', (e as Error).message.slice(0, 100));
    await ctx.shutdown(); process.exit(1);
  }
  // Brave Search removed — agents use built-in web_search now.
  console.log('Web search: built-in (no plugin needed)');

  // Simple task — no Playwright, just Brave Search.
  console.log('\nCreating ticket...');
  const r = await ctx.pluginRegistry.invoke('atlassian', 'create_issue', {
    project: 'SCRUM', issueType: 'Story',
    summary: '[TEST] Find the pricing of UptimeRobot',
    description: 'Use Brave Search to find UptimeRobot pricing. List the tier names and prices. That is all.',
    labels: ['warden:research', 'test-delete'],
  });
  const key = JSON.parse(r).key;
  console.log('Created:', key);

  await ctx.wardenRegistry.rehydrateAll();
  console.log('Rehydrated. Monitoring (5min max)...\n');

  const start = Date.now();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const elapsed = Math.round((Date.now() - start) / 1000);

    // Direct JIRA query.
    let status = '?', comments = 0;
    try {
      const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
      const jr = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=status,comment`, {
        headers: { Authorization: auth }, signal: AbortSignal.timeout(5000),
      });
      if (jr.ok) {
        const issue = await jr.json() as any;
        status = issue.fields?.status?.name ?? '?';
        comments = issue.fields?.comment?.comments?.length ?? 0;
      }
    } catch {}

    const w = ctx.wardenRegistry.listWithStatus().find(s => s.config.label === 'warden:research');
    console.log(`${elapsed}s — ${status} (${comments}c) busy=${w?.busy} active=${w?.concurrentTickets}`);

    if (status === 'Done') { console.log('\n*** DONE ***'); break; }
    if (status === 'Blocked') {
      // Get last comment
      try {
        const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
        const jr = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=comment`, {
          headers: { Authorization: auth },
        });
        const issue = await jr.json() as any;
        const last = issue.fields?.comment?.comments?.slice(-1)?.[0];
        const text = last?.body?.content?.map((b: any) => b.content?.map((t: any) => t.text || '').join('') || '').join(' ') || '';
        console.log('BLOCKED reason:', text.slice(0, 300));
      } catch {}
      break;
    }
    if (elapsed > 300) { console.log('\n5min timeout'); break; }
  }

  // Cleanup
  await ctx.pluginRegistry.invoke('atlassian', 'delete_issue', { issueKey: key }).catch(() => {});
  console.log('Cleaned up');
  await ctx.shutdown();
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
