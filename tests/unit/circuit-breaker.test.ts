import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../../src/resilience/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('should start in closed state', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.currentState).toBe('closed');
  });

  it('should pass through successful calls', async () => {
    const cb = new CircuitBreaker({ name: 'test' });
    const result = await cb.exec(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('should open after errorThreshold consecutive errors', async () => {
    const cb = new CircuitBreaker({ name: 'test', errorThreshold: 3, resetTimeout: 100 });

    for (let i = 0; i < 3; i++) {
      await cb.exec(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    expect(cb.currentState).toBe('open');
  });

  it('should throw CircuitOpenError when open', async () => {
    const cb = new CircuitBreaker({ name: 'test', errorThreshold: 1, resetTimeout: 1000 });
    await cb.exec(() => Promise.reject(new Error('fail'))).catch(() => {});

    await expect(cb.exec(() => Promise.resolve('ok'))).rejects.toThrow(CircuitOpenError);
  });

  it('should transition to half-open after resetTimeout', async () => {
    const cb = new CircuitBreaker({ name: 'test', errorThreshold: 1, resetTimeout: 50 });
    await cb.exec(() => Promise.reject(new Error('fail'))).catch(() => {});

    expect(cb.currentState).toBe('open');

    // Wait for resetTimeout.
    await new Promise((r) => setTimeout(r, 60));

    // Next call should be allowed (half-open test).
    const result = await cb.exec(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.currentState).toBe('closed');
  });

  it('should re-open if half-open test call fails', async () => {
    const cb = new CircuitBreaker({ name: 'test', errorThreshold: 1, resetTimeout: 50 });
    await cb.exec(() => Promise.reject(new Error('fail'))).catch(() => {});

    await new Promise((r) => setTimeout(r, 60));

    // Half-open test call fails.
    await cb.exec(() => Promise.reject(new Error('still failing'))).catch(() => {});
    expect(cb.currentState).toBe('open');
  });

  it('should reset consecutive errors on success', async () => {
    const cb = new CircuitBreaker({ name: 'test', errorThreshold: 3 });

    // 2 errors, then a success, then 2 more errors — should not open.
    await cb.exec(() => Promise.reject(new Error('1'))).catch(() => {});
    await cb.exec(() => Promise.reject(new Error('2'))).catch(() => {});
    await cb.exec(() => Promise.resolve('ok'));
    await cb.exec(() => Promise.reject(new Error('3'))).catch(() => {});
    await cb.exec(() => Promise.reject(new Error('4'))).catch(() => {});

    expect(cb.currentState).toBe('closed');
  });

  it('should call onStateChange callback', async () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ name: 'test', errorThreshold: 1, onStateChange });

    await cb.exec(() => Promise.reject(new Error('fail'))).catch(() => {});

    expect(onStateChange).toHaveBeenCalledWith('test', 'closed', 'open');
  });

  it('should support force reset', async () => {
    const cb = new CircuitBreaker({ name: 'test', errorThreshold: 1, resetTimeout: 99999 });
    await cb.exec(() => Promise.reject(new Error('fail'))).catch(() => {});

    expect(cb.currentState).toBe('open');
    cb.reset();
    expect(cb.currentState).toBe('closed');

    // Should work again.
    const result = await cb.exec(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });
});
