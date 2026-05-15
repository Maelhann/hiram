// ---------------------------------------------------------------------------
// TokenBudget — prevents runaway token spend on a single task.
//
// Each agentic run gets a token budget. When exceeded, the run is stopped
// and an error is raised so the warden can escalate or skip.
// ---------------------------------------------------------------------------

export interface TokenBudgetOptions {
  /** Max total tokens (input + output) per run. Default 500K. */
  maxTokensPerRun?: number;
  /** Max total tokens per ticket (across all worker runs). Default 2M. */
  maxTokensPerTicket?: number;
}

const DEFAULT_PER_RUN = 500_000;
const DEFAULT_PER_TICKET = 2_000_000;

export class TokenBudget {
  private _perRunLimit: number;
  private _perTicketLimit: number;
  private ticketTotals = new Map<string, number>();

  constructor(opts?: TokenBudgetOptions) {
    this._perRunLimit = opts?.maxTokensPerRun ?? DEFAULT_PER_RUN;
    this._perTicketLimit = opts?.maxTokensPerTicket ?? DEFAULT_PER_TICKET;
  }

  /** Current per-run token limit. */
  get perRunLimit(): number { return this._perRunLimit; }

  /** Current per-ticket token limit. */
  get perTicketLimit(): number { return this._perTicketLimit; }

  /** Update limits at runtime (for hot-reload). */
  setLimits(opts: { perRun?: number; perTicket?: number }): void {
    if (opts.perRun !== undefined) this._perRunLimit = opts.perRun;
    if (opts.perTicket !== undefined) this._perTicketLimit = opts.perTicket;
  }

  /** Check if a run can continue given tokens consumed so far. Throws if over budget. */
  checkRun(tokensUsed: number): void {
    if (tokensUsed > this._perRunLimit) {
      throw new TokenBudgetExceeded(
        `Run exceeded token budget: ${tokensUsed.toLocaleString()} / ${this._perRunLimit.toLocaleString()} tokens. Stopping to prevent runaway spend.`,
      );
    }
  }

  /** Record tokens used for a ticket. Throws if the ticket's total budget is exceeded. */
  recordTicket(ticketKey: string, tokens: number): void {
    const current = this.ticketTotals.get(ticketKey) ?? 0;
    const updated = current + tokens;
    this.ticketTotals.set(ticketKey, updated);

    if (updated > this._perTicketLimit) {
      throw new TokenBudgetExceeded(
        `Ticket ${ticketKey} exceeded token budget: ${updated.toLocaleString()} / ${this._perTicketLimit.toLocaleString()} tokens across all runs. Escalate or skip.`,
      );
    }
  }

  /** Get tokens used for a ticket so far. */
  getTicketUsage(ticketKey: string): number {
    return this.ticketTotals.get(ticketKey) ?? 0;
  }

  /** Clear ticket tracking (e.g. when ticket is done). */
  clearTicket(ticketKey: string): void {
    this.ticketTotals.delete(ticketKey);
  }
}

export class TokenBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenBudgetExceeded';
  }
}
