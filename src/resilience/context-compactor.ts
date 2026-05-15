import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// ContextCompactor — reduces conversation size when approaching token limits.
//
// Two-layer strategy (cheapest first):
//   1. Snip: Replace old tool results with short summaries
//   2. Collapse: Merge early conversation turns into a single recap message
//
// Inspired by Claude Code's multi-layer compression system but adapted for
// HIRAM's headless daemon context (no UI, no interactive approval).
// ---------------------------------------------------------------------------

type Message = Anthropic.Messages.MessageParam;

export interface CompactResult {
  messages: Message[];
  tokensFreed: number; // estimated tokens removed
  method: 'snip' | 'collapse' | 'none';
}

export interface CompactOptions {
  /** Number of recent turns to preserve intact. Default 10. */
  preserveRecent?: number;
  /** Estimated token count of the current messages. */
  currentTokens: number;
  /** Token budget limit. */
  budgetLimit: number;
  /** Threshold ratio to trigger compaction. Default 0.6 (60%). */
  threshold?: number;
}

const DEFAULT_PRESERVE_RECENT = 10;
const DEFAULT_THRESHOLD = 0.6;

/** Rough token estimation: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTextLength(msg: Message): number {
  if (typeof msg.content === 'string') return msg.content.length;
  if (Array.isArray(msg.content)) {
    let len = 0;
    for (const block of msg.content) {
      if ('text' in block && typeof block.text === 'string') len += block.text.length;
      if ('content' in block && typeof block.content === 'string') len += block.content.length;
    }
    return len;
  }
  return 0;
}

/**
 * Attempt to compact the conversation to stay within token budget.
 * Returns the compacted messages and an estimate of tokens freed.
 */
export function compactMessages(
  messages: Message[],
  opts: CompactOptions,
): CompactResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const ratio = opts.currentTokens / opts.budgetLimit;

  // Not over threshold — no compaction needed.
  if (ratio < threshold) {
    return { messages, tokensFreed: 0, method: 'none' };
  }

  const preserveRecent = opts.preserveRecent ?? DEFAULT_PRESERVE_RECENT;

  // Layer 1: Snip old tool results.
  const snipped = snipToolResults(messages, preserveRecent);
  const snipTokensFreed = estimateTokens(
    messages.map(messageTextLength).reduce((a, b) => a + b, 0).toString(),
  ) - estimateTokens(
    snipped.map(messageTextLength).reduce((a, b) => a + b, 0).toString(),
  );

  // Check if snipping was enough.
  const afterSnipTokens = opts.currentTokens - snipTokensFreed;
  if (afterSnipTokens / opts.budgetLimit < threshold) {
    return {
      messages: snipped,
      tokensFreed: snipTokensFreed,
      method: 'snip',
    };
  }

  // Layer 2: Collapse early turns into a summary.
  const collapsed = collapseEarlyTurns(snipped, preserveRecent);
  const totalFreed = estimateTokensDiff(messages, collapsed.messages);

  // Validate: every tool_use in an assistant message must have a
  // corresponding tool_result in the immediately following user message.
  const validated = validateToolPairs(collapsed.messages) ? collapsed.messages : messages;
  if (validated === messages) {
    console.warn('[COMPACT] Validation failed — skipping compaction to avoid tool_use/tool_result corruption.');
    return { messages, tokensFreed: 0, method: 'none' };
  }

  return {
    messages: validated,
    tokensFreed: totalFreed,
    method: 'collapse',
  };
}

/** Verify every tool_use has a matching tool_result in the next message. */
function validateToolPairs(messages: Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseIds = (msg.content as any[])
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => b.id as string);

    if (toolUseIds.length === 0) continue;

    // The next message must be a user message with tool_results for all these IDs.
    const next = messages[i + 1];
    if (!next || next.role !== 'user' || !Array.isArray(next.content)) return false;

    const resultIds = new Set(
      (next.content as any[])
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => b.tool_use_id as string),
    );

    for (const id of toolUseIds) {
      if (!resultIds.has(id)) return false;
    }
  }
  return true;
}

/**
 * Layer 1: Replace tool results in old messages with short summaries.
 * Preserves the most recent `preserveRecent` message pairs intact.
 */
function snipToolResults(messages: Message[], preserveRecent: number): Message[] {
  // Each "turn" is roughly 2 messages (assistant + user with tool results).
  let preserveFromIdx = Math.max(0, messages.length - preserveRecent * 2);
  // Never split a tool_use/tool_result pair — if the boundary lands on a
  // tool_result user message, include its preceding assistant message too.
  while (preserveFromIdx > 0) {
    const msg = messages[preserveFromIdx];
    if (msg?.role === 'user' && Array.isArray(msg.content) &&
        (msg.content as any[]).some((b: any) => b.type === 'tool_result')) {
      preserveFromIdx--;
    } else break;
  }
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Preserve recent messages as-is.
    if (i >= preserveFromIdx) {
      result.push(msg);
      continue;
    }

    // Snip tool_result blocks in old user messages.
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const snippedContent = msg.content.map((block) => {
        if (block.type === 'tool_result') {
          const isError = 'is_error' in block && block.is_error;
          const snippet = isError
            ? '[Tool result snipped: returned error]'
            : '[Tool result snipped: returned ok]';
          return {
            ...block,
            content: snippet,
          };
        }
        return block;
      });
      result.push({ role: 'user', content: snippedContent });
      continue;
    }

    // Snip text blocks in old assistant messages (keep tool_use blocks).
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const snippedContent = msg.content.map((block) => {
        if (block.type === 'text' && block.text.length > 200) {
          return { ...block, text: block.text.slice(0, 150) + '... [snipped]' };
        }
        return block;
      });
      result.push({ role: 'assistant', content: snippedContent });
      continue;
    }

    result.push(msg);
  }

  return result;
}

/**
 * Layer 2: Collapse all messages before the preserve window into a single
 * recap message. This is a heuristic extraction (no LLM call) that
 * summarizes tool calls made and their outcomes.
 */
function collapseEarlyTurns(
  messages: Message[],
  preserveRecent: number,
): { messages: Message[]; summary: string } {
  const preserveFromIdx = Math.max(0, messages.length - preserveRecent * 2);

  if (preserveFromIdx <= 1) {
    // Nothing to collapse (only the initial user message + recent turns).
    return { messages, summary: '' };
  }

  // Build a summary of what happened in the early turns.
  const summaryParts: string[] = ['[Context compacted — early conversation summary]'];
  let toolCallCount = 0;
  let toolErrorCount = 0;
  const toolNames = new Set<string>();

  for (let i = 0; i < preserveFromIdx; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolCallCount++;
          toolNames.add(block.name);
        }
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && 'is_error' in block && block.is_error) {
          toolErrorCount++;
        }
      }
    }
  }

  summaryParts.push(
    `Turns 1-${Math.floor(preserveFromIdx / 2)}: Made ${toolCallCount} tool calls ` +
    `(${toolErrorCount} errors) using: ${[...toolNames].join(', ') || 'none'}.`,
  );

  // Extract the initial user prompt (always important context).
  const firstMsg = messages[0];
  if (firstMsg?.role === 'user') {
    const text = typeof firstMsg.content === 'string'
      ? firstMsg.content
      : '';
    if (text.length > 0) {
      const truncated = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
      summaryParts.push('', 'Original task:', truncated);
    }
  }

  const summary = summaryParts.join('\n');

  // Adjust the preserve boundary to never split a tool_use/tool_result pair.
  // Walk backward from preserveFromIdx: if the first preserved message is a
  // user message with tool_results, its preceding assistant message with
  // tool_use blocks was collapsed — this would corrupt the conversation.
  // Fix: include the assistant message too.
  let safeIdx = preserveFromIdx;
  while (safeIdx > 0) {
    const msg = messages[safeIdx];
    if (!msg) break;
    // If first preserved message is a user tool_result, we need the assistant before it.
    if (msg.role === 'user' && Array.isArray(msg.content) &&
        msg.content.some((b: any) => b.type === 'tool_result')) {
      safeIdx--;
      continue;
    }
    break;
  }

  // Build the compacted message list: summary + preserved recent messages.
  const preserved = messages.slice(safeIdx);

  // Ensure the first preserved message is a user message (valid alternation).
  // If it's an assistant message, prepend the summary as a user message.
  const compacted: Message[] = [
    { role: 'user', content: summary },
  ];

  if (preserved.length > 0 && preserved[0].role === 'assistant') {
    // Already starts with assistant — the summary user message provides the context.
    compacted.push(...preserved);
  } else if (preserved.length > 0 && preserved[0].role === 'user') {
    // Insert an assistant ack between summary and the preserved user message.
    compacted.push(
      { role: 'assistant', content: [{ type: 'text', text: 'Understood. Continuing from where I left off.' }] },
      ...preserved,
    );
  }

  return { messages: compacted, summary };
}

/** Estimate the token difference between two message arrays. */
function estimateTokensDiff(original: Message[], compacted: Message[]): number {
  const origLen = original.reduce((sum, m) => sum + messageTextLength(m), 0);
  const compLen = compacted.reduce((sum, m) => sum + messageTextLength(m), 0);
  return Math.max(0, estimateTokens(origLen.toString()) - estimateTokens(compLen.toString()));
}
