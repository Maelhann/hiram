import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { Vault } from '../../src/secrets/vault.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';

describe('KnowledgeStore', () => {
  let db: Database.Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    const vault = new Vault(db, 'test-key');
    // No VOYAGE_API_KEY in vault — forces FTS5 fallback.
    store = new KnowledgeStore(db, vault);
  });

  it('should save and retrieve a knowledge entry', async () => {
    const entry = await store.save({
      title: 'Stripe requires PKCE for OAuth',
      content: 'When integrating Stripe OAuth, you must use PKCE flow. Client credentials grant is not supported.',
      source: 'warden:dev',
      tags: ['stripe', 'auth', 'oauth'],
    });

    expect(entry.id).toBeDefined();
    expect(entry.title).toBe('Stripe requires PKCE for OAuth');

    const retrieved = store.get(entry.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toContain('PKCE');
    expect(retrieved!.tags).toEqual(['stripe', 'auth', 'oauth']);
    expect(retrieved!.source).toBe('warden:dev');
  });

  it('should search by keyword using FTS5 fallback', async () => {
    await store.save({ title: 'Deploy requires health check', content: 'Always verify health endpoint after deployment.', source: 'ops', tags: ['deploy'] });
    await store.save({ title: 'Stripe webhook retry', content: 'Stripe retries webhooks for 72 hours on failure.', source: 'dev', tags: ['stripe'] });
    await store.save({ title: 'DNS propagation delay', content: 'Cloudflare DNS changes take up to 5 minutes.', source: 'ops', tags: ['dns'] });

    const results = await store.search('deploy health');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('Deploy');
  });

  it('should filter by tag', async () => {
    await store.save({ title: 'Entry A', content: 'Tagged with alpha', source: 'test', tags: ['alpha'] });
    await store.save({ title: 'Entry B', content: 'Tagged with beta', source: 'test', tags: ['beta'] });
    await store.save({ title: 'Entry C', content: 'Tagged with alpha too', source: 'test', tags: ['alpha', 'gamma'] });

    const alphas = store.getByTag('alpha');
    expect(alphas.length).toBe(2);
    expect(alphas.every((e) => e.tags.includes('alpha'))).toBe(true);
  });

  it('should update an entry', async () => {
    const entry = await store.save({ title: 'Original', content: 'First version', source: 'test' });
    const updated = await store.update(entry.id, { content: 'Updated version', tags: ['updated'] });

    expect(updated.content).toBe('Updated version');
    expect(updated.tags).toEqual(['updated']);
  });

  it('should remove an entry', async () => {
    const entry = await store.save({ title: 'To delete', content: 'Temporary', source: 'test' });
    expect(store.remove(entry.id)).toBe(true);
    expect(store.get(entry.id)).toBeUndefined();
  });

  it('should return recent entries with limit', async () => {
    await store.save({ title: 'First', content: 'A', source: 'test' });
    await store.save({ title: 'Second', content: 'B', source: 'test' });
    await store.save({ title: 'Third', content: 'C', source: 'test' });

    const recent2 = store.recent(2);
    expect(recent2.length).toBe(2);

    const recentAll = store.recent(10);
    expect(recentAll.length).toBe(3);
  });

  it('should handle empty search gracefully', async () => {
    const results = await store.search('nonexistent query');
    expect(results).toEqual([]);
  });
});
