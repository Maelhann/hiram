import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// HookEngine — pre/post tool execution hooks for safety and auditing.
//
// Inspired by Claude Code's hook system. Hooks fire conditionally based on
// tool name pattern matching. Pre-hooks can block or modify tool inputs.
// Post-hooks can modify results or trigger side effects (audit logging).
//
// Built-in safety hooks are registered at construction and cannot be
// removed by agents — they are code-level guardrails, not prompt-level.
// ---------------------------------------------------------------------------

export interface HookContext {
  toolName: string;
  input: Record<string, unknown>;
  agentType?: string;
  ticketKey?: string;
}

export interface PreHookResult {
  allow: boolean;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
}

export interface PostHookContext extends HookContext {
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface PostHookResult {
  modifiedResult?: string;
}

export interface Hook {
  name: string;
  /** Regex or exact tool name to match. */
  toolPattern: RegExp | string;
  phase: 'pre' | 'post';
}

export interface PreHook extends Hook {
  phase: 'pre';
  action: (ctx: HookContext) => PreHookResult | Promise<PreHookResult>;
}

export interface PostHook extends Hook {
  phase: 'post';
  action: (ctx: PostHookContext) => PostHookResult | void | Promise<PostHookResult | void>;
}

export type AnyHook = PreHook | PostHook;

export class HookEngine {
  private preHooks: PreHook[] = [];
  private postHooks: PostHook[] = [];
  private db?: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db;
  }

  /** Register a pre-tool hook. */
  registerPre(hook: PreHook): void {
    this.preHooks.push(hook);
  }

  /** Register a post-tool hook. */
  registerPost(hook: PostHook): void {
    this.postHooks.push(hook);
  }

  /** Run all matching pre-hooks. Returns the first deny result, or allow. */
  async runPreHooks(ctx: HookContext): Promise<PreHookResult> {
    let currentInput = ctx.input;

    for (const hook of this.preHooks) {
      if (!matchesPattern(ctx.toolName, hook.toolPattern)) continue;

      try {
        const result = await hook.action({ ...ctx, input: currentInput });
        if (!result.allow) {
          return result;
        }
        if (result.modifiedInput) {
          currentInput = result.modifiedInput;
        }
      } catch (err) {
        // Hook errors are logged but don't block execution (fail-open for hooks).
        console.error(`[Hook:${hook.name}] Pre-hook error:`, err);
      }
    }

    return { allow: true, modifiedInput: currentInput !== ctx.input ? currentInput : undefined };
  }

  /** Run all matching post-hooks. */
  async runPostHooks(ctx: PostHookContext): Promise<PostHookResult> {
    let currentResult = ctx.result;

    for (const hook of this.postHooks) {
      if (!matchesPattern(ctx.toolName, hook.toolPattern)) continue;

      try {
        const hookResult = await hook.action({ ...ctx, result: currentResult });
        if (hookResult?.modifiedResult) {
          currentResult = hookResult.modifiedResult;
        }
      } catch (err) {
        console.error(`[Hook:${hook.name}] Post-hook error:`, err);
      }
    }

    return currentResult !== ctx.result ? { modifiedResult: currentResult } : {};
  }

  /** Write an audit log entry to SQLite. */
  audit(entry: {
    toolName: string;
    agentType?: string;
    ticketKey?: string;
    inputHash: string;
    resultStatus: 'ok' | 'error' | 'blocked';
    durationMs: number;
  }): void {
    if (!this.db) return;

    try {
      this.db.prepare(
        `INSERT INTO audit_log (id, timestamp, agent_type, ticket_key, tool_name, input_hash, result_status, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        new Date().toISOString(),
        entry.agentType ?? null,
        entry.ticketKey ?? null,
        entry.toolName,
        entry.inputHash,
        entry.resultStatus,
        entry.durationMs,
      );
    } catch (err) {
      // Audit logging must never break tool execution.
      console.error('[Audit] Write failed:', err);
    }
  }
}

/** Check if a tool name matches a hook's pattern. */
function matchesPattern(toolName: string, pattern: RegExp | string): boolean {
  if (typeof pattern === 'string') return toolName === pattern;
  return pattern.test(toolName);
}

/** Hash tool input for audit logging (SHA-256, truncated to 16 chars). */
export function hashInput(input: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}
