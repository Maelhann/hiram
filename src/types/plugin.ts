// ---------------------------------------------------------------------------
// Plugin — a unified abstraction built on MCP.
//
// Every plugin is an MCP server. Two kinds:
//   - Custom: TypeScript source written by agents, compiled and started as a
//     stdio MCP server process by the registry.
//   - Installed: Pre-built MCP servers from the ecosystem, connected via
//     stdio (local command) or http/ws (remote URL).
//
// Agents see one interface: plugin_list, plugin_invoke, plugin_install, etc.
// Under the hood, everything speaks MCP.
// ---------------------------------------------------------------------------

export type PluginKind = 'custom' | 'installed';
export type PluginTransport = 'stdio' | 'http' | 'ws';

/** Row stored in SQLite. */
export interface PluginRecord {
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  transport: PluginTransport;
  /** For custom: path to .ts source. For installed/stdio: command + args JSON. For http/ws: url. */
  config: string;
  tags: string;            // JSON string[]
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Parsed view returned by registry methods. */
export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  transport: PluginTransport;
  config: CustomConfig | StdioConfig | RemoteConfig;
  tags: string[];
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomConfig {
  sourcePath: string;
  compiledPath: string;
}

export interface StdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteConfig {
  url: string;
  headers?: Record<string, string>;
}

/** Tool exposed by a connected plugin (MCP server). */
export interface PluginTool {
  pluginName: string;
  name: string;
  description?: string;
  inputSchema: unknown;
}

// ---------------------------------------------------------------------------
// Plugin Work types — kept for the PluginWorker agent
// ---------------------------------------------------------------------------

export interface PluginWorkReport {
  status: 'success' | 'failure' | 'partial';
  plugin: {
    name: string;
    description: string;
    tools: string[];
  } | null;
  notes: string;
}
