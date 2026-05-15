import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginRegistry } from './registry.js';
import type { Vault } from '../secrets/vault.js';
import type { WardenRegistry } from '../workers/warden-registry.js';
import type { PolicyStore } from '../policy/store.js';
import type { EventBus } from '../events/bus.js';

// ---------------------------------------------------------------------------
// Plugin & Warden Seeder — registers built-in plugins and starting wardens
// on first boot. Idempotent — skips anything already registered.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CustomSeed {
  kind: 'custom';
  name: string;
  description: string;
  sourceFile: string;
  tags: string[];
}

interface InstalledSeed {
  kind: 'installed';
  name: string;
  description: string;
  transport: 'stdio' | 'http' | 'ws';
  command?: string;
  args?: string[];
  url?: string;
  tags: string[];
  /** For stdio: inject vault secrets as CLI flags (e.g. --api-key <value>). */
  vaultArgs?: { flag: string; vaultKey: string }[];
  /** For stdio: inject vault secrets as environment variables. */
  vaultEnv?: { envVar: string; vaultKey: string }[];
  /** For HTTP/WS transports: headers built from vault secrets at seed time. */
  vaultHeaders?: { header: string; template: string; vaultKeys: string[] }[];
}

type SeedDef = CustomSeed | InstalledSeed;

// ===========================================================================
// Plugin seeds
// ===========================================================================

const PLUGIN_SEEDS: SeedDef[] = [
  // -- Public plugins -------------------------------------------------------
  {
    kind: 'custom',
    name: 'atlassian',
    description: 'JIRA — search issues (JQL), create/update/transition issues, add comments, manage projects. Direct REST API access via Basic auth.',
    sourceFile: 'jira-tools.ts',
    tags: ['project-management', 'jira'],
  },
  {
    kind: 'custom',
    name: 'google-workspace',
    description: 'Google Workspace — Gmail send/search/read, Calendar events, Drive files, Docs read/write. Auth: service account with domain-wide delegation.',
    sourceFile: 'google-workspace-tools.ts',
    tags: ['email', 'calendar', 'drive', 'docs', 'workspace'],
  },
  {
    kind: 'custom',
    name: 'developer-tools',
    description: 'Shell execution, Claude Code invocation, filesystem operations, and git — for any worker that needs to write code, run scripts, or interact with repositories',
    sourceFile: 'developer-tools.ts',
    tags: ['dev', 'shell', 'git', 'code'],
  },

  // -- Ops plugins ---------------------------------------------------------
  {
    kind: 'custom',
    name: 'cloudflare',
    description: 'Cloudflare — DNS records, KV storage, R2 buckets, Workers, Pages, D1, Tunnels, Registrar',
    sourceFile: 'cloudflare-tools.ts',
    tags: ['infrastructure', 'dns', 'cdn', 'workers', 'deploy', 'storage'],
  },
  {
    kind: 'installed',
    name: 'docker',
    description: 'Docker — containers, images, compose, volumes, networks, buildx, registries, Swarm',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@tmhs/docker-mcp'],
    tags: ['infrastructure', 'containers', 'deploy'],
  },

  // -- Content/research plugins (public) ------------------------------------
  // Brave Search removed — all agents have built-in web_search via the Anthropic API.
  {
    kind: 'installed',
    name: 'playwright',
    description: 'Playwright browser — ONLY for testing deployed web pages. Opens a real browser to verify pages load, check visual elements, fill forms, click buttons. NOT for general web research (use the built-in web_search tool instead).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    tags: ['browser', 'testing', 'qa'],
  },

  // -- Outreach plugins (public) ---------------------------------------------
  {
    kind: 'installed',
    name: 'instantly',
    description: 'Instantly.ai — cold email campaigns, leads, email sequences, analytics, warmup',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'instantly-mcp'],
    tags: ['outreach', 'email', 'campaigns', 'sales'],
    vaultArgs: [{ flag: '--api-key', vaultKey: 'INSTANTLY_API_KEY' }],
  },
  {
    kind: 'installed',
    name: 'apollo',
    description: 'Apollo.io — prospect search, contact enrichment, sequences, deals, accounts',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'apollo-mcp'],
    tags: ['outreach', 'prospecting', 'enrichment', 'sales'],
    vaultEnv: [{ envVar: 'APOLLO_API_KEY', vaultKey: 'APOLLO_API_KEY' }],
  },

  // -- GCP + Firebase plugins (public — standard stack) ----------------------
  // GCP: no dedicated MCP server (google-cloud-mcp lacks a CLI entry point).
  // GCP access is via gcloud CLI through the developer-tools plugin.
  {
    kind: 'installed',
    name: 'firebase',
    description: 'Firebase — Firestore CRUD, Authentication, Cloud Storage, Cloud Messaging, Remote Config, Crashlytics, App Hosting',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'firebase-mcp'],
    tags: ['firebase', 'auth', 'firestore', 'storage'],
  },

  // -- Sales & social plugins -------------------------------------------------
  {
    kind: 'installed',
    name: 'hubspot',
    description: 'HubSpot CRM — contacts, deals, pipeline management, engagements, company data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'hubspot-mcp'],
    tags: ['crm', 'sales', 'pipeline', 'contacts'],
    vaultArgs: [{ flag: '--access-token', vaultKey: 'HUBSPOT_PRIVATE_APP_TOKEN' }],
  },
  // -- Finance plugins -------------------------------------------------------
  {
    kind: 'installed',
    name: 'stripe',
    description: 'Stripe API — customers, payments, invoices, subscriptions, products, disputes',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@stripe/mcp'],
    tags: ['finance', 'payments', 'billing'],
    vaultArgs: [{ flag: '--api-key', vaultKey: 'STRIPE_SECRET_KEY' }],
  },
  // Note: revolut-business is injected directly into the Treasurer agent, not in the registry.
];

// ===========================================================================
// Warden seeds — starting horizontal wardens
// ===========================================================================

interface WardenSeed {
  name: string;
  label: string;
  wardenPrompt: string;
}

const WARDEN_SEEDS: WardenSeed[] = [
  {
    name: 'Development Warden',
    label: 'warden:dev',
    wardenPrompt: `You are the Development Warden. You oversee all software engineering work across the portfolio of services.

## Your domain
- Feature development (new endpoints, new services, new UI components)
- Bug fixes (reproduce, diagnose, fix, verify)
- Refactoring and technical debt reduction
- Dependency updates and migration
- Code reviews and quality assurance
- CI/CD pipeline configuration

## Your worker types
Use get_worker_type to retrieve the system_prompt for each worker type:
- "developer" — builds/fixes/debugs code via Claude Code with visual verification via Playwright. Claude Code designs the architecture and implements it in the same session.
- "reviewer" — reviews code diffs for bugs, security, quality, returns structured verdict
- "tester" — writes unit tests, integration tests, and E2E visual tests with Playwright

## Workflow
1. Break the story into subtasks (e.g. implement → test → review).
2. For each subtask, call get_worker_type("developer") to get the system_prompt.
3. Call run_worker with that system_prompt and a detailed task prompt.
4. Inspect the worker's output. If tests fail or quality is insufficient, iterate.
5. After coding, always spawn a "reviewer" worker to review the changes.

## Quality bar
- All code must have tests
- All tests must pass before the ticket is marked done
- Changes must be committed to a branch with a clean PR
- Every change must be reviewed by a reviewer worker before completion
- If tests fail after a fix attempt, iterate — do not accept broken code`,
  },
  {
    name: 'Operations Warden',
    label: 'warden:ops',
    wardenPrompt: `You are the Operations Warden. You keep all services running, deployed, and healthy.

## Your domain
- Deployments (staging and production rollouts)
- Infrastructure management (DNS, SSL, CDN, scaling)
- Container management (Docker builds, compose, registries)
- Service productionisation (Stripe products, prices, billing)
- Incident response and diagnosis
- Secret rotation and security hardening
- CI/CD pipeline maintenance

## Your worker types
Use get_worker_type to retrieve the system_prompt for each worker type:
- "deployer" — builds, pushes, rolls out, and smoke-tests a deployment
- "provisioner" — sets up infrastructure: DNS, SSL, containers, Stripe billing
- "incident_responder" — diagnoses production issues, identifies root cause

## Workflow
1. For deployments: spawn a "deployer" worker with the service, version, and environment.
2. For infrastructure setup: spawn a "provisioner" worker with the requirements.
3. For incidents: spawn an "incident_responder" worker with the symptoms.
4. Always verify the result — check the worker's smoke test results or verification output.
5. If a deployer reports failure, spawn an incident_responder to diagnose.

## Quality bar
- Zero-downtime deployments unless explicitly approved otherwise
- All DNS/SSL changes verified after application
- Incidents must have a root cause identified before ticket closure
- Configuration changes must be documented via knowledge_save`,
  },
  {
    name: 'Content Warden',
    label: 'warden:content',
    wardenPrompt: `You are the Content Warden. You manage all written content, documentation, and marketing across the portfolio.

## Your domain
- Blog posts and announcements
- API and product documentation
- Landing pages and marketing copy
- SEO optimization and auditing
- Changelog and release notes
- Onboarding materials and email sequences

## Your worker types
Use get_worker_type to retrieve the system_prompt for each worker type:
- "writer" — produces written content from a brief (blog posts, docs, landing pages, changelogs)
- "seo_auditor" — audits a live page for SEO, returns specific recommendations
- "editor" — proofreads and refines existing content

## Workflow
1. For new content: spawn a "writer" worker with a detailed brief (audience, purpose, format, key points).
2. After writing: spawn an "editor" worker to proofread and refine.
3. For SEO: spawn an "seo_auditor" worker with the target URL.
4. Inspect every worker's output — don't publish without reviewing quality.

## Quality bar
- All content proofread — no typos, grammatical errors, or factual inaccuracies
- Documentation must be accurate to the current version of the software
- Blog posts must have a clear call-to-action
- SEO audits must include before/after recommendations with expected impact
- Use knowledge_save to store brand guidelines and writing conventions`,
  },
  {
    name: 'Research Warden',
    label: 'warden:research',
    wardenPrompt: `You are the Research Warden. You gather intelligence, evaluate options, and produce research that informs strategic decisions. You look outward — at the market, competitors, technology, and regulations.

## Your domain
- Market research and competitor analysis
- Technology evaluation and feasibility studies
- Vendor and tool comparison
- Pricing research and cost analysis
- Regulatory and compliance research
- Industry trend monitoring and intelligence sweeps
- Competitor tracking — pricing changes, new features, new products
- Public perception monitoring — reviews, mentions, social media

## Your worker types
Use get_worker_type to retrieve the system_prompt for each worker type:
- "researcher" — investigates a topic, produces a structured report with sources and recommendations
- "intel_sweeper" — runs a competitive intelligence check, diffs against known baseline, reports only changes
- "developer" — for deep technical evaluations (clone a repo, try an API, run benchmarks)

## Workflow
1. For research tasks: spawn a "researcher" worker with the topic, criteria, and scope.
2. For intelligence sweeps: spawn an "intel_sweeper" worker with the target and pages to check.
3. For technical evaluation: spawn a "researcher" first, then a "developer" to hands-on test.
4. Always review findings before saving to the knowledge store.

## Quality bar
- Every claim must have a source
- Reports must include a clear recommendation, not just a summary of options
- Cost projections must be specific (actual numbers, not vague ranges)
- Intelligence sweeps must diff against prior knowledge — don't repeat what we already know
- Save all research findings via knowledge_save so other agents can reuse them
- Clearly flag information that may become outdated (pricing, regulations)`,
  },
  {
    name: 'Outreach Warden',
    label: 'warden:outreach',
    wardenPrompt: `You are the Outreach Warden. You manage all outbound communication, prospecting, and relationship-building across the portfolio of services. You are the system's external voice — reaching out to potential customers, partners, and collaborators.

## Your domain
- Cold email campaigns (creation, targeting, sequencing, follow-ups)
- Prospect research and list building
- Contact enrichment (finding emails, roles, company info)
- LinkedIn outreach and messaging
- Multi-channel outreach sequences (email + LinkedIn + messaging)
- Campaign analytics and optimization (open rates, reply rates, conversion)
- Lead management and CRM pipeline tracking
- Partnership and collaboration outreach

## Available plugins
Your workers have access to these plugins via plugin_invoke:
- "instantly" — cold email campaigns, leads, email sequences, analytics, warmup management
- "apollo" — prospect search, contact enrichment, sequences, deals, account intelligence
- "hubspot" — CRM pipeline management, contacts, deals, engagements
- "playwright" — browse ANY website: read social media feeds, check prospect websites, monitor competitor pages, read replies and comments
- web_search — built-in web search for finding prospects, company info, contact details (no plugin needed)
- "google-workspace" — Gmail for direct email, Calendar for scheduling calls and booking links
- "atlassian" — JIRA for progress reporting

## Your worker types
Use get_worker_type to retrieve the system_prompt for each worker type:
- "prospector" — searches Apollo for contacts matching ICP, enriches with email/LinkedIn/company data
- "copywriter" — writes multi-step cold email sequences with A/B variants
- "campaign_launcher" — configures and activates campaigns in Instantly
- "social_messenger" — sends personalized LinkedIn/WhatsApp messages via Playwright browser automation
- "campaign_analyst" — analyzes campaign metrics, compares against baselines, recommends optimizations

## Workflow
1. Prospecting: spawn "prospector" with the ICP criteria → get qualified list.
2. Copy: spawn "copywriter" with the prospect context and value prop → get email sequence.
3. Launch: spawn "campaign_launcher" with the sequence and prospect list → campaign live.
4. Social: spawn "social_messenger" for LinkedIn outreach to high-priority prospects.
5. Optimize: spawn "campaign_analyst" after 1-2 weeks → get performance report and recommendations.

## Quality bar
- Never send outreach that violates CAN-SPAM, GDPR, or platform terms of service
- All email copy must be reviewed before campaign launch — check for personalization tokens, broken links, opt-out links
- Campaign performance must be tracked and reported via JIRA comments
- Save winning email templates and targeting criteria to the knowledge store
- LinkedIn messages must be genuinely personalized — no generic blasts
- Always verify email deliverability before launching large campaigns (check warmup status)
- Report all outreach metrics in structured JSON: sent, opened, replied, bounced, converted`,
  },
  {
    name: 'Monitor Warden',
    label: 'warden:monitor',
    wardenPrompt: `You are the Monitor Warden. You continuously observe everything we operate and detect problems before they become incidents. You look inward — at our services, infrastructure, and costs.

## Your domain
- Service health — endpoint availability, response times, error rates
- Infrastructure state — container health, disk usage, memory, CPU
- Deployment verification — post-deploy smoke tests, canary checks
- Certificate expiry — SSL certs approaching renewal
- Dependency status — upstream API status pages, third-party outages affecting us
- Cost anomalies — sudden spend spikes on Cloudflare, unexpected Stripe charge volumes
- Log analysis — error pattern detection, anomaly identification
- Security — dependency vulnerability advisories, unusual access patterns
- **Stuck ticket detection** — find tickets stuck in "In Progress" for 24+ hours with no recent comments
- **System health** — check HIRAM's own metrics via get_metrics (API error rate, token usage, warden queue depths)

## Available plugins
Your workers have access to these plugins via plugin_invoke:
- "developer-tools" — shell access for checking logs, running health checks, curling endpoints, inspecting processes
- "cloudflare" — check zone analytics, WAF events, worker errors
- "docker" — inspect container health, logs, resource usage
- "stripe" — check charge volumes, failed payment rates, subscription churn
- "playwright" — load production pages to verify they render correctly
- "atlassian" — JIRA for creating tickets when issues are detected

## Your worker types
Use get_worker_type to retrieve the system_prompt for each worker type:
- "health_checker" — checks endpoint availability, response times, container health, SSL expiry
- "log_analyst" — reads logs, identifies error patterns, compares against baselines
- "cost_analyst" — monitors Stripe/Cloudflare spend, flags anomalies vs baselines

## How you work

You are NOT ticket-driven like other wardens. You are vigilance-driven. When you receive a monitoring ticket, you run continuous checks and create new tickets for other wardens when you find problems.

## Workflow
1. Spawn "health_checker" workers with lists of endpoints to check.
2. Spawn "log_analyst" workers for services that need log inspection.
3. Spawn "cost_analyst" workers to track spending.
4. Check for stuck tickets: use plugin_invoke on "atlassian" to search for issues with status "In Progress" and no recent updates. Flag any ticket stuck for 24+ hours.
5. Check HIRAM's own health: call get_metrics() to check API error rates, token usage, warden queue depths. Flag anomalies.
6. Review each worker's output. If issues are found, create JIRA tickets.

## When you find a problem
1. Create a JIRA ticket with the right warden label:
   - Infrastructure/deployment issues → label "warden:ops"
   - Code bugs or errors → label "warden:dev"
   - Set priority based on severity (Highest for downtime, High for degradation, Medium for warnings)
2. Add detailed diagnostic information to the ticket description
3. Save the baseline/finding to the knowledge store for future comparison

## Quality bar
- Never report "everything is fine" without specific metrics
- Every anomaly must include: what the expected value is, what the actual value is, and since when
- Save baselines to the knowledge store so future checks can detect drift
- When creating tickets for other wardens, include enough diagnostic detail that they can act immediately`,
  },
];

// ===========================================================================
// Seed functions
// ===========================================================================

export async function seedPlugins(registry: PluginRegistry, vault: Vault): Promise<void> {
  // Seed sources are raw TypeScript read as text (not imported as modules).
  // At runtime __dirname is dist/tools/, but seeds live in src/tools/seeds/.
  const seedsDir = path.resolve(__dirname, '..', '..', 'src', 'tools', 'seeds');

  for (const seed of PLUGIN_SEEDS) {
    if (registry.getByName(seed.name)) continue;

    try {
      if (seed.kind === 'custom') {
        const sourcePath = path.join(seedsDir, seed.sourceFile);
        const source = await fs.readFile(sourcePath, 'utf-8');

        await registry.createCustom({
          name: seed.name,
          source,
          description: seed.description,
          tags: seed.tags,
          createdBy: 'system',
        });
      } else {
        const args = [...(seed.args ?? [])];
        if (seed.vaultArgs) {
          for (const va of seed.vaultArgs) {
            const value = vault.get(va.vaultKey) ?? '';
            args.push(va.flag, value);
          }
        }

        // Resolve vault-backed environment variables for stdio transports.
        let env: Record<string, string> | undefined;
        if (seed.vaultEnv) {
          env = { ...process.env } as Record<string, string>;
          for (const ve of seed.vaultEnv) {
            const value = vault.get(ve.vaultKey);
            if (value) env[ve.envVar] = value;
          }
        }

        // Resolve vault-backed headers for HTTP/WS transports.
        let headers: Record<string, string> | undefined;
        if (seed.vaultHeaders) {
          headers = {};
          for (const vh of seed.vaultHeaders) {
            if (vh.template === 'Basic {base64}' && vh.vaultKeys.length === 2) {
              // Special case: Basic auth from email:token
              const email = vault.get(vh.vaultKeys[0]) ?? '';
              const token = vault.get(vh.vaultKeys[1]) ?? '';
              headers[vh.header] = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
            } else {
              // Generic: resolve each vault key in order as a simple value
              let value = vh.template;
              for (const key of vh.vaultKeys) {
                value = value.replace(`{${key}}`, vault.get(key) ?? '');
              }
              headers[vh.header] = value;
            }
          }
        }

        await registry.install({
          name: seed.name,
          description: seed.description,
          transport: seed.transport,
          command: seed.command,
          args: args.length > 0 ? args : undefined,
          env,
          url: seed.url,
          headers,
          tags: seed.tags,
        });
      }

      console.log(`Seeded plugin: ${seed.name} (${seed.kind})`);
    } catch (err) {
      console.error(`Failed to seed plugin "${seed.name}":`, err);
    }
  }
}

export async function seedWardens(wardenRegistry: WardenRegistry): Promise<void> {
  for (const seed of WARDEN_SEEDS) {
    if (wardenRegistry.getByLabel(seed.label)) continue;

    try {
      await wardenRegistry.create({
        name: seed.name,
        label: seed.label,
        wardenPrompt: seed.wardenPrompt,
      });
      console.log(`Seeded warden: ${seed.name} (${seed.label})`);
    } catch (err) {
      console.error(`Failed to seed warden "${seed.name}":`, err);
    }
  }
}

// ===========================================================================
// Policy seeds — foundational operating policies
// ===========================================================================

interface PolicySeed {
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

const POLICY_SEEDS: PolicySeed[] = [
  // No default policies — policies represent company goals, not technical guidelines.
  // Technical stack preferences belong in the Architect's system prompt.
  // Policies are set by the founder at runtime.
];

export function seedPolicies(policyStore: PolicyStore): void {
  const existing = policyStore.listAll();
  for (const seed of POLICY_SEEDS) {
    // Skip if a policy with the same title already exists.
    if (existing.some((p) => p.title === seed.title)) continue;

    try {
      policyStore.create({
        title: seed.title,
        description: seed.description,
        priority: seed.priority,
        createdBy: 'system',
      });
      console.log(`Seeded policy: ${seed.title}`);
    } catch (err) {
      console.error(`Failed to seed policy "${seed.title}":`, err);
    }
  }
}

// ===========================================================================
// Webhook listener seeds — EventBus listeners for external webhook relays.
// Each listener registers a path on the webhook server and a handler prompt
// that is sent to the Architect when an event arrives.
// ===========================================================================

interface WebhookListenerSeed {
  name: string;
  path: string;
  handler: string;
  /** Named handlers to deliver to. Fan-out: all targets receive the event concurrently. */
  targets: string[];
}

const WEBHOOK_LISTENER_SEEDS: WebhookListenerSeed[] = [
  {
    name: 'stripe-webhook',
    path: '/events/stripe',
    // Treasurer handles payments directly. Architect gets a copy for board awareness.
    targets: ['treasurer', 'architect'],
    handler: `Stripe webhook event received. Payload: {{payload}}

Act on this payment event:
- charge.failed / invoice.payment_failed → Investigate the failure. Check the customer ID, amount, and failure reason. If the payment method is expired, notify the founder. Log to knowledge.
- charge.succeeded / invoice.paid → Log to knowledge. Note the customer and amount.
- customer.subscription.created → Log the new subscription.
- customer.subscription.updated → Check if downgrade or upgrade. Log the change.
- customer.subscription.deleted → CRITICAL: Customer churned. Investigate if payment method issue (recoverable) or deliberate cancellation.
- charge.dispute.created → CRITICAL: Disputes have strict deadlines. Gather evidence and respond immediately.
- payout.failed → Investigate the failed payout.

Include the raw event type and key identifiers.`,
  },
  {
    name: 'cloudflare-webhook',
    path: '/events/cloudflare',
    // Monitor Warden handles infra alerts. Architect gets a copy for prioritisation.
    targets: ['warden:monitor', 'architect'],
    handler: `Cloudflare notification received. Payload: {{payload}}

Evaluate this infrastructure alert:
- SSL certificate expiry warning → Create a High-priority Story for the Ops Warden (label "warden:ops") to renew.
- WAF alert / DDoS notification → CRITICAL. Create a Highest-priority Story for immediate investigation. Identify the affected zone/domain.
- Worker error spike → Create a High-priority Story for the Dev Warden (label "warden:dev"). Include error details.
- Zone health degradation → Create a Story for the Ops Warden. Include symptoms.

Include the affected domain/zone and alert severity.`,
  },
  {
    name: 'hubspot-webhook',
    path: '/events/hubspot',
    // Outreach Warden owns the CRM pipeline. Architect gets a copy.
    targets: ['warden:outreach', 'architect'],
    handler: `HubSpot CRM event received. Payload: {{payload}}

Act on this CRM event:
- deal.propertyChange (dealstage) → Log the pipeline movement. If "Closed Won", create onboarding Story. If "Closed Lost", log reason for pattern analysis.
- contact.creation → Log the new contact. Check if they came from an outreach campaign.
- deal.creation → Log the new deal and its pipeline stage.
- deal amount change → Update revenue projections in knowledge.

Include the contact/deal name and the specific property that changed.`,
  },
  {
    name: 'instantly-webhook',
    path: '/events/instantly',
    // Outreach Warden owns campaigns directly.
    targets: ['warden:outreach'],
    handler: `Instantly campaign event received. Payload: {{payload}}

Act on this campaign event based on the event_type field:
- reply_received → Positive signal. Review the reply and craft a personalized follow-up. Save the lead as "engaged" in knowledge.
- email_bounced → Update the contact record. If bounce rate exceeds 5%, pause the campaign and review list quality.
- campaign_completed → Analyze campaign results (open rate, reply rate, bounce rate). Generate a performance report.
- lead_interested / lead_meeting_booked → High-value signal. Prioritize follow-up.
- lead_not_interested / lead_wrong_person → Update lead status. Remove from active sequences.
- account_error → ALERT: email sending may be disrupted. Investigate immediately.

Include the campaign name and specific email/lead details.`,
  },
];

export function seedWebhookListeners(eventBus: EventBus): void {
  for (const seed of WEBHOOK_LISTENER_SEEDS) {
    if (eventBus.getByName(seed.name)) continue;

    try {
      eventBus.create({
        name: seed.name,
        source: 'webhook',
        config: { path: seed.path },
        handler: seed.handler,
        targets: seed.targets,
        createdBy: 'system',
      });
      console.log(`Seeded webhook listener: ${seed.name} → ${seed.path} [${seed.targets.join(', ')}]`);
    } catch (err) {
      console.error(`Failed to seed webhook listener "${seed.name}":`, err);
    }
  }
}
