import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { PolicyStore } from '../../src/policy/store.js';

describe('PolicyStore', () => {
  let db: Database.Database;
  let store: PolicyStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    store = new PolicyStore(db);
  });

  it('should create and retrieve a policy', () => {
    const policy = store.create({
      title: 'Grow MRR to €10K',
      description: 'Increase monthly recurring revenue to €10,000 by end of Q3 through new customer acquisition and upsells.',
      priority: 'high',
    });

    expect(policy.id).toBeDefined();
    expect(policy.title).toBe('Grow MRR to €10K');
    expect(policy.priority).toBe('high');
    expect(policy.status).toBe('active');

    const retrieved = store.get(policy.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.description).toContain('€10,000');
  });

  it('should list active policies in priority order', () => {
    store.create({ title: 'Low priority', description: 'Not urgent', priority: 'low' });
    store.create({ title: 'Critical', description: 'Do now', priority: 'critical' });
    store.create({ title: 'Medium', description: 'Normal', priority: 'medium' });

    const active = store.listActive();
    expect(active.length).toBe(3);
    expect(active[0].title).toBe('Critical');
    expect(active[2].title).toBe('Low priority');
  });

  it('should track progress updates', () => {
    const policy = store.create({ title: 'Ship v2', description: 'Release version 2.0', priority: 'high' });

    store.addUpdate(policy.id, 'Backend API complete. Frontend 60% done.');
    store.addUpdate(policy.id, 'Frontend complete. QA starting.');
    store.addUpdate(policy.id, 'QA passed. Ready for deploy.');

    const updated = store.get(policy.id)!;
    expect(updated.updates.length).toBe(3);
    expect(updated.updates[0].body).toContain('Backend API');
    expect(updated.updates[2].body).toContain('Ready for deploy');
  });

  it('should change policy status', () => {
    const policy = store.create({ title: 'Temporary', description: 'Will pause', priority: 'medium' });

    store.setStatus(policy.id, 'paused');
    expect(store.get(policy.id)!.status).toBe('paused');

    store.setStatus(policy.id, 'completed');
    expect(store.get(policy.id)!.status).toBe('completed');

    // Paused/completed policies don't appear in listActive.
    expect(store.listActive().length).toBe(0);
  });

  it('should update policy fields', () => {
    const policy = store.create({ title: 'Original', description: 'v1', priority: 'low' });

    store.update(policy.id, { title: 'Updated', priority: 'critical' });

    const updated = store.get(policy.id)!;
    expect(updated.title).toBe('Updated');
    expect(updated.priority).toBe('critical');
  });

  it('should format policies for the Architect', () => {
    store.create({ title: 'Grow revenue', description: 'Target €10K MRR', priority: 'critical' });
    store.create({ title: 'Reduce churn', description: 'Below 5% monthly', priority: 'high' });

    const formatted = store.formatForArchitect();
    expect(formatted).toContain('Grow revenue');
    expect(formatted).toContain('Reduce churn');
    expect(formatted).toContain('[CRITICAL]');
    expect(formatted).toContain('[HIGH]');
  });

  it('should include latest update in formatted output', () => {
    const p = store.create({ title: 'Test policy', description: 'Test', priority: 'medium' });
    store.addUpdate(p.id, 'Making progress');

    const formatted = store.formatForArchitect();
    expect(formatted).toContain('Making progress');
  });

  it('should return empty string when no active policies', () => {
    expect(store.formatForArchitect()).toBe('');
  });
});
