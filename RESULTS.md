# E2E Run Results — Ordo DocGen Network

Raw metrics from a live E2E test run on April 29, 2026. HIRAM was given a single directive: *build and launch the Ordo DocGen Network — 5 vertical document-generation websites*. No human intervention during execution. All data extracted from the E2E recorder database (`e2e_api_calls`, `e2e_tool_execs`, `knowledge` tables).

## Run overview

| Metric | Value |
|--------|-------|
| **Duration** | 23 minutes (terminated by SIGBUS — WSL memory pressure) |
| **Total cost** | $7.27 |
| **API calls** | 302 (13 Opus, 289 Sonnet) |
| **Tool executions** | 443 |
| **Tool error rate** | 4.7% (21/443) |
| **Tokens processed** | 10.6M total (9.3M from prompt cache — **89% cache hit rate**) |
| **JIRA tickets created** | 23 (7 Epics + 16 Stories) |
| **Knowledge entries saved** | 13 |
| **Peak concurrency** | 12 tickets being worked simultaneously |

## Timeline

```
00:19  Architect (Opus) begins. Reads policy, searches JIRA, creates project ODGEN.
       ├─ Creates 7 Epics (one per vertical + Research + Documentation)
       └─ Creates 16 Stories with dependency chains (DEPENDS ON relationships)

00:24  Research phase starts. Wardens pick up research stories.
       ├─ Worker 1: Ordo Studio API research (endpoints, auth, blueprints)
       ├─ Worker 2: Legal document competitor pricing
       ├─ Worker 3: Invoice generation competitor pricing
       ├─ Worker 4: Real estate document competitor pricing
       ├─ Worker 5: Educational certificate competitor pricing
       └─ Worker 6: HR document competitor pricing
       Peak: 7 concurrent tickets at 00:25

00:28  Research workers complete. 13 knowledge store entries saved.
       Key finding cached: "No API-first HR document generation product exists
       at SMB price points. All HRIS suites bundle docs into $250-$500+/mo."

00:30  Build phase launches. 5 dev workers spawn in parallel.
       ├─ Worker: Build LegalDraft (GitHub repo + web app)
       ├─ Worker: Build InvoiceForge
       ├─ Worker: Build PropDocs
       ├─ Worker: Build EduCert
       └─ Worker: Build HRPapers
       Workers creating GitHub repos, scaffolding Next.js apps, writing code.

00:38  Build activity peaks. All 5 dev workers + wardens active.
       Peak: 12 concurrent tickets at 00:40
       58 API calls in a single minute (00:40).

00:42  SIGBUS. WSL process killed by OOM (12 concurrent Claude SDK connections
       + esbuild processes + Node.js event loop exceeded WSL memory allocation).
       Build phase was ~40% through — repos created, code scaffolding in progress.
```

## What the Architect produced

In 4 minutes, the Architect (Opus 4.6) decomposed a high-level policy into a fully structured JIRA project:

**Project:** ODGEN (Ordo DocGen Network)

**Epics:**
1. Research & Architecture — Ordo Studio API, competitor pricing, architecture brief
2. LegalDraft — Build & Launch
3. InvoiceForge — Build & Launch
4. PropDocs — Build & Launch
5. EduCert — Build & Launch
6. HRPapers — Build & Launch
7. Documentation, Metrics & Launch Communication

**Stories (with dependency chains):**
| Story | Type | Assigned to | Depends on |
|-------|------|-------------|------------|
| Research Ordo Studio API and Blueprints | Research | warden:research | — |
| Research competitor pricing (all 5 verticals) | Research | warden:research | — |
| Build LegalDraft web app | Build | warden:dev | Research stories |
| Build InvoiceForge web app | Build | warden:dev | Research stories |
| Build PropDocs web app | Build | warden:dev | Research stories |
| Build EduCert web app | Build | warden:dev | Research stories |
| Build HRPapers web app | Build | warden:dev | Research stories |
| Deploy LegalDraft to Cloud Run + DNS | Deploy | warden:ops | Build LegalDraft |
| Deploy InvoiceForge to Cloud Run + DNS | Deploy | warden:ops | Build InvoiceForge |
| Deploy PropDocs to Cloud Run + DNS | Deploy | warden:ops | Build PropDocs |
| Deploy EduCert to Cloud Run + DNS | Deploy | warden:ops | Build EduCert |
| Deploy HRPapers to Cloud Run + DNS | Deploy | warden:ops | Build HRPapers |
| QA verify all 5 sites (Playwright) | Verify | warden:dev | All deploy stories |
| Landing page copy and marketing content | Content | warden:content | Research stories |
| Stripe products and pricing tiers | Pricing | agent:treasurer | Research stories |
| Launch summary email | Communication | agent:secretary | All deploy stories |

## What the research workers found

The research phase completed fully. Workers conducted web searches, visited competitor websites, analyzed pricing pages, and synthesized findings into the knowledge store. Sample output:

### Competitor pricing — legal documents
| Competitor | Model | Price range |
|-----------|-------|-------------|
| LegalZoom | Per-document | $59/doc, ~$99/mo subscription |
| Rocket Lawyer | Subscription | $39.99/mo (unlimited docs) |
| LawDepot | Freemium + per-doc | Free basic, $8-15/doc premium |
| PandaDoc | SaaS subscription | $19-65/user/mo |

### Competitor pricing — invoices
| Competitor | Model | Price range |
|-----------|-------|-------------|
| Invoice Ninja | Freemium | Free (5 clients), $10-14/mo Pro |
| FreshBooks | Subscription | $7.60-27.50/mo |
| Zoho Invoice | Freemium | Free (5 clients), from $9/mo |

### Key insight discovered autonomously
> *"Across ALL 5 verticals, the same pattern: every incumbent is UI-first or bundle-first. API access is gated behind $500-$1,000+/yr minimums (or unavailable). No competitor offers usage-based, per-document API pricing."*

This finding — identified by the research workers without prompting — directly informed the pricing strategy for the DocGen Network.

## Token economics

| Category | Tokens | Cost share |
|----------|--------|-----------|
| Architect (Opus 4.6) | 17.6K output | ~$1.32 |
| Workers (Sonnet 4.6) | 133.5K output | ~$2.00 |
| TicketAgent (Sonnet 4.6) | 64.9K output | ~$0.97 |
| Cache reads (all agents) | 9.3M | ~$2.79 |
| Cache writes (all agents) | 1.3M | ~$0.19 |
| **Total** | **10.6M** | **$7.27** |

The 89% prompt cache hit rate is critical for cost control. System prompts, tool definitions, and prior conversation turns are cached across turns. Without caching, this run would have cost approximately $47 — 6.5x more.

## Latency

| Model | Avg latency | Min | Max |
|-------|-------------|-----|-----|
| Claude Opus 4.6 | 16.6s | — | 133.7s |
| Claude Sonnet 4.6 | 11.6s | 1.5s | — |

The 134-second Opus call was the initial planning decomposition — the Architect's first turn where it read the policy, searched JIRA, and planned the full project structure in a single response.

## Errors observed

21 tool errors out of 443 executions (4.7% error rate). Breakdown:

| Error type | Count | Impact |
|-----------|-------|--------|
| MCP timeout (plugin process) | 3 | Transient — circuit breaker handled, retried |
| Git clone arg validation | 2 | Worker used wrong parameter format — self-corrected |
| `jq` not installed | 2 | Worker tried shell-based JSON parsing — fell back to Node |
| Secret not found (`STRIPE_PUBLISHABLE_KEY`) | 2 | Non-critical — worker adapted approach |
| Google Workspace API validation | 2 | Wrong tool parameters — worker retried |
| GitHub repo creation (tool not found) | 1 | Worker fell back to shell `curl` + GitHub API directly |
| Circuit breaker OPEN | 2 | Developer-tools plugin overloaded — 26s backoff, recovered |
| Playwright browser errors | 2 | Browser automation flaky — non-blocking |
| Other | 5 | Various transient failures, all recovered |

No errors were fatal. The circuit breaker pattern worked as designed — when the developer-tools plugin was overwhelmed by 5 concurrent workers, it tripped the breaker for 26 seconds, then recovered.

## What didn't finish

The run was terminated at 23 minutes by SIGBUS (out-of-memory kill in WSL). At the time of crash:

- **Completed:** All research, knowledge store populated, JIRA project fully structured
- **In progress:** 5 dev workers building web apps (GitHub repos created, code scaffolding ~40% complete)
- **Not started:** Deployment, DNS, Stripe pricing, QA verification, launch email

The crash was caused by running 12 concurrent agents (each with a Claude SDK connection, tool processes, and esbuild compilations) inside a WSL instance with limited memory. On a dedicated server, the run would have continued through the build, deploy, and verification phases.

## Methodology

- **Test harness:** `tests/e2e/01-policy-driven-work.test.ts` using Vitest
- **Recording:** Every API call and tool execution logged to SQLite via `tests/e2e/recorder.ts`
- **Environment:** WSL2 (Debian) on Windows 11, Node.js 22, Redis
- **Models:** Claude Opus 4.6 (Architect), Claude Sonnet 4.6 (all workers)
- **Duration limit:** 3 hours (configured), terminated early by OOM at 23 minutes
- **Human intervention:** None. Policy injected programmatically, system ran autonomously.
