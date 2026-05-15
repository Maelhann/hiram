import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SafeStdioClientTransport } from './safe-stdio-transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type Database from 'better-sqlite3';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import type { MetaTool } from './meta-tools.js';
import type {
  PluginEntry,
  PluginRecord,
  PluginTool,
  CustomConfig,
  StdioConfig,
  RemoteConfig,
  PluginTransport,
} from '../types/plugin.js';

// ---------------------------------------------------------------------------
// PluginRegistry — unified MCP-based plugin system.
//
// Every plugin is an MCP server. Two kinds:
//   - Custom: TypeScript source → compiled via esbuild → started as a stdio
//     MCP server process → connected as MCP client.
//   - Installed: Pre-built MCP servers from the ecosystem, connected via
//     stdio (local command), HTTP, or WebSocket.
//
// All tool invocation goes through the MCP protocol. One abstraction.
// ---------------------------------------------------------------------------

interface LivePlugin {
  entry: PluginEntry;
  client: Client;
  transport: SafeStdioClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;
}

// Simple mutex for serializing stdio calls to a single plugin.
class PluginMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

export class PluginRegistry {
  private live = new Map<string, LivePlugin>();
  private telemetry?: import('../telemetry/collector.js').TelemetryCollector;
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private mutexes = new Map<string, PluginMutex>();
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;

  /** Cached MCP resources per plugin — discovered at boot, refreshed on reconnect. */
  private resourceCache = new Map<string, { uri: string; name: string; description?: string; content?: string }[]>();
  /** Cached tool summaries per plugin — built during discoverAll(). */
  readonly toolSummaryCache = new Map<string, string>();

  /** Path to node_modules for bundling custom plugins. */
  private nodeModulesDir: string;

  constructor(
    private db: Database.Database,
    private toolsDir: string,
    nodeModulesDir?: string,
  ) {
    // Default: look for node_modules alongside toolsDir's parent.
    // In production: toolsDir is $HIRAM_ROOT/tools, node_modules is $HIRAM_ROOT/node_modules.
    // Pass explicitly if the layout differs (e.g. E2E tests with temp dirs).
    this.nodeModulesDir = nodeModulesDir ?? path.resolve(toolsDir, '..', 'node_modules');
  }

  /** Attach telemetry collector (set after construction to avoid circular deps). */
  setTelemetry(tel: import('../telemetry/collector.js').TelemetryCollector): void {
    this.telemetry = tel;
  }

  /** Get or create a circuit breaker for a plugin. */
  private getBreaker(pluginName: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(pluginName);
    if (!breaker) {
      breaker = new CircuitBreaker({
        name: `plugin:${pluginName}`,
        errorThreshold: 3,
        resetTimeout: 30_000,
      });
      this.circuitBreakers.set(pluginName, breaker);
    }
    return breaker;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    await fs.mkdir(this.toolsDir, { recursive: true });

    const active = this.list().filter((p) => p.active);
    for (const entry of active) {
      try {
        await this.connect(entry);
      } catch (err) {
        console.error(`Plugin "${entry.name}" failed to start:`, err);
      }
    }

    if (active.length > 0) {
      console.log(`PluginRegistry: started ${this.live.size}/${active.length} plugin(s).`);
    }

    // Start auto-reconnect timer — checks every 30s for disconnected plugins.
    this.reconnectTimer = setInterval(() => this.reconnectLoop(), 30_000);
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, live] of this.live) {
      try { await live.client.close(); } catch { /* ignore */ }
    }
    this.live.clear();
  }

  // -----------------------------------------------------------------------
  // Create custom plugin (agent writes TypeScript MCP server source)
  // -----------------------------------------------------------------------

  async createCustom(opts: {
    name: string;
    source: string;
    description?: string;
    tags?: string[];
    createdBy?: string;
  }): Promise<PluginEntry> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tsPath = path.resolve(this.toolsDir, `${opts.name}.ts`);
    const jsPath = path.resolve(this.toolsDir, `${opts.name}.js`);

    // Write and compile.
    await fs.writeFile(tsPath, opts.source, 'utf-8');
    try {
      await this.compile(tsPath, jsPath);
    } catch (err) {
      await fs.unlink(tsPath).catch(() => {});
      throw new Error(`Compilation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const config: CustomConfig = { sourcePath: tsPath, compiledPath: jsPath };
    const description = opts.description ?? '';

    this.db.prepare(
      `INSERT INTO plugins (id, name, description, kind, transport, config, tags, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'custom', 'stdio', ?, ?, 1, ?, ?, ?)`,
    ).run(id, opts.name, description, JSON.stringify(config), JSON.stringify(opts.tags ?? []), opts.createdBy ?? 'agent', now, now);

    const entry = this.getByName(opts.name)!;

    // Start the MCP server process and connect.
    try {
      await this.connect(entry);
      // Discover resources + cache tool list for the new plugin.
      await this.discoverResources(entry.name);
      const tools = await this.listTools(entry.name);
      this.toolSummaryCache.set(entry.name, tools.map(t => t.name).join(', '));
    } catch (err) {
      // Clean up on failure.
      this.db.prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
      await fs.unlink(tsPath).catch(() => {});
      await fs.unlink(jsPath).catch(() => {});
      throw new Error(`Plugin server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }

    return entry;
  }

  // -----------------------------------------------------------------------
  // Install ecosystem plugin (pre-built MCP server)
  // -----------------------------------------------------------------------

  async install(opts: {
    name: string;
    description?: string;
    transport: PluginTransport;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    tags?: string[];
    private?: boolean;
  }): Promise<PluginEntry> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let config: StdioConfig | RemoteConfig;
    if (opts.transport === 'stdio') {
      if (!opts.command) throw new Error('stdio transport requires a command');
      config = { command: opts.command, args: opts.args, env: opts.env };
    } else {
      if (!opts.url) throw new Error(`${opts.transport} transport requires a url`);
      config = { url: opts.url, headers: opts.headers };
    }

    this.db.prepare(
      `INSERT INTO plugins (id, name, description, kind, transport, config, tags, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'installed', ?, ?, ?, 1, 'system', ?, ?)`,
    ).run(id, opts.name, opts.description ?? '', opts.transport, JSON.stringify(config), JSON.stringify(opts.tags ?? []), now, now);

    const entry = this.getByName(opts.name)!;

    try {
      await this.connect(entry);
      await this.discoverResources(entry.name);
      const tools = await this.listTools(entry.name);
      this.toolSummaryCache.set(entry.name, tools.map(t => t.name).join(', '));
    } catch (err) {
      this.db.prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
      throw new Error(`Plugin failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    }

    return entry;
  }

  // -----------------------------------------------------------------------
  // Update custom plugin source
  // -----------------------------------------------------------------------

  async updateCustom(name: string, source: string): Promise<PluginEntry> {
    const entry = this.getByName(name);
    if (!entry) throw new Error(`Plugin not found: ${name}`);
    if (entry.kind !== 'custom') throw new Error(`Cannot update source of installed plugin: ${name}`);

    const config = entry.config as CustomConfig;

    // Disconnect the running server.
    await this.disconnect(name);

    // Rewrite and recompile.
    await fs.writeFile(config.sourcePath, source, 'utf-8');
    await this.compile(config.sourcePath, config.compiledPath);

    this.db.prepare(`UPDATE plugins SET updated_at = ? WHERE name = ?`).run(new Date().toISOString(), name);

    // Reconnect.
    const updated = this.getByName(name)!;
    await this.connect(updated);
    return updated;
  }

  // -----------------------------------------------------------------------
  // Remove
  // -----------------------------------------------------------------------

  async remove(name: string): Promise<void> {
    const entry = this.getByName(name);
    if (!entry) throw new Error(`Plugin not found: ${name}`);

    await this.disconnect(name);

    if (entry.kind === 'custom') {
      const config = entry.config as CustomConfig;
      await fs.unlink(config.sourcePath).catch(() => {});
      await fs.unlink(config.compiledPath).catch(() => {});
    }

    this.db.prepare(`DELETE FROM plugins WHERE name = ?`).run(name);
  }

  // -----------------------------------------------------------------------
  // Tool discovery
  // -----------------------------------------------------------------------

  async listTools(pluginName?: string): Promise<PluginTool[]> {
    const results: PluginTool[] = [];
    const targets = pluginName
      ? [this.live.get(pluginName)].filter(Boolean) as LivePlugin[]
      : [...this.live.values()];

    for (const live of targets) {
      try {
        const resp = await live.client.listTools();
        for (const tool of resp.tools) {
          results.push({
            pluginName: live.entry.name,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      } catch {
        // Server might be down.
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // MCP Resources — context injection for agents
  // -----------------------------------------------------------------------

  /** Discover resources from a single plugin. Caches the result. */
  async discoverResources(pluginName: string): Promise<{ uri: string; name: string; description?: string; content?: string }[]> {
    const live = this.live.get(pluginName);
    if (!live) return [];

    try {
      const resp = await live.client.listResources();
      const resources: { uri: string; name: string; description?: string; content?: string }[] = [];
      for (const res of resp.resources) {
        try {
          const content = await live.client.readResource({ uri: res.uri });
          const text = content.contents?.[0] && 'text' in content.contents[0] ? (content.contents[0] as { text: string }).text : undefined;
          resources.push({ uri: res.uri, name: res.name, description: res.description, content: text?.slice(0, 5000) });
        } catch {
          resources.push({ uri: res.uri, name: res.name, description: res.description });
        }
      }
      this.resourceCache.set(pluginName, resources);
      return resources;
    } catch {
      // Plugin doesn't support resources — that's fine.
      this.resourceCache.set(pluginName, []);
      return [];
    }
  }

  /** Read a specific resource from a plugin. */
  async readResource(pluginName: string, uri: string): Promise<string | null> {
    const live = this.live.get(pluginName);
    if (!live) return null;
    try {
      const resp = await live.client.readResource({ uri });
      return resp.contents?.[0] && 'text' in resp.contents[0] ? (resp.contents[0] as { text: string }).text : null;
    } catch {
      return null;
    }
  }

  /** Discover resources from ALL connected plugins. Call once at boot. */
  async discoverAllResources(): Promise<void> {
    const plugins = [...this.live.keys()];
    let totalResources = 0;
    for (const name of plugins) {
      const resources = await this.discoverResources(name);
      totalResources += resources.length;
    }

    // Also cache tool summaries for each plugin.
    for (const name of plugins) {
      try {
        const tools = await this.listTools(name);
        const toolNames = tools.map(t => t.name).join(', ');
        this.toolSummaryCache.set(name, toolNames);
      } catch {
        this.toolSummaryCache.set(name, '(unavailable)');
      }
    }

    if (totalResources > 0) {
      console.log(`[PluginRegistry] Discovered ${totalResources} resource(s) across ${plugins.length} plugin(s).`);
    }
  }

  /** Get cached resources for a plugin. */
  getCachedResources(pluginName: string): { uri: string; name: string; description?: string; content?: string }[] {
    return this.resourceCache.get(pluginName) ?? [];
  }

  // -----------------------------------------------------------------------
  // Large result extraction — uses Haiku to summarize oversized tool outputs
  // -----------------------------------------------------------------------

  private extractionClient: Anthropic | null = null;

  /** Set the API key for the Haiku extraction client. Call once during boot. */
  setApiKey(apiKey: string): void {
    this.extractionClient = new Anthropic({ apiKey });
  }

  /**
   * When a tool result exceeds the extraction threshold, pipe it through Haiku
   * to extract structured information instead of dumping raw data (e.g. 44K
   * chars of Playwright accessibility YAML) into the agent's conversation.
   */
  private async extractLargeResult(pluginName: string, toolName: string, rawResult: string): Promise<string> {
    if (!this.extractionClient) {
      // No API key — fall back to truncation.
      return rawResult.slice(0, 6_000) + `\n\n[Truncated from ${rawResult.length} chars — extraction client not configured]`;
    }

    try {
      const response = await this.extractionClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: 'You are a data extraction assistant. Extract the key information from the tool output below and return a concise, structured summary. Focus on: names, prices, features, URLs, error messages, status codes — anything actionable. Omit raw HTML, CSS, layout details, and decorative elements. Be thorough but concise.',
        messages: [{
          role: 'user',
          content: `Extract the key information from this ${pluginName}/${toolName} result (${rawResult.length} chars):\n\n${rawResult.slice(0, 30_000)}`,
        }],
      });

      const extracted = response.content[0]?.type === 'text' ? response.content[0].text : '';
      if (extracted.length > 0) {
        this.telemetry?.inc('plugin.extractions');
        return `[Extracted from ${rawResult.length} char ${pluginName}/${toolName} result via Haiku]\n\n${extracted}`;
      }
    } catch (err) {
      console.warn(`[PluginRegistry] Haiku extraction failed for ${pluginName}/${toolName}:`, err instanceof Error ? err.message : err);
    }

    // Fallback: truncate.
    return rawResult.slice(0, 6_000) + `\n\n[Truncated from ${rawResult.length} chars — extraction failed]`;
  }

  // -----------------------------------------------------------------------
  // Tool invocation
  // -----------------------------------------------------------------------

  async invoke(pluginName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const live = this.live.get(pluginName);
    if (!live) {
      const connected = [...this.live.keys()].join(', ');
      throw new Error(`Plugin "${pluginName}" is not connected (live: ${connected}). Use plugin_list() to see available plugins.`);
    }

    const metricKey = `plugin.${pluginName}.${toolName}`;
    this.telemetry?.inc(`${metricKey}.calls`);

    // Serialize calls for stdio plugins — the MCP stdio transport
    // is single-channel and can't handle concurrent requests.
    const needsMutex = live.entry.transport === 'stdio';
    let mutex: PluginMutex | undefined;
    if (needsMutex) {
      mutex = this.mutexes.get(pluginName);
      if (!mutex) { mutex = new PluginMutex(); this.mutexes.set(pluginName, mutex); }
      await mutex.acquire();
    }

    const breaker = this.getBreaker(pluginName);
    const t0 = Date.now();
    let result;
    try {
      // 60s timeout per tool call — prevents Playwright/browser hangs from blocking the worker forever.
      const toolPromise = breaker.exec(() => live.client.callTool({ name: toolName, arguments: args }));
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${toolName}" on plugin "${pluginName}" timed out after 60s`)), 60_000),
      );
      result = await Promise.race([toolPromise, timeoutPromise]);
    } catch (err) {
      this.telemetry?.inc(`${metricKey}.errors`);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PluginRegistry] invoke("${pluginName}", "${toolName}") FAILED: ${msg.slice(0, 200)} [breaker=${breaker.currentState}]`);
      if (breaker.currentState === 'open') {
        this.scheduleReconnect(pluginName);
      }
      throw err;
    } finally {
      mutex?.release();
    }
    this.telemetry?.record(`${metricKey}.latency_ms`, Date.now() - t0);

    const content = result.content as { type: string; text?: string; mimeType?: string }[];
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else {
        parts.push(JSON.stringify(block));
      }
    }

    let joined = parts.join('\n');

    // Only extract browser/playwright results — NEVER extract structured API data
    // (JIRA, Stripe, etc.) which must remain valid JSON for callers to parse.
    const EXTRACTION_THRESHOLD = 10_000;
    const isExtractable = pluginName === 'playwright' && joined.length > EXTRACTION_THRESHOLD;
    if (isExtractable) {
      joined = await this.extractLargeResult(pluginName, toolName, joined);
    }

    if (result.isError) {
      this.telemetry?.inc(`${metricKey}.errors`);
      throw new Error(
        `Tool "${toolName}" on plugin "${pluginName}" returned an error: ${joined.slice(0, 500)}. ` +
        `Use plugin_list_tools({ plugin: "${pluginName}" }) to verify the correct tool name.`,
      );
    }

    return joined;
  }

  // -----------------------------------------------------------------------
  // Read custom source
  // -----------------------------------------------------------------------

  async readSource(name: string): Promise<string> {
    const entry = this.getByName(name);
    if (!entry) throw new Error(`Plugin not found: ${name}`);
    if (entry.kind !== 'custom') throw new Error(`Installed plugins have no source to read: ${name}`);
    const config = entry.config as CustomConfig;
    return fs.readFile(config.sourcePath, 'utf-8');
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** List plugins. By default excludes private plugins. */
  list(tag?: string): PluginEntry[] {
    const rows = tag
      ? this.db.prepare(`SELECT * FROM plugins WHERE tags LIKE ? ORDER BY name`).all(`%"${tag}"%`) as PluginRecord[]
      : this.db.prepare(`SELECT * FROM plugins ORDER BY name`).all() as PluginRecord[];
    return rows.map(toEntry);
  }

  getByName(name: string): PluginEntry | undefined {
    const row = this.db.prepare(`SELECT * FROM plugins WHERE name = ?`).get(name) as PluginRecord | undefined;
    return row ? toEntry(row) : undefined;
  }

  search(query: string): PluginEntry[] {
    const q = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM plugins WHERE name LIKE ? OR description LIKE ? OR tags LIKE ? ORDER BY name`,
    ).all(q, q, q) as PluginRecord[];
    return rows.map(toEntry);
  }

  listWithStatus(): { entry: PluginEntry; connected: boolean }[] {
    return this.list().map((entry) => ({
      entry,
      connected: this.live.has(entry.name),
    }));
  }

  // -----------------------------------------------------------------------
  // Connection management
  // -----------------------------------------------------------------------

  private async connect(entry: PluginEntry): Promise<void> {
    if (this.live.has(entry.name)) return;

    const client = new Client({ name: 'hiram', version: '0.1.0' });
    let transport: SafeStdioClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;

    // Build full env for stdio plugins.
    const fullEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) fullEnv[k] = v;
    }

    // Pipe error handler — absorbs EPIPE/ECONNRESET and triggers reconnect.
    const onPipeError = (err: NodeJS.ErrnoException) => {
      console.warn(`[PluginRegistry] Pipe error on "${entry.name}" (${err.code}) — will reconnect.`);
      this.scheduleReconnect(entry.name);
    };

    switch (entry.transport) {
      case 'stdio': {
        if (entry.kind === 'custom') {
          const cfg = entry.config as CustomConfig;
          transport = new SafeStdioClientTransport({
            command: 'node', args: [cfg.compiledPath],
            stderr: 'inherit',
            env: fullEnv,
          }, onPipeError);
        } else {
          const cfg = entry.config as StdioConfig;
          const pluginEnv = cfg.env ? { ...fullEnv, ...cfg.env } : fullEnv;
          transport = new SafeStdioClientTransport({ command: cfg.command, args: cfg.args, env: pluginEnv }, onPipeError);
        }
        break;
      }
      case 'http': {
        const cfg = entry.config as RemoteConfig;
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
        break;
      }
      case 'ws': {
        const cfg = entry.config as RemoteConfig;
        transport = new WebSocketClientTransport(new URL(cfg.url));
        break;
      }
    }

    await client.connect(transport);
    this.live.set(entry.name, { entry, client, transport });
    console.log(`Plugin "${entry.name}" connected (${entry.kind}/${entry.transport}).`);

    // Detect plugin death — reconnect immediately.
    client.onclose = () => {
      console.warn(`[PluginRegistry] Plugin "${entry.name}" disconnected — reconnecting immediately...`);
      this.live.delete(entry.name);
      // Immediate async reconnect (don't block).
      this.disconnect(entry.name).then(() => this.connect(entry)).then(() => {
        this.circuitBreakers.get(entry.name)?.reset();
        console.log(`[SELF-HEAL] Plugin "${entry.name}" reconnected.`);
      }).catch((err) => {
        console.error(`[SELF-HEAL] Plugin "${entry.name}" reconnect failed:`, err instanceof Error ? err.message : err);
        this.scheduleReconnect(entry.name);
      });
    };
  }

  /** Mark a plugin for reconnection on the next reconnect loop cycle. */
  private pluginsToReconnect = new Set<string>();

  private scheduleReconnect(pluginName: string): void {
    this.pluginsToReconnect.add(pluginName);
    console.warn(`[SELF-HEAL] Plugin "${pluginName}" scheduled for reconnect.`);
  }

  /** Periodic reconnect loop — attempts to reconnect failed plugins. */
  private async reconnectLoop(): Promise<void> {
    if (this.pluginsToReconnect.size === 0) return;

    const toReconnect = [...this.pluginsToReconnect];
    this.pluginsToReconnect.clear();

    for (const name of toReconnect) {
      const entry = this.getByName(name);
      if (!entry || !entry.active) continue;

      try {
        await this.disconnect(name);
        await this.connect(entry);
        // Reset circuit breaker on successful reconnect.
        this.circuitBreakers.get(name)?.reset();
        console.log(`[SELF-HEAL] Plugin "${name}" reconnected successfully.`);
        // Refresh resources and tool cache.
        this.discoverResources(name).catch(() => {});
      } catch (err) {
        console.error(`[SELF-HEAL] Plugin "${name}" reconnect failed:`, err);
        // Re-schedule for next cycle.
        this.pluginsToReconnect.add(name);
      }
    }
  }

  private async disconnect(name: string): Promise<void> {
    const live = this.live.get(name);
    if (live) {
      try { await live.client.close(); } catch { /* ignore */ }
      this.live.delete(name);
    }
  }

  // -----------------------------------------------------------------------
  // Compilation (custom plugins only)
  // -----------------------------------------------------------------------

  private async compile(tsPath: string, jsPath: string): Promise<void> {
    // Resolve node_modules so esbuild can bundle deps even when
    // the source file is in a temp directory.
    const projectNodeModules = this.nodeModulesDir;
    await esbuild({
      entryPoints: [tsPath],
      outfile: jsPath,
      bundle: true,
      format: 'esm',
      target: 'node22',
      platform: 'node',
      external: ['node:*'],
      nodePaths: [projectNodeModules],
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
  }
}

// ---------------------------------------------------------------------------
// Meta-tools — plugin management for agents
// ---------------------------------------------------------------------------

export function createPluginTools(registry: PluginRegistry): MetaTool[] {
  return [
    pluginList(registry),
    pluginSearch(registry),
    pluginListTools(registry),
    pluginInvoke(registry),
    pluginListResources(registry),
    pluginReadResource(registry),
    pluginCreate(registry),
    pluginInstall(registry),
    pluginUpdate(registry),
    pluginGet(registry),
    pluginRemove(registry),
  ];
}

function pluginListResources(reg: PluginRegistry): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'plugin_list_resources',
      description: 'List MCP resources exposed by a plugin. Resources provide context data (API docs, schemas, current state) without calling a tool.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plugin: { type: 'string', description: 'Plugin name' },
        },
        required: ['plugin'],
      },
    },
    async handle(input) {
      const resources = await reg.discoverResources(input.plugin as string);
      return JSON.stringify({ ok: true, count: resources.length, resources: resources.map(r => ({ uri: r.uri, name: r.name, description: r.description })) });
    },
  };
}

function pluginReadResource(reg: PluginRegistry): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'plugin_read_resource',
      description: 'Read a specific MCP resource from a plugin. Returns the resource content (API docs, schemas, state data, etc.).',
      input_schema: {
        type: 'object' as const,
        properties: {
          plugin: { type: 'string', description: 'Plugin name' },
          uri: { type: 'string', description: 'Resource URI (from plugin_list_resources)' },
        },
        required: ['plugin', 'uri'],
      },
    },
    async handle(input) {
      const content = await reg.readResource(input.plugin as string, input.uri as string);
      if (content === null) return JSON.stringify({ ok: false, error: 'Resource not found or not readable' });
      return JSON.stringify({ ok: true, content: content.slice(0, 10_000) });
    },
  };
}

function pluginList(reg: PluginRegistry): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'plugin_list',
      description: 'List all registered plugins with their connection status. Shows both custom (agent-created) and installed (ecosystem) plugins.',
      input_schema: { type: 'object' as const, properties: { tag: { type: 'string', description: 'Optional tag filter' } }, required: [] },
    },
    async handle(input) {
      const all = reg.listWithStatus();
      const tag = input.tag as string | undefined;
      const filtered = tag ? all.filter((p) => p.entry.tags.includes(tag)) : all;
      return JSON.stringify({
        ok: true,
        count: filtered.length,
        plugins: filtered.map((p) => ({
          name: p.entry.name, description: p.entry.description, kind: p.entry.kind,
          transport: p.entry.transport, tags: p.entry.tags, connected: p.connected, active: p.entry.active,
          tools: reg.toolSummaryCache.get(p.entry.name) ?? null,
          resourceCount: reg.getCachedResources(p.entry.name).length,
        })),
      });
    },
  };
}

function pluginSearch(reg: PluginRegistry): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'plugin_search',
      description: 'Search plugins by keyword across name, description, and tags.',
      input_schema: { type: 'object' as const, properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
    },
    async handle(input) {
      const results = reg.search(input.query as string);
      return JSON.stringify({ ok: true, count: results.length, plugins: results.map((p) => ({ name: p.name, description: p.description, kind: p.kind, tags: p.tags })) });
    },
  };
}

function pluginListTools(reg: PluginRegistry): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'plugin_list_tools',
      description: 'List all tools exposed by connected plugins. Optionally filter by plugin name. Use this to discover available capabilities before calling plugin_invoke.',
      input_schema: { type: 'object' as const, properties: { plugin: { type: 'string', description: 'Optional: filter by plugin name' } }, required: [] },
    },
    async handle(input) {
      try {
        const pluginName = input.plugin as string | undefined;
        const tools = await reg.listTools(pluginName);
        const result: Record<string, unknown> = {
          ok: true,
          count: tools.length,
          tools: tools.map((t) => ({ plugin: t.pluginName, name: t.name, description: t.description })),
        };
        // Include cached resources if querying a specific plugin — gives the
        // model context about what data is available without an extra call.
        if (pluginName) {
          const resources = reg.getCachedResources(pluginName);
          if (resources.length > 0) {
            result.resources = resources.map(r => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              content: r.content?.slice(0, 1000),
            }));
          }
        }
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function pluginInvoke(reg: PluginRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'plugin_invoke',
      description: 'Call a tool on a connected plugin. Use plugin_list_tools first to discover available tools and their input schemas.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plugin: { type: 'string', description: 'Plugin name' },
          tool: { type: 'string', description: 'Tool name within the plugin' },
          arguments: { type: 'object', description: 'Arguments to pass to the tool' },
        },
        required: ['plugin', 'tool'],
      },
    },
    async handle(input) {
      try {
        const result = await reg.invoke(input.plugin as string, input.tool as string, (input.arguments ?? {}) as Record<string, unknown>);
        return JSON.stringify({ ok: true, result });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function pluginCreate(reg: PluginRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'plugin_create',
      description: `Create a custom plugin by writing a TypeScript MCP server. The source is compiled and started as a local MCP server process. The server's tools become immediately available via plugin_invoke.

Example MCP server source:
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'my-plugin', version: '1.0.0' });

server.tool('my_tool', 'Description of what this tool does', {
  param: z.string().describe('Parameter description'),
}, async ({ param }) => {
  return { content: [{ type: 'text', text: JSON.stringify({ result: param.toUpperCase() }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);`,
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Plugin name (kebab-case, e.g. "github-integration")' },
          source: { type: 'string', description: 'Full TypeScript MCP server source code' },
          description: { type: 'string', description: 'What this plugin does' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        },
        required: ['name', 'source'],
      },
    },
    async handle(input) {
      try {
        const entry = await reg.createCustom({
          name: input.name as string,
          source: input.source as string,
          description: input.description as string | undefined,
          tags: input.tags as string[] | undefined,
        });
        return JSON.stringify({ ok: true, plugin: { name: entry.name, description: entry.description, kind: entry.kind } });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function pluginInstall(reg: PluginRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'plugin_install',
      description: 'Install a pre-built MCP server from the ecosystem. Supports stdio (local command), HTTP, or WebSocket transports.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Plugin name (e.g. "github", "cloudflare")' },
          description: { type: 'string', description: 'What this plugin provides' },
          transport: { type: 'string', enum: ['stdio', 'http', 'ws'], description: 'Transport type' },
          command: { type: 'string', description: 'For stdio: command to run (e.g. "npx")' },
          args: { type: 'array', items: { type: 'string' }, description: 'For stdio: command arguments' },
          env: { type: 'object', description: 'For stdio: environment variables' },
          url: { type: 'string', description: 'For http/ws: server URL' },
          headers: { type: 'object', description: 'For http/ws: request headers (e.g. Authorization)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        },
        required: ['name', 'transport'],
      },
    },
    async handle(input) {
      try {
        const entry = await reg.install({
          name: input.name as string,
          description: input.description as string | undefined,
          transport: input.transport as PluginTransport,
          command: input.command as string | undefined,
          args: input.args as string[] | undefined,
          env: input.env as Record<string, string> | undefined,
          url: input.url as string | undefined,
          headers: input.headers as Record<string, string> | undefined,
          tags: input.tags as string[] | undefined,
        });
        return JSON.stringify({ ok: true, plugin: { name: entry.name, description: entry.description, kind: entry.kind, transport: entry.transport } });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function pluginUpdate(reg: PluginRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'plugin_update',
      description: 'Update a custom plugin with new TypeScript MCP server source code. The plugin is recompiled and restarted.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Plugin name to update' },
          source: { type: 'string', description: 'Updated TypeScript MCP server source' },
        },
        required: ['name', 'source'],
      },
    },
    async handle(input) {
      try {
        const entry = await reg.updateCustom(input.name as string, input.source as string);
        return JSON.stringify({ ok: true, plugin: { name: entry.name } });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function pluginGet(reg: PluginRegistry): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'plugin_get',
      description: 'Get full details of a plugin. For custom plugins, includes the TypeScript source code.',
      input_schema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Plugin name' } }, required: ['name'] },
    },
    async handle(input) {
      try {
        const name = input.name as string;
        const entry = reg.getByName(name);
        if (!entry) return JSON.stringify({ ok: false, error: `Plugin not found: ${name}` });

        const result: Record<string, unknown> = {
          ok: true, name: entry.name, description: entry.description, kind: entry.kind,
          transport: entry.transport, tags: entry.tags, active: entry.active,
          created_by: entry.createdBy, created_at: entry.createdAt,
        };

        if (entry.kind === 'custom') {
          result.source = await reg.readSource(name);
        }

        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function pluginRemove(reg: PluginRegistry): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'plugin_remove',
      description: 'Permanently remove a plugin — disconnects, deletes source files (for custom), and removes from the registry.',
      input_schema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Plugin name to remove' } }, required: ['name'] },
    },
    async handle(input) {
      try {
        await reg.remove(input.name as string);
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEntry(row: PluginRecord): PluginEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    transport: row.transport,
    config: JSON.parse(row.config) as PluginEntry['config'],
    tags: JSON.parse(row.tags) as string[],
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
