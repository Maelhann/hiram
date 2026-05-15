// Test the Architect in isolation — uses the same boot() function as the E2E test.
import { boot } from '../../src/daemon.js';

async function main() {
  const ctx = await boot({
    sqlitePath: '/tmp/architect-speed.db',
    workspaceRoot: '/tmp/arch-speed-workspace',
    skipTunnel: true,
    skipRelayCheck: true,
    skipWebhookRegistration: true,
  });

  console.log('\nTesting Architect response time...');
  const t0 = Date.now();
  const result = await ctx.architect.handleInstruction(
    'Create an Epic in JIRA project SCRUM called "[TEST] Architect speed test" with label "test-delete". Create 2 Stories under it. Report what you created.',
  );
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`Done in ${elapsed}s`);
  console.log('Result:', result.slice(0, 500));

  // Check JIRA
  const r = await ctx.pluginRegistry.invoke('atlassian', 'search_issues', { jql: 'labels = "test-delete"', maxResults: 10 });
  const issues = JSON.parse(r).issues ?? [];
  console.log(`\nJIRA tickets created: ${issues.length}`);
  for (const i of issues) console.log(`  ${i.key} — ${i.fields?.summary?.slice(0, 60)}`);

  // Cleanup
  for (const i of issues) await ctx.pluginRegistry.invoke('atlassian', 'delete_issue', { issueKey: i.key }).catch(() => {});
  console.log('Cleaned up');

  await ctx.shutdown();
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
