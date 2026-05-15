import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Webhook signature validators — one per external service.
//
// Each validator receives the raw request body and headers, and returns
// true if the webhook is authentic. All use Node.js built-in crypto —
// no external SDKs required.
// ---------------------------------------------------------------------------

export type ValidatorFn = (rawBody: Buffer, headers: Record<string, string | string[] | undefined>) => boolean;

/** Get the appropriate validator for a service. Returns null if no validation is configured. */
export function getValidator(service: string): ValidatorFn | null {
  switch (service) {
    case 'stripe': return validateStripe;
    case 'cloudflare': return validateCloudflare;
    case 'hubspot': return validateHubspot;
    case 'instantly': return validateInstantly;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Stripe — HMAC-SHA256 with v1 signature scheme.
//
// Header: stripe-signature = t=<timestamp>,v1=<sig1>,v1=<sig2>,...
// Signed payload: "<timestamp>.<raw_body>"
// Secret: STRIPE_WEBHOOK_SECRET (whsec_...)
// ---------------------------------------------------------------------------

function validateStripe(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
  const sig = headerValue(headers, 'stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) return false;

  const elements = sig.split(',');
  const timestamp = elements.find(e => e.startsWith('t='))?.slice(2);
  const v1Signatures = elements
    .filter(e => e.startsWith('v1='))
    .map(e => e.slice(3));

  if (!timestamp || v1Signatures.length === 0) return false;

  // Reject events older than 5 minutes (replay protection).
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Math.abs(age) > 300) return false;

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return v1Signatures.some(s => {
    try {
      return crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Cloudflare — shared webhook token in header.
//
// Header: cf-webhook-auth = <token>
// Secret: CLOUDFLARE_WEBHOOK_TOKEN
// ---------------------------------------------------------------------------

function validateCloudflare(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
  const token = headerValue(headers, 'cf-webhook-auth');
  const expected = process.env.CLOUDFLARE_WEBHOOK_TOKEN;

  // If no token is configured, skip validation (allow all).
  if (!expected) return true;
  if (!token) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HubSpot — HMAC-SHA256 v3 signature.
//
// Header: X-HubSpot-Signature-Version = v3
//         X-HubSpot-Signature = <base64-hmac>
//         X-HubSpot-Request-Timestamp = <ms-timestamp>
// Signed payload: "<method><url><body><timestamp>"
// Secret: HUBSPOT_CLIENT_SECRET
// ---------------------------------------------------------------------------

function validateHubspot(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
  const signature = headerValue(headers, 'x-hubspot-signature');
  const timestamp = headerValue(headers, 'x-hubspot-request-timestamp');
  const secret = process.env.HUBSPOT_CLIENT_SECRET;

  // If no secret is configured, skip validation.
  if (!secret) return true;
  if (!signature || !timestamp) return false;

  // Reject events older than 5 minutes.
  const age = Date.now() - parseInt(timestamp, 10);
  if (Math.abs(age) > 300_000) return false;

  // HubSpot v3: HMAC-SHA256 of "POST<requestURI><body><timestamp>"
  // We use a generic URI since the Cloud Function URL is stable.
  const requestUri = process.env.HUBSPOT_WEBHOOK_URI ?? '';
  const payload = `POST${requestUri}${rawBody.toString('utf8')}${timestamp}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Instantly — no standard signature scheme. Accept all if no secret is set.
// If INSTANTLY_WEBHOOK_SECRET is configured, check the Authorization header.
// ---------------------------------------------------------------------------

function validateInstantly(_rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (!secret) return true;

  const auth = headerValue(headers, 'authorization');
  if (!auth) return false;

  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a single header value (case-insensitive). */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key) return undefined;
  const val = headers[key];
  return Array.isArray(val) ? val[0] : val;
}
