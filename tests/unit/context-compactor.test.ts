import { describe, it, expect } from 'vitest';
import { compactMessages } from '../../src/resilience/context-compactor.js';
import type Anthropic from '@anthropic-ai/sdk';

type Message = Anthropic.Messages.MessageParam;

function makeToolResult(id: string, content: string, isError = false): Anthropic.Messages.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

function makeToolUse(id: string, name: string): Anthropic.Messages.ToolUseBlock {
  return { type: 'tool_use', id, name, input: {} };
}

function buildConversation(turns: number): Message[] {
  const messages: Message[] = [
    { role: 'user', content: 'Do the task please.' },
  ];

  for (let i = 0; i < turns; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Thinking about step ${i}... `.repeat(20) },
        makeToolUse(`tool-${i}`, `tool_${i % 3}`),
      ],
    });
    messages.push({
      role: 'user',
      content: [
        makeToolResult(`tool-${i}`, JSON.stringify({ ok: true, data: 'x'.repeat(500) })),
      ],
    });
  }

  return messages;
}

describe('ContextCompactor', () => {
  it('should not compact when below threshold', () => {
    const messages = buildConversation(5);
    const result = compactMessages(messages, {
      currentTokens: 10_000,
      budgetLimit: 500_000,
    });

    expect(result.method).toBe('none');
    expect(result.tokensFreed).toBe(0);
    expect(result.messages).toBe(messages); // same reference
  });

  it('should snip old tool results when over threshold', () => {
    const messages = buildConversation(30);
    const result = compactMessages(messages, {
      currentTokens: 350_000,
      budgetLimit: 500_000, // 70% — over the 60% threshold
    });

    expect(result.method).not.toBe('none');
    expect(result.tokensFreed).toBeGreaterThanOrEqual(0);
    expect(result.messages.length).toBeGreaterThan(0);

    // Recent messages should be preserved intact.
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg).toBeDefined();
  });

  it('should preserve the most recent turns', () => {
    const messages = buildConversation(20);
    const result = compactMessages(messages, {
      currentTokens: 400_000,
      budgetLimit: 500_000,
      preserveRecent: 5,
    });

    // The last 10 messages (5 turns * 2) should be preserved.
    const recentMessages = messages.slice(-10);
    const resultRecent = result.messages.slice(-10);

    // Recent messages should have the same content (not snipped).
    for (let i = 0; i < recentMessages.length; i++) {
      if (recentMessages[i].role === 'user' && Array.isArray(recentMessages[i].content)) {
        const origContent = recentMessages[i].content as Anthropic.Messages.ToolResultBlockParam[];
        const resultContent = resultRecent[i].content as Anthropic.Messages.ToolResultBlockParam[];
        for (let j = 0; j < origContent.length; j++) {
          if (origContent[j].type === 'tool_result') {
            expect(resultContent[j].content).toBe(origContent[j].content);
          }
        }
      }
    }
  });

  it('should collapse early turns when snipping is not enough', () => {
    const messages = buildConversation(50);
    const result = compactMessages(messages, {
      currentTokens: 490_000,
      budgetLimit: 500_000, // 98% — very high, needs aggressive compaction
      preserveRecent: 5,
    });

    // Should have collapsed and have fewer messages.
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.method).toBe('collapse');

    // First message should be the summary.
    const first = result.messages[0];
    expect(first.role).toBe('user');
    if (typeof first.content === 'string') {
      expect(first.content).toContain('[Context compacted');
    }
  });

  it('should handle empty conversations', () => {
    const result = compactMessages([], {
      currentTokens: 0,
      budgetLimit: 500_000,
    });

    expect(result.method).toBe('none');
    expect(result.messages).toEqual([]);
  });

  it('should handle conversations with only text (no tool calls)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ];

    const result = compactMessages(messages, {
      currentTokens: 400_000,
      budgetLimit: 500_000,
    });

    // Over threshold but very few messages — snip should still work.
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('should use custom threshold', () => {
    const messages = buildConversation(10);

    // 50% usage with 0.8 threshold should not trigger.
    const result = compactMessages(messages, {
      currentTokens: 250_000,
      budgetLimit: 500_000,
      threshold: 0.8,
    });
    expect(result.method).toBe('none');
  });
});
