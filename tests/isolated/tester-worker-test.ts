import { boot } from '../../src/daemon.js';

async function main() {
  const ctx = await boot({
    sqlitePath: '/tmp/tester-test.db',
    workspaceRoot: '/tmp/tester-workspace',
    skipTunnel: true,
    skipRelayCheck: true,
    skipWebhookRegistration: true,
  });

  console.log('Plugins stabilizing (5s)...');
  await new Promise(r => setTimeout(r, 5000));

  // Verify playwright plugin
  try {
    const tools = await ctx.pluginRegistry.listTools('playwright');
    console.log('Playwright:', tools.length, 'tools');
  } catch (e) {
    console.error('Playwright BROKEN:', (e as Error).message.slice(0, 100));
    await ctx.shutdown(); process.exit(1);
  }

  // Create a QA test ticket for the dev warden
  console.log('\nCreating test ticket...');
  const r = await ctx.pluginRegistry.invoke('atlassian', 'create_issue', {
    project: 'SCRUM', issueType: 'Story',
    summary: '[TEST] Verify your-gcp-project.web.app loads and works correctly',
    description: `Use Playwright to test the deployed site at https://your-gcp-project.web.app.

Test these things:
1. Navigate to the page and verify it returns HTTP 200
2. Check the page title contains "HIRAM"
3. Take an accessibility snapshot (use depth=3 to keep it small)
4. Check the browser console for JavaScript errors
5. Verify at least one link exists on the page
6. Report pass/fail for each check

Use browser_evaluate to run JavaScript assertions. Use browser_snapshot with depth=3 (not the default).
Use browser_console_messages to check for errors.
Do NOT use browser_snapshot without depth=3 — the default output is too large.`,
    labels: ['warden:dev', 'test-delete'],
  });
  const key = JSON.parse(r).key;
  console.log('Created:', key);

  await ctx.wardenRegistry.rehydrateAll();
  console.log('Rehydrated. Monitoring (5min max)...\n');

  const start = Date.now();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const elapsed = Math.round((Date.now() - start) / 1000);

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

    const w = ctx.wardenRegistry.listWithStatus().find(s => s.config.label === 'warden:dev');
    console.log(`${elapsed}s — ${status} (${comments}c) busy=${w?.busy} active=${w?.concurrentTickets}`);

    if (status === 'Done') { console.log('\n*** DONE ***'); break; }
    if (status === 'Blocked') {
      try {
        const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
        const jr = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=comment`, { headers: { Authorization: auth } });
        const issue = await jr.json() as any;
        const last = issue.fields?.comment?.comments?.slice(-1)?.[0];
        const text = last?.body?.content?.map((b: any) => b.content?.map((t: any) => t.text || '').join('') || '').join(' ') || '';
        console.log('BLOCKED:', text.slice(0, 300));
      } catch {}
      break;
    }
    if (elapsed > 300) { console.log('\n5min timeout'); break; }
  }

  await ctx.pluginRegistry.invoke('atlassian', 'delete_issue', { issueKey: key }).catch(() => {});
  console.log('Cleaned up');
  await ctx.shutdown();
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
