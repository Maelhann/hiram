import { http } from '@google-cloud/functions-framework';
import { getValidator } from './validators.js';

// ---------------------------------------------------------------------------
// Webhook Relay — unified GCP Cloud Function for all external webhooks.
//
// Receives webhooks from Stripe, Cloudflare, HubSpot, and Instantly.
// Validates signatures per service, then forwards the raw payload to
// HIRAM's EventBus via Cloudflare Tunnel.
//
// Path routing: POST /relay/<service>
//   - /relay/stripe     → validates stripe-signature, forwards to /events/stripe
//   - /relay/cloudflare → validates cf-webhook-auth, forwards to /events/cloudflare
//   - /relay/hubspot    → validates X-HubSpot-Signature, forwards to /events/hubspot
//   - /relay/instantly  → validates auth header, forwards to /events/instantly
//
// GET /relay/* returns 200 for health probes (HIRAM boot checks).
// ---------------------------------------------------------------------------

const SUPPORTED_SERVICES = ['stripe', 'cloudflare', 'hubspot', 'instantly'];

http('webhookRelay', async (req, res) => {
  // Health probe — HIRAM pings this on boot to verify the function is deployed.
  if (req.method === 'GET') {
    res.status(200).json({
      status: 'ok',
      service: 'webhook-relay',
      supported: SUPPORTED_SERVICES,
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  // Extract service from path: /relay/stripe → stripe
  const pathParts = req.path.split('/').filter(Boolean);
  if (pathParts.length < 2 || pathParts[0] !== 'relay') {
    res.status(400).json({
      error: 'Invalid path. Expected /relay/<service>',
      supported: SUPPORTED_SERVICES,
    });
    return;
  }

  const service = pathParts[1];
  if (!SUPPORTED_SERVICES.includes(service)) {
    res.status(404).json({
      error: `Unknown service: ${service}`,
      supported: SUPPORTED_SERVICES,
    });
    return;
  }

  // Validate webhook signature.
  const validator = getValidator(service);
  if (validator) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      res.status(400).send('Missing request body');
      return;
    }

    const valid = validator(rawBody, req.headers);
    if (!valid) {
      console.warn(`[RELAY] ${service}: signature validation failed`);
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }
  }

  // Forward to HIRAM.
  const hiramUrl = process.env.HIRAM_WEBHOOK_URL;
  const relaySecret = process.env.WEBHOOK_RELAY_SECRET;

  if (!hiramUrl || !relaySecret) {
    console.error('[RELAY] Missing HIRAM_WEBHOOK_URL or WEBHOOK_RELAY_SECRET env vars');
    // Still return 200 to external service — don't trigger retries for config issues.
    res.status(200).send('Accepted (relay not configured)');
    return;
  }

  const forwardUrl = `${hiramUrl}/events/${service}`;

  try {
    const response = await fetch(forwardUrl, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] ?? 'application/json',
        'X-Relay-Secret': relaySecret,
        'X-Original-Service': service,
      },
      body: req.rawBody ? new Uint8Array(req.rawBody) : req.body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[RELAY] ${service}: HIRAM returned ${response.status}`);
    }

    // Always return 200 to external service.
    res.status(200).json({
      relayed: true,
      service,
      hiram_status: response.status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[RELAY] ${service}: failed to forward to HIRAM — ${message}`);

    // Return 200 to prevent the external service from retrying excessively.
    // The event is lost, but retries would also fail if HIRAM is down.
    res.status(200).json({
      relayed: false,
      service,
      error: 'Forwarding failed — HIRAM may be unavailable',
    });
  }
});
