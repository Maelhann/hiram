import type { Vault } from './vault.js';
import type { BootLogger } from '../boot-logger.js';

// ---------------------------------------------------------------------------
// Vault Seeder — populates the vault with all required secrets on first boot.
//
// Reads secrets from environment variables (prefixed with VAULT_SEED_) or
// from a seed file at VAULT_SEED_FILE. If a secret already exists in the
// vault, it is NOT overwritten (idempotent).
//
// On a fresh server, the .env file (or systemd env) contains the secrets.
// After the first boot, they're encrypted in SQLite and the env vars can
// be removed.
// ---------------------------------------------------------------------------

interface SecretDef {
  /** Vault key name. */
  name: string;
  /** Environment variable to read the value from. */
  envVar: string;
  /** Human-readable description (for logging). */
  label: string;
  /** If true, the secret is required for critical functionality. */
  critical?: boolean;
}

const SECRETS: SecretDef[] = [
  // --- Infrastructure ---
  { name: 'CLOUDFLARE_API_TOKEN', envVar: 'VAULT_CLOUDFLARE_API_TOKEN', label: 'Cloudflare API key', critical: true },
  { name: 'CLOUDFLARE_EMAIL', envVar: 'VAULT_CLOUDFLARE_EMAIL', label: 'Cloudflare account email' },
  { name: 'CLOUDFLARE_ACCOUNT_ID', envVar: 'VAULT_CLOUDFLARE_ACCOUNT_ID', label: 'Cloudflare account ID' },
  { name: 'GCP_CLIENT_EMAIL', envVar: 'VAULT_GCP_CLIENT_EMAIL', label: 'GCP service account email' },
  { name: 'GCP_PROJECT_ID', envVar: 'VAULT_GCP_PROJECT_ID', label: 'GCP project ID' },
  { name: 'GCP_PRIVATE_KEY_ID', envVar: 'VAULT_GCP_PRIVATE_KEY_ID', label: 'GCP private key ID' },
  { name: 'GCP_CLIENT_ID', envVar: 'VAULT_GCP_CLIENT_ID', label: 'GCP client ID' },
  { name: 'GCP_PRIVATE_KEY_B64', envVar: 'VAULT_GCP_PRIVATE_KEY_B64', label: 'GCP private key (base64)' },

  // --- Finance ---
  { name: 'STRIPE_SECRET_KEY', envVar: 'VAULT_STRIPE_SECRET_KEY', label: 'Stripe secret key', critical: true },

  // --- Outreach & Sales ---
  { name: 'INSTANTLY_API_KEY', envVar: 'VAULT_INSTANTLY_API_KEY', label: 'Instantly API key' },
  { name: 'APOLLO_API_KEY', envVar: 'VAULT_APOLLO_API_KEY', label: 'Apollo API key' },
  { name: 'HUBSPOT_PRIVATE_APP_TOKEN', envVar: 'VAULT_HUBSPOT_PRIVATE_APP_TOKEN', label: 'HubSpot private app token' },
  { name: 'HUBSPOT_DEVELOPER_API_KEY', envVar: 'VAULT_HUBSPOT_DEVELOPER_API_KEY', label: 'HubSpot developer API key' },
  { name: 'HUBSPOT_APP_ID', envVar: 'VAULT_HUBSPOT_APP_ID', label: 'HubSpot app ID (for webhook subscriptions)' },
  { name: 'BRAVE_SEARCH_API_KEY', envVar: 'VAULT_BRAVE_SEARCH_API_KEY', label: 'Brave Search API key' },

  // --- Ordo Studio ---
  { name: 'ORDO_STUDIO_API_KEY', envVar: 'VAULT_ORDO_STUDIO_API_KEY', label: 'Ordo Studio API key' },

  // --- Atlassian ---
  { name: 'ATLASSIAN_EMAIL', envVar: 'VAULT_ATLASSIAN_EMAIL', label: 'Atlassian email', critical: true },
  { name: 'ATLASSIAN_API_TOKEN', envVar: 'VAULT_ATLASSIAN_API_TOKEN', label: 'Atlassian API token', critical: true },
  { name: 'ATLASSIAN_SITE_URL', envVar: 'VAULT_ATLASSIAN_SITE_URL', label: 'Atlassian site URL' },

  // --- Webhook relay ---
  { name: 'WEBHOOK_RELAY_SECRET', envVar: 'VAULT_WEBHOOK_RELAY_SECRET', label: 'Webhook relay shared secret' },
  { name: 'STRIPE_WEBHOOK_SECRET', envVar: 'VAULT_STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret' },

  // --- GitHub ---
  { name: 'GITHUB_TOKEN', envVar: 'VAULT_GITHUB_TOKEN', label: 'GitHub PAT', critical: true },

  // --- Core system ---
  { name: 'VOYAGE_API_KEY', envVar: 'VAULT_VOYAGE_API_KEY', label: 'Voyage AI API key' },
  { name: 'TELEGRAM_BOT_TOKEN', envVar: 'VAULT_TELEGRAM_BOT_TOKEN', label: 'Telegram bot token' },
  { name: 'FOUNDER_EMAIL', envVar: 'VAULT_FOUNDER_EMAIL', label: 'Founder email' },

  // --- Tunnel ---
  { name: 'CLOUDFLARE_TUNNEL_TOKEN', envVar: 'VAULT_CLOUDFLARE_TUNNEL_TOKEN', label: 'Cloudflare Tunnel token' },
  { name: 'HIRAM_PUBLIC_URL', envVar: 'VAULT_HIRAM_PUBLIC_URL', label: 'HIRAM public URL' },
  { name: 'GIT_EMAIL', envVar: 'VAULT_GIT_EMAIL', label: 'Git commit email for agents' },
];

export function seedVault(vault: Vault, log: BootLogger): void {
  let seeded = 0;
  let existing = 0;
  let missing = 0;

  for (const secret of SECRETS) {
    // Already in vault — skip.
    if (vault.get(secret.name)) {
      existing++;
      continue;
    }

    // Try to read from environment.
    const value = process.env[secret.envVar];
    if (value) {
      vault.set(secret.name, value);
      seeded++;
      log.ok(`${secret.label} ${DIM}(seeded from ${secret.envVar})${RESET}`);
    } else {
      missing++;
      if (secret.critical) {
        log.warn(`${secret.label} — not set ${DIM}(set ${secret.envVar} in .env)${RESET}`);
      }
    }
  }

  if (seeded > 0) {
    log.info(`${seeded} secret(s) seeded into vault from environment`);
  }
  if (existing > 0) {
    log.ok(`${existing} secret(s) already in vault`);
  }
  if (missing > 0 && seeded === 0 && existing === 0) {
    log.warn(`No secrets found — set VAULT_* env vars in .env for first-time setup`);
  }
}

// Re-export colour codes used in templates above.
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
