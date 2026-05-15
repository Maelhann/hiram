import { describe, it, expect } from 'vitest';
import { TokenBudget, TokenBudgetExceeded } from '../../src/resilience/token-budget.js';

describe('TokenBudget', () => {
  it('should allow usage within per-run limit', () => {
    const budget = new TokenBudget({ maxTokensPerRun: 100_000 });
    expect(() => budget.checkRun(50_000)).not.toThrow();
  });

  it('should throw when per-run limit exceeded', () => {
    const budget = new TokenBudget({ maxTokensPerRun: 100_000 });
    expect(() => budget.checkRun(150_000)).toThrow(TokenBudgetExceeded);
  });

  it('should track per-ticket usage', () => {
    const budget = new TokenBudget({ maxTokensPerTicket: 200_000 });
    budget.recordTicket('TEST-1', 50_000);
    budget.recordTicket('TEST-1', 50_000);
    expect(budget.getTicketUsage('TEST-1')).toBe(100_000);
  });

  it('should throw when per-ticket limit exceeded', () => {
    const budget = new TokenBudget({ maxTokensPerTicket: 100_000 });
    budget.recordTicket('TEST-1', 60_000);
    expect(() => budget.recordTicket('TEST-1', 60_000)).toThrow(TokenBudgetExceeded);
  });

  it('should track tickets independently', () => {
    const budget = new TokenBudget({ maxTokensPerTicket: 100_000 });
    budget.recordTicket('TEST-1', 80_000);
    expect(() => budget.recordTicket('TEST-2', 80_000)).not.toThrow();
  });

  it('should clear ticket usage', () => {
    const budget = new TokenBudget({ maxTokensPerTicket: 100_000 });
    budget.recordTicket('TEST-1', 80_000);
    budget.clearTicket('TEST-1');
    expect(budget.getTicketUsage('TEST-1')).toBe(0);
    expect(() => budget.recordTicket('TEST-1', 80_000)).not.toThrow();
  });

  it('should expose limits via getters', () => {
    const budget = new TokenBudget({ maxTokensPerRun: 42, maxTokensPerTicket: 99 });
    expect(budget.perRunLimit).toBe(42);
    expect(budget.perTicketLimit).toBe(99);
  });

  it('should support hot-reload via setLimits', () => {
    const budget = new TokenBudget({ maxTokensPerRun: 100_000 });
    expect(budget.perRunLimit).toBe(100_000);

    budget.setLimits({ perRun: 200_000 });
    expect(budget.perRunLimit).toBe(200_000);

    // Old value should now be within budget.
    expect(() => budget.checkRun(150_000)).not.toThrow();
  });

  it('should use defaults when no options provided', () => {
    const budget = new TokenBudget();
    expect(budget.perRunLimit).toBe(500_000);
    expect(budget.perTicketLimit).toBe(2_000_000);
  });
});
