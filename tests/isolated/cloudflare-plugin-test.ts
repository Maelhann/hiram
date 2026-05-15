// Isolated test: verify the custom cloudflare-tools MCP plugin works.
// Boots the daemon, calls every Cloudflare tool, reports pass/fail.

import { boot } from '../../src/daemon.js';

async function main() {
  const ctx = await boot({
    sqlitePath: `${process.env.TEMP || '/tmp'}/cf-test-${Date.now()}.db`,
    workspaceRoot: `${process.env.TEMP || '/tmp'}/cf-workspace-${Date.now()}`,
    skipTunnel: true,
    skipRelayCheck: true,
    skipWebhookRegistration: true,
  });

  console.log('Plugins stabilizing (3s)...');
  await new Promise(r => setTimeout(r, 3000));

  // Verify cloudflare plugin is connected
  let tools: { name: string }[];
  try {
    tools = await ctx.pluginRegistry.listTools('cloudflare');
    console.log(`\nCloudflare plugin: ${tools.length} tools`);
    for (const t of tools) console.log(`  - ${t.name}`);
  } catch (e) {
    console.error('Cloudflare plugin BROKEN:', (e as Error).message.slice(0, 200));
    await ctx.shutdown(); process.exit(1);
  }

  // Test each tool category
  const results: { tool: string; ok: boolean; detail: string }[] = [];

  async function test(name: string, tool: string, args: Record<string, unknown>) {
    try {
      const r = await ctx.pluginRegistry.invoke('cloudflare', tool, args);
      const parsed = JSON.parse(r);
      const success = parsed.success !== false;
      results.push({ tool: `${name} (${tool})`, ok: success, detail: success ? 'OK' : JSON.stringify(parsed.errors).slice(0, 100) });
      console.log(`  ${success ? '✅' : '❌'} ${name}: ${tool}`);
      return parsed;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 150);
      results.push({ tool: `${name} (${tool})`, ok: false, detail: msg });
      console.log(`  ❌ ${name}: ${tool} — ${msg}`);
      return null;
    }
  }

  console.log('\n=== Zones ===');
  const zones = await test('List zones', 'zones_list', {});
  const zoneId = zones?.result?.[0]?.id;
  if (zoneId) {
    console.log(`  Zone: ${zones.result[0].name} (${zoneId})`);
    await test('Get zone', 'zone_get', { zoneId });
  }

  console.log('\n=== DNS ===');
  if (zoneId) {
    await test('List DNS records', 'dns_list', { zoneId });
    // Create a test TXT record, then delete it
    const created = await test('Create DNS record', 'dns_create', {
      zoneId, type: 'TXT', name: '_cf-test', content: 'hiram-test-' + Date.now(),
    });
    if (created?.result?.id) {
      await test('Delete DNS record', 'dns_delete', { zoneId, recordId: created.result.id });
    }
  }

  console.log('\n=== KV Storage ===');
  await test('List KV namespaces', 'kv_list_namespaces', {});

  console.log('\n=== R2 Storage ===');
  await test('List R2 buckets', 'r2_list_buckets', {});

  console.log('\n=== Workers ===');
  await test('List Workers', 'workers_list', {});
  await test('List Worker domains', 'workers_domains_list', {});

  console.log('\n=== Pages ===');
  await test('List Pages projects', 'pages_list_projects', {});

  console.log('\n=== D1 ===');
  await test('List D1 databases', 'd1_list_databases', {});

  console.log('\n=== Registrar ===');
  await test('List registrar domains', 'registrar_list_domains', {});

  console.log('\n=== Tunnels ===');
  await test('List tunnels', 'tunnels_list', {});

  // Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ❌ ${r.tool}: ${r.detail}`);
    }
  }

  await ctx.shutdown();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
