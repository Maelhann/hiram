import type { Vault } from '../secrets/vault.js';

// ---------------------------------------------------------------------------
// Webhook Registration — auto-registers webhook endpoints with external
// services on boot. Idempotent: checks if our URL already exists before
// creating. Runs after the relay check confirms the Cloud Function is up.
//
// Services with API-based webhook registration:
//   - Stripe: POST /v1/webhook_endpoints → returns signing secret
//   - Instantly: POST /api/v2/webhooks
//   - JIRA: POST /rest/webhooks/1.0/webhook (direct to HIRAM, not relay)
//   - Cloudflare: POST /client/v4/accounts/{id}/alerting/v3/destinations/webhooks
//
// Services requiring manual setup:
//   - HubSpot: webhook subscriptions require a Developer App (not Private App)
// ---------------------------------------------------------------------------

const CLOUD_FUNCTION_REGION = 'europe-west1';
const GCP_PROJECT = process.env.GCP_PROJECT_ID ?? process.env.VAULT_GCP_PROJECT_ID ?? '';
const FUNCTION_NAME = 'webhook-relay';

export const RELAY_BASE_URL =
  `https://${CLOUD_FUNCTION_REGION}-${GCP_PROJECT}.cloudfunctions.net/${FUNCTION_NAME}`;

export interface RegistrationResult {
  service: string;
  status: 'ok' | 'exists' | 'created' | 'fail' | 'skip';
  url?: string;
  error?: string;
}

export async function registerWebhooks(vault: Vault): Promise<RegistrationResult[]> {
  console.log('\n=== Webhook Registration ===\n');

  const results: RegistrationResult[] = [];

  results.push(await registerStripe(vault));
  results.push(await registerInstantly(vault));
  results.push(await registerJira(vault));
  results.push(await registerCloudflare(vault));
  results.push(await registerHubspot(vault));

  // Summary.
  const created = results.filter(r => r.status === 'created').length;
  const existing = results.filter(r => r.status === 'exists' || r.status === 'ok').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  console.log(`\n=== Registration: ${created} created, ${existing} existing, ${failed} failed, ${skipped} skipped ===`);
  console.log('');

  return results;
}

// ---------------------------------------------------------------------------
// Stripe — POST /v1/webhook_endpoints
//
// Auth: Bearer STRIPE_SECRET_KEY
// Content-Type: application/x-www-form-urlencoded
// On creation, the response includes `secret` (the webhook signing secret).
// We auto-save it to the vault as STRIPE_WEBHOOK_SECRET.
// ---------------------------------------------------------------------------

const STRIPE_EVENTS = [
  'charge.failed',
  'charge.succeeded',
  'charge.refunded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
  'charge.dispute.created',
  'payout.failed',
];

async function registerStripe(vault: Vault): Promise<RegistrationResult> {
  const apiKey = vault.get('STRIPE_SECRET_KEY');
  if (!apiKey) {
    console.log('  [SKIP]     stripe — STRIPE_SECRET_KEY not set');
    return { service: 'stripe', status: 'skip', error: 'STRIPE_SECRET_KEY not set' };
  }

  const targetUrl = `${RELAY_BASE_URL}/relay/stripe`;
  const headers = { Authorization: `Bearer ${apiKey}` };

  try {
    // List existing webhook endpoints.
    const listRes = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!listRes.ok) {
      const err = await listRes.text();
      throw new Error(`List failed: ${listRes.status} ${err.slice(0, 200)}`);
    }

    const listData = await listRes.json() as { data: { id: string; url: string; status: string }[] };
    const existing = listData.data.find(ep => ep.url === targetUrl);

    if (existing) {
      console.log(`  [EXISTS]   stripe — webhook already registered (${existing.id})`);
      return { service: 'stripe', status: 'exists', url: targetUrl };
    }

    // Create new webhook endpoint.
    const params = new URLSearchParams();
    params.append('url', targetUrl);
    for (const event of STRIPE_EVENTS) {
      params.append('enabled_events[]', event);
    }
    params.append('description', 'HIRAM webhook relay');

    const createRes = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Create failed: ${createRes.status} ${err.slice(0, 200)}`);
    }

    const created = await createRes.json() as { id: string; secret: string };

    // Auto-save the webhook signing secret to the vault.
    if (created.secret) {
      vault.set('STRIPE_WEBHOOK_SECRET', created.secret);
      console.log(`  [CREATED]  stripe — endpoint ${created.id}, signing secret saved to vault`);
    } else {
      console.log(`  [CREATED]  stripe — endpoint ${created.id} (no secret returned)`);
    }

    return { service: 'stripe', status: 'created', url: targetUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL]     stripe — ${msg.slice(0, 120)}`);
    return { service: 'stripe', status: 'fail', error: msg };
  }
}

// ---------------------------------------------------------------------------
// Instantly — POST /api/v2/webhooks
//
// Auth: Bearer INSTANTLY_API_KEY
// Content-Type: application/json
// First lists event types, then creates webhooks for each.
// ---------------------------------------------------------------------------

async function registerInstantly(vault: Vault): Promise<RegistrationResult> {
  const apiKey = vault.get('INSTANTLY_API_KEY');
  if (!apiKey) {
    console.log('  [SKIP]     instantly — INSTANTLY_API_KEY not set');
    return { service: 'instantly', status: 'skip', error: 'INSTANTLY_API_KEY not set' };
  }

  const targetUrl = `${RELAY_BASE_URL}/relay/instantly`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // List existing webhooks.
    const listRes = await fetch('https://api.instantly.ai/api/v2/webhooks', {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!listRes.ok) {
      const err = await listRes.text();
      throw new Error(`List failed: ${listRes.status} ${err.slice(0, 200)}`);
    }

    const listData = await listRes.json() as {
      items?: { id: string; target_hook_url: string; event_type: string }[];
    };
    const existing = (listData.items ?? []).filter(wh => wh.target_hook_url === targetUrl);

    if (existing.length > 0) {
      const types = existing.map(w => w.event_type).join(', ');
      console.log(`  [EXISTS]   instantly — webhook already registered (${types})`);
      return { service: 'instantly', status: 'exists', url: targetUrl };
    }

    // Register a single webhook with all_events (catches everything).
    const createRes = await fetch('https://api.instantly.ai/api/v2/webhooks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ target_hook_url: targetUrl, event_type: 'all_events' }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Create failed: ${createRes.status} ${err.slice(0, 200)}`);
    }

    const created = await createRes.json() as { id: string };
    console.log(`  [CREATED]  instantly — webhook ${created.id} (all_events)`);
    return { service: 'instantly', status: 'created', url: targetUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL]     instantly — ${msg.slice(0, 120)}`);
    return { service: 'instantly', status: 'fail', error: msg };
  }
}

// ---------------------------------------------------------------------------
// JIRA — POST /rest/webhooks/1.0/webhook
//
// Auth: Basic base64(ATLASSIAN_EMAIL:ATLASSIAN_API_TOKEN)
// Goes directly to HIRAM (not via relay) since JIRA has its own handler.
// ---------------------------------------------------------------------------

async function registerJira(vault: Vault): Promise<RegistrationResult> {
  const email = vault.get('ATLASSIAN_EMAIL');
  const token = vault.get('ATLASSIAN_API_TOKEN');
  const siteUrl = vault.get('ATLASSIAN_SITE_URL');
  const hiramUrl = vault.get('HIRAM_PUBLIC_URL');

  if (!email || !token) {
    console.log('  [SKIP]     jira — ATLASSIAN_EMAIL or ATLASSIAN_API_TOKEN not set');
    return { service: 'jira', status: 'skip', error: 'Atlassian credentials not set' };
  }

  if (!siteUrl) {
    console.log('  [SKIP]     jira — ATLASSIAN_SITE_URL not set (e.g. "https://yoursite.atlassian.net")');
    return { service: 'jira', status: 'skip', error: 'ATLASSIAN_SITE_URL not set' };
  }

  if (!hiramUrl) {
    console.log('  [SKIP]     jira — HIRAM_PUBLIC_URL not set (Cloudflare Tunnel URL)');
    return { service: 'jira', status: 'skip', error: 'HIRAM_PUBLIC_URL not set' };
  }

  const targetUrl = `${hiramUrl}/webhook/jira`;
  const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    // List existing webhooks.
    const listRes = await fetch(`${siteUrl}/rest/webhooks/1.0/webhook`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!listRes.ok) {
      const err = await listRes.text();
      throw new Error(`List failed: ${listRes.status} ${err.slice(0, 200)}`);
    }

    const existing = await listRes.json() as { name: string; url: string; self?: string }[];
    const ours = existing.find(wh => wh.url === targetUrl);

    if (ours) {
      console.log(`  [EXISTS]   jira — webhook already registered`);
      return { service: 'jira', status: 'exists', url: targetUrl };
    }

    // Create webhook.
    const createRes = await fetch(`${siteUrl}/rest/webhooks/1.0/webhook`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'HIRAM',
        url: targetUrl,
        events: [
          'jira:issue_created',
          'jira:issue_updated',
          'jira:issue_deleted',
        ],
        excludeBody: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Create failed: ${createRes.status} ${err.slice(0, 200)}`);
    }

    console.log(`  [CREATED]  jira — webhook registered at ${targetUrl}`);
    return { service: 'jira', status: 'created', url: targetUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL]     jira — ${msg.slice(0, 120)}`);
    return { service: 'jira', status: 'fail', error: msg };
  }
}

// ---------------------------------------------------------------------------
// Cloudflare — register a webhook destination for alerts.
//
// Auth: Bearer CLOUDFLARE_API_TOKEN
// Step 1: GET /client/v4/accounts → get account_id
// Step 2: List/create webhook destination
// Note: notification POLICIES (what alerts trigger the webhook) must still
// be configured in the dashboard — the API only registers the destination.
// ---------------------------------------------------------------------------

async function registerCloudflare(vault: Vault): Promise<RegistrationResult> {
  const apiToken = vault.get('CLOUDFLARE_API_TOKEN');
  if (!apiToken) {
    console.log('  [SKIP]     cloudflare — CLOUDFLARE_API_TOKEN not set');
    return { service: 'cloudflare', status: 'skip', error: 'CLOUDFLARE_API_TOKEN not set' };
  }

  const targetUrl = `${RELAY_BASE_URL}/relay/cloudflare`;

  // Support both API Token (Bearer) and Global API Key (X-Auth-Key + X-Auth-Email).
  // Global keys start with "cfk_", API tokens start with "cfat_" or similar.
  const cfEmail = vault.get('CLOUDFLARE_EMAIL');
  const headers: Record<string, string> = cfEmail
    ? { 'X-Auth-Key': apiToken, 'X-Auth-Email': cfEmail, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  try {
    // Get account ID.
    const acctRes = await fetch('https://api.cloudflare.com/client/v4/accounts?page=1&per_page=1', {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!acctRes.ok) {
      const err = await acctRes.text();
      throw new Error(`Account list failed: ${acctRes.status} ${err.slice(0, 200)}`);
    }

    const acctData = await acctRes.json() as { result: { id: string }[] };
    if (!acctData.result?.[0]) {
      throw new Error('No Cloudflare accounts found');
    }
    const accountId = acctData.result[0].id;

    // List existing webhook destinations.
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/alerting/v3/destinations/webhooks`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );

    if (!listRes.ok) {
      const err = await listRes.text();
      throw new Error(`List destinations failed: ${listRes.status} ${err.slice(0, 200)}`);
    }

    const listData = await listRes.json() as { result: { id: string; name: string; url: string }[] };
    const existing = listData.result?.find(d => d.url === targetUrl);

    if (existing) {
      console.log(`  [EXISTS]   cloudflare — webhook destination "${existing.name}" already registered`);
      return { service: 'cloudflare', status: 'exists', url: targetUrl };
    }

    // Create webhook destination.
    const createRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/alerting/v3/destinations/webhooks`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'HIRAM Relay', url: targetUrl }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Create destination failed: ${createRes.status} ${err.slice(0, 200)}`);
    }

    console.log(`  [CREATED]  cloudflare — webhook destination registered (notification policies need manual setup in dashboard)`);
    return { service: 'cloudflare', status: 'created', url: targetUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL]     cloudflare — ${msg.slice(0, 120)}`);
    return { service: 'cloudflare', status: 'fail', error: msg };
  }
}

// ---------------------------------------------------------------------------
// HubSpot — webhook subscriptions via Developer API key + App ID.
//
// Auth: hapikey query param (Developer API key)
// Step 1: Find or discover the App ID
// Step 2: Configure webhook target URL
// Step 3: Subscribe to deal/contact/engagement events
// ---------------------------------------------------------------------------

async function registerHubspot(vault: Vault): Promise<RegistrationResult> {
  const devKey = vault.get('HUBSPOT_DEVELOPER_API_KEY');
  if (!devKey) {
    console.log('  [SKIP]     hubspot — HUBSPOT_DEVELOPER_API_KEY not set');
    return { service: 'hubspot', status: 'skip', error: 'Developer API key not set' };
  }

  const appId = vault.get('HUBSPOT_APP_ID');
  if (!appId) {
    console.log('  [SKIP]     hubspot — HUBSPOT_APP_ID not set (create an app in the HubSpot developer portal, then set VAULT_HUBSPOT_APP_ID)');
    return { service: 'hubspot', status: 'skip', error: 'HUBSPOT_APP_ID not set' };
  }

  const targetUrl = `${RELAY_BASE_URL}/relay/hubspot`;

  try {
    // Configure the webhook target URL for this app.
    const settingsRes = await fetch(
      `https://api.hubapi.com/webhooks/v3/${appId}/settings?hapikey=${devKey}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl, throttling: { maxConcurrentRequests: 10, period: 'SECONDLY' } }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!settingsRes.ok) {
      const err = await settingsRes.text();
      throw new Error(`Settings failed: ${settingsRes.status} ${err.slice(0, 200)}`);
    }

    // List existing subscriptions.
    const listRes = await fetch(
      `https://api.hubapi.com/webhooks/v3/${appId}/subscriptions?hapikey=${devKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const listData = await listRes.json() as { results?: { eventType: string; active: boolean }[] };
    const existing = (listData.results ?? []).map(s => s.eventType);

    // Subscribe to key events if not already subscribed.
    const events = [
      'deal.propertyChange',
      'deal.creation',
      'deal.deletion',
      'contact.creation',
      'contact.propertyChange',
    ];

    let created = 0;
    for (const eventType of events) {
      if (existing.includes(eventType)) continue;

      const subRes = await fetch(
        `https://api.hubapi.com/webhooks/v3/${appId}/subscriptions?hapikey=${devKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventType, active: true }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (subRes.ok) created++;
    }

    if (created > 0) {
      console.log(`  [CREATED]  hubspot — ${created} webhook subscription(s), target: ${targetUrl}`);
      return { service: 'hubspot', status: 'created', url: targetUrl };
    } else {
      console.log(`  [EXISTS]   hubspot — ${existing.length} subscription(s) already active`);
      return { service: 'hubspot', status: 'exists', url: targetUrl };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL]     hubspot — ${msg.slice(0, 120)}`);
    return { service: 'hubspot', status: 'fail', error: msg };
  }
}
