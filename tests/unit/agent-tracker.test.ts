import { describe, it, expect } from 'vitest';
import { AgentTracker } from '../../src/workers/agent-tracker.js';

describe('AgentTracker', () => {
  it('should register and track an agent', () => {
    const tracker = new AgentTracker();
    const { id, signal } = tracker.register({ type: 'worker', label: 'developer', ticketKey: 'TEST-1' });

    expect(id).toBeTruthy();
    expect(signal.aborted).toBe(false);
    expect(tracker.activeCount).toBe(1);

    const snapshot = tracker.get(id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.type).toBe('worker');
    expect(snapshot!.label).toBe('developer');
    expect(snapshot!.ticketKey).toBe('TEST-1');
    expect(snapshot!.status).toBe('running');
  });

  it('should complete an agent', () => {
    const tracker = new AgentTracker();
    const { id } = tracker.register({ type: 'warden', label: 'warden:dev' });

    tracker.complete(id);

    const snapshot = tracker.get(id);
    expect(snapshot!.status).toBe('completed');
    expect(snapshot!.durationMs).toBeGreaterThanOrEqual(0);
    expect(tracker.activeCount).toBe(0);
  });

  it('should fail an agent with error', () => {
    const tracker = new AgentTracker();
    const { id } = tracker.register({ type: 'worker' });

    tracker.fail(id, 'Something went wrong');

    const snapshot = tracker.get(id);
    expect(snapshot!.status).toBe('failed');
    expect(snapshot!.error).toBe('Something went wrong');
  });

  it('should kill an agent and abort its signal', () => {
    const tracker = new AgentTracker();
    const { id, signal } = tracker.register({ type: 'worker' });

    expect(signal.aborted).toBe(false);
    const killed = tracker.kill(id);
    expect(killed).toBe(true);
    expect(signal.aborted).toBe(true);

    const snapshot = tracker.get(id);
    expect(snapshot!.status).toBe('killed');
  });

  it('should not kill a non-running agent', () => {
    const tracker = new AgentTracker();
    const { id } = tracker.register({ type: 'worker' });
    tracker.complete(id);

    const killed = tracker.kill(id);
    expect(killed).toBe(false);
  });

  it('should timeout an agent', () => {
    const tracker = new AgentTracker();
    const { id, signal } = tracker.register({ type: 'warden' });

    tracker.timeout(id);

    expect(signal.aborted).toBe(true);
    expect(tracker.get(id)!.status).toBe('timeout');
  });

  it('should list running agents only', () => {
    const tracker = new AgentTracker();
    const { id: id1 } = tracker.register({ type: 'worker', label: 'a' });
    tracker.register({ type: 'worker', label: 'b' });
    tracker.register({ type: 'warden', label: 'c' });
    tracker.complete(id1);

    const running = tracker.running();
    expect(running.length).toBe(2);
    expect(running.every((a) => a.status === 'running')).toBe(true);
  });

  it('should list all agents including finished', () => {
    const tracker = new AgentTracker();
    const { id } = tracker.register({ type: 'worker' });
    tracker.register({ type: 'warden' });
    tracker.complete(id);

    const all = tracker.all();
    expect(all.length).toBe(2);
  });

  it('should killAll running agents', () => {
    const tracker = new AgentTracker();
    const r1 = tracker.register({ type: 'worker' });
    const r2 = tracker.register({ type: 'warden' });
    const r3 = tracker.register({ type: 'architect' });
    tracker.complete(r1.id);

    const killed = tracker.killAll();
    expect(killed).toBe(2); // r2 and r3

    expect(r2.signal.aborted).toBe(true);
    expect(r3.signal.aborted).toBe(true);
    expect(r1.signal.aborted).toBe(false); // was already completed
    expect(tracker.activeCount).toBe(0);
  });

  it('should prune old finished agents', async () => {
    const tracker = new AgentTracker();
    const { id } = tracker.register({ type: 'worker' });
    tracker.complete(id);

    // Wait a tick so endedAt is strictly in the past relative to the cutoff.
    await new Promise((r) => setTimeout(r, 10));

    const pruned = tracker.prune(5); // prune entries older than 5ms
    expect(pruned).toBe(1);
    expect(tracker.get(id)).toBeUndefined();
  });

  it('should not prune running agents', () => {
    const tracker = new AgentTracker();
    tracker.register({ type: 'worker' });

    const pruned = tracker.prune(5);
    expect(pruned).toBe(0);
    expect(tracker.activeCount).toBe(1);
  });

  it('should return undefined for unknown ID', () => {
    const tracker = new AgentTracker();
    expect(tracker.get('nonexistent')).toBeUndefined();
  });

  it('should track multiple agent types simultaneously', () => {
    const tracker = new AgentTracker();
    tracker.register({ type: 'architect' });
    tracker.register({ type: 'warden', label: 'warden:dev' });
    tracker.register({ type: 'warden', label: 'warden:deploy' });
    tracker.register({ type: 'worker', label: 'developer', ticketKey: 'TEST-1' });
    tracker.register({ type: 'worker', label: 'tester', ticketKey: 'TEST-2' });

    expect(tracker.activeCount).toBe(5);

    const all = tracker.running();
    const types = all.map((a) => a.type);
    expect(types.filter((t) => t === 'architect')).toHaveLength(1);
    expect(types.filter((t) => t === 'warden')).toHaveLength(2);
    expect(types.filter((t) => t === 'worker')).toHaveLength(2);
  });
});
