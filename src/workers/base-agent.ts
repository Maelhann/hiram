import Anthropic from '@anthropic-ai/sdk';
import type { PluginRegistry } from '../tools/registry.js';
import type { Vault } from '../secrets/vault.js';
import type { WardenRegistry } from './warden-registry.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { Workspace } from '../workspace.js';
import type { TelemetryCollector } from '../telemetry/collector.js';
import type { PolicyStore } from '../policy/store.js';
import type { EventBus } from '../events/bus.js';
import { CircuitBreaker, CircuitOpenError } from '../resilience/circuit-breaker.js';
import { TokenBudget, TokenBudgetExceeded } from '../resilience/token-budget.js';
import { execWithRetry, classifyError, AbortError, STANDARD_RETRY, PERSISTENT_RETRY, type RetryOptions } from '../resilience/retry-policy.js';
import { compactMessages } from '../resilience/context-compactor.js';
import { type HookEngine, hashInput } from '../hooks/hook-engine.js';
import { createMetaTools, type MetaTool } from '../tools/meta-tools.js';

// ---------------------------------------------------------------------------
// BaseAgent — shared foundation for all HIRAM agent classes.
//
// Handles Anthropic client setup, meta-tool wiring, and the core agentic
// loop (send → tool_use → execute → repeat). Includes circuit breaker for
// API failures, token budget enforcement, exponential backoff retry, model
// fallback, and abort signal support.
//
// Defaults:  model = claude-sonnet-4-6  |  max turns = 500  |  max tokens = 8192
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TURNS = 500;
const DEFAULT_MAX_TOKENS = 32768;
const ESCALATED_MAX_TOKENS = 65536;
/** Number of consecutive 529 errors before falling back to a cheaper model. */
const FALLBACK_THRESHOLD = 3;
/** Max consecutive max_tokens responses before forcing the agent to wrap up. */
const MAX_TOKENS_SPIRAL_LIMIT = 2;

/** Override the model for all agents at runtime. */
let modelOverride: string | null = null;
export function setModelOverride(model: string | null): void {
  modelOverride = model;
}

/** Shared circuit breaker for the Anthropic API — all agents share this. */
const apiCircuitBreaker = new CircuitBreaker({
  name: 'anthropic-api',
  errorThreshold: 5,
  resetTimeout: 60_000, // 1 minute backoff after 5 consecutive errors
  onStateChange: (name, from, to) => {
    if (to === 'open') {
      console.error(`[SELF-HEAL] Anthropic API circuit OPEN — stopping all agent calls for 60s`);
    } else if (to === 'closed') {
      console.log(`[SELF-HEAL] Anthropic API circuit CLOSED — API recovered`);
    }
  },
});

/** Shared token budget — enforced per run and per ticket. */
const tokenBudget = new TokenBudget();

export { apiCircuitBreaker, tokenBudget };

export interface AgentDeps {
  apiKey: string;
  registry: PluginRegistry;
  vault: Vault;
  knowledge: KnowledgeStore;
  workspace?: Workspace;
  telemetry?: TelemetryCollector;
  wardenRegistry?: WardenRegistry;
  policyStore?: PolicyStore;
  eventBus?: EventBus;
  tracker?: import('./agent-tracker.js').AgentTracker;
  hooks?: HookEngine;
  /** E2E test recording — captures every API call and tool execution. Set via setTranscriptRecorder(). */
  transcriptRecorder?: {
    recordApiCall(r: { agentType: string; ticketKey?: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; stopReason: string; toolCallsRequested: string[]; turnIndex: number; latencyMs: number }): void;
    recordToolExec(r: { agentType: string; ticketKey?: string; toolName: string; input: string; result: string; isError: boolean; durationMs: number }): void;
  };
}

export interface RunOptions {
  /** Abort signal — cancelled agents stop immediately. */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms. Default: none (caller controls). */
  timeoutMs?: number;
  /** Retry behaviour. Default: STANDARD_RETRY. Use PERSISTENT_RETRY for wardens. */
  retryOptions?: RetryOptions;
}

export abstract class BaseAgent {
  protected client: Anthropic;
  protected metaTools: MetaTool[];
  protected telemetry?: TelemetryCollector;
  protected hooks?: HookEngine;
  protected transcriptRecorder?: AgentDeps['transcriptRecorder'];
  /** Per-agent model override. Takes precedence over the global setModelOverride(). */
  protected agentModel?: string;

  constructor(deps: AgentDeps) {
    this.client = new Anthropic({ apiKey: deps.apiKey });
    this.telemetry = deps.telemetry;
    this.hooks = deps.hooks;
    this.transcriptRecorder = deps.transcriptRecorder;
    this.metaTools = createMetaTools(deps.registry, deps.vault, deps.knowledge, deps.workspace, deps.wardenRegistry, deps.telemetry, deps.policyStore, deps.eventBus);
  }

  /** Attach a transcript recorder (for E2E tests). */
  setTranscriptRecorder(recorder: AgentDeps['transcriptRecorder']): void {
    this.transcriptRecorder = recorder;
  }

  /** The system prompt that defines this agent's role. */
  protected abstract systemPrompt(): string;

  /** Append an extra tool to this agent's tool belt. */
  addTool(tool: MetaTool): void {
    this.metaTools.push(tool);
  }

  /**
   * Execute a tool call with pre/post hooks and audit logging.
   * Returns the tool result string. Throws on errors (caller handles).
   */
  private async executeToolWithHooks(
    tool: MetaTool,
    toolName: string,
    input: Record<string, unknown>,
    agentType?: string,
    ticketKey?: string,
  ): Promise<string> {
    const t0 = Date.now();

    // Pre-hooks: may block or modify input.
    if (this.hooks) {
      const preResult = await this.hooks.runPreHooks({ toolName, input, agentType, ticketKey });
      if (!preResult.allow) {
        const duration = Date.now() - t0;
        this.hooks.audit({ toolName, agentType, ticketKey, inputHash: hashInput(input), resultStatus: 'blocked', durationMs: duration });
        return JSON.stringify({ error: preResult.reason ?? 'Blocked by safety hook', blocked: true });
      }
      if (preResult.modifiedInput) {
        input = preResult.modifiedInput;
      }
    }

    // Execute the tool.
    const result = await tool.handle(input);
    const duration = Date.now() - t0;

    // Post-hooks.
    let finalResult = result;
    if (this.hooks) {
      const isError = result.includes('"error"') || result.includes('"is_error":true');
      const postResult = await this.hooks.runPostHooks({
        toolName, input, result, isError, durationMs: duration, agentType, ticketKey,
      });
      if (postResult.modifiedResult) {
        finalResult = postResult.modifiedResult;
      }

      // Audit log.
      this.hooks.audit({
        toolName, agentType, ticketKey,
        inputHash: hashInput(input),
        resultStatus: isError ? 'error' : 'ok',
        durationMs: duration,
      });
    }

    // Transcript recording (E2E tests only).
    if (this.transcriptRecorder) {
      try {
        this.transcriptRecorder.recordToolExec({
          agentType: agentType ?? this.constructor.name,
          ticketKey,
          toolName,
          input: JSON.stringify(input),
          result: finalResult,
          isError: finalResult.includes('"error"') || finalResult.includes('"blocked":true'),
          durationMs: duration,
        });
      } catch { /* never block */ }
    }

    return finalResult;
  }

  /**
   * Run the agentic loop with a user prompt. Returns the final assistant text.
   *
   * Supports abort signals, wall-clock timeouts, exponential backoff retry on
   * transient API errors, and automatic model fallback after repeated 529s.
   */
  async run(prompt: string, ticketKey?: string, opts?: RunOptions): Promise<string> {
    const system = this.systemPrompt();
    // Build tool list: built-in web search + agent's meta-tools.
    // Web search is first so cache_control lands on the last function tool.
    const functionTools = this.metaTools.map((t) => t.spec);
    const toolMap = new Map(this.metaTools.map((t) => [t.spec.name, t]));
    const tools: Anthropic.Messages.Tool[] = [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as unknown as Anthropic.Messages.Tool,
      ...functionTools,
    ];
    const tel = this.telemetry;
    const retryOpts = opts?.retryOptions ?? STANDARD_RETRY;

    // Combine caller signal with an optional wall-clock timeout.
    const ac = new AbortController();
    const signal = ac.signal;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    if (opts?.timeoutMs) {
      timeoutTimer = setTimeout(() => ac.abort(), opts.timeoutMs);
    }

    // Per-run model fallback state.
    let consecutive529s = 0;
    let consecutiveMaxTokens = 0;
    let activeModel = this.agentModel ?? modelOverride ?? DEFAULT_MODEL;
    let maxTokens = DEFAULT_MAX_TOKENS;

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: prompt },
    ];

    let lastText = '';
    let runTokens = 0;

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (signal.aborted) throw new AbortError('Agent aborted');

        tel?.inc('api.turns');

        const t0 = Date.now();
        let response: Anthropic.Messages.Message;
        try {
          // Retry wraps the circuit breaker: a successful retry = circuit sees success.
          // Cache strategy:
          // 1. System prompt — cached (static across all turns)
          // 2. Tools — last tool marked with cache_control (static across all turns)
          // 3. Messages — last message marked with cache_control (grows each turn,
          //    previous turns hit cache on subsequent API calls)
          const cachedTools = tools.map((t, i) =>
            i === tools.length - 1
              ? { ...t, cache_control: { type: 'ephemeral' as const } }
              : t,
          );

          // Mark the last message for caching.
          const cachedMessages = messages.map((m, i) => {
            if (i !== messages.length - 1) return m;
            if (typeof m.content === 'string') {
              return { ...m, content: [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }] };
            }
            if (Array.isArray(m.content) && m.content.length > 0) {
              const lastBlock = m.content[m.content.length - 1];
              return { ...m, content: [...m.content.slice(0, -1), { ...lastBlock, cache_control: { type: 'ephemeral' as const } }] };
            }
            return m;
          });

          response = await execWithRetry(
            () => apiCircuitBreaker.exec(async () => {
              const stream = this.client.messages.stream({
                model: activeModel,
                max_tokens: maxTokens,
                system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
                tools: cachedTools,
                messages: cachedMessages,
              });
              return stream.finalMessage();
            }),
            {
              ...retryOpts,
              onRetry: (attempt, delayMs, error) => {
                tel?.inc('api.retries');
                const status = (error as { status?: number }).status;
                console.warn(
                  `[RETRY] Attempt ${attempt}, waiting ${Math.round(delayMs / 1000)}s` +
                  `${status ? ` (HTTP ${status})` : ''}: ${error.message}`,
                );

                // Track consecutive 529s for model fallback.
                if (status === 529) {
                  consecutive529s++;
                  if (consecutive529s >= FALLBACK_THRESHOLD && activeModel !== FALLBACK_MODEL) {
                    console.warn(`[SELF-HEAL] ${consecutive529s} consecutive 529s — falling back to ${FALLBACK_MODEL}`);
                    activeModel = FALLBACK_MODEL;
                    tel?.inc('api.model_fallbacks');
                  }
                } else {
                  consecutive529s = 0;
                }

                retryOpts.onRetry?.(attempt, delayMs, error);
              },
            },
            signal,
          );
        } catch (err) {
          tel?.inc('api.errors');
          if (err instanceof CircuitOpenError) {
            console.error(`[SELF-HEAL] Agent aborted: ${err.message}`);
          }
          throw err;
        }
        const latency = Date.now() - t0;

        // Successful call — reset 529 counter.
        consecutive529s = 0;

        // Record API metrics.
        tel?.inc('api.calls');
        tel?.record('api.latency_ms', latency);

        // Track token usage, cache performance, and enforce budget.
        if (response.usage) {
          const turnTokens = response.usage.input_tokens + response.usage.output_tokens;
          tel?.inc('api.tokens_in', response.usage.input_tokens);
          tel?.inc('api.tokens_out', response.usage.output_tokens);
          runTokens += turnTokens;

          // Track cache performance.
          const usage = response.usage as unknown as Record<string, number>;
          if (usage.cache_read_input_tokens) {
            tel?.inc('api.cache_read_tokens', usage.cache_read_input_tokens);
          }
          if (usage.cache_creation_input_tokens) {
            tel?.inc('api.cache_write_tokens', usage.cache_creation_input_tokens);
          }

          try {
            tokenBudget.checkRun(runTokens);
            if (ticketKey) {
              tokenBudget.recordTicket(ticketKey, turnTokens);
            }
          } catch (err) {
            if (err instanceof TokenBudgetExceeded) {
              console.error(`[SELF-HEAL] ${err.message}`);
              tel?.inc('api.budget_exceeded');
            }
            throw err;
          }

          // Context compaction: proactively shrink the conversation to avoid
          // hitting the hard budget limit and losing all work.
          const compacted = compactMessages(messages, {
            currentTokens: runTokens,
            budgetLimit: tokenBudget.perRunLimit,
          });
          if (compacted.method !== 'none') {
            messages.length = 0;
            messages.push(...compacted.messages);
            runTokens = Math.max(0, runTokens - compacted.tokensFreed);
            tel?.inc('api.context_compactions');
            console.log(
              `[COMPACT] ${compacted.method}: freed ~${compacted.tokensFreed} tokens, ` +
              `${messages.length} messages remaining`,
            );
          }
        }

        // Transcript recording (E2E tests only).
        if (this.transcriptRecorder) {
          try {
            const recToolCalls = response.content
              .filter((b) => b.type === 'tool_use')
              .map((b) => ('name' in b ? (b as { name: string }).name : ''));
            const recUsage = response.usage as unknown as Record<string, number>;
            this.transcriptRecorder.recordApiCall({
              agentType: this.constructor.name,
              ticketKey,
              model: activeModel,
              inputTokens: response.usage?.input_tokens ?? 0,
              outputTokens: response.usage?.output_tokens ?? 0,
              cacheReadTokens: recUsage?.cache_read_input_tokens ?? 0,
              cacheWriteTokens: recUsage?.cache_creation_input_tokens ?? 0,
              stopReason: response.stop_reason ?? 'unknown',
              toolCallsRequested: recToolCalls,
              turnIndex: turn,
              latencyMs: latency,
            });
          } catch { /* never block */ }
        }

        messages.push({ role: 'assistant', content: response.content });

        for (const block of response.content) {
          if (block.type === 'text') lastText = block.text;
        }

        // Check for tool_use blocks REGARDLESS of stop_reason.
        // The model can emit tool_use with end_turn or max_tokens.
        // If tool_use blocks exist, we MUST provide tool_results.
        const hasToolUseBlocks = response.content.some((b) => b.type === 'tool_use');

        if (!hasToolUseBlocks && response.stop_reason === 'end_turn') break;

        if (response.stop_reason === 'max_tokens' && !hasToolUseBlocks) {
          consecutiveMaxTokens++;
          tel?.inc('api.max_tokens_hits');

          if (consecutiveMaxTokens >= MAX_TOKENS_SPIRAL_LIMIT) {
            // Circuit-break: two consecutive truncations means the model is
            // generating text that won't fit. Stop the run with what we have
            // rather than spiraling. The partial text is in lastText.
            console.warn(`[AGENT] max_tokens circuit-break after ${consecutiveMaxTokens} consecutive truncations. Ending run.`);
            tel?.inc('api.max_tokens_circuit_breaks');
            break;
          }

          // First hit: compact context to shed older messages, then redirect
          // the model to use tool calls instead of long text generation.
          const compacted = compactMessages(messages, {
            currentTokens: runTokens,
            budgetLimit: Math.floor(tokenBudget.perRunLimit * 0.7), // aggressive compact
          });
          if (compacted.method !== 'none') {
            messages.length = 0;
            messages.push(...compacted.messages);
            runTokens = Math.max(0, runTokens - compacted.tokensFreed);
            console.log(`[COMPACT] max_tokens recovery: freed ~${compacted.tokensFreed} tokens`);
          }

          messages.push({
            role: 'user',
            content: 'SYSTEM: Your output was truncated (too long). Do NOT continue generating text. ' +
              'Instead, save your work using a tool call (knowledge_save, comment, or write_file) ' +
              'and then finish. Keep any remaining output under 1000 words.',
          });
          continue;
        } else {
          consecutiveMaxTokens = 0;
        }

        if (hasToolUseBlocks) {
          // Collect ALL tool_use blocks — every one MUST get a tool_result
          // or the API will reject the next request.
          const toolCalls = response.content.filter(
            (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
          );
          const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

          const concurrentCalls: Anthropic.Messages.ToolUseBlock[] = [];
          const sequentialCalls: Anthropic.Messages.ToolUseBlock[] = [];

          for (const block of toolCalls) {
            const tool = toolMap.get(block.name);
            if (tool?.concurrent) {
              concurrentCalls.push(block);
            } else {
              sequentialCalls.push(block);
            }
          }

          // Execute concurrent-safe tools in parallel.
          if (concurrentCalls.length > 0) {
            const results = await Promise.allSettled(
              concurrentCalls.map(async (block) => {
                if (signal.aborted) throw new AbortError('Agent aborted');
                const tool = toolMap.get(block.name)!;
                const result = await this.executeToolWithHooks(tool, block.name, block.input as Record<string, unknown>);
                return { id: block.id, content: result };
              }),
            );

            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              const block = concurrentCalls[i];
              if (r.status === 'fulfilled') {
                toolResults.push({ type: 'tool_result', tool_use_id: r.value.id, content: r.value.content });
              } else {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: JSON.stringify({ error: r.reason instanceof Error ? r.reason.message : String(r.reason) }),
                  is_error: true,
                });
              }
            }
          }

          // Execute non-concurrent tools sequentially.
          for (const block of sequentialCalls) {
            const tool = toolMap.get(block.name);
            if (!tool) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: `Unknown tool: ${block.name}` }),
              });
              continue;
            }

            if (signal.aborted) {
              // Aborted — still MUST provide a tool_result for this block.
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: 'Agent aborted' }),
                is_error: true,
              });
              continue;
            }

            try {
              const result = await this.executeToolWithHooks(tool, block.name, block.input as Record<string, unknown>);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            } catch (err) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
                is_error: true,
              });
            }
          }

          // Safety check: ensure every tool_use has a tool_result.
          // This should never trigger, but guards against future bugs.
          for (const block of toolCalls) {
            if (!toolResults.some(r => r.tool_use_id === block.id)) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: 'Tool result missing — internal error' }),
                is_error: true,
              });
            }
          }

          messages.push({ role: 'user', content: toolResults });
        }
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    return lastText;
  }
}

export { AbortError } from '../resilience/retry-policy.js';
