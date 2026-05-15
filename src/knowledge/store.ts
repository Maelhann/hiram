import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Vault } from '../secrets/vault.js';
import type { MetaTool } from '../tools/meta-tools.js';

// ---------------------------------------------------------------------------
// KnowledgeStore — persistent institutional memory for HIRAM.
//
// Agents save lessons learned, domain discoveries, failure patterns, and
// operational context. Entries are embedded on write via Voyage AI for
// semantic search. FTS5 keyword search is kept as a fallback.
// ---------------------------------------------------------------------------

const VOYAGE_MODEL = 'voyage-3';
const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

interface KnowledgeRecord {
  id: string;
  title: string;
  content: string;
  source: string;
  tags: string;
  embedding: string | null;
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export class KnowledgeStore {
  private voyageApiKey: string | undefined;

  constructor(
    private db: Database.Database,
    vault: Vault,
  ) {
    this.voyageApiKey = vault.get('VOYAGE_API_KEY');
    if (!this.voyageApiKey) {
      console.warn('VOYAGE_API_KEY not found in vault. Knowledge search will use keyword fallback.');
    }
  }

  // -----------------------------------------------------------------------
  // Write — embed on save
  // -----------------------------------------------------------------------

  async save(opts: {
    title: string;
    content: string;
    source: string;
    tags?: string[];
  }): Promise<KnowledgeEntry> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tags = JSON.stringify(opts.tags ?? []);
    const text = `${opts.title}\n\n${opts.content}`;

    // Embed the entry.
    const embedding = await this.embed(text);

    this.db
      .prepare(
        `INSERT INTO knowledge (id, title, content, source, tags, embedding, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.title, opts.content, opts.source, tags, embedding ? JSON.stringify(embedding) : null, now, now);

    return { id, title: opts.title, content: opts.content, source: opts.source, tags: opts.tags ?? [], createdAt: now, updatedAt: now };
  }

  // -----------------------------------------------------------------------
  // Search — semantic (vector) with FTS5 fallback
  // -----------------------------------------------------------------------

  async search(query: string, limit = 10): Promise<KnowledgeEntry[]> {
    // Try semantic search first.
    const queryEmbedding = await this.embed(query);
    if (queryEmbedding) {
      return this.semanticSearch(queryEmbedding, limit);
    }

    // Fallback to FTS5 keyword search.
    return this.keywordSearch(query, limit);
  }

  private semanticSearch(queryEmbedding: number[], limit: number): KnowledgeEntry[] {
    // Load all entries with embeddings and compute cosine similarity in JS.
    // Fast enough for < 10K entries.
    const rows = this.db
      .prepare(`SELECT * FROM knowledge WHERE embedding IS NOT NULL`)
      .all() as KnowledgeRecord[];

    const now = Date.now();
    const scored = rows
      .map((row) => {
        let score = cosineSimilarity(queryEmbedding, JSON.parse(row.embedding!) as number[]);

        // Recency boost: entries validated in the last 7 days get +10%.
        // Entries not validated in 60+ days get -10%.
        const validatedAt = row.last_validated_at
          ? new Date(row.last_validated_at).getTime()
          : new Date(row.updated_at).getTime();
        const daysSinceValidation = (now - validatedAt) / 86_400_000;

        if (daysSinceValidation <= 7) {
          score *= 1.10;
        } else if (daysSinceValidation >= 60) {
          score *= 0.90;
        }

        return { row, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => toEntry(s.row));
  }

  private keywordSearch(query: string, limit: number): KnowledgeEntry[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT k.* FROM knowledge k
           JOIN knowledge_fts fts ON k.rowid = fts.rowid
           WHERE knowledge_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, limit) as KnowledgeRecord[];
      return rows.map(toEntry);
    } catch {
      // FTS query syntax error — return empty.
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Other queries
  // -----------------------------------------------------------------------

  getByTag(tag: string): KnowledgeEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM knowledge WHERE tags LIKE ? ORDER BY created_at DESC`)
      .all(`%"${tag}"%`) as KnowledgeRecord[];
    return rows.map(toEntry);
  }

  get(id: string): KnowledgeEntry | undefined {
    const row = this.db
      .prepare(`SELECT * FROM knowledge WHERE id = ?`)
      .get(id) as KnowledgeRecord | undefined;
    return row ? toEntry(row) : undefined;
  }

  async update(id: string, opts: { title?: string; content?: string; tags?: string[] }): Promise<KnowledgeEntry> {
    const existing = this.get(id);
    if (!existing) throw new Error(`Knowledge entry not found: ${id}`);

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (opts.title !== undefined) { sets.push('title = ?'); values.push(opts.title); }
    if (opts.content !== undefined) { sets.push('content = ?'); values.push(opts.content); }
    if (opts.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(opts.tags)); }

    // Re-embed if title or content changed.
    if (opts.title !== undefined || opts.content !== undefined) {
      const newTitle = opts.title ?? existing.title;
      const newContent = opts.content ?? existing.content;
      const embedding = await this.embed(`${newTitle}\n\n${newContent}`);
      sets.push('embedding = ?');
      values.push(embedding ? JSON.stringify(embedding) : null);
    }

    values.push(id);
    this.db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.get(id)!;
  }

  remove(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM knowledge WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  recent(limit = 20): KnowledgeEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM knowledge ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as KnowledgeRecord[];
    return rows.map(toEntry);
  }

  // -----------------------------------------------------------------------
  // Voyage AI embedding
  // -----------------------------------------------------------------------

  private async embed(text: string): Promise<number[] | null> {
    if (!this.voyageApiKey) return null;

    try {
      const res = await fetch(`${VOYAGE_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.voyageApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: VOYAGE_MODEL,
          input: [text],
          input_type: 'document',
        }),
      });

      if (!res.ok) {
        console.error(`Voyage AI embedding failed (${res.status}):`, await res.text());
        return null;
      }

      const json = await res.json() as { data: { embedding: number[] }[] };
      return json.data[0].embedding;
    } catch (err) {
      console.error('Voyage AI embedding error:', err);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Meta-tools — let agents read and write knowledge
// ---------------------------------------------------------------------------

export function createKnowledgeTools(store: KnowledgeStore): MetaTool[] {
  return [
    knowledgeSave(store),
    knowledgeSearch(store),
    knowledgeRemove(store),
  ];
}

function knowledgeSave(store: KnowledgeStore): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'knowledge_save',
      description:
        'Save a piece of knowledge to the persistent knowledge store. Use this to record lessons learned, ' +
        'domain discoveries, failure patterns, operational gotchas, or anything a future agent would benefit ' +
        'from knowing. Knowledge is embedded for semantic search — future agents will find it even if they ' +
        'use different words to describe the same concept.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Short descriptive title (e.g. "Service X requires OAuth2 PKCE flow")' },
          content: { type: 'string', description: 'Detailed knowledge content. Be specific — include what was learned, why it matters, and how to apply it.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization (e.g. ["deploy", "service-x", "auth"])' },
        },
        required: ['title', 'content'],
      },
    },
    async handle(input) {
      try {
        const entry = await store.save({
          title: input.title as string,
          content: input.content as string,
          source: 'agent',
          tags: (input.tags ?? []) as string[],
        });
        return JSON.stringify({ ok: true, id: entry.id, title: entry.title });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function knowledgeSearch(store: KnowledgeStore): MetaTool {
  return {
    concurrent: true,
    spec: {
      name: 'knowledge_search',
      description:
        'Search the knowledge store for relevant information. Uses semantic similarity — finds ' +
        'conceptually related entries even if the exact words differ. Use before starting work ' +
        'to check if anything has been learned about this topic before.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (natural language — describe what you\'re looking for)' },
          tag: { type: 'string', description: 'Optional: filter by tag instead of semantic search' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    async handle(input) {
      try {
        const tag = input.tag as string | undefined;
        const limit = (input.limit as number) ?? 10;

        const results = tag
          ? store.getByTag(tag).slice(0, limit)
          : await store.search(input.query as string, limit);

        return JSON.stringify({
          ok: true,
          count: results.length,
          entries: results.map((e) => ({
            id: e.id,
            title: e.title,
            content: e.content,
            tags: e.tags,
            source: e.source,
            created_at: e.createdAt,
          })),
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function knowledgeRemove(store: KnowledgeStore): MetaTool {
  return {
    concurrent: false,
    spec: {
      name: 'knowledge_remove',
      description: 'Remove a knowledge entry that is outdated, incorrect, or no longer relevant.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Knowledge entry ID to remove' },
        },
        required: ['id'],
      },
    },
    async handle(input) {
      try {
        const removed = store.remove(input.id as string);
        if (!removed) return JSON.stringify({ ok: false, error: 'Entry not found' });
        return JSON.stringify({ ok: true, id: input.id });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEntry(row: KnowledgeRecord): KnowledgeEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    source: row.source,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
