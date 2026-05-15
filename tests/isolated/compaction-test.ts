import { compactMessages } from '../../src/resilience/context-compactor.js';

// Test that context compaction never breaks tool_use/tool_result pairs.

function makeToolTurn(turnIdx: number): [any, any] {
  const toolId = `toolu_${turnIdx}_abc`;
  return [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text', text: `Turn ${turnIdx}: calling tool` },
        { type: 'tool_use', id: toolId, name: 'shell_exec', input: { command: 'echo ' + turnIdx } },
      ],
    },
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', tool_use_id: toolId, content: `Result for turn ${turnIdx}: ${'x'.repeat(500)}` },
      ],
    },
  ];
}

function validate(messages: any[]): { valid: boolean; issue?: string } {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseIds = msg.content
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => b.id);

    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    if (!next || next.role !== 'user' || !Array.isArray(next.content)) {
      return { valid: false, issue: `tool_use at msg ${i} (ids: ${toolUseIds.join(',')}) has no following user tool_result message` };
    }

    const resultIds = new Set(
      next.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id),
    );

    for (const id of toolUseIds) {
      if (!resultIds.has(id)) {
        return { valid: false, issue: `tool_use id ${id} at msg ${i} has no matching tool_result in msg ${i + 1}` };
      }
    }
  }
  return { valid: true };
}

// Build a conversation with 30 tool turns (60 messages) to trigger compaction.
const messages: any[] = [
  { role: 'user', content: 'Build a landing page with an arcade game. This is the original task.' },
];

for (let i = 0; i < 30; i++) {
  const [assistant, user] = makeToolTurn(i);
  messages.push(assistant, user);
}

console.log(`Built ${messages.length} messages (${Math.floor(messages.length / 2)} turns)`);

// Test 1: Snip (60% threshold, simulate high token count)
const snipResult = compactMessages(messages, {
  currentTokens: 70_000,
  budgetLimit: 100_000,
  threshold: 0.6,
  preserveRecent: 5,
});

console.log(`\nSnip: ${snipResult.method}, ${snipResult.messages.length} messages, ~${snipResult.tokensFreed} tokens freed`);
const snipValid = validate(snipResult.messages);
console.log(`Snip valid: ${snipValid.valid}${snipValid.issue ? ' — ' + snipValid.issue : ''}`);

// Test 2: Collapse (90% threshold)
const collapseResult = compactMessages(messages, {
  currentTokens: 95_000,
  budgetLimit: 100_000,
  threshold: 0.6,
  preserveRecent: 5,
});

console.log(`\nCollapse: ${collapseResult.method}, ${collapseResult.messages.length} messages, ~${collapseResult.tokensFreed} tokens freed`);
const collapseValid = validate(collapseResult.messages);
console.log(`Collapse valid: ${collapseValid.valid}${collapseValid.issue ? ' — ' + collapseValid.issue : ''}`);

// Test 3: Edge case — compaction boundary lands exactly on a tool_result message
const edgeMessages: any[] = [
  { role: 'user', content: 'Task' },
];
for (let i = 0; i < 20; i++) {
  const [a, u] = makeToolTurn(i);
  edgeMessages.push(a, u);
}
const edgeResult = compactMessages(edgeMessages, {
  currentTokens: 95_000,
  budgetLimit: 100_000,
  threshold: 0.5,
  preserveRecent: 3,
});
console.log(`\nEdge: ${edgeResult.method}, ${edgeResult.messages.length} messages`);
const edgeValid = validate(edgeResult.messages);
console.log(`Edge valid: ${edgeValid.valid}${edgeValid.issue ? ' — ' + edgeValid.issue : ''}`);

// Test 4: Multi-tool turn (assistant uses 3 tools in one turn)
const multiMessages: any[] = [
  { role: 'user', content: 'Do three things' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'multi_1', name: 'a', input: {} },
      { type: 'tool_use', id: 'multi_2', name: 'b', input: {} },
      { type: 'tool_use', id: 'multi_3', name: 'c', input: {} },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'multi_1', content: 'ok1' },
      { type: 'tool_result', tool_use_id: 'multi_2', content: 'ok2' },
      { type: 'tool_result', tool_use_id: 'multi_3', content: 'ok3' },
    ],
  },
];
// Add more turns to push the multi-tool turn into the collapse zone
for (let i = 0; i < 20; i++) {
  const [a, u] = makeToolTurn(100 + i);
  multiMessages.push(a, u);
}
const multiResult = compactMessages(multiMessages, {
  currentTokens: 90_000,
  budgetLimit: 100_000,
  threshold: 0.5,
  preserveRecent: 3,
});
console.log(`\nMulti-tool: ${multiResult.method}, ${multiResult.messages.length} messages`);
const multiValid = validate(multiResult.messages);
console.log(`Multi-tool valid: ${multiValid.valid}${multiValid.issue ? ' — ' + multiValid.issue : ''}`);

// Summary
const allPass = snipValid.valid && collapseValid.valid && edgeValid.valid && multiValid.valid;
console.log(`\n=== ${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} ===`);
if (!allPass) process.exit(1);
