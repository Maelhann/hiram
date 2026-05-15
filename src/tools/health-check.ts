import type { Vault } from '../secrets/vault.js';
import type { PluginRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Plugin Health Check — runs on boot to verify every plugin can connect
// and has the credentials it needs.
//
// For each registered plugin:
//   1. Check if required vault secrets are present
//   2. Attempt to connect and list tools
//   3. Report pass/fail per plugin
//   4. Log a clear summary so the operator knows what's missing
// ---------------------------------------------------------------------------

interface PluginSecretRequirement {
  plugin: string;
  vaultKeys: string[];
}

/** Map of plugins to the vault secrets they require. */
const REQUIRED_SECRETS: PluginSecretRequirement[] = [
  // cloudflare is a custom plugin — reads CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID from env (set by daemon).
  // brave-search removed — built-in web_search via Anthropic API replaces it.
  { plugin: 'instantly', vaultKeys: ['INSTANTLY_API_KEY'] },
  { plugin: 'apollo', vaultKeys: ['APOLLO_API_KEY'] },
  { plugin: 'stripe', vaultKeys: ['STRIPE_SECRET_KEY'] },
  { plugin: 'hubspot', vaultKeys: ['HUBSPOT_PRIVATE_APP_TOKEN'] },
  // atlassian is a custom plugin — reads JIRA_EMAIL/JIRA_API_TOKEN from env (set by daemon).
];

/** Non-plugin secrets the system needs. */
const SYSTEM_SECRETS = [
  { name: 'VOYAGE_API_KEY', purpose: 'Knowledge store semantic search (Voyage AI embeddings)' },
  { name: 'TELEGRAM_BOT_TOKEN', purpose: 'ContactGateway — Telegram bot for Secretary' },
  { name: 'FOUNDER_EMAIL', purpose: 'ContactGateway — Gmail polling for Secretary' },
  { name: 'FOUNDER_PHONE', purpose: 'ContactGateway — WhatsApp for Secretary' },
  { name: 'WEBHOOK_RELAY_SECRET', purpose: 'Shared secret for GCP Cloud Function webhook relay → HIRAM authentication' },
  { name: 'STRIPE_WEBHOOK_SECRET', purpose: 'Stripe webhook signature verification (auto-populated on first boot if Stripe key is set)' },
  { name: 'HIRAM_PUBLIC_URL', purpose: 'Public URL via Cloudflare Tunnel (for JIRA webhook registration)' },
  { name: 'ATLASSIAN_SITE_URL', purpose: 'Atlassian site URL, e.g. https://yoursite.atlassian.net (for JIRA webhook registration)' },
];

export interface HealthCheckResult {
  plugin: string;
  status: 'ok' | 'missing_secrets' | 'connection_failed' | 'no_tools';
  missingSecrets?: string[];
  toolCount?: number;
  error?: string;
}

export interface SystemSecretResult {
  name: string;
  purpose: string;
  present: boolean;
}

export interface HealthReport {
  plugins: HealthCheckResult[];
  systemSecrets: SystemSecretResult[];
  healthy: number;
  degraded: number;
  failed: number;
}

export async function runHealthCheck(
  registry: PluginRegistry,
  vault: Vault,
): Promise<HealthReport> {
  console.log('\n=== Plugin Health Check ===\n');

  const pluginResults: HealthCheckResult[] = [];

  // Check all registered plugins (including ones without secret requirements).
  const allPlugins = registry.list(); // include private

  for (const entry of allPlugins) {
    const result: HealthCheckResult = { plugin: entry.name, status: 'ok' };

    // 1. Check required secrets.
    const requirement = REQUIRED_SECRETS.find((r) => r.plugin === entry.name);
    if (requirement) {
      const missing = requirement.vaultKeys.filter((key) => !vault.get(key));
      if (missing.length > 0) {
        result.status = 'missing_secrets';
        result.missingSecrets = missing;
        pluginResults.push(result);
        console.log(`  [MISSING]  ${entry.name} — secrets not set: ${missing.join(', ')}`);
        continue;
      }
    }

    // 2. Try to list tools (proves the plugin is connected and responding).
    try {
      const tools = await registry.listTools(entry.name);
      result.toolCount = tools.length;

      if (tools.length === 0) {
        result.status = 'no_tools';
        console.log(`  [WARNING]  ${entry.name} — connected but exposes 0 tools`);
      } else {
        console.log(`  [OK]       ${entry.name} — ${tools.length} tool(s) available`);
      }
    } catch (err) {
      result.status = 'connection_failed';
      result.error = err instanceof Error ? err.message : String(err);
      console.log(`  [FAILED]   ${entry.name} — ${result.error}`);
    }

    pluginResults.push(result);
  }

  // Check system secrets.
  console.log('\n--- System Secrets ---\n');
  const systemResults: SystemSecretResult[] = [];

  for (const secret of SYSTEM_SECRETS) {
    const present = !!vault.get(secret.name);
    systemResults.push({ name: secret.name, purpose: secret.purpose, present });
    if (present) {
      console.log(`  [OK]       ${secret.name}`);
    } else {
      console.log(`  [MISSING]  ${secret.name} — ${secret.purpose}`);
    }
  }

  // Summary.
  const healthy = pluginResults.filter((r) => r.status === 'ok').length;
  const degraded = pluginResults.filter((r) => r.status === 'no_tools' || r.status === 'missing_secrets').length;
  const failed = pluginResults.filter((r) => r.status === 'connection_failed').length;
  const missingSystemSecrets = systemResults.filter((s) => !s.present).length;

  console.log(`\n=== Health Check Summary ===`);
  console.log(`  Plugins: ${healthy} healthy, ${degraded} degraded, ${failed} failed (${allPlugins.length} total)`);
  console.log(`  System secrets: ${systemResults.length - missingSystemSecrets}/${systemResults.length} present`);

  if (degraded > 0 || failed > 0 || missingSystemSecrets > 0) {
    console.log(`\n  To set missing secrets, use the vault:`);
    const allMissing = [
      ...pluginResults.filter((r) => r.missingSecrets).flatMap((r) => r.missingSecrets!),
      ...systemResults.filter((s) => !s.present).map((s) => s.name),
    ];
    for (const key of allMissing) {
      console.log(`    secret_set("${key}", "<value>")`);
    }
  }

  console.log('');

  return { plugins: pluginResults, systemSecrets: systemResults, healthy, degraded, failed };
}
