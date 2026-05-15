// ---------------------------------------------------------------------------
// CircuitBreaker — prevents cascading failures by stopping calls to a
// failing service after a threshold of consecutive errors.
//
// States:
//   CLOSED  — calls pass through normally
//   OPEN    — calls are rejected immediately (fail fast)
//   HALF    — one test call allowed to see if the service recovered
//
// Transitions:
//   CLOSED → OPEN   when errorThreshold consecutive errors
//   OPEN → HALF     after resetTimeout elapses
//   HALF → CLOSED   if test call succeeds
//   HALF → OPEN     if test call fails (resets the timeout)
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Name for logging. */
  name: string;
  /** Number of consecutive errors before opening the circuit. */
  errorThreshold?: number;
  /** Time in ms to wait before trying again (OPEN → HALF-OPEN). */
  resetTimeout?: number;
  /** Optional callback when state changes. */
  onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveErrors = 0;
  private lastFailure = 0;
  private name: string;
  private errorThreshold: number;
  private resetTimeout: number;
  private onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.errorThreshold = opts.errorThreshold ?? 5;
    this.resetTimeout = opts.resetTimeout ?? 30_000; // 30s default
    this.onStateChange = opts.onStateChange;
  }

  /** Execute a function through the circuit breaker. */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if enough time has passed to try again.
      if (Date.now() - this.lastFailure >= this.resetTimeout) {
        this.transition('half-open');
      } else {
        throw new CircuitOpenError(this.name, this.resetTimeout - (Date.now() - this.lastFailure));
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onError();
      throw err;
    }
  }

  private onSuccess(): void {
    this.consecutiveErrors = 0;
    if (this.state === 'half-open') {
      this.transition('closed');
    }
  }

  private onError(): void {
    this.consecutiveErrors++;
    this.lastFailure = Date.now();

    if (this.state === 'half-open') {
      // Test call failed — go back to open.
      this.transition('open');
    } else if (this.consecutiveErrors >= this.errorThreshold) {
      this.transition('open');
    }
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    console.warn(`[CircuitBreaker:${this.name}] ${from} → ${to}`);
    this.onStateChange?.(this.name, from, to);
  }

  /** Current state. */
  get currentState(): CircuitState {
    return this.state;
  }

  /** Force reset (e.g. after manual intervention). */
  reset(): void {
    this.consecutiveErrors = 0;
    this.transition('closed');
  }
}

export class CircuitOpenError extends Error {
  constructor(name: string, retryAfterMs: number) {
    super(`Circuit breaker "${name}" is OPEN. Service is failing. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'CircuitOpenError';
  }
}
