import type { PreHook, PostHook, HookEngine } from './hook-engine.js';
import { hashInput } from './hook-engine.js';

// ---------------------------------------------------------------------------
// Built-in safety hooks — registered at daemon boot, cannot be removed by
// agents. These are code-level guardrails for an autonomous system that
// handles real money, infrastructure, and communications.
// ---------------------------------------------------------------------------

// ---- Dangerous shell command patterns ----
const DANGEROUS_COMMANDS: { pattern: RegExp; description: string }[] = [
  { pattern: /\brm\s+-rf\s+\/(?!\w)/,          description: 'rm -rf / (filesystem wipe)' },
  { pattern: /\bmkfs\b/,                        description: 'mkfs (format filesystem)' },
  { pattern: /\bdd\s+if=/,                      description: 'dd (raw disk write)' },
  { pattern: /\bshutdown\b/,                    description: 'shutdown (power off)' },
  { pattern: /\breboot\b/,                      description: 'reboot' },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,  description: 'fork bomb' },
  { pattern: /\bgit\s+push\s+.*--force\s+.*\bmain\b/, description: 'force push to main' },
  { pattern: /\bgit\s+push\s+.*\bmain\b.*--force/,    description: 'force push to main' },
  { pattern: /\bcurl\b.*\|\s*(?:bash|sh)\b/,    description: 'piping curl to shell' },
  { pattern: /\bwget\b.*\|\s*(?:bash|sh)\b/,    description: 'piping wget to shell' },
  { pattern: />\s*\/dev\/[sh]da/,               description: 'writing to raw block device' },
  { pattern: /\biptables\s+-F\b/,               description: 'flushing iptables rules' },
  { pattern: /\bsystemctl\s+(?:stop|disable)\s+(?:sshd|firewalld|ufw)\b/, description: 'disabling critical services' },
];

/** Pre-hook: block dangerous shell commands. */
export const shellSafetyHook: PreHook = {
  name: 'shell-safety',
  toolPattern: 'shell_exec',
  phase: 'pre',
  action(ctx) {
    const command = ctx.input.command as string | undefined;
    if (!command) return { allow: true };

    for (const { pattern, description } of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) {
        console.warn(`[SAFETY] Blocked dangerous command: ${description}`);
        return {
          allow: false,
          reason: `Blocked by safety hook: ${description}. This command is not allowed in autonomous mode.`,
        };
      }
    }

    return { allow: true };
  },
};

// ---- Financial guardrails ----
const FINANCIAL_PLUGINS = ['revolut', 'revolut-business', 'stripe'];
const PAYMENT_TOOLS = ['create_payment', 'create_transfer', 'send_payment', 'create_payout'];
const SPENDING_CAP_EUR = 500;

/** Pre-hook: enforce spending caps on financial plugins. */
export const financialSafetyHook: PreHook = {
  name: 'financial-safety',
  toolPattern: 'plugin_invoke',
  phase: 'pre',
  action(ctx) {
    const plugin = (ctx.input.plugin as string || '').toLowerCase();
    const tool = (ctx.input.tool as string || '').toLowerCase();

    if (!FINANCIAL_PLUGINS.includes(plugin)) return { allow: true };
    if (!PAYMENT_TOOLS.includes(tool)) return { allow: true };

    // Check the arguments for an amount field.
    const args = ctx.input.arguments as Record<string, unknown> | undefined;
    if (!args) return { allow: true };

    const amount = Number(args.amount ?? args.value ?? args.total ?? 0);
    if (amount > SPENDING_CAP_EUR) {
      console.warn(`[SAFETY] Blocked payment of ${amount} (cap: ${SPENDING_CAP_EUR})`);
      return {
        allow: false,
        reason: `Blocked by financial safety hook: payment amount ${amount} exceeds autonomous spending cap of ${SPENDING_CAP_EUR}. Requires manual approval.`,
      };
    }

    return { allow: true };
  },
};

/** Post-hook: audit log every tool call. */
export function createAuditHook(): PostHook {
  return {
    name: 'audit-log',
    toolPattern: /.*/,
    phase: 'post',
    action(ctx) {
      // The HookEngine.audit() method is called separately from base-agent.
      // This hook exists as a placeholder for any post-tool audit logic.
      return undefined;
    },
  };
}

/** Register all built-in safety hooks on a HookEngine instance. */
export function registerSafetyHooks(engine: HookEngine): void {
  engine.registerPre(shellSafetyHook);
  engine.registerPre(financialSafetyHook);
  engine.registerPost(createAuditHook());
}
