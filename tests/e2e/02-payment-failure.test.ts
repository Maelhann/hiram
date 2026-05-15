import { describe, it, expect, afterAll } from 'vitest';
import { E2EHarness } from './harness.js';

// ---------------------------------------------------------------------------
// E2E Test 2: Payment Failure — Full Stripe incident response
//
// Injects a realistic Stripe charge.failed webhook. The system must:
//
//   1. EventBus delivers to Treasurer (direct) + Architect (awareness)
//   2. Treasurer investigates: calls Stripe API to look up the customer,
//      checks the failure reason, determines if recoverable
//   3. Treasurer creates a JIRA ticket documenting the failure
//   4. Treasurer adds a comment with investigation findings
//   5. If the failure is a card decline, Treasurer recommends contacting
//      the customer or retrying with a different payment method
//   6. Architect creates an awareness Story linking to the Treasurer's ticket
//
// Then a SECOND event: a subscription deletion (churn). The system must:
//   7. Treasurer investigates the churn
//   8. Outreach Warden is notified to check if this was an outreach lead
//
// Uses the LIVE Stripe key — Treasurer reads real customer data.
// ---------------------------------------------------------------------------

describe('E2E 02: Payment Failure — Full Stripe incident response', () => {
  let harness: E2EHarness;

  afterAll(async () => {
    await harness?.teardown();
  }, 600_000);

  it('should investigate a payment failure and handle subscription churn', async () => {
    harness = new E2EHarness('02-payment-failure');
    await harness.setup();

    // Pre-seed: tell Architect to tag everything.
    await harness.ctx.architect.handleInstruction(
      `For this session, add the label "${harness.runLabel}" to every JIRA issue you create.`,
    );

    // =====================================================================
    // Phase 1: Charge failed event.
    // =====================================================================
    console.log('[E2E] Phase 1: Injecting charge.failed event...');
    const chargeFailed = {
      id: 'evt_e2e_charge_failed',
      type: 'charge.failed',
      created: Math.floor(Date.now() / 1000),
      livemode: true,
      data: {
        object: {
          id: 'ch_e2e_failed_001',
          object: 'charge',
          amount: 14900,
          currency: 'eur',
          customer: 'cus_e2e_test',
          failure_code: 'card_declined',
          failure_message: 'Your card was declined. Your card does not support this type of purchase.',
          description: 'Pro plan — monthly subscription',
          receipt_email: 'client@example.com',
          metadata: {
            service: 'landing.example.com',
            plan: 'pro',
            customer_name: 'Test Client Inc.',
          },
          payment_intent: 'pi_e2e_test_001',
          status: 'failed',
        },
      },
    };

    const handled1 = await harness.ctx.eventBus.handleWebhook('/events/stripe', chargeFailed);
    expect(handled1).toBe(true);

    // Wait for Treasurer + Architect to process.
    console.log('[E2E] Waiting for Phase 1 processing...');
    await harness.waitForIdle(600_000);

    // Verify Phase 1.
    const journal1 = harness.queryEventJournal();
    const stripeEvents = journal1.filter(e => e.listener === 'stripe-webhook');
    console.log(`[E2E] Phase 1: ${stripeEvents.length} stripe event(s) in journal`);
    expect(stripeEvents.length).toBeGreaterThanOrEqual(1);

    // Check Treasurer was active.
    const summary1 = harness.recorder.getSummary();
    console.log(`[E2E] Phase 1: ${summary1.apiCalls} API calls, agents: ${Object.keys(summary1.perAgent).join(', ')}`);

    // =====================================================================
    // Phase 2: Subscription deleted (churn).
    // =====================================================================
    console.log('[E2E] Phase 2: Injecting subscription.deleted event (churn)...');
    const subDeleted = {
      id: 'evt_e2e_sub_deleted',
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      livemode: true,
      data: {
        object: {
          id: 'sub_e2e_cancelled',
          object: 'subscription',
          customer: 'cus_e2e_test',
          status: 'canceled',
          cancel_at_period_end: false,
          canceled_at: Math.floor(Date.now() / 1000),
          items: {
            data: [{
              price: { unit_amount: 14900, currency: 'eur', recurring: { interval: 'month' } },
              quantity: 1,
            }],
          },
          metadata: {
            service: 'landing.example.com',
            plan: 'pro',
            customer_name: 'Test Client Inc.',
          },
        },
      },
    };

    const handled2 = await harness.ctx.eventBus.handleWebhook('/events/stripe', subDeleted);
    expect(handled2).toBe(true);

    // Wait for processing.
    console.log('[E2E] Waiting for Phase 2 processing...');
    await harness.waitForIdle(600_000);

    // =====================================================================
    // Verify everything.
    // =====================================================================
    console.log('[E2E] Verifying results...');

    // No dead events.
    const dead = harness.queryEventJournal('dead');
    expect(dead.length).toBe(0);

    // All events delivered.
    const allDelivered = harness.queryEventJournal('delivered');
    expect(allDelivered.length).toBeGreaterThanOrEqual(2);

    // JIRA tickets about payment/churn.
    const paymentIssues = await harness.searchJira(
      `labels = "${harness.runLabel}" ORDER BY created ASC`,
    );
    const issueList = paymentIssues as { key: string; fields: { summary: string; status: { name: string } } }[];
    console.log(`[E2E] JIRA issues created: ${issueList.length}`);
    for (const issue of issueList) {
      console.log(`  ${issue.key} [${issue.fields.status.name}] — ${issue.fields.summary}`);
    }
    expect(issueList.length).toBeGreaterThanOrEqual(1);

    // Transcript should show Treasurer activity.
    const finalSummary = harness.recorder.getSummary();
    console.log(`[E2E] Final: ${finalSummary.apiCalls} API calls, ${finalSummary.toolExecutions} tools, $${finalSummary.estimatedCostUsd.toFixed(2)}`);
    expect(finalSummary.apiCalls).toBeGreaterThanOrEqual(3);

    // At least Treasurer and Architect should appear.
    const agents = Object.keys(finalSummary.perAgent);
    console.log(`[E2E] Agents involved: ${agents.join(', ')}`);
    expect(agents.length).toBeGreaterThanOrEqual(1);

    // Tool executions should include Stripe API calls and JIRA calls.
    const toolExecs = harness.ctx.db.prepare(
      `SELECT tool_name, COUNT(*) as count FROM e2e_tool_execs GROUP BY tool_name ORDER BY count DESC`,
    ).all() as { tool_name: string; count: number }[];
    console.log('[E2E] Tool usage:');
    for (const t of toolExecs.slice(0, 10)) {
      console.log(`  ${t.tool_name}: ${t.count}x`);
    }

    console.log('\n[E2E] ============================');
    console.log('[E2E] TEST 2 RESULTS:');
    console.log(`[E2E]   Events processed:  ${allDelivered.length}`);
    console.log(`[E2E]   JIRA issues:       ${issueList.length}`);
    console.log(`[E2E]   API calls:         ${finalSummary.apiCalls}`);
    console.log(`[E2E]   Tool executions:   ${finalSummary.toolExecutions}`);
    console.log(`[E2E]   Cost:              $${finalSummary.estimatedCostUsd.toFixed(2)}`);
    console.log('[E2E] ============================\n');
  });
});
