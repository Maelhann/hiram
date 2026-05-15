import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeStore } from './store.js';
import type { AgentDeps } from '../workers/base-agent.js';
import { BaseAgent } from '../workers/base-agent.js';
import { STANDARD_RETRY } from '../resilience/retry-policy.js';

// ---------------------------------------------------------------------------
// KnowledgeConsolidator — periodic deduplication and pruning of the knowledge
// store. Inspired by Claude Code's AutoDream pattern.
//
// Three-gate trigger system (cheapest first):
//   1. Time gate — minimum hours since last consolidation (default 7 days)
//   2. Count gate — minimum new entries since last run (default 20)
//   3. Lock gate — no concurrent consolidation in progress
//
// The consolidation itself runs as a BaseAgent with a curator system prompt
// that reads, deduplicates, merges, and prunes knowledge entries.
// ---------------------------------------------------------------------------

const DEFAULT_MIN_HOURS = 7 * 24; // 7 days
const DEFAULT_MIN_ENTRIES = 20;
const LOCK_STALENESS_MS = 60 * 60_000; // 60 minutes

interface ConsolidatorOptions {
  /** Minimum hours between consolidation runs. Default 168 (7 days). */
  minHoursBetweenRuns?: number;
  /** Minimum new entries to trigger consolidation. Default 20. */
  minNewEntries?: number;
  /** Path to the lock file. */
  lockPath: string;
}

/** Agent that performs knowledge consolidation. */
class CuratorAgent extends BaseAgent {
  protected systemPrompt(): string {
    return CURATOR_PROMPT;
  }
}

export class KnowledgeConsolidator {
  private lockPath: string;
  private minHours: number;
  private minEntries: number;
  private running = false;

  constructor(private opts: ConsolidatorOptions) {
    this.lockPath = opts.lockPath;
    this.minHours = opts.minHoursBetweenRuns ?? DEFAULT_MIN_HOURS;
    this.minEntries = opts.minNewEntries ?? DEFAULT_MIN_ENTRIES;
  }

  /**
   * Check all gates and run consolidation if appropriate.
   * Returns true if consolidation was executed.
   */
  async maybeConsolidate(deps: AgentDeps, knowledge: KnowledgeStore): Promise<boolean> {
    // Gate 1: Time
    if (!this.timeGateOpen()) return false;

    // Gate 2: Count
    const recent = knowledge.recent(this.minEntries + 1);
    if (recent.length < this.minEntries) return false;

    // Gate 3: Lock
    if (!this.acquireLock()) return false;

    try {
      this.running = true;
      console.log('[Consolidator] Starting knowledge consolidation...');

      const agent = new CuratorAgent(deps);
      const entryCount = knowledge.recent(1000).length;
      const prompt = buildConsolidationPrompt(entryCount);

      await agent.run(prompt, undefined, {
        timeoutMs: 30 * 60_000, // 30 minutes max
        retryOptions: STANDARD_RETRY,
      });

      console.log('[Consolidator] Knowledge consolidation completed.');
      return true;
    } catch (err) {
      console.error('[Consolidator] Consolidation failed:', err);
      this.rollbackLock();
      return false;
    } finally {
      this.running = false;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  // -----------------------------------------------------------------------
  // Gate checks
  // -----------------------------------------------------------------------

  private timeGateOpen(): boolean {
    try {
      const stat = fs.statSync(this.lockPath);
      const hoursSinceLast = (Date.now() - stat.mtimeMs) / 3_600_000;
      return hoursSinceLast >= this.minHours;
    } catch {
      // Lock file doesn't exist — first run.
      return true;
    }
  }

  // -----------------------------------------------------------------------
  // File-based lock
  // -----------------------------------------------------------------------

  private acquireLock(): boolean {
    try {
      // Check if lock exists and is stale.
      const stat = fs.statSync(this.lockPath);
      const age = Date.now() - stat.mtimeMs;

      if (age < LOCK_STALENESS_MS) {
        // Lock is fresh — another consolidation may be running.
        const pid = fs.readFileSync(this.lockPath, 'utf8').trim();
        try {
          // Check if the PID is still alive.
          process.kill(Number(pid), 0);
          return false; // Process is alive — don't consolidate.
        } catch {
          // Process is dead — lock is stale.
        }
      }
    } catch {
      // Lock doesn't exist — proceed.
    }

    // Write lock with our PID.
    const lockDir = path.dirname(this.lockPath);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(this.lockPath, String(process.pid));
    return true;
  }

  private rollbackLock(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Lock may not exist.
    }
  }
}

function buildConsolidationPrompt(entryCount: number): string {
  return `You are a knowledge curator for the HIRAM autonomous system. The knowledge store currently has approximately ${entryCount} entries.

Your task is to consolidate, deduplicate, and prune the knowledge store to keep it useful and accurate.

## Process

### Phase 1: Orient
Use \`knowledge_search\` with broad queries to understand the current landscape:
- Search for common themes (e.g., "deploy", "error", "config", "auth")
- Note which topics have many similar entries

### Phase 2: Identify duplicates and stale entries
- Search for specific topics that seem over-represented
- Look for entries that contain contradictory information
- Flag entries older than 30 days that may be outdated

### Phase 3: Consolidate
For groups of related/duplicate entries:
1. Determine which entry has the most complete and accurate information
2. Use \`knowledge_save\` to create a merged entry combining the best parts
3. Use \`knowledge_remove\` to delete the redundant entries
4. Add a tag "consolidated" to merged entries

### Phase 4: Prune
- Remove entries that are clearly outdated or no longer relevant
- Remove entries that are too vague to be useful
- Keep entries that contain specific, actionable knowledge

## Rules
- Be conservative — when in doubt, keep the entry
- Never remove entries about safety incidents or critical failures
- Preserve entries tagged with "critical" or "warning"
- After consolidation, save a summary entry about what you changed

## Tools available
- \`knowledge_search(query)\` — find entries by topic
- \`knowledge_save(title, content, tags)\` — create or update entries
- \`knowledge_remove(id)\` — delete an entry

Begin by searching for broad categories to understand the knowledge landscape.`;
}

const CURATOR_PROMPT = `You are a knowledge curator agent in the HIRAM autonomous system.

Your sole purpose is to maintain the quality of the institutional knowledge store.
You read, deduplicate, merge, and prune knowledge entries so that future agents
get clean, accurate, non-redundant search results.

You have access to knowledge_search, knowledge_save, and knowledge_remove tools.
Use them methodically. Be conservative — it's better to keep a slightly redundant
entry than to lose important knowledge.

NEVER create entries about yourself or the consolidation process. Focus entirely
on improving existing knowledge quality.`;
