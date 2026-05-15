import type { Vault } from '../secrets/vault.js';
import { RELAY_BASE_URL } from './webhook-registration.js';

// ---------------------------------------------------------------------------
// Webhook Relay Check — boot-time verification that GCP Cloud Functions
// are deployed and reachable for each webhook relay endpoint.
//
// Runs after the tool runway and before the webhook server starts.
// Non-blocking — the system starts in degraded mode if relays are down.
// ---------------------------------------------------------------------------

const RELAY_ENDPOINTS = [
  { service: 'stripe', description: 'Stripe payments & subscriptions' },
  { service: 'cloudflare', description: 'Infrastructure alerts' },
  { service: 'hubspot', description: 'CRM pipeline events' },
  { service: 'instantly', description: 'Campaign feedback' },
];

export interface RelayCheckResult {
  service: string;
  status: 'ok' | 'fail' | 'skip';
  latencyMs: number;
  error?: string;
}

export async function runWebhookRelayCheck(vault: Vault): Promise<RelayCheckResult[]> {
  console.log('\n=== Webhook Relay Check ===\n');

  const relaySecret = vault.get('WEBHOOK_RELAY_SECRET');
  if (!relaySecret) {
    console.log('  [SKIP]     Relay infrastructure not configured (WEBHOOK_RELAY_SECRET not set)');
    console.log('');
    return RELAY_ENDPOINTS.map(e => ({
      service: e.service,
      status: 'skip' as const,
      latencyMs: 0,
      error: 'WEBHOOK_RELAY_SECRET not set',
    }));
  }

  const results: RelayCheckResult[] = [];

  for (const endpoint of RELAY_ENDPOINTS) {
    const url = `${RELAY_BASE_URL}/relay/${endpoint.service}`;
    const t0 = Date.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      const latency = Date.now() - t0;

      if (response.ok) {
        console.log(`  [OK]       ${endpoint.service} — ${endpoint.description} (${latency}ms)`);
        results.push({ service: endpoint.service, status: 'ok', latencyMs: latency });
      } else {
        const error = `HTTP ${response.status} ${response.statusText}`;
        console.log(`  [FAIL]     ${endpoint.service} — ${error} (${latency}ms)`);
        results.push({ service: endpoint.service, status: 'fail', latencyMs: latency, error });
      }
    } catch (err) {
      const latency = Date.now() - t0;
      const error = err instanceof Error ? err.message : String(err);
      const shortError = error.length > 100 ? error.slice(0, 100) + '...' : error;
      console.log(`  [FAIL]     ${endpoint.service} — ${shortError} (${latency}ms)`);
      results.push({ service: endpoint.service, status: 'fail', latencyMs: latency, error });
    }
  }

  // Summary.
  const ok = results.filter(r => r.status === 'ok').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  console.log(`\n=== Relay Check: ${ok} ok, ${failed} failed, ${skipped} skipped ===`);

  if (failed > 0) {
    console.log(`\n  Failed relays:`);
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`    ${r.service}: ${r.error}`);
    }
    console.log(`\n  Deploy the relay function: cd cloud-functions/webhook-relay && ./deploy.sh`);
  }

  console.log('');
  return results;
}
