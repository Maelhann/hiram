# HIRAM

**An autonomous multi-agent daemon that turns high-level business directives into deployed products.** Give it a one-paragraph policy — *"build 5 document-generation websites"* — and it decomposes the objective into a JIRA project, researches the market, writes the code, deploys to cloud infrastructure, configures payments, and sends a launch email. No human in the loop.

In a [23-minute E2E test run](RESULTS.md), HIRAM autonomously created a JIRA project with 23 tickets, researched competitor pricing across 5 verticals, saved 13 institutional knowledge entries, and launched 5 parallel code-generation workers — spending $7.27 with an 89% prompt cache hit rate — before the test environment ran out of memory.

This is a research project exploring the practical limits of LLM-based multi-agent coordination against real infrastructure.

---

## How it works

HIRAM runs as a long-lived daemon. You give it a **policy** (a strategic directive), and the system does the rest:

```typescript
// This is the entire human input. Everything below happens autonomously.
ctx.policyStore.create({
  title: 'Ordo DocGen Network — 5 vertical document-generation websites',
  description: `Build LegalDraft, InvoiceForge, PropDocs, EduCert, HRPapers.
    Research competitors, build with Ordo Studio API, deploy to Cloud Run,
    price on Stripe, document in Google Docs, send launch email.`,
  priority: 'critical',
  createdBy: 'founder',
});
```

**What happens next (no human intervention):**

1. The **Architect** (Opus 4.6) reads the policy, creates JIRA project `ODGEN`, decomposes it into 7 epics and 16 stories with explicit dependency chains
2. **Research wardens** pick up research stories, run web searches, analyze competitor pricing across all 5 verticals, save findings to the knowledge store
3. When research completes, the dependency pipeline mechanically unblocks build stories
4. **Dev wardens** spawn 5 parallel workers that create GitHub repos, scaffold apps via Claude Code, write code, run tests, and push
5. When builds complete, **ops wardens** deploy to Cloud Run, configure Cloudflare DNS
6. The **Treasurer** sets up Stripe products with competitive pricing (informed by research findings)
7. The **Secretary** sends a launch summary email

All coordination happens through JIRA tickets. You can watch it in real-time on the board.

## Architecture

```
                         ┌──────────────┐
                         │   Policies   │   "Build 5 doc-gen websites"
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │  Architect   │   Opus 4.6 — strategic planning
                         │  (singleton) │   Creates JIRA projects, epics, stories
                         └──────┬───────┘
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                     │
     ┌─────▼─────┐       ┌─────▼─────┐        ┌─────▼──────┐
     │    Dev     │       │    Ops    │        │  Research   │   Wardens: pick up
     │   Warden   │       │   Warden  │        │   Warden   │   JIRA stories by label,
     └─────┬─────┘       └─────┬─────┘        └─────┬──────┘   spawn workers
           │                    │                     │
      ┌────▼─────┐       ┌─────▼─────┐        ┌─────▼───────┐
      │Developer │       │ Deployer  │        │ Researcher  │   Workers: one per
      │  Worker  │       │  Worker   │        │   Worker    │   ticket, runs to
      └──────────┘       └───────────┘        └─────────────┘   completion

  Singletons: Treasurer (Stripe) · Secretary (Google Workspace) · Expert (self-improvement)
```

### Why this hierarchy?

**Opus for planning, Sonnet for execution.** The Architect makes 13 API calls to plan an entire project — the cost difference between Opus and Sonnet for 13 calls is negligible. But the quality difference in decomposition, dependency ordering, and label assignment is significant. Workers make hundreds of calls — Sonnet's speed and cost efficiency matters there.

**JIRA as coordination substrate.** Agents coordinate through JIRA tickets instead of custom task queues. This gives observability (watch the board live), auditability (every decision has a comment), and human override (edit any ticket to redirect work). The tradeoff is API latency — acceptable for tasks measured in minutes.

**Mechanical dependency enforcement.** Early versions relied on the Architect to notice when dependencies completed. This was unreliable — the LLM would sometimes forget. The current system mechanically blocks tickets until predecessors reach Done status, then transitions dependents and triggers warden rehydration. Deterministic decisions should be code, not prompts.

## Prompt engineering

The prompts are the most important code in HIRAM. Every constraint exists because something broke without it. Six principles, each learned from real failures:

| Principle | What it says | What broke without it |
|-----------|-------------|----------------------|
| **Agents must act, not describe** | *"NEVER just describe what should be done — DO it by calling tools."* | Agents produced beautiful analysis then stopped |
| **Scope boundaries** | *"Your job ends at git push. Do NOT deploy."* | Dev workers ran `gcloud deploy`, doing ops work |
| **Explicit tool signatures** | *"`issueKey` NOT `issue_key`"* with exact examples | Agents hallucinated parameter names constantly |
| **Research limits** | *"Max 5 web searches. Once you have enough, STOP."* | Research workers explored tangents indefinitely, burning thousands of tokens |
| **Structured output** | Every worker type specifies exact JSON output format | Downstream consumers couldn't parse freeform responses |
| **Debugging workflow** | 6-step diagnostic process spelled out | Workers retried the same failing command 8 times without diagnosing |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full rationale behind each decision, with the failure stories that motivated them.

## E2E test results

The system is tested against real infrastructure. The E2E test creates a policy, lets HIRAM run autonomously, and records every API call and tool execution.

**Latest run** ([full results](RESULTS.md)):

| Metric | Value |
|--------|-------|
| Duration | 23 min (terminated by OOM in test environment) |
| Cost | $7.27 |
| API calls | 302 (13 Opus, 289 Sonnet) |
| Tool executions | 443 (4.7% error rate, all recovered) |
| Prompt cache hit rate | 89% |
| JIRA tickets created | 23 (7 epics + 16 stories) |
| Knowledge entries saved | 13 (competitor pricing, API research) |
| Peak concurrency | 12 tickets worked simultaneously |

The research phase completed fully — competitor pricing for all 5 verticals was analyzed, a cross-vertical market gap was identified autonomously (*"no competitor offers usage-based per-document API pricing"*), and the build phase was running 5 parallel code-generation workers when the test environment hit memory limits.

## Resilience

HIRAM runs for hours without supervision. Every failure mode observed during E2E testing has a corresponding mitigation:

```
Circuit breaker     ─── 5 consecutive API failures → 60s backoff for all agents
Token budget        ─── Hard cap per run (32k) and per ticket → prevents cost spirals
Context compaction  ─── Proactive message summarization at 70% budget → preserves context
Max_tokens circuit  ─── 2 consecutive truncations → force wrap-up → prevents output loops
Model fallback      ─── 3 consecutive 529s → Sonnet falls back to Haiku → stays running
Streaming API       ─── messages.stream().finalMessage() → avoids 10-min SDK timeout
Dependency checks   ─── Mechanical block/unblock → deterministic pipeline ordering
Self-healing        ─── EPIPE/ECONNRESET caught → plugin reconnect loop handles recovery
```

## Tool integration (MCP)

Four custom MCP servers, 58 tools total. Each is a standalone TypeScript file compiled via esbuild and connected over stdio:

| Plugin | Tools | What it does |
|--------|-------|-------------|
| **atlassian** | 10 | JIRA: search, create, get, update, delete, comment, transitions, projects |
| **cloudflare** | 24 | DNS, KV namespaces, R2 storage, Workers, Pages, D1 databases, Registrar, Tunnels |
| **google-workspace** | 17 | Gmail, Calendar, Drive, Docs, Contacts with domain-wide delegation |
| **developer-tools** | 7 | Claude Code integration, shell execution, git operations |

These replaced third-party MCP packages that had auth issues and parameter mismatches. Building custom servers with exactly the tools agents need — and error messages agents can act on — took less time than debugging third-party code.

## Project structure

```
src/
├── daemon.ts                  # Entry point — 14-step boot sequence
├── workers/
│   ├── base-agent.ts          # Core agentic loop with all resilience patterns
│   ├── base-warden.ts         # Concurrent ticket coordinator + dependency enforcement
│   ├── architect.ts           # Strategic orchestrator (Opus 4.6)
│   ├── worker-types.ts        # System prompts for 19 worker specializations
│   ├── secretary.ts           # Google Workspace operations
│   ├── treasurer.ts           # Stripe financial operations
│   ├── expert.ts              # Self-modification agent
│   └── warden-registry.ts     # Dynamic warden lifecycle
├── tools/
│   ├── registry.ts            # MCP plugin registry (compile → connect → invoke)
│   ├── meta-tools.ts          # Agent-facing tool definitions
│   └── seeds/                 # MCP server source (JIRA, Cloudflare, Google, Dev)
├── resilience/
│   ├── circuit-breaker.ts     # Shared API circuit breaker
│   ├── token-budget.ts        # Per-run and per-ticket spend limits
│   ├── retry-policy.ts        # Exponential backoff with error classification
│   └── context-compactor.ts   # Conversation compression
├── knowledge/store.ts         # Persistent memory with Voyage AI embeddings
├── secrets/vault.ts           # AES-256-GCM encrypted storage
├── events/bus.ts              # Webhook/cron/poll event fan-out
├── jira/webhook-server.ts     # HTTP listener for JIRA events
├── hooks/                     # Pre/post-execution safety hooks
└── telemetry/collector.ts     # Prometheus metrics

tests/
├── unit/          (18 tests)  # No external dependencies
├── integration/   (4 tests)   # Real JIRA API calls
├── scenarios/     (7 tests)   # Multi-agent coordination
└── e2e/           (3 tests)   # Full autonomous runs, 1-3 hours each
```

## Quick start

```bash
git clone https://github.com/Maelhann/hiram.git && cd hiram
npm install
cp .env.example .env   # Set ANTHROPIC_API_KEY, HIRAM_MASTER_KEY, VAULT_ATLASSIAN_*
npm run build && npm start
```

## Research questions

HIRAM is an exploration of practical questions in autonomous agent systems:

- **Prompt engineering as architecture.** HIRAM uses no fine-tuned models, no RAG, no vector databases for agent coordination. The prompts are the architecture — 19 worker type definitions, each evolved through failure analysis. Can prompt engineering alone handle complex multi-agent coordination? The E2E results suggest yes, but the prompts must be treated as code: versioned, tested, and evolved from observed failures.

- **LLM judgment vs. mechanical enforcement.** The dependency pipeline went through three iterations. v1 relied entirely on LLM reasoning (unreliable). v2 added mechanical blocking but relied on LLMs for unblocking (partially worked). v3 is fully mechanical with LLM oversight (current, reliable). The general lesson: use LLMs for decisions that benefit from reasoning, code for decisions that must be deterministic.

- **Cost control at scale.** A single stuck agent can burn $50+ in minutes. HIRAM's multi-layered approach (token budgets → max_tokens detection → context compaction → model fallback) evolved from real cost incidents during testing. Each layer exists because the layers below it weren't sufficient alone. The 89% prompt cache hit rate is the single biggest cost optimization — see [RESULTS.md](RESULTS.md) for the economics.

- **Observability as a feature.** Using JIRA as the coordination substrate means every agent decision is visible as a ticket, comment, or status transition. This turned out to be the most valuable architectural decision for debugging — you can trace exactly why an agent made a choice by reading its JIRA comments.

## License

MIT — see [LICENSE](LICENSE).

---

*Built with [Claude](https://anthropic.com/claude) — Opus 4.6 for orchestration, Sonnet 4.6 for execution, and the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-node) + [Model Context Protocol](https://modelcontextprotocol.io/) for tool integration.*
