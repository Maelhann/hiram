// ---------------------------------------------------------------------------
// RetryPolicy — exponential backoff with jitter for transient API errors.
//
// Classifies Anthropic SDK errors into retryable (429, 529, 5xx) vs terminal
// (400, 401, 404). Retryable errors are retried with exponential backoff +
// jitter to prevent thundering herd. Terminal errors throw immediately.
//
// Two modes:
//   standard  — max 8 retries, 32s cap (for workers / short-lived agents)
//   persistent — indefinite retries, 5-min cap (for wardens / long-lived agents)
// ---------------------------------------------------------------------------

export type ErrorClass = 'retryable' | 'terminal';

export interface RetryOptions {
  /** Maximum retries before giving up. Default 8. Set to Infinity for persistent mode. */
  maxRetries?: number;
  /** Base delay in ms. Default 500. */
  baseDelay?: number;
  /** Maximum delay in ms. Default 32_000. */
  maxDelay?: number;
  /** Called before each retry with attempt number and delay. */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 32_000;

/** Persistent mode preset for long-lived agents (wardens, architect). */
export const PERSISTENT_RETRY: RetryOptions = {
  maxRetries: Infinity,
  baseDelay: 500,
  maxDelay: 300_000, // 5-minute cap
};

/** Standard mode preset for short-lived agents (workers). */
export const STANDARD_RETRY: RetryOptions = {
  maxRetries: 8,
  baseDelay: 500,
  maxDelay: 32_000,
};

/**
 * Classify an error as retryable or terminal.
 *
 * Retryable: 429 (rate limit), 529 (overloaded), 5xx (server errors),
 *            network errors (ECONNRESET, EPIPE, ETIMEDOUT).
 * Terminal:  400, 401, 403, 404 and anything else.
 */
export function classifyError(err: unknown): ErrorClass {
  // Anthropic SDK errors expose a `status` property.
  const status = (err as { status?: number }).status;
  if (typeof status === 'number') {
    if (status === 429 || status === 529) return 'retryable';
    if (status >= 500 && status < 600) return 'retryable';
    return 'terminal';
  }

  // Network-level errors.
  const code = (err as { code?: string }).code;
  if (typeof code === 'string') {
    if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
      return 'retryable';
    }
  }

  // Unknown errors are terminal — don't retry what we don't understand.
  return 'terminal';
}

/**
 * Extract Retry-After header value from an Anthropic API error, if present.
 * Returns delay in ms, or null if not available.
 */
function getRetryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: Record<string, string> }).headers;
  if (!headers) return null;

  const retryAfter = headers['retry-after'];
  if (!retryAfter) return null;

  // Could be seconds (integer) or HTTP-date. We handle the integer case.
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return null;
}

/**
 * Calculate backoff delay: min(baseDelay * 2^attempt, maxDelay) + jitter.
 * Jitter is ±25% of the computed delay.
 */
function backoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponential = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = exponential * 0.25 * (2 * Math.random() - 1); // ±25%
  return Math.max(0, Math.round(exponential + jitter));
}

/**
 * Execute a function with retry logic. Only retryable errors are retried;
 * terminal errors throw immediately.
 *
 * When used inside a CircuitBreaker, a successful retry means the circuit
 * breaker sees a success — only exhausted retries propagate as failures.
 */
export async function execWithRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
  signal?: AbortSignal,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts?.baseDelay ?? DEFAULT_BASE_DELAY;
  const maxDelay = opts?.maxDelay ?? DEFAULT_MAX_DELAY;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check abort signal before each attempt.
    if (signal?.aborted) {
      throw new AbortError('Agent aborted');
    }

    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      // Terminal errors throw immediately — no retry.
      if (classifyError(err) === 'terminal') {
        throw error;
      }

      // Last attempt exhausted — throw.
      if (attempt >= maxRetries) {
        throw error;
      }

      // Calculate delay. Respect Retry-After header if present.
      const retryAfter = getRetryAfterMs(err);
      const delay = retryAfter ?? backoffDelay(attempt, baseDelay, maxDelay);

      opts?.onRetry?.(attempt + 1, delay, error);

      // Wait before retrying.
      await sleep(delay, signal);
    }
  }

  // Should never reach here, but just in case.
  throw lastError ?? new Error('execWithRetry: unexpected state');
}

/** Sleep for a duration, respecting an abort signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError('Agent aborted'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AbortError('Agent aborted'));
    }, { once: true });
  });
}

export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}
