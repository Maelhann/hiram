import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { EventBus } from '../../src/events/bus.js';

describe('EventBus', () => {
  let db: Database.Database;
  let bus: EventBus;
  const events: string[] = [];

  beforeEach(() => {
    db = initDatabase(':memory:');
    bus = new EventBus(db);
    events.length = 0;
    bus.onEvent(async (prompt) => {
      events.push(prompt);
    });
  });

  afterEach(() => {
    bus.stop();
    db.close();
  });

  it('should create and persist a cron listener', () => {
    const listener = bus.create({
      name: 'weekly-review',
      source: 'cron',
      config: { expression: 'every 7d' },
      handler: 'Perform a weekly portfolio review. Check all services for health, update policies.',
    });

    expect(listener.id).toBeDefined();
    expect(listener.name).toBe('weekly-review');
    expect(listener.source).toBe('cron');
    expect(listener.active).toBe(true);

    // Persisted in DB.
    const all = bus.listAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('weekly-review');
  });

  it('should create a poll listener and detect changes', async () => {
    // We can't easily test real polling, but we can verify the listener is created.
    const listener = bus.create({
      name: 'competitor-pricing',
      source: 'poll',
      config: { url: 'https://competitor.com/pricing', intervalSeconds: 3600 },
      handler: 'Competitor pricing page changed: {{payload}}. Evaluate if we need to adjust our pricing.',
    });

    expect(listener.source).toBe('poll');
    expect(listener.active).toBe(true);
  });

  it('should create a webhook listener', () => {
    const listener = bus.create({
      name: 'stripe-events',
      source: 'webhook',
      config: { path: '/events/stripe' },
      handler: 'Stripe event received: {{payload}}. Check if a customer churned or a payment failed.',
    });

    expect(listener.source).toBe('webhook');
    const paths = bus.getWebhookPaths();
    expect(paths).toContain('/events/stripe');
  });

  it('should handle webhook events and fire the handler', async () => {
    bus.create({
      name: 'test-webhook',
      source: 'webhook',
      config: { path: '/events/test' },
      handler: 'Test event: {{payload}}',
    });

    const handled = await bus.handleWebhook('/events/test', { type: 'test', value: 42 });
    expect(handled).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0]).toContain('test-webhook');
    expect(events[0]).toContain('"value":42');
  });

  it('should return false for unregistered webhook paths', async () => {
    const handled = await bus.handleWebhook('/events/unknown', {});
    expect(handled).toBe(false);
    expect(events.length).toBe(0);
  });

  it('should remove listeners', () => {
    bus.create({
      name: 'removable',
      source: 'cron',
      config: { expression: 'every 1h' },
      handler: 'test',
    });

    expect(bus.listAll().length).toBe(1);
    bus.remove('removable');
    expect(bus.listAll().length).toBe(0);
  });

  it('should deactivate listeners', () => {
    bus.create({
      name: 'deactivatable',
      source: 'cron',
      config: { expression: 'every 1h' },
      handler: 'test',
    });

    bus.deactivateByName('deactivatable');
    const listener = bus.getByName('deactivatable');
    expect(listener?.active).toBe(false);
  });

  it('should support multiple webhook listeners on different paths', async () => {
    bus.create({
      name: 'stripe',
      source: 'webhook',
      config: { path: '/events/stripe' },
      handler: 'Stripe: {{payload}}',
    });
    bus.create({
      name: 'github',
      source: 'webhook',
      config: { path: '/events/github' },
      handler: 'GitHub: {{payload}}',
    });

    await bus.handleWebhook('/events/stripe', { event: 'charge.succeeded' });
    await bus.handleWebhook('/events/github', { action: 'opened' });

    expect(events.length).toBe(2);
    expect(events[0]).toContain('stripe');
    expect(events[1]).toContain('github');
  });

  it('should reload listeners on start from SQLite', () => {
    // Insert directly into DB (simulating previous boot).
    db.prepare(
      `INSERT INTO event_listeners (id, name, source, config, handler, active, created_by, created_at)
       VALUES ('id1', 'persisted', 'cron', '{"expression":"every 24h"}', 'Daily check', 1, 'system', datetime('now'))`,
    ).run();

    const bus2 = new EventBus(db);
    const all = bus2.listAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('persisted');
    bus2.stop();
  });

  it('should handle handler template with {{payload}} replacement', async () => {
    bus.create({
      name: 'template-test',
      source: 'webhook',
      config: { path: '/events/tmpl' },
      handler: 'Customer {{payload}} needs attention.',
    });

    await bus.handleWebhook('/events/tmpl', { id: 'cust_123', status: 'churned' });
    expect(events[0]).toContain('cust_123');
    expect(events[0]).toContain('churned');
  });
});
