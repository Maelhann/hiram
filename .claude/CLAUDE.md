# HIRAM — Claude Code Project Instructions

## Build & Run
- `npm run build` — compile TypeScript
- `npm start` — run the daemon
- `npm run dev` — run in development mode (tsx, no compile)
- `npm test` — unit tests
- `npm run test:e2e` — end-to-end tests (requires all credentials, 1-3 hours)

## Architecture
- Entry point: `src/daemon.ts` — 14-step boot sequence
- Agent hierarchy: Architect (Opus) → Wardens (Sonnet) → Workers (Sonnet)
- All external integrations via MCP plugins in `src/tools/seeds/`
- Worker type prompts in `src/workers/worker-types.ts`
- Resilience patterns in `src/resilience/`

## Code Conventions
- ES modules (`"type": "module"` in package.json)
- TypeScript strict mode
- Import types with `import type { ... }`
- Tool parameter names are camelCase (issueKey, not issue_key)
- JIRA transition IDs must be discovered via get_transitions, never hardcoded

## Don't deploy anything unless specifically told to.
