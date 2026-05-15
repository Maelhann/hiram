# HIRAM Architecture

This document explains the architectural decisions behind HIRAM, with particular focus on why things are the way they are — the constraints, tradeoffs, and lessons learned from running the system against real infrastructure.

## Table of contents

- [Agent hierarchy](#agent-hierarchy)
- [The agentic loop](#the-agentic-loop)
- [Prompt engineering](#prompt-engineering)
- [MCP plugin system](#mcp-plugin-system)
- [Dependency pipeline](#dependency-pipeline)
- [Resilience engineering](#resilience-engineering)
- [Knowledge store](#knowledge-store)
- [Configuration and secrets](#configuration-and-secrets)

---

## Agent hierarchy

HIRAM uses a three-tier agent hierarchy. Each tier has different responsibilities, model assignments, and autonomy levels.

### Tier 1: Architect (singleton)

- **Model:** Claude Opus 4.6
- **Role:** Strategic orchestrator — decomposes high-level policies into structured JIRA work
- **Autonomy:** Full — creates projects, epics, stories; manages wardens; reacts to webhooks
- **Why Opus?** The Architect makes decisions with the highest blast radius: a bad decomposition wastes hours of worker time. Opus's superior reasoning is worth the 5x cost here because the Architect makes relatively few API calls (tens, not hundreds) — it's a planning agent, not an execution agent. The cost delta between Opus and Sonnet for planning is negligible compared to the cost of wasted worker execution.

### Tier 2: Wardens (dynamic)

- **Model:** Claude Sonnet 4.6
- **Role:** Concurrent ticket coordinators — pick up JIRA stories, spawn workers, track progress
- **Autonomy:** Bounded — operate within their domain label (dev, ops, research, content, outreach, monitor)
- **Why dynamic?** Wardens are defined in SQLite and instantiated at boot. The Architect can create new wardens at runtime (`warden_create`), allowing the system to expand its capabilities without redeployment. Each warden runs its own JQL filter to find work, so new wardens just need a unique label.

### Tier 3: Workers (ephemeral)

- **Model:** Claude Sonnet 4.6 (falls back to Haiku under load)
- **Role:** Task executors — one worker per JIRA ticket, runs until completion or failure
- **Autonomy:** Minimal — constrained by worker type prompts (see [Prompt Engineering](#prompt-engineering))
- **Why Sonnet?** Workers execute bounded, well-specified tasks where Sonnet's speed and cost efficiency matter more than Opus's reasoning depth. A worker building a React app doesn't need Opus — it needs fast tool execution loops. The model fallback to Haiku (after 3 consecutive 529 "overloaded" errors) keeps the system running during capacity constraints.

### Singletons: Treasurer, Secretary, Expert

These are hardcoded agents (not wardens) that handle specialized domains:

- **Treasurer** — Stripe financial operations (products, prices, invoices). Processes tickets labeled `agent:treasurer`. Has full Stripe autonomy but only notifies (never executes) for Revolut bank transfers.
- **Secretary** — Google Workspace operations (Gmail, Calendar, Drive, Docs). Processes tickets labeled `agent:secretary`. Handles founder-facing communication.
- **Expert** — Self-improvement. Processes tickets labeled `agent:expert`. Can modify HIRAM's own codebase, run tests, and deploy changes through a safe pipeline. The Architect creates Expert tickets when it observes repeated failures or missing capabilities.

**Design rationale:** These agents are singletons because they need persistent state (OAuth tokens, conversation history) and because their domain knowledge is too specialized for generic wardens. The Treasurer must understand Stripe's product/price hierarchy. The Secretary must understand Google Workspace's delegation model. The Expert must understand HIRAM's own codebase.

---

## The agentic loop

Every agent in HIRAM shares the same core loop, implemented in `src/workers/base-agent.ts`. This is the most critical piece of infrastructure — all agent behavior flows through it.

### Loop structure

```
for each turn (max 500):
  1. Send [system, tools, messages] to Claude via streaming API
  2. Record metrics (tokens, latency, cache performance)
  3. Enforce token budget
  4. Proactive context compaction (if approaching budget)
  5. Handle stop_reason:
     - end_turn (no tool_use): done
     - max_tokens (no tool_use): compact + redirect, or circuit-break
     - tool_use: execute tools → append results → continue
```

### Why streaming?

All API calls use `messages.stream().finalMessage()` rather than the non-streaming `messages.create()`. This avoids the Anthropic SDK's 10-minute non-streaming timeout, which is critical because Opus planning calls can take several minutes. The streaming connection stays alive as long as tokens are being generated.

### Prompt caching strategy

Every API call uses three cache breakpoints:

1. **System prompt** — `cache_control: ephemeral` on the system text block. The system prompt is identical across all turns for a given agent, so it's cached after the first call.
2. **Tools** — `cache_control: ephemeral` on the last tool definition. Tool definitions are static across all turns.
3. **Messages** — `cache_control: ephemeral` on the last message. Previous turns hit cache on subsequent API calls.

This means that for a 20-turn conversation, turns 2-20 only pay for the new message content — the system prompt and tool definitions are read from cache. This reduces cost by approximately 90% for the input portion of subsequent turns.

### Max_tokens handling

When the model hits the token output limit (32,768 tokens), the response is truncated — potentially mid-sentence, mid-JSON, or mid-tool-call. Early versions of HIRAM would feed the truncated response back, leading to a death spiral: the model would try to continue from the broken state, hit max_tokens again, get truncated again, and waste thousands of tokens on unusable output.

The current approach, inspired by Claude Code's compact-and-redirect pattern:

1. **First truncation:** Compact the context (summarize old messages), then inject a system message: *"Your output was truncated. Do NOT continue generating text. Instead, save your work using a tool call and finish."*
2. **Second consecutive truncation:** Circuit-break — end the run with whatever partial output exists. Two consecutive truncations means the model is generating text that fundamentally won't fit, and continuing will only waste tokens.

### Model fallback

After 3 consecutive HTTP 529 errors (model overloaded), the agent automatically falls back from Sonnet to Haiku. This is a temporary measure — successful calls reset the counter. The fallback keeps the system functional during peak load, at the cost of reduced output quality.

---

## Prompt engineering

HIRAM's prompts are its most important architectural artifact. They're defined in three files:

- `src/workers/architect.ts` — the Architect's system prompt
- `src/workers/worker-types.ts` — all 19 worker type prompts
- `src/tools/meta-tools.ts` — tool descriptions and parameter schemas

### Design principles

**1. Autonomous agents must be told to act, not describe.**

The Architect prompt opens with:
```
CRITICAL: You are an autonomous agent. No human reads your text output.
- NEVER just describe what should be done — DO it by calling tools.
- Every decision must result in a tool call.
- Thinking without acting is useless. Act through tools.
```

Without this, Claude will produce beautiful analysis of what *should* be done and then stop. The explicit instruction to act through tools is the single most important line in the system.

**2. Scope boundaries prevent agents from overstepping.**

The Developer worker prompt includes:
```
SCOPE BOUNDARY: Your job ends at git push. Build the code, run tests,
verify it works, then push to GitHub. That's it. Do NOT deploy, configure
DNS, set up Cloud Run, or run any gcloud/docker deploy commands.
Deployment is the Ops Warden's responsibility.
```

This exists because, without it, developer workers would routinely attempt deployments — running `gcloud run deploy`, configuring DNS, even setting up Stripe products. The scope boundary was added after observing this behavior in E2E testing. The principle: agents will try to be helpful by doing more than asked, which breaks the responsibility model.

**3. Tool signatures must be explicit and repeated.**

The Architect prompt includes exact tool call syntax:
```
plugin_invoke({ plugin: "atlassian", tool: "create_issue",
  arguments: { project: "PULSE", issueType: "Epic", ... } })
```

And the warning:
```
IMPORTANT: Parameter names are camelCase: issueKey NOT issue_key,
parentKey NOT parent_key.
```

This exists because agents frequently hallucinate parameter names (using `issue_key` instead of `issueKey`), especially when the tool name uses underscores. Explicit examples with exact parameter names significantly reduce argument hallucination. The same approach is used for transition IDs — agents must call `get_transitions` first rather than hardcoding IDs, because transition IDs vary per JIRA project.

**4. Research workers must be constrained to prevent infinite loops.**

The Researcher prompt includes:
```
- Do NOT do more than 5 web searches.
- Once you have enough data to answer the question, STOP searching.
- Save your findings via knowledge_save or comment, then finish.
```

Without these constraints, research workers will explore tangentially related topics indefinitely, consuming thousands of tokens on marginally relevant information. The 5-search limit forces concise, targeted research. The explicit "then finish" instruction prevents the common failure mode where the agent keeps searching because it hasn't reached "enough" confidence.

**5. Output format specifications prevent unstructured responses.**

Every worker type specifies an exact JSON output format:
```json
{
  "status": "success | failure",
  "branch": "feature/...",
  "files_changed": ["path/to/file.ts"],
  "tests": { "passed": true, "details": "..." }
}
```

This serves two purposes: (a) downstream consumers (wardens, the Architect) can parse worker output reliably, and (b) it forces the worker to self-evaluate its own work. A worker that must report `"tests": { "passed": false }` is more likely to attempt fixes before finishing.

**6. Debugging workflows must be spelled out.**

The Developer worker includes an explicit debugging workflow:
```
1. Read the error — what exactly failed?
2. Locate the source — read the file and line.
3. Understand the cause — logic error? Missing dependency?
4. Form a hypothesis.
5. Verify — add a console.log or write a minimal test.
6. Fix precisely — give Claude Code the exact diagnosis.
```

Without this, workers will retry the exact same failing command multiple times (the "blind retry" antipattern). The explicit workflow was added after observing workers call Claude Code with "fix it" 8 times in a row without diagnosing the actual error.

### Worker type catalog

HIRAM defines 19 worker types, each a specialized system prompt:

| Type | Domain | Key constraint |
|------|--------|---------------|
| DEVELOPER | Build code | Scope ends at git push; uses Claude Code for all coding |
| REVIEWER | Code review | Read-only; structured verdict format |
| TESTER | Testing | Unit + integration + visual/E2E via Playwright |
| DEPLOYER | Deployment | Must verify with smoke test; uses gcloud directly |
| PROVISIONER | Infrastructure | Must verify every change; document in knowledge store |
| INCIDENT_RESPONDER | Incident response | Diagnose only; recommend but don't implement |
| WRITER | Content creation | No filler; every sentence adds value |
| SEO_AUDITOR | SEO analysis | Specific metrics; competitor comparison |
| EDITOR | Content editing | Preserve author's voice; structured change tracking |
| RESEARCHER | Research | Max 5 searches; 500-1500 word briefs; concise |
| INTEL_SWEEPER | Competitive intel | Diff-only reporting; baseline comparison |
| HEALTH_CHECKER | Monitoring | Specific numbers; retry 3x before declaring down |
| LOG_ANALYST | Log analysis | Quantify everything; distinguish new vs. recurring |
| COST_ANALYST | Cost monitoring | Actual numbers; period-over-period comparison |
| PROSPECTOR | Lead generation | Verified emails only; deduplicate against existing |
| COPYWRITER | Email sequences | Under 150 words; CAN-SPAM/GDPR compliant |
| CAMPAIGN_LAUNCHER | Campaign execution | Check warmup status before launch |
| SOCIAL_MESSENGER | Social outreach | Genuinely personalized; rate-limited |
| CAMPAIGN_ANALYST | Campaign analysis | Statistical significance; specific recommendations |

---

## MCP plugin system

HIRAM uses the Model Context Protocol (MCP) for all external integrations. Each integration is a standalone TypeScript file that implements an MCP server.

### Plugin lifecycle

```
TypeScript source (src/tools/seeds/*.ts)
  → esbuild compile to single JS file
  → Spawn as child process (stdio transport)
  → MCP client connects via stdin/stdout
  → Tools discovered and registered
  → Agents invoke via plugin_invoke()
```

### Why custom MCP servers?

HIRAM initially used third-party MCP packages (e.g., `@cloudflare/mcp-server-cloudflare`). These were replaced with custom implementations for several reasons:

1. **Auth issues.** The Cloudflare MCP package returned 401 errors on KV and domain operations despite a valid API token. The same token worked fine with native `fetch`. Root cause was never identified in the third-party code — building a custom 24-tool implementation took less time than debugging someone else's auth flow.

2. **Parameter mismatches.** Third-party packages often use different parameter names or conventions than agents expect. Custom servers match the tool schemas to what agents actually generate.

3. **Minimal dependencies.** Custom servers have exactly one dependency: `@modelcontextprotocol/sdk`. No framework bloat, no unused tools, no transitive dependency risk.

4. **Full control over error messages.** When a tool fails, the error message is what the agent sees. Custom servers return actionable errors ("JIRA 404: Issue PULSE-999 not found") instead of generic framework errors.

### Current plugins

| Plugin | Tools | Source |
|--------|-------|--------|
| `atlassian` | 10 | JIRA: search, create, get, update, delete, comment, transitions, projects |
| `cloudflare` | 24 | DNS, KV, R2, Workers, Pages, D1, Registrar, Tunnels |
| `google-workspace` | 17 | Gmail, Calendar, Drive, Docs, Contacts |
| `developer-tools` | 7 | Claude Code, shell exec, git (commit, push, branch), file I/O |

### Meta-tools

Agents don't call MCP servers directly. Instead, they use **meta-tools** — higher-level tool definitions that wrap the plugin registry:

- `plugin_invoke({ plugin, tool, arguments })` — invoke any tool on any plugin
- `plugin_list_tools({ plugin })` — discover available tools on a plugin
- `shell_exec({ command, cwd })` — execute shell commands
- `secret_get(name)` / `secret_set(name, value)` — vault access
- `knowledge_search(query)` / `knowledge_save({ title, content, tags })` — institutional memory
- `warden_create/update/list/deactivate` — warden lifecycle (Architect only)
- `policy_list/progress` — policy management
- `listener_create/list` — dynamic event triggers

Plus `web_search` — Claude's built-in web search tool, provided as a first-class tool with a 5-use limit per agent run.

---

## Dependency pipeline

The dependency pipeline ensures work happens in the right order. It's the most evolved subsystem in HIRAM, having gone through several iterations based on E2E testing failures.

### How it works

1. **Architect creates stories with dependency text.**
   The Architect writes `DEPENDS ON: PROJ-42` in the description of dependent stories and transitions them to "Blocked" status.

2. **TicketRunner checks dependencies before execution.**
   When a warden picks up a story, the TicketRunner parses the description for `DEPENDS ON: <key>`, fetches the dependency via `get_issue`, and checks its status. If not Done, the story is transitioned back to Blocked and skipped.

3. **Mechanical unblocking after completion.**
   When a story transitions to Done (detected via JIRA webhook changelog), the daemon searches for stories with matching `DEPENDS ON` text and transitions them to "To Do". Then calls `wardenRegistry.rehydrateAll()` so wardens discover the newly available work.

4. **Belt-and-suspenders: TicketRunner also unblocks.**
   The TicketRunner independently runs the same unblocking logic after completing a story, in case the webhook delivery is delayed or lost.

### Evolution of this design

**v1 — Pure LLM reasoning (failed):** The Architect's prompt told it to "check if dependent Stories are Blocked waiting for it." This relied entirely on the Architect independently deciding to search for blocked stories and transition them. It worked sometimes, but was fundamentally unreliable — the Architect had many things to think about and would frequently miss unblocking actions.

**v2 — Mechanical check, no mechanical unblock (partially worked):** Added `checkDependency()` to prevent premature execution, but still relied on the Architect to notice completions and unblock. Stories would stay Blocked forever.

**v3 — Full mechanical pipeline (current):** Both blocking and unblocking are mechanical. The Architect is still notified (via webhooks) and can take strategic action, but the system doesn't depend on it for correct operation.

**Key lesson:** Use LLMs for decisions that benefit from reasoning. Use code for decisions that must be deterministic. Dependency ordering is deterministic — it should never depend on an LLM deciding to check.

---

## Resilience engineering

HIRAM is designed to run unattended for hours. Every failure mode observed during E2E testing has a corresponding mitigation.

### Circuit breaker

Shared across all agents. Opens after 5 consecutive API failures, stays open for 60 seconds. When open, all agent calls fail immediately with `CircuitOpenError` instead of queuing up and adding pressure to a failing API.

```typescript
const apiCircuitBreaker = new CircuitBreaker({
  errorThreshold: 5,
  resetTimeout: 60_000,
});
```

### Token budget

Two levels of enforcement:

- **Per-run:** 32,768 tokens default, 65,536 escalated. Prevents any single agent run from consuming unlimited tokens.
- **Per-ticket:** Tracks cumulative spend per JIRA ticket key. Prevents a stuck ticket from draining the budget across multiple retry attempts.

### Context compaction

When token usage approaches 70% of the budget, the compactor summarizes older messages while preserving recent turns. This is proactive — it happens before hitting the hard limit, so the agent still has budget for useful work after compaction.

### Self-healing

HIRAM catches process-level errors that would normally crash Node.js:

- `EPIPE` — a plugin child process died and the parent wrote to its broken pipe. Logged and ignored; the reconnect loop handles it.
- `ECONNRESET` — a remote MCP server dropped the connection. Same treatment.
- `ERR_STREAM_DESTROYED` — a stream was destroyed mid-write. Same treatment.

These are recoverable errors that the plugin registry's reconnect logic handles automatically. Crashing the entire daemon for a single plugin failure would be disproportionate.

---

## Knowledge store

The knowledge store is HIRAM's persistent institutional memory. Unlike conversation context (which resets between runs), knowledge persists in SQLite and is searchable across all agents.

### How it works

- **Write:** Agents call `knowledge_save({ title, content, tags, source })`. The content is embedded via the Voyage AI API and stored alongside the raw text.
- **Search:** Agents call `knowledge_search(query)`. Returns results ranked by semantic similarity (cosine distance on Voyage embeddings) with FTS5 keyword fallback.
- **Consolidation:** Periodic passes merge related entries and prune stale data.

### Why this matters

Research findings persist across runs. If the system researches competitor pricing for legal document generators in run 1, the Build warden in run 2 can retrieve those findings via `knowledge_search("legal document pricing")` without re-doing the research. This is particularly valuable because research costs real API credits — caching findings in the knowledge store avoids duplicate spend.

---

## Configuration and secrets

### Two-layer configuration

1. **Environment variables** (`.env`) — loaded at boot, immutable at runtime. Covers database paths, ports, API keys.
2. **Runtime config** (`data/config.json`) — hot-reloadable without restart. Covers model selection, token budgets, circuit breaker thresholds.

### Encrypted vault

All secrets are encrypted at rest using AES-256-GCM with the `HIRAM_MASTER_KEY` as the encryption key. Secrets are stored in SQLite (the `secrets` table) and decrypted on-demand into memory. This means:

- The `.env` file only needs secrets on first boot — after seeding, secrets live in the encrypted database.
- The master key is the only secret that must remain in the environment permanently.
- Database backups contain encrypted secrets — they're safe to store without additional encryption.

### Vault seeding

On boot, the `seedVault()` function reads all `VAULT_*` environment variables and stores them in the vault (if not already present). This is idempotent — if the vault already has a secret, the env var is ignored. This design allows a clean first-boot workflow:

1. Set all secrets in `.env`
2. Start HIRAM — secrets are seeded into the encrypted vault
3. Remove secrets from `.env` (only `ANTHROPIC_API_KEY` and `HIRAM_MASTER_KEY` must remain)
4. Future boots read from the encrypted vault
