# HIRAM

An autonomous multi-agent system that manages a portfolio of online services. HIRAM orchestrates a hierarchy of AI agents — each with distinct roles, tools, and constraints — to research, build, deploy, price, document, and monitor web products without human intervention.

**This is a research project** exploring the boundaries of what autonomous agent systems can achieve when given real infrastructure access: production APIs, payment processing, DNS, cloud compute, and project management boards.

## What it does

Given a high-level directive (a "policy") like *"Build and launch 5 document-generation websites"*, HIRAM:

1. **Decomposes** the objective into a JIRA project with epics, stories, and dependency chains
2. **Researches** the market — competitor pricing, API capabilities, technical feasibility
3. **Builds** full-stack web applications via Claude Code, pushes to GitHub
4. **Deploys** to Google Cloud Run, configures DNS via Cloudflare
5. **Prices** products competitively on Stripe
6. **Documents** the work in Google Docs/Sheets
7. **Communicates** launch summaries via email
8. **Monitors** deployed services for uptime and cost anomalies

All orchestrated by a hierarchy of agents that coordinate through JIRA tickets, enforce dependency ordering, and self-heal on failures.

## Architecture overview

```
                    ┌──────────────┐
                    │   Policies   │  ← Strategic directives from the operator
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Architect   │  ← Opus 4.6 — decomposes policies into
                    │  (singleton) │    JIRA epics/stories with dependencies
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼────┐ ┌────▼─────┐ ┌────▼─────┐
        │  Dev      │ │  Ops     │ │ Research │  ← Wardens: concurrent ticket
        │  Warden   │ │  Warden  │ │ Warden   │    coordinators (dynamic)
        └─────┬─────┘ └────┬─────┘ └────┬─────┘
              │            │            │
         ┌────▼────┐  ┌───▼────┐  ┌───▼────────┐
         │Developer│  │Deployer│  │ Researcher  │  ← Workers: task executors
         │ Worker  │  │ Worker │  │   Worker    │    (one per JIRA ticket)
         └─────────┘  └────────┘  └─────────────┘

  Singletons: Treasurer (Stripe), Secretary (Google Workspace), Expert (self-improvement)
```

**Key design decisions:**

- **Opus for the Architect, Sonnet for workers.** The Architect makes strategic decisions (decomposing objectives, dependency ordering, warden management) where reasoning quality matters most. Workers execute bounded tasks where speed and cost efficiency matter. This is a deliberate cost/quality tradeoff — see [ARCHITECTURE.md](ARCHITECTURE.md) for the full rationale.

- **JIRA as the coordination substrate.** Rather than custom task queues, agents coordinate through JIRA tickets. This gives full observability (you can watch the board in real-time), provides a natural audit trail, and means humans can intervene by editing tickets. The tradeoff is latency — JIRA API calls are slower than in-memory queues — but for a system that runs tasks measured in minutes, this is acceptable.

- **Mechanical dependency enforcement.** Agents don't decide when to start work on dependent tasks — the system mechanically blocks tickets until their dependencies complete, then transitions them to "To Do" and triggers warden rehydration. This removes an entire class of ordering bugs that would be fragile if left to LLM judgment.

- **MCP (Model Context Protocol) for all tool access.** Every external integration (JIRA, Cloudflare, Stripe, Google Workspace, GitHub) is a standalone MCP server that agents access through a unified `plugin_invoke()` interface. Agents don't need to know HTTP, auth headers, or API versions — they just call tools by name with JSON arguments.

## Prerequisites

- **Node.js 22+** (ES modules, native fetch)
- **Redis** (job queue, rate limiting, caching)
- **Anthropic API key** with access to Claude Sonnet 4.6 and Opus 4.6
- **JIRA Cloud** account (free tier works) — the coordination substrate
- **GitHub** account + PAT — where agents push code

Optional (for full functionality):
- Cloudflare account — DNS, Workers, Tunnel for webhook delivery
- Google Cloud Platform — Cloud Run deployments, Google Workspace (Gmail, Drive, Docs)
- Stripe — payment processing
- Voyage AI — knowledge store embeddings
- Telegram bot — operator notifications

## Quick start

```bash
# Clone
git clone https://github.com/Maelhann/hiram.git
cd hiram

# Install
npm install

# Configure
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY, HIRAM_MASTER_KEY,
# and VAULT_ATLASSIAN_* for JIRA access.

# Build
npm run build

# Start
npm start
```

On first boot, HIRAM runs a 14-step initialization sequence:

1. Configuration loading
2. SQLite database initialization (WAL mode, FTS5)
3. Core services (Redis, Vault, Knowledge Store, Telemetry)
4. Vault secret seeding from `VAULT_*` environment variables
5. Git + GitHub CLI configuration
6. Workspace directory creation
7. Agent wiring (Architect, Wardens, Treasurer, Secretary, Expert)
8. MCP plugin compilation and connection
9. Health check across all integrations
10. Tool runway verification (smoke tests for each plugin)
11. Webhook listener registration
12. Cloudflare Tunnel startup
13. Service startup (HTTP server, wardens, supervisor, scheduler)
14. Ready

## Giving HIRAM work

HIRAM takes direction through **policies** — high-level strategic directives stored in the database. The Architect reads policies and decomposes them into actionable work.

You can create policies through the Telegram bot interface, the CLI server, or directly in the E2E test harness:

```typescript
ctx.policyStore.create({
  title: 'Build a status page SaaS product',
  description: `Research the market, build a web app for monitoring uptime,
    deploy to Cloud Run, set up Stripe pricing, write docs, send launch email.`,
  priority: 'critical',
  createdBy: 'founder',
});

await ctx.architect.handleInstruction(
  'There is a new CRITICAL policy. Read it, create a JIRA project, ' +
  'break it into epics and stories, and start immediately.'
);
```

The Architect then:
1. Creates a dedicated JIRA project (e.g., key `PULSE` for "PulseCheck")
2. Creates epics for each major work stream
3. Creates stories with dependency chains (Research → Build → Deploy → Verify → Communicate)
4. Labels each story for the right warden (`warden:dev`, `warden:ops`, `warden:research`, etc.)
5. Wardens pick up stories and spawn workers to execute them

## Project structure

```
src/
├── daemon.ts                  # Entry point — 14-step boot sequence
├── config.ts                  # Environment-based configuration with hot-reload
├── workers/
│   ├── base-agent.ts          # Core agentic loop: send → tool_use → execute → repeat
│   ├── base-warden.ts         # Concurrent ticket coordinator with dependency enforcement
│   ├── architect.ts           # Strategic orchestrator (Opus 4.6)
│   ├── secretary.ts           # Google Workspace operations
│   ├── treasurer.ts           # Stripe financial operations
│   ├── expert.ts              # Self-improvement — modifies HIRAM's own code
│   ├── warden-registry.ts     # Dynamic warden lifecycle management
│   └── worker-types.ts        # System prompts for all 19 worker types
├── tools/
│   ├── registry.ts            # MCP plugin registry (compile, connect, invoke)
│   ├── meta-tools.ts          # Agent tool definitions (plugin_invoke, shell_exec, etc.)
│   ├── seeds/                 # MCP server source code (TypeScript → esbuild → stdio)
│   │   ├── jira-tools.ts      # JIRA REST API (search, create, transition, comment)
│   │   ├── cloudflare-tools.ts# Cloudflare API (DNS, KV, R2, Workers, Tunnels)
│   │   ├── google-workspace-tools.ts  # Gmail, Calendar, Drive, Docs, Contacts
│   │   └── developer-tools.ts # Claude Code integration, shell, git
│   ├── health-check.ts        # Integration health verification
│   └── runway.ts              # Tool smoke tests on boot
├── resilience/
│   ├── circuit-breaker.ts     # API circuit breaker (5 failures → 60s backoff)
│   ├── token-budget.ts        # Per-run and per-ticket token spend limits
│   ├── retry-policy.ts        # Exponential backoff with error classification
│   └── context-compactor.ts   # Message compression for long conversations
├── knowledge/
│   └── store.ts               # Persistent institutional memory with Voyage AI embeddings
├── secrets/
│   └── vault.ts               # AES-256-GCM encrypted secret storage
├── events/
│   └── bus.ts                 # Webhook/cron/poll event intake with fan-out delivery
├── jira/
│   └── webhook-server.ts      # HTTP listener for JIRA events
├── policy/
│   └── store.ts               # Strategic directive management
├── hooks/
│   ├── hook-engine.ts         # Pre/post-execution hooks for safety and audit
│   └── safety-hooks.ts        # Cost limits, resource guards
├── telemetry/
│   └── collector.ts           # Prometheus metrics (API calls, tokens, errors)
└── messaging/
    └── gateway.ts             # Telegram + email routing
```

## Testing

```bash
# Unit tests (no external dependencies)
npm test

# Integration tests (requires JIRA credentials in .env)
npm test -- --config vitest.config.ts tests/integration/

# E2E tests (requires all credentials, real Claude API, 1-3 hours)
npm run test:e2e
```

The E2E tests are the most interesting — they create a real policy, let the system run autonomously for up to 3 hours, then verify the results (JIRA tickets created, websites deployed, etc.). They record every API call and tool execution to a SQLite database for post-run analysis.

## How the agent loop works

Every agent in HIRAM — from the Architect down to individual workers — shares the same core loop implemented in `base-agent.ts`:

```
┌─────────────────────────────────────────────────┐
│                  Agentic Loop                    │
│                                                  │
│  1. Send system prompt + conversation to Claude  │
│  2. If response contains tool_use blocks:        │
│     a. Execute each tool (with pre/post hooks)   │
│     b. Return tool_results to Claude             │
│     c. Go to 1                                   │
│  3. If end_turn: done                            │
│  4. If max_tokens: compact context + redirect    │
│                                                  │
│  Safety rails at every step:                     │
│  • Circuit breaker (5 consecutive API failures)  │
│  • Token budget (per-run: 32k, escalated: 64k)   │
│  • Context compaction (70% threshold)            │
│  • Max_tokens spiral detection (2 consecutive)   │
│  • Model fallback (Sonnet → Haiku after 3× 529) │
│  • Abort signal propagation                      │
│  • Pre/post hooks (safety, audit, cost limits)   │
└─────────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed rationales behind each design decision.

## Resilience patterns

HIRAM is designed to run for hours without supervision. Several patterns make this possible:

| Pattern | What it does | Why |
|---------|-------------|-----|
| **Circuit breaker** | After 5 consecutive API failures, stops all agent calls for 60s | Prevents cascading failures when Anthropic API has transient issues |
| **Token budget** | Hard cap on tokens per run (32k default, 64k escalated) and per ticket | Prevents runaway costs from agents stuck in loops |
| **Context compaction** | Proactively summarizes old messages when approaching budget | Lets agents have long conversations without losing context |
| **Max_tokens circuit-break** | After 2 consecutive truncated responses, forces wrap-up | Prevents infinite text generation loops that waste tokens |
| **Model fallback** | Switches from Sonnet to Haiku after 3 consecutive 529s | Keeps the system running during capacity constraints |
| **Exponential backoff** | Retries transient errors with increasing delays | Handles API rate limits and temporary outages gracefully |
| **Streaming API** | Uses `messages.stream().finalMessage()` for all API calls | Avoids Anthropic SDK's 10-minute non-streaming timeout |
| **Dependency enforcement** | Mechanically blocks tickets until dependencies complete | Eliminates ordering bugs from LLM reasoning |

## Observability

- **JIRA board** — real-time view of all agent work (tickets, statuses, comments)
- **Prometheus metrics** — API calls, token spend, error rates, agent lifecycle events
- **Grafana dashboard** — pre-built dashboard for all metrics (see `deploy/grafana-dashboard.json`)
- **Telegram bot** — operator notifications and interactive commands
- **Knowledge store** — persistent institutional memory across runs
- **E2E transcript recording** — every API call and tool execution logged to SQLite

## Research context

HIRAM is an exploration of several open questions in autonomous agent systems:

1. **How far can prompt engineering take you?** HIRAM uses no fine-tuned models, no RAG pipelines, no vector databases for agent memory. Everything runs on prompt engineering — carefully crafted system prompts with explicit instructions, constraints, and output formats. The results suggest that prompt architecture is sufficient for complex multi-agent coordination, but the prompts must be treated as code: versioned, tested, and evolved based on failure analysis.

2. **What's the right coordination substrate?** Rather than building custom task queues, HIRAM uses JIRA as the shared state between agents. This gives full observability and human-in-the-loop capability for free, at the cost of API latency. The tradeoff is worth it for a system where tasks take minutes, not milliseconds.

3. **Where should you trust LLM judgment vs. mechanical enforcement?** HIRAM's dependency pipeline is a case study: early versions relied on the Architect to notice when dependencies completed and unblock downstream work. This was unreliable. The current version uses mechanical enforcement (parse dependency text → check status → transition) with the Architect as a strategic overlay. The lesson: use LLMs for decisions that benefit from reasoning, use code for decisions that must be deterministic.

4. **How do you prevent cost spirals?** An agent stuck in a loop can burn through API credits in minutes. HIRAM's multi-layered approach (token budgets, max_tokens circuit-breaking, context compaction, model fallback) evolved from real incidents during E2E testing. Each layer exists because the layers below it weren't sufficient alone.

## License

MIT — see [LICENSE](LICENSE).
