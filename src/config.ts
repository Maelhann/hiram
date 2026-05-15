import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Config — HIRAM daemon configuration with hot-reload support.
//
// Base config is loaded from environment variables (immutable at runtime).
// Runtime overrides are loaded from a JSON file and can be changed without
// restarting the daemon. A file watcher triggers reload on change.
// ---------------------------------------------------------------------------

export interface HiramConfig {
  anthropicApiKey: string;
  masterKey: string;
  webhookPort: number;
  redisUrl: string;
  sqlitePath: string;
  socketPath: string;
  tcpPort: number;
  workspaceRoot: string;
  toolsDir: string;
  backupDir: string;
  backupRetain: number;
  logLevel: string;
}

/** Runtime-adjustable settings (loaded from config.json, hot-reloadable). */
export interface RuntimeConfig {
  model?: string;
  tokenBudgetPerRun?: number;
  tokenBudgetPerTicket?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
}

export interface ConfigManager extends EventEmitter {
  base: HiramConfig;
  runtime: RuntimeConfig;
  reload(): void;
  stop(): void;
}

export function loadConfig(): HiramConfig {
  return {
    anthropicApiKey: env('ANTHROPIC_API_KEY'),
    masterKey: env('HIRAM_MASTER_KEY'),
    webhookPort: parseInt(env('WEBHOOK_PORT', '7401'), 10),
    redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379'),
    sqlitePath: env('SQLITE_PATH', './data/hiram.db'),
    socketPath: env('SOCKET_PATH', '/var/run/hiram/hiram.sock'),
    tcpPort: parseInt(env('TCP_PORT', '7400'), 10),
    workspaceRoot: env('WORKSPACE_ROOT', '/opt/hiram'),
    toolsDir: env('TOOLS_DIR', './tools'),
    backupDir: env('BACKUP_DIR', './backups'),
    backupRetain: parseInt(env('BACKUP_RETAIN', '10'), 10),
    logLevel: env('LOG_LEVEL', 'info'),
  };
}

/**
 * Create a ConfigManager that watches a JSON config file for changes.
 * Emits 'changed' event with the new RuntimeConfig when the file changes.
 */
export function createConfigManager(base: HiramConfig, configPath?: string): ConfigManager {
  const resolvedPath = configPath ?? path.join(path.dirname(base.sqlitePath), 'config.json');
  const emitter = new EventEmitter() as ConfigManager;

  emitter.base = base;
  emitter.runtime = loadRuntimeConfig(resolvedPath);

  let watcher: fs.FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  emitter.reload = () => {
    const prev = emitter.runtime;
    emitter.runtime = loadRuntimeConfig(resolvedPath);

    // Check if anything actually changed.
    if (JSON.stringify(prev) !== JSON.stringify(emitter.runtime)) {
      console.log('[Config] Runtime config reloaded:', emitter.runtime);
      emitter.emit('changed', emitter.runtime);
    }
  };

  emitter.stop = () => {
    watcher?.close();
    watcher = undefined;
    if (debounce) clearTimeout(debounce);
  };

  // Watch the config file for changes (debounced to avoid rapid re-reads).
  try {
    watcher = fs.watch(resolvedPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => emitter.reload(), 500);
    });
    watcher.unref(); // Don't keep the daemon alive just for config watching.
  } catch {
    // File doesn't exist yet — that's fine, will be created later.
  }

  return emitter;
}

function loadRuntimeConfig(filePath: string): RuntimeConfig {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);

    return {
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      tokenBudgetPerRun: typeof parsed.tokenBudgetPerRun === 'number' ? parsed.tokenBudgetPerRun : undefined,
      tokenBudgetPerTicket: typeof parsed.tokenBudgetPerTicket === 'number' ? parsed.tokenBudgetPerTicket : undefined,
      circuitBreakerThreshold: typeof parsed.circuitBreakerThreshold === 'number' ? parsed.circuitBreakerThreshold : undefined,
      circuitBreakerResetMs: typeof parsed.circuitBreakerResetMs === 'number' ? parsed.circuitBreakerResetMs : undefined,
    };
  } catch {
    return {};
  }
}

function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
