import { initDatabase } from '../../src/db/schema.js';
import { PluginRegistry } from '../../src/tools/registry.js';
import { Vault } from '../../src/secrets/vault.js';
import { seedVault } from '../../src/secrets/seed.js';
import { WardenRegistry } from '../../src/workers/warden-registry.js';
import { seedWardens } from '../../src/tools/seeder.js';
import { WebhookServer } from '../../src/jira/webhook-server.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import { Workspace } from '../../src/workspace.js';
import { TelemetryCollector } from '../../src/telemetry/collector.js';
import { PolicyStore } from '../../src/policy/store.js';
import { EventBus } from '../../src/events/bus.js';
import { AgentTracker } from '../../src/workers/agent-tracker.js';
import { HookEngine } from '../../src/hooks/hook-engine.js';
import fs from 'node:fs';

const log = { ok: () => {}, warn: () => {}, info: () => {}, detail: () => {}, step: () => {}, count: () => {}, banner: () => {}, ready: () => {} };

async function main() {
  const db = initDatabase('/tmp/lifecycle-test.db');
  const vault = new Vault(db, 'test-key');
  seedVault(vault, log as any);

  process.env.JIRA_EMAIL = vault.get('ATLASSIAN_EMAIL') ?? '';
  process.env.JIRA_API_TOKEN = vault.get('ATLASSIAN_API_TOKEN') ?? '';
  process.env.JIRA_BASE_URL = vault.get('ATLASSIAN_SITE_URL') ?? '';
  process.env.GH_TOKEN = vault.get('GITHUB_TOKEN') ?? '';

  const registry = new PluginRegistry(db, 'tools');
  await registry.start();

  const jiraSrc = fs.readFileSync('src/tools/seeds/jira-tools.ts', 'utf8');
  await registry.createCustom({ name: 'atlassian', source: jiraSrc, description: 'JIRA', tags: [], createdBy: 't' });

  const devSrc = fs.readFileSync('src/tools/seeds/developer-tools.ts', 'utf8');
  await registry.createCustom({ name: 'developer-tools', source: devSrc, description: 'Dev', tags: [], createdBy: 't' });

  console.log(`Plugins: atlassian (${(await registry.listTools('atlassian')).length} tools), developer-tools (${(await registry.listTools('developer-tools')).length} tools)`);

  const knowledge = new KnowledgeStore(db, vault);
  const workspace = new Workspace({ root: '/tmp/lifecycle-workspace' });
  await workspace.init();
  const telemetry = new TelemetryCollector(db);
  const policyStore = new PolicyStore(db);
  const eventBus = new EventBus(db);
  const tracker = new AgentTracker();
  const hooks = new HookEngine(db);
  const webhooks = new WebhookServer(0, db);

  const wardenRegistry = new WardenRegistry(db, {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    registry, vault, knowledge, workspace, telemetry, policyStore, eventBus, tracker, hooks,
  }, webhooks);

  await seedWardens(wardenRegistry);
  await wardenRegistry.start();

  // Create 1 simple ticket
  console.log('\nCreating test ticket...');
  const r = await registry.invoke('atlassian', 'create_issue', {
    project: 'SCRUM', issueType: 'Story',
    summary: '[LIFECYCLE-TEST] Write a simple hello-world script',
    description: 'Create a file called hello.txt with the text "Hello from HIRAM" in the scratch workspace. This is a test.',
    labels: ['warden:dev', 'test-lifecycle'],
  });
  const key = JSON.parse(r).key;
  console.log('Created:', key);

  // Rehydrate
  await wardenRegistry.rehydrateAll();

  // Monitor
  console.log('\nMonitoring lifecycle...');
  const start = Date.now();
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - start) / 1000);
    const statuses = wardenRegistry.listWithStatus();
    const dev = statuses.find(s => s.config.label === 'warden:dev');

    let ticketStatus = '?';
    let comments = 0;
    try {
      const tr = await registry.invoke('atlassian', 'get_issue', { issueKey: key });
      const issue = JSON.parse(tr);
      ticketStatus = issue.fields?.status?.name ?? '?';
      comments = issue.fields?.comment?.comments?.length ?? 0;
    } catch {}

    console.log(`${elapsed}s — warden: concurrent=${dev?.concurrentTickets ?? 0} busy=${dev?.busy ?? false} | ticket: ${ticketStatus} (${comments} comments)`);

    if (ticketStatus === 'Done') {
      console.log('\n*** TICKET TRANSITIONED TO DONE — LIFECYCLE COMPLETE ***');
      break;
    }

    if (elapsed > 180) {
      console.log('\nTimeout — ticket did not reach Done');
      break;
    }
  }

  // Final check
  const finalR = await registry.invoke('atlassian', 'get_issue', { issueKey: key });
  const finalIssue = JSON.parse(finalR);
  console.log('\nFinal status:', finalIssue.fields?.status?.name);
  console.log('Comments:', finalIssue.fields?.comment?.comments?.length ?? 0);
  for (const c of (finalIssue.fields?.comment?.comments ?? [])) {
    const text = c.body?.content?.map((b: any) => b.content?.map((t: any) => t.text || '').join('') || '').join(' ') || '';
    console.log('  ' + text.slice(0, 120));
  }

  // Cleanup
  await registry.invoke('atlassian', 'delete_issue', { issueKey: key }).catch(() => {});
  console.log('Cleaned up');

  await registry.stop();
  db.close();
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
