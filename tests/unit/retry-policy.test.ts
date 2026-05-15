import { describe, it, expect, vi } from 'vitest';
import { classifyError, execWithRetry, AbortError, type RetryOptions } from '../../src/resilience/retry-policy.js';

describe('RetryPolicy', () => {
  describe('classifyError', () => {
    it('should classify 429 as retryable', () => {
      expect(classifyError({ status: 429 })).toBe('retryable');
    });

    it('should classify 529 as retryable', () => {
      expect(classifyError({ status: 529 })).toBe('retryable');
    });

    it('should classify 500 as retryable', () => {
      expect(classifyError({ status: 500 })).toBe('retryable');
    });

    it('should classify 503 as retryable', () => {
      expect(classifyError({ status: 503 })).toBe('retryable');
    });

    it('should classify 400 as terminal', () => {
      expect(classifyError({ status: 400 })).toBe('terminal');
    });

    it('should classify 401 as terminal', () => {
      expect(classifyError({ status: 401 })).toBe('terminal');
    });

    it('should classify 404 as terminal', () => {
      expect(classifyError({ status: 404 })).toBe('terminal');
    });

    it('should classify ECONNRESET as retryable', () => {
      expect(classifyError({ code: 'ECONNRESET' })).toBe('retryable');
    });

    it('should classify ETIMEDOUT as retryable', () => {
      expect(classifyError({ code: 'ETIMEDOUT' })).toBe('retryable');
    });

    it('should classify unknown errors as terminal', () => {
      expect(classifyError(new Error('something weird'))).toBe('terminal');
    });

    it('should classify plain strings as terminal', () => {
      expect(classifyError('some error')).toBe('terminal');
    });
  });

  describe('execWithRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await execWithRetry(fn, { maxRetries: 3 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry retryable errors and succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce({ status: 429, message: 'rate limited' })
        .mockRejectedValueOnce({ status: 529, message: 'overloaded' })
        .mockResolvedValue('recovered');

      const result = await execWithRetry(fn, {
        maxRetries: 5,
        baseDelay: 1, // 1ms for fast tests
        maxDelay: 10,
      });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw immediately on terminal errors', async () => {
      const err = Object.assign(new Error('bad request'), { status: 400 });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(
        execWithRetry(fn, { maxRetries: 5, baseDelay: 1, maxDelay: 10 }),
      ).rejects.toMatchObject({ status: 400 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw after exhausting retries', async () => {
      const err = Object.assign(new Error('rate limited'), { status: 429 });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(
        execWithRetry(fn, { maxRetries: 2, baseDelay: 1, maxDelay: 10 }),
      ).rejects.toMatchObject({ status: 429 });
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should call onRetry callback', async () => {
      const onRetry = vi.fn();
      const fn = vi.fn()
        .mockRejectedValueOnce({ status: 500, message: 'server error' })
        .mockResolvedValue('ok');

      await execWithRetry(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10, onRetry });
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Object));
    });

    it('should respect abort signal', async () => {
      const ac = new AbortController();
      ac.abort();

      const fn = vi.fn().mockResolvedValue('ok');
      await expect(
        execWithRetry(fn, { maxRetries: 3, baseDelay: 1 }, ac.signal),
      ).rejects.toThrow(AbortError);
      expect(fn).not.toHaveBeenCalled();
    });

    it('should abort mid-retry when signal fires', async () => {
      const ac = new AbortController();
      const fn = vi.fn().mockRejectedValue({ status: 429, message: 'rate limited' });

      // Abort after a short delay.
      setTimeout(() => ac.abort(), 50);

      await expect(
        execWithRetry(fn, { maxRetries: 100, baseDelay: 20, maxDelay: 100 }, ac.signal),
      ).rejects.toThrow(AbortError);
    });
  });
});
