import type { PluginRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Tool Runway — end-to-end smoke test for every connected plugin on boot.
//
// For each connected plugin, invokes a single read-only tool to verify the
// full pipeline: credentials, network, API response.
// If a known probe exists for the plugin, use it. Otherwise, try to call
// the first tool discovered via listTools (with empty args).
//
// If a tool fails, the failure is logged but deployment continues.
// ---------------------------------------------------------------------------

/**
 * Preferred probe calls per plugin. Each must be:
 *   1. Read-only — no writes, no mutations
 *   2. Idempotent — calling it N times has the same effect as 0
 *   3. Fast — should return in < 5 seconds
 */
const PROBES: Record<string, { tool: string; args: Record<string, unknown>; description: string }> = {
  atlassian: {
    tool: 'list_projects',
    args: {},
    description: 'List JIRA projects (read-only)',
  },
  'developer-tools': {
    tool: 'shell_exec',
    args: { command: 'echo "hiram-runway-ok"' },
    description: 'Echo test via shell',
  },
  playwright: {
    tool: 'browser_close',
    args: {},
    description: 'Playwright browser close (health check)',
  },
};

export interface RunwayResult {
  plugin: string;
  probe: string;
  status: 'pass' | 'fail' | 'skip';
  latencyMs: number;
  error?: string;
}

export async function runToolRunway(registry: PluginRegistry): Promise<RunwayResult[]> {
  const results: RunwayResult[] = [];
  const connected = registry.listWithStatus().filter((p) => p.connected);

  for (const { entry } of connected) {
    // Use the known probe if we have one.
    let probe = PROBES[entry.name];

    // Otherwise, discover the first tool and call it with empty args.
    if (!probe) {
      try {
        const tools = await registry.listTools(entry.name);
        if (tools.length > 0) {
          // Pick the first tool that looks read-only (list_, get_, search_, describe_).
          const readOnly = tools.find(t =>
            /^(list|get|search|describe|read|show|check|ping|status|info|whoami)/i.test(t.name),
          );
          const target = readOnly ?? tools[0];
          probe = { tool: target.name, args: {}, description: `${target.name} (auto-discovered)` };
        }
      } catch {
        // Can't list tools — skip.
      }
    }

    if (!probe) {
      results.push({ plugin: entry.name, probe: 'none', status: 'skip', latencyMs: 0 });
      continue;
    }

    const t0 = Date.now();
    try {
      await registry.invoke(entry.name, probe.tool, probe.args);
      const latency = Date.now() - t0;
      results.push({ plugin: entry.name, probe: probe.tool, status: 'pass', latencyMs: latency });
    } catch (err) {
      const latency = Date.now() - t0;
      const error = err instanceof Error ? err.message : String(err);
      results.push({ plugin: entry.name, probe: probe.tool, status: 'fail', latencyMs: latency, error });
    }
  }

  return results;
}
