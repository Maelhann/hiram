import type Database from 'better-sqlite3';
import { Redis } from 'ioredis';
import { loadConfig, type HiramConfig } from './config.js';
import { initDatabase } from './db/schema.js';
import { PluginRegistry } from './tools/registry.js';
import { seedPlugins, seedWardens, seedPolicies, seedWebhookListeners } from './tools/seeder.js';
import { Vault } from './secrets/vault.js';
import { seedVault } from './secrets/seed.js';
import { WebhookServer } from './jira/webhook-server.js';
import { KnowledgeStore } from './knowledge/store.js';
import { WardenRegistry } from './workers/warden-registry.js';
import { Architect } from './workers/architect.js';
import type { AgentDeps } from './workers/base-agent.js';
import { Treasurer } from './workers/treasurer.js';
import { Secretary } from './workers/secretary.js';
import { Expert } from './workers/expert.js';
import { ContactGateway } from './messaging/gateway.js';
import { runHealthCheck } from './tools/health-check.js';
import { runToolRunway } from './tools/runway.js';
import { runWebhookRelayCheck } from './tools/webhook-relay-check.js';
import { registerWebhooks } from './tools/webhook-registration.js';
import { BackupService, restoreIfNeeded } from './backup.js';
import { Supervisor } from './supervisor.js';
import { Scheduler } from './scheduler.js';
import { CliServer } from './cli-server.js';
import { Workspace } from './workspace.js';
import { TelemetryCollector } from './telemetry/collector.js';
import { PolicyStore } from './policy/store.js';
import { EventBus } from './events/bus.js';
import { AgentTracker } from './workers/agent-tracker.js';
import { HookEngine } from './hooks/hook-engine.js';
import { registerSafetyHooks } from './hooks/safety-hooks.js';
import { startTunnel, stopTunnel } from './tunnel.js';
import { configureGit } from './git-config.js';
import { BootLogger } from './boot-logger.js';
import { BotCommands } from './messaging/bot-commands.js';

// ---------------------------------------------------------------------------
// DaemonContext — returned by boot(), gives full access to all services.
// Used by E2E tests to inject events, set policies, and inspect state.
// ---------------------------------------------------------------------------

export interface DaemonContext {
  config: HiramConfig;
  db: Database.Database;
  redis: Redis;
  vault: Vault;
  pluginRegistry: PluginRegistry;
  knowledge: KnowledgeStore;
  workspace: Workspace;
  telemetry: TelemetryCollector;
  policyStore: PolicyStore;
  eventBus: EventBus;
  hooks: HookEngine;
  tracker: AgentTracker;
  webhookServer: WebhookServer;
  wardenRegistry: WardenRegistry;
  architect: Architect;
  treasurer: Treasurer;
  secretary: Secretary;
  expert: Expert;
  contactGateway: ContactGateway;
  backup: BackupService;
  supervisor: Supervisor;
  scheduler: Scheduler;
  cliServer: CliServer;
  shutdown: () => Promise<void>;
}

export interface BootOverrides {
  sqlitePath?: string;
  webhookPort?: number;
  workspaceRoot?: string;
  toolsDir?: string;
  skipTunnel?: boolean;
  skipRelayCheck?: boolean;
  skipWebhookRegistration?: boolean;
}

const TOTAL_BOOT_STEPS = 14;

export async function boot(overrides?: BootOverrides): Promise<DaemonContext> {
  const log = new BootLogger(TOTAL_BOOT_STEPS);
  log.banner();

  // =========================================================================
  // 1. Configuration
  // =========================================================================
  log.step('Configuration');
  const config = loadConfig();

  // Apply overrides.
  if (overrides?.sqlitePath) config.sqlitePath = overrides.sqlitePath;
  if (overrides?.webhookPort !== undefined) config.webhookPort = overrides.webhookPort;
  if (overrides?.workspaceRoot) config.workspaceRoot = overrides.workspaceRoot;
  if (overrides?.toolsDir) config.toolsDir = overrides.toolsDir;

  // Prevent unhandled errors from crashing the process.
  // EPIPE: a plugin child process dies and we write to its broken pipe.
  // ECONNRESET: a remote MCP server drops the connection.
  // These are recoverable — the reconnect loop handles them.
  process.on('uncaughtException', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
      console.warn(`[SELF-HEAL] ${code} — a plugin connection broke. Reconnect will handle it.`);
      return;
    }
    console.error('[FATAL] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/EPIPE|ECONNRESET|ERR_STREAM|Connection closed/i.test(msg)) {
      console.warn('[SELF-HEAL] Unhandled rejection (connection):', msg.slice(0, 100));
      return;
    }
    console.error('[WARN] Unhandled rejection:', reason);
  });
  // Also catch error events on stdout/stderr to prevent EPIPE crashes when piping.
  process.stdout?.on('error', () => {});
  process.stderr?.on('error', () => {});

  log.ok(`Anthropic API key (${config.anthropicApiKey.length} chars)`);
  log.ok('Master key set');
  log.detail('Webhook port', String(config.webhookPort));
  log.detail('SQLite', config.sqlitePath);
  log.detail('Workspace', config.workspaceRoot);

  // =========================================================================
  // 2. Database
  // =========================================================================
  log.step('Database');
  const backupConfig = {
    backupDir: config.backupDir,
    sqlitePath: config.sqlitePath,
    toolsDir: config.toolsDir,
    retain: config.backupRetain,
  };
  const restored = await restoreIfNeeded(backupConfig);
  if (restored) log.ok('Restored from backup');

  const db = initDatabase(config.sqlitePath);
  log.ok('SQLite initialised (WAL mode, FTS5)');

  // =========================================================================
  // 3. Core services
  // =========================================================================
  log.step('Core services');

  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 500, 30_000),
    lazyConnect: true,
  });
  let redisErrorLogged = false;
  redis.on('error', (err) => {
    if (!redisErrorLogged) {
      log.warn(`Redis: ${err.message} (non-critical)`);
      redisErrorLogged = true;
    }
  });
  redis.connect().catch(() => {});

  const vault = new Vault(db, config.masterKey);
  log.ok('Vault (AES-256-GCM)');

  const pluginRegistry = new PluginRegistry(db, config.toolsDir);
  const knowledge = new KnowledgeStore(db, vault);
  const workspace = new Workspace({ root: config.workspaceRoot });
  const telemetry = new TelemetryCollector(db);
  const policyStore = new PolicyStore(db);
  const eventBus = new EventBus(db);
  log.ok('Knowledge store, workspace, telemetry, policies, event bus');

  pluginRegistry.setTelemetry(telemetry);
  pluginRegistry.setApiKey(config.anthropicApiKey);

  // =========================================================================
  // 4. Vault secrets
  // =========================================================================
  log.step('Vault secrets');
  seedVault(vault, log);
  await configureGit(vault, log);

  // Export Cloudflare credentials for the custom cloudflare-tools MCP plugin.
  const cfToken = vault.get('CLOUDFLARE_API_TOKEN');
  if (cfToken) process.env.CLOUDFLARE_API_TOKEN = cfToken;
  const cfAccountId = vault.get('CLOUDFLARE_ACCOUNT_ID') ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (cfAccountId) process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

  // Export JIRA credentials to env so the custom jira-tools MCP plugin can use them.
  const jiraEmail = vault.get('ATLASSIAN_EMAIL');
  const jiraToken = vault.get('ATLASSIAN_API_TOKEN');
  const jiraSite = vault.get('ATLASSIAN_SITE_URL');
  if (jiraEmail) process.env.JIRA_EMAIL = jiraEmail;
  if (jiraToken) process.env.JIRA_API_TOKEN = jiraToken;
  if (jiraSite) process.env.JIRA_BASE_URL = jiraSite;

  // Export Google Workspace credentials for the custom google-workspace MCP plugin.
  // Reconstruct the service account JSON from decomposed env vars (avoids shell escaping issues).
  const gcpEmail = vault.get('GCP_CLIENT_EMAIL') ?? process.env.VAULT_GCP_CLIENT_EMAIL;
  const gcpKeyB64 = vault.get('GCP_PRIVATE_KEY_B64') ?? process.env.VAULT_GCP_PRIVATE_KEY_B64;
  const gcpProjectId = vault.get('GCP_PROJECT_ID') ?? process.env.VAULT_GCP_PROJECT_ID;
  const gcpKeyId = vault.get('GCP_PRIVATE_KEY_ID') ?? process.env.VAULT_GCP_PRIVATE_KEY_ID;
  const gcpClientId = vault.get('GCP_CLIENT_ID') ?? process.env.VAULT_GCP_CLIENT_ID;
  if (gcpEmail && gcpKeyB64) {
    const privateKey = Buffer.from(gcpKeyB64, 'base64').toString('utf-8');
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      project_id: gcpProjectId ?? '',
      private_key_id: gcpKeyId ?? '',
      private_key: privateKey,
      client_email: gcpEmail,
      client_id: gcpClientId ?? '',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(gcpEmail)}`,
      universe_domain: 'googleapis.com',
    });
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = serviceAccountJson;
    log.ok('Google service account reconstructed from decomposed env vars');
  } else {
    // Fallback: try the single JSON var (may work if loaded via vault, not shell)
    const googleKey = vault.get('GOOGLE_SERVICE_ACCOUNT_KEY');
    if (googleKey) process.env.GOOGLE_SERVICE_ACCOUNT_KEY = googleKey;
  }
  const founderEmail = vault.get('FOUNDER_EMAIL');
  if (founderEmail) process.env.GOOGLE_IMPERSONATE_EMAIL = founderEmail;

  // Firebase: create the config file it expects.
  const gcpProject = vault.get('GCP_PROJECT_ID') ?? process.env.VAULT_GCP_PROJECT_ID;
  if (gcpProject && gcpEmail) {
    const fbConfig = JSON.stringify({
      projectId: gcpProject,
      serviceAccount: {
        type: 'service_account',
        project_id: gcpProject,
        client_email: gcpEmail,
        private_key: gcpKeyB64 ? Buffer.from(gcpKeyB64, 'base64').toString('utf-8') : '',
        client_id: gcpClientId ?? '',
      },
    }, null, 2);
    try {
      const fs = await import('node:fs/promises');
      await fs.writeFile('./firebase-mcp.json', fbConfig);
      log.ok(`Firebase config written (project: ${gcpProject})`);
    } catch { /* non-critical */ }
  }

  // Export credentials for installed MCP plugins that read from env vars.
  // These complement the vaultArgs (CLI flags) approach — some plugins check env as fallback.
  const stripeKey = vault.get('STRIPE_SECRET_KEY');
  const ghToken = vault.get('GITHUB_TOKEN');
  if (stripeKey) process.env.STRIPE_SECRET_KEY = stripeKey;
  if (ghToken) process.env.GH_TOKEN = ghToken;

  // HubSpot: the PAK must be exchanged for a real access token.
  const hubspotPak = vault.get('HUBSPOT_PRIVATE_APP_TOKEN');
  if (hubspotPak) {
    try {
      const hsRes = await fetch('https://api.hubapi.com/localdevauth/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encodedOAuthRefreshToken: hubspotPak }),
      });
      if (hsRes.ok) {
        const hsData = await hsRes.json() as { oauthAccessToken?: string };
        if (hsData.oauthAccessToken) {
          process.env.HUBSPOT_ACCESS_TOKEN = hsData.oauthAccessToken;
          log.ok('HubSpot access token exchanged from PAK');
        }
      } else {
        log.warn('HubSpot PAK exchange failed: ' + hsRes.status);
      }
    } catch (err) {
      log.warn('HubSpot PAK exchange error: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // =========================================================================
  // 5. Workspace & directories
  // =========================================================================
  log.step('Workspace');
  await workspace.init();
  log.ok(`Directories ready at ${config.workspaceRoot}`);

  // =========================================================================
  // 6. Agents & wiring
  // =========================================================================
  log.step('Agents');

  const hooks = new HookEngine(db);
  registerSafetyHooks(hooks);
  const tracker = new AgentTracker();

  const webhookServer = new WebhookServer(config.webhookPort, db);
  webhookServer.setTelemetry(telemetry);
  webhookServer.setEventBus(eventBus);

  const wardenDeps: AgentDeps = {
    apiKey: config.anthropicApiKey,
    registry: pluginRegistry,
    vault, knowledge, workspace, telemetry, policyStore, eventBus, tracker, hooks,
  };
  const wardenRegistry = new WardenRegistry(db, wardenDeps, webhookServer);
  // Back-reference: wardens need access to the registry for dependency unblocking.
  wardenDeps.wardenRegistry = wardenRegistry;

  const agentDeps = {
    apiKey: config.anthropicApiKey,
    registry: pluginRegistry,
    vault, knowledge, workspace, telemetry, policyStore, eventBus, wardenRegistry, tracker, hooks,
  };

  const architect = new Architect(agentDeps);
  architect.registerWebhooks(webhookServer);

  const treasurer = new Treasurer(agentDeps);
  treasurer.registerWebhooks(webhookServer);

  const secretary = new Secretary(agentDeps);
  secretary.registerWebhooks(webhookServer);

  const expert = new Expert(agentDeps);
  expert.registerWebhooks(webhookServer);

  // ---------------------------------------------------------------------------
  // Dependency unblocking — webhook-driven.
  //
  // When a Story transitions to Done (detected via JIRA webhook changelog),
  // search for stories with "DEPENDS ON: <key>" in their description and
  // transition them to To Do. Wardens' own webhook handlers then pick them
  // up naturally. Rehydrate all agents to ensure they discover the new work.
  // ---------------------------------------------------------------------------
  webhookServer.on('jira:issue_updated', async (payload) => {
    const issue = payload.issue;
    if (!issue) return;
    const issueType = issue.fields.issuetype.name?.toLowerCase();
    if (issueType === 'task' || issueType === 'sub-task') return;

    // Detect status → Done transition via changelog.
    const statusChange = payload.changelog?.items.find(
      (item) => item.field === 'status' && item.toString === 'Done',
    );
    if (!statusChange) return;

    const doneKey = issue.key;
    const projectKey = issue.fields.project?.key;
    if (!projectKey) return;

    try {
      const jql = `project = ${projectKey} AND statusCategory != Done AND text ~ "DEPENDS ON: ${doneKey}"`;
      const resultStr = await pluginRegistry.invoke('atlassian', 'search_issues', {
        jql, maxResults: 20, fields: 'summary,status,description',
      });
      const result = JSON.parse(resultStr) as { issues?: { key: string; fields: { summary: string; status: { name: string }; description?: unknown } }[] };
      const candidates = result.issues ?? [];

      let unblocked = 0;
      for (const candidate of candidates) {
        const descText = JSON.stringify(candidate.fields.description ?? '');
        if (!descText.includes(`DEPENDS ON: ${doneKey}`)) continue;

        // Transition to To Do — look up correct transition ID by name.
        try {
          const trStr = await pluginRegistry.invoke('atlassian', 'get_transitions', { issueKey: candidate.key });
          const transitions = (JSON.parse(trStr) as { transitions?: { id: string; name: string }[] }).transitions ?? [];
          const toTodo = transitions.find(t => t.name.toLowerCase() === 'to do');
          if (toTodo) {
            await pluginRegistry.invoke('atlassian', 'transition_issue', { issueKey: candidate.key, transitionId: toTodo.id });
          }
        } catch {}
        await pluginRegistry.invoke('atlassian', 'add_comment', {
          issueKey: candidate.key,
          body: `✅ Dependency ${doneKey} is Done — this story is now unblocked and ready for work.`,
        }).catch(() => {});
        console.log(`[DEPENDENCY] Unblocked ${candidate.key} (was waiting on ${doneKey})`);
        unblocked++;
      }

      if (unblocked > 0) {
        console.log(`[DEPENDENCY] Unblocked ${unblocked} story(s) after ${doneKey} completed.`);
        await wardenRegistry.rehydrateAll();
        await treasurer.rehydrate().catch(() => {});
        await secretary.rehydrate().catch(() => {});
      }
    } catch (err) {
      console.warn(`[DEPENDENCY] unblockDependents failed for ${doneKey}:`, err);
    }
  });

  // Subscribe agents and wardens as EventBus handlers.
  eventBus.subscribe('architect', async (prompt) => { await architect.handleInstruction(prompt); });
  eventBus.subscribe('treasurer', async (prompt) => { await treasurer.handleInstruction(prompt); });
  eventBus.subscribe('secretary', async (prompt) => { await secretary.handleInstruction(prompt); });
  eventBus.subscribe('expert', async (prompt) => { await expert.handleInstruction(prompt); });

  const wardenLabels = ['warden:dev', 'warden:ops', 'warden:content', 'warden:research', 'warden:outreach', 'warden:monitor'];
  for (const label of wardenLabels) {
    eventBus.subscribe(label, async (prompt) => {
      await architect.handleInstruction(
        `${prompt}\n\nIMPORTANT: Route this to the ${label} warden. Create a Story with label "${label}".`,
      );
    });
  }

  log.ok('Architect, Treasurer, Secretary, Expert');

  const contactGateway = new ContactGateway(vault, pluginRegistry, webhookServer);
  const botCommands = new BotCommands({
    pluginRegistry, wardenRegistry, tracker, telemetry, db, version: '0.1.0',
  });
  contactGateway.onCommand((cmd, args) => botCommands.handle(cmd, args));
  contactGateway.onMessage(async (msg) => secretary.handleMessage(msg.channel, msg.text));

  const backup = new BackupService(db, backupConfig);
  const supervisor = new Supervisor({ architect, tracker, telemetry });
  const scheduler = new Scheduler(supervisor, backup);
  const cliServer = new CliServer(supervisor, config.socketPath, config.tcpPort);
  log.ok('Supervisor, scheduler, CLI server');

  // =========================================================================
  // 7. Plugins
  // =========================================================================
  log.step('Plugins');
  await pluginRegistry.start();
  await seedPlugins(pluginRegistry, vault);

  const status = pluginRegistry.listWithStatus();
  const connected = status.filter(p => p.connected).length;
  const disconnected = status.filter(p => !p.connected).length;

  for (const { entry, connected: ok } of status) {
    if (ok) {
      const tools = await pluginRegistry.listTools(entry.name);
      log.ok(`${entry.name} — ${tools.length} tool(s)`);
    } else {
      log.warn(`${entry.name} — not connected`);
    }
  }
  log.count('Plugins', connected, disconnected, status.length);

  // Discover MCP resources from all plugins (for agent context injection).
  await pluginRegistry.discoverAllResources();

  // =========================================================================
  // 8. Health check
  // =========================================================================
  log.step('Health check');
  const health = await runHealthCheck(pluginRegistry, vault);
  log.count('Plugins', health.healthy, health.failed, health.healthy + health.degraded + health.failed);

  const systemOk = health.systemSecrets.filter(s => s.present).length;
  const systemMissing = health.systemSecrets.filter(s => !s.present).length;
  log.count('System secrets', systemOk, 0, systemOk + systemMissing);
  if (systemMissing > 0) {
    for (const s of health.systemSecrets.filter(s => !s.present)) {
      log.info(`Missing: ${s.name} — ${s.purpose}`);
    }
  }

  // =========================================================================
  // 9. Tool runway
  // =========================================================================
  log.step('Tool runway');
  const runway = await runToolRunway(pluginRegistry);
  const runwayPass = runway.filter(r => r.status === 'pass');
  const runwayFail = runway.filter(r => r.status === 'fail');

  for (const r of runwayPass) {
    log.ok(`${r.plugin} — ${r.probe} (${r.latencyMs}ms)`);
  }
  for (const r of runwayFail) {
    const short = (r.error ?? '').slice(0, 80);
    log.warn(`${r.plugin} — ${short}`);
  }
  log.count('Probes', runwayPass.length, runwayFail.length, runway.length);

  // =========================================================================
  // 10. Webhook listeners
  // =========================================================================
  log.step('Webhook listeners');
  seedWebhookListeners(eventBus);
  const listeners = eventBus.listAll();
  for (const l of listeners) {
    log.ok(`${l.name} → ${(l.config as { path?: string }).path ?? l.source}`);
  }

  // =========================================================================
  // 11. Webhook relay & registration
  // =========================================================================
  log.step('Webhook relay');
  if (!overrides?.skipRelayCheck) {
    const relayResults = await runWebhookRelayCheck(vault);
    const relayOk = relayResults.filter(r => r.status === 'ok').length;
    const relayFail = relayResults.filter(r => r.status === 'fail').length;
    log.count('Cloud Functions', relayOk, relayFail, relayResults.length);
  } else {
    log.info('Relay check skipped');
  }

  if (!overrides?.skipWebhookRegistration) {
    const regResults = await registerWebhooks(vault);
    for (const r of regResults) {
      if (r.status === 'created') log.ok(`${r.service} webhook registered`);
      else if (r.status === 'exists') log.ok(`${r.service} webhook exists`);
      else if (r.status === 'skip') log.info(`${r.service} — skipped (${r.error})`);
      else log.warn(`${r.service} — ${r.error}`);
    }
  } else {
    log.info('Webhook registration skipped');
  }

  const relaySecret = vault.get('WEBHOOK_RELAY_SECRET');
  if (relaySecret) {
    webhookServer.setRelaySecret(relaySecret, [
      '/events/stripe',
      '/events/cloudflare',
      '/events/hubspot',
      '/events/instantly',
    ]);
    log.ok('Relay secret configured');
  }

  // =========================================================================
  // 12. Cloudflare Tunnel
  // =========================================================================
  log.step('Cloudflare Tunnel');
  if (!overrides?.skipTunnel) {
    await startTunnel(vault);
    const publicUrl = vault.get('HIRAM_PUBLIC_URL');
    if (publicUrl) log.ok(publicUrl);
  } else {
    log.info('Tunnel skipped');
  }

  // =========================================================================
  // 13. Services
  // =========================================================================
  log.step('Services');
  telemetry.start();
  log.ok('Telemetry (60s flush)');

  await webhookServer.start();
  log.ok(`HTTP server on :${config.webhookPort}`);

  await seedWardens(wardenRegistry);
  seedPolicies(policyStore);
  await wardenRegistry.start();
  const wardens = wardenRegistry.listAll?.() ?? [];
  log.ok(`${wardens.length || 6} warden(s) active`);

  await supervisor.start();
  log.ok('Supervisor');

  contactGateway.start();
  log.ok('Contact gateway (Telegram, Email)');

  eventBus.start();
  log.ok(`Event bus (${listeners.length} listener(s))`);

  scheduler.start();
  log.ok('Scheduler (daily planning, backups)');

  await cliServer.start();
  log.ok(`CLI server (:${config.tcpPort})`);

  // =========================================================================
  // 14. Ready
  // =========================================================================
  log.step('Ready');
  log.ready();

  // -----------------------------------------------------------------------
  // Shutdown function
  // -----------------------------------------------------------------------
  const shutdown = async () => {
    console.log('\nHIRAM daemon shutting down...');
    scheduler.stop();
    eventBus.stop();
    contactGateway.stop();
    if (!overrides?.skipTunnel) stopTunnel();
    telemetry.stop();
    await cliServer.stop();
    await supervisor.stop();
    wardenRegistry.stop();
    await webhookServer.stop();
    await pluginRegistry.stop();
    await backup.run().catch((err) => console.error('Shutdown backup failed:', err));
    db.close();
    redis.disconnect();
  };

  return {
    config, db, redis, vault, pluginRegistry, knowledge, workspace, telemetry,
    policyStore, eventBus, hooks, tracker, webhookServer, wardenRegistry,
    architect, treasurer, secretary, expert, contactGateway,
    backup, supervisor, scheduler, cliServer, shutdown,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point — wraps boot() with signal handlers.
// ---------------------------------------------------------------------------

// Only auto-boot when run directly (not when imported by tests).
const isDirectRun = process.argv[1]?.endsWith('daemon.js') || process.argv[1]?.endsWith('daemon.ts');
if (isDirectRun) {
  boot().then((ctx) => {
    process.on('SIGINT', async () => { await ctx.shutdown(); process.exit(0); });
    process.on('SIGTERM', async () => { await ctx.shutdown(); process.exit(0); });
  }).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
