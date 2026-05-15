// ---------------------------------------------------------------------------
// MockPluginRegistry — intercepts plugin_invoke calls for testing.
//
// Routes "atlassian" calls to MockJiraBoard.
// Returns stub responses for all other plugins.
// Tracks all invocations through MetricsTracker.
//
// Uses composition — wraps a real PluginRegistry but overrides key methods.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { PluginRegistry } from '../../src/tools/registry.js';
import type { PluginEntry, PluginTool } from '../../src/types/plugin.js';
import type { MockJiraBoard } from './mock-jira.js';
import type { MetricsTracker } from './metrics.js';

export class MockPluginRegistry extends PluginRegistry {
  private jira: MockJiraBoard;
  private metrics: MetricsTracker;
  private mockDb: Database;

  constructor(
    db: Database,
    toolsDir: string,
    jira: MockJiraBoard,
    metrics: MetricsTracker,
  ) {
    super(db, toolsDir);
    this.jira = jira;
    this.metrics = metrics;
    this.mockDb = db;
  }

  /** Skip actual MCP connections. */
  override async start(): Promise<void> {}

  /** Nothing to disconnect. */
  override async stop(): Promise<void> {}

  /** Route through mocks — logs every call for transcript inspection. */
  override async invoke(pluginName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    // Normalize tool names for consistent metrics tracking.
    const normalized = toolName.replace(/^jira_/, '').replace(/^atlassian_/, '');
    this.metrics.recordPluginInvocation(pluginName, normalized);

    console.log(`[TOOL] ${pluginName}.${toolName}(${JSON.stringify(args).slice(0, 500)})`);

    let result: string;
    if (pluginName === 'atlassian') {
      result = this.jira.handleToolCall(toolName, args);
      // If the mock returned an unknown tool error, rewrite it so the agent can self-correct.
      if (result.includes('Unknown JIRA tool')) {
        result = JSON.stringify({
          ok: false,
          error: `Tool "${toolName}" does not exist on plugin "${pluginName}". Call plugin_list_tools({ plugin: "${pluginName}" }) to see available tools and retry with the correct name.`,
        });
      }
    } else {
      result = JSON.stringify({
        ok: true,
        stub: true,
        plugin: pluginName,
        tool: toolName,
      });
    }

    console.log(`[RESULT] ${pluginName}.${toolName} → ${result.slice(0, 300)}`);
    return result;
  }

  /** Return mock tool lists. */
  override async listTools(pluginName?: string): Promise<PluginTool[]> {
    if (pluginName === 'atlassian' || !pluginName) {
      return [
        { pluginName: 'atlassian', name: 'create_issue', description: 'Create a JIRA issue', inputSchema: {} },
        { pluginName: 'atlassian', name: 'get_issue', description: 'Get issue details', inputSchema: {} },
        { pluginName: 'atlassian', name: 'update_issue', description: 'Update issue fields', inputSchema: {} },
        { pluginName: 'atlassian', name: 'transition_issue', description: 'Transition issue status', inputSchema: {} },
        { pluginName: 'atlassian', name: 'get_transitions', description: 'Get available transitions', inputSchema: {} },
        { pluginName: 'atlassian', name: 'add_comment', description: 'Add a comment', inputSchema: {} },
        { pluginName: 'atlassian', name: 'search_issues', description: 'Search with JQL', inputSchema: {} },
      ];
    }
    return [];
  }

  /** Track plugin creation without compiling/starting MCP servers. */
  override async createCustom(opts: {
    name: string;
    source: string;
    description?: string;
    tags?: string[];
    createdBy?: string;
  }): Promise<PluginEntry> {
    this.metrics.recordPluginCreation();

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.mockDb.prepare(
      `INSERT INTO plugins (id, name, description, kind, transport, config, tags, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'custom', 'stdio', ?, ?, 1, ?, ?, ?)`,
    ).run(id, opts.name, opts.description ?? '', JSON.stringify({ sourcePath: '', compiledPath: '' }), JSON.stringify(opts.tags ?? []), opts.createdBy ?? 'agent', now, now);

    return this.getByName(opts.name)!;
  }
}
