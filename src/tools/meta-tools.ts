import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Anthropic from '@anthropic-ai/sdk';
import type { PluginRegistry } from './registry.js';
import type { Vault } from '../secrets/vault.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { Workspace } from '../workspace.js';
import type { WardenRegistry } from '../workers/warden-registry.js';
import type { TelemetryCollector } from '../telemetry/collector.js';
import { createPluginTools } from './registry.js';
import { createKnowledgeTools } from '../knowledge/store.js';
import { createWardenTools } from '../workers/warden-registry.js';
import type { PolicyStore } from '../policy/store.js';
import type { EventBus } from '../events/bus.js';
import { createPolicyTools } from '../policy/store.js';
import { createEventTools } from '../events/bus.js';
import { createMetricsTool } from '../telemetry/collector.js';
import * as workerTypes from '../workers/worker-types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Meta-tools — Anthropic API tool definitions that let agents interact with
// the plugin registry, secrets vault, knowledge store, warden registry,
// workspace, and shell at runtime.
// ---------------------------------------------------------------------------

type Tool = Anthropic.Messages.Tool;

export interface MetaTool {
  spec: Tool;
  handle: (input: Record<string, unknown>) => Promise<string>;
  /** If true, this tool is safe to execute concurrently with other concurrent tools. Default false (fail-closed). */
  concurrent?: boolean;
}

/** Build the full set of meta-tools. */
export function createMetaTools(
  registry: PluginRegistry,
  vault: Vault,
  knowledge: KnowledgeStore,
  workspace?: Workspace,
  wardenRegistry?: WardenRegistry,
  telemetry?: TelemetryCollector,
  policyStore?: PolicyStore,
  eventBus?: EventBus,
): MetaTool[] {
  const tools: MetaTool[] = [
    ...createPluginTools(registry),
    secretSet(vault),
    secretGet(vault),
    secretList(vault),
    secretDelete(vault),
    ...createKnowledgeTools(knowledge),
    shellExec(),
    getWorkerType(),
    listWorkerTypes(),
  ];

  if (wardenRegistry) {
    tools.push(...createWardenTools(wardenRegistry));
  }

  if (telemetry) {
    tools.push(createMetricsTool(telemetry));
  }

  if (policyStore) {
    tools.push(...createPolicyTools(policyStore));
  }

  if (eventBus) {
    tools.push(...createEventTools(eventBus));
  }

  void workspace;

  return tools;
}

// ===========================================================================
// Shell execution — core tool available to all agents
// ===========================================================================

function shellExec(): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'shell_exec',
      description: 'Execute a shell command on the server and return stdout/stderr. Use for builds, tests, installs, git operations, inspecting files, or any CLI task. Commands run until completion with no timeout.',
      input_schema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'Shell command to run (e.g. "ls -la", "npm test", "git status")' },
          cwd: { type: 'string', description: 'Working directory (defaults to home). Use /opt/hiram/dev/ for code, /opt/hiram/ops/ for infrastructure, etc.' },
        },
        required: ['command'],
      },
    },
    async handle(input) {
      try {
        const { stdout, stderr } = await execFileAsync(
          'bash', ['-c', input.command as string],
          {
            cwd: (input.cwd as string) ?? process.env.HOME,
            timeout: 0,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env },
          },
        );
        const output = [
          stdout ? `STDOUT:\n${stdout}` : '',
          stderr ? `STDERR:\n${stderr}` : '',
        ].filter(Boolean).join('\n\n');
        return JSON.stringify({ ok: true, output: output || '(no output)' });
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message: string; code?: number };
        return JSON.stringify({
          ok: false,
          exit_code: e.code ?? 'unknown',
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? '',
          error: e.message,
        });
      }
    },
  };
}

// ===========================================================================
// Secret tools
// ===========================================================================

function secretSet(vault: Vault): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'secret_set',
      description: 'Store or update a secret in the encrypted vault. If the secret already exists it will be overwritten.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Secret name (e.g. "OPENAI_API_KEY", "SMTP_PASSWORD")' },
          value: { type: 'string', description: 'The secret value to store' },
        },
        required: ['name', 'value'],
      },
    },
    async handle(input) {
      try {
        vault.set(input.name as string, input.value as string);
        return JSON.stringify({ ok: true, name: input.name });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function secretGet(vault: Vault): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'secret_get',
      description: 'Retrieve a secret value from the encrypted vault by name.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Secret name to retrieve' },
        },
        required: ['name'],
      },
    },
    async handle(input) {
      const value = vault.get(input.name as string);
      if (value === undefined) {
        return JSON.stringify({ ok: false, error: `Secret not found: ${input.name}` });
      }
      return JSON.stringify({ ok: true, name: input.name, value });
    },
  };
}

function secretList(vault: Vault): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'secret_list',
      description: 'List all secret names stored in the vault. Returns names only, not values.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    async handle() {
      const names = vault.list();
      return JSON.stringify({ ok: true, secrets: names, count: names.length });
    },
  };
}

function secretDelete(vault: Vault): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'secret_delete',
      description: 'Permanently remove a secret from the vault.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Secret name to delete' },
        },
        required: ['name'],
      },
    },
    async handle(input) {
      const deleted = vault.delete(input.name as string);
      if (!deleted) {
        return JSON.stringify({ ok: false, error: `Secret not found: ${input.name}` });
      }
      return JSON.stringify({ ok: true, name: input.name });
    },
  };
}

// ===========================================================================
// Worker type tools
// ===========================================================================

const WORKER_TYPES: Record<string, string> = {
  // Development
  developer: workerTypes.DEVELOPER,
  reviewer: workerTypes.REVIEWER,
  tester: workerTypes.TESTER,
  // Operations
  deployer: workerTypes.DEPLOYER,
  provisioner: workerTypes.PROVISIONER,
  incident_responder: workerTypes.INCIDENT_RESPONDER,
  // Content
  writer: workerTypes.WRITER,
  seo_auditor: workerTypes.SEO_AUDITOR,
  editor: workerTypes.EDITOR,
  // Research
  researcher: workerTypes.RESEARCHER,
  intel_sweeper: workerTypes.INTEL_SWEEPER,
  // Monitor
  health_checker: workerTypes.HEALTH_CHECKER,
  log_analyst: workerTypes.LOG_ANALYST,
  cost_analyst: workerTypes.COST_ANALYST,
  // Outreach
  prospector: workerTypes.PROSPECTOR,
  copywriter: workerTypes.COPYWRITER,
  campaign_launcher: workerTypes.CAMPAIGN_LAUNCHER,
  social_messenger: workerTypes.SOCIAL_MESSENGER,
  campaign_analyst: workerTypes.CAMPAIGN_ANALYST,
};

function getWorkerType(): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'get_worker_type',
      description: 'Retrieve the system prompt for a worker type by name. Use this to get the full system_prompt to pass to run_worker. Available types: ' +
        Object.keys(WORKER_TYPES).join(', '),
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Worker type name (e.g. "developer", "deployer", "researcher")' },
        },
        required: ['name'],
      },
    },
    async handle(input) {
      const name = input.name as string;
      const prompt = WORKER_TYPES[name];
      if (!prompt) {
        return JSON.stringify({ ok: false, error: `Unknown worker type: ${name}. Available: ${Object.keys(WORKER_TYPES).join(', ')}` });
      }
      return JSON.stringify({ ok: true, name, system_prompt: prompt });
    },
  };
}

function listWorkerTypes(): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'list_worker_types',
      description: 'List all available worker types.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    async handle() {
      return JSON.stringify({
        ok: true,
        worker_types: Object.keys(WORKER_TYPES),
      });
    },
  };
}
