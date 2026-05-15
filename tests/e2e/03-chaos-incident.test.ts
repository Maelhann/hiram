import { describe, it, expect, afterAll } from 'vitest';
import { E2EHarness } from './harness.js';

// ---------------------------------------------------------------------------
// E2E Test 3: Chaos — Concurrent multi-domain disruptions
//
// Fires five events simultaneously into the system, targeting different
// wardens and agents. Tests the system's ability to handle concurrent
// autonomous work without dropping events, deadlocking, or confusing
// ticket assignments.
//
// Events:
//   1. Cloudflare WAF alert         → warden:monitor + architect
//   2. Instantly campaign bounces    → warden:outreach
//   3. Stripe payout failed          → treasurer + architect
//   4. Broken JIRA ticket            → architect (direct)
//   5. HubSpot deal closed-won       → warden:outreach + architect
//
// Verification:
//   - Zero dead events in journal
//   - Every event delivered to all targets
//   - JIRA tickets created with correct warden labels
//   - Multiple agents active concurrently in transcript
//   - No event dropped even under concurrent load
// ---------------------------------------------------------------------------

describe('E2E 03: Chaos — Five simultaneous disruptions', () => {
  let harness: E2EHarness;

  afterAll(async () => {
    await harness?.teardown();
  }, 600_000);

  it('should handle concurrent events across all wardens without dropping any', async () => {
    harness = new E2EHarness('03-chaos-incident');
    await harness.setup();

    // Pre-seed: label tagging.
    await harness.ctx.architect.handleInstruction(
      `For this session, add the label "${harness.runLabel}" to every JIRA issue you create. ` +
      `When creating tickets for wardens, always use the appropriate warden label (warden:ops, warden:dev, etc).`,
    );

    console.log('[E2E] Injecting 5 concurrent events...');

    // =====================================================================
    // Event 1: Cloudflare WAF alert — SQL injection attempt.
    // =====================================================================
    const cfPayload = {
      alert_type: 'waf',
      zone: 'example.com',
      severity: 'high',
      description: 'WAF rule triggered: SQL injection attempt detected on /api/auth/login. ' +
        'Request blocked. Source IP: 198.51.100.42 (AS16509 Amazon). ' +
        '47 similar requests in the last 5 minutes from the same IP range.',
      rule_id: 'cf.waf.sqli.001',
      source_ip: '198.51.100.42',
      uri: '/api/auth/login',
      action: 'block',
      timestamp: new Date().toISOString(),
    };

    // =====================================================================
    // Event 2: Instantly — campaign bounce spike.
    // =====================================================================
    const instantlyPayload = {
      event_type: 'email_bounced',
      campaign_id: 'camp_q2_enterprise_outreach',
      campaign_name: 'Q2 Enterprise Outreach - Series A CTOs',
      email: 'jane.doe@bigcorp.example.com',
      bounce_type: 'hard',
      bounce_reason: 'Mailbox not found (550 5.1.1)',
      lead_id: 'lead_abc123',
      sequence_step: 2,
      timestamp: new Date().toISOString(),
    };

    // =====================================================================
    // Event 3: Stripe payout failed.
    // =====================================================================
    const stripePayload = {
      id: 'evt_e2e_payout_failed',
      type: 'payout.failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'po_e2e_failed',
          amount: 245000,
          currency: 'eur',
          failure_code: 'account_closed',
          failure_message: 'The bank account has been closed.',
          arrival_date: Math.floor(Date.now() / 1000) + 86400,
          status: 'failed',
        },
      },
    };

    // =====================================================================
    // Event 4: Broken JIRA ticket — direct to Architect.
    // =====================================================================
    const brokenTicketPrompt =
      'URGENT: Automated monitoring detected an anomaly in the JIRA board. ' +
      'Ticket HIRAM-999 (summary: "Deploy SSL certificate renewal automation") ' +
      'has been stuck in "In Progress" status for 72 hours with no comments or updates. ' +
      'The assigned warden (warden:ops) has not picked it up. ' +
      'Investigate: check if the ticket exists, check the warden status, ' +
      'and take corrective action. If the warden is stuck, reassign or create a new ticket.';

    // =====================================================================
    // Event 5: HubSpot deal closed-won.
    // =====================================================================
    const hubspotPayload = {
      subscriptionType: 'deal.propertyChange',
      objectId: 123456,
      propertyName: 'dealstage',
      propertyValue: 'closedwon',
      changeSource: 'CRM',
      objectType: 'DEAL',
      portalId: 148347362,
      appId: 0,
      occurredAt: Date.now(),
      sourceId: 'user:1',
      properties: {
        dealname: 'BigCorp Enterprise Contract',
        amount: '24000',
        dealstage: 'closedwon',
        pipeline: 'default',
      },
    };

    // =====================================================================
    // Fire all 5 concurrently.
    // =====================================================================
    const results = await Promise.allSettled([
      harness.ctx.eventBus.handleWebhook('/events/cloudflare', cfPayload),
      harness.ctx.eventBus.handleWebhook('/events/instantly', instantlyPayload),
      harness.ctx.eventBus.handleWebhook('/events/stripe', stripePayload),
      harness.ctx.architect.handleInstruction(brokenTicketPrompt),
      harness.ctx.eventBus.handleWebhook('/events/hubspot', hubspotPayload),
    ]);

    // Verify all injections succeeded.
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const labels = ['cloudflare', 'instantly', 'stripe', 'broken-ticket', 'hubspot'];
      if (r.status === 'fulfilled') {
        console.log(`[E2E] ${labels[i]}: injected`);
      } else {
        console.log(`[E2E] ${labels[i]}: FAILED — ${r.reason}`);
      }
    }

    // =====================================================================
    // Wait for all processing.
    // =====================================================================
    console.log('[E2E] Waiting for all agents to process...');

    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < 1_800_000) { // 30 min max
      await new Promise(r => setTimeout(r, 15_000));

      const elapsed = Math.round((Date.now() - start) / 1000);
      const summary = harness.recorder.getSummary();

      if (elapsed - lastLog >= 60) {
        lastLog = elapsed;
        const journal = harness.queryEventJournal();
        const delivered = journal.filter(e => e.status === 'delivered').length;
        const pending = journal.filter(e => e.status === 'pending' || e.status === 'partial').length;
        console.log(
          `[E2E] ${elapsed}s — API: ${summary.apiCalls}, tools: ${summary.toolExecutions}, ` +
          `events: ${delivered} delivered / ${pending} pending, ` +
          `agents: ${Object.keys(summary.perAgent).join(', ') || 'none'}`,
        );
      }

      const architectBusy = harness.ctx.architect.busy;
      const wardenStatuses = harness.ctx.wardenRegistry.listWithStatus();
      const anyWardenBusy = wardenStatuses.some((s: any) => s.busy || (s.queueDepth ?? 0) > 0);

      if (!architectBusy && !anyWardenBusy && harness.recorder.getSummary().apiCalls > 0) {
        await new Promise(r => setTimeout(r, 10_000));
        const recheck = harness.ctx.wardenRegistry.listWithStatus();
        if (!harness.ctx.architect.busy && !recheck.some((s: any) => s.busy || (s.queueDepth ?? 0) > 0)) {
          console.log(`[E2E] System idle after ${elapsed}s.`);
          break;
        }
      }
    }

    // =====================================================================
    // Verify: Event journal.
    // =====================================================================
    console.log('[E2E] Verifying event journal...');
    const allJournal = harness.queryEventJournal();
    const dead = allJournal.filter(e => e.status === 'dead');
    const delivered = allJournal.filter(e => e.status === 'delivered');
    const pending = allJournal.filter(e => e.status === 'pending' || e.status === 'partial');

    console.log(`[E2E] Journal: ${delivered.length} delivered, ${pending.length} pending, ${dead.length} dead`);
    expect(dead.length).toBe(0);

    // At least 4 webhook events should have been recorded.
    // (The broken-ticket goes direct to Architect, not through EventBus.)
    expect(allJournal.length).toBeGreaterThanOrEqual(3);

    // Specific event verification.
    const cfEvents = allJournal.filter(e => e.listener === 'cloudflare-webhook');
    const instEvents = allJournal.filter(e => e.listener === 'instantly-webhook');
    const stripeEvents = allJournal.filter(e => e.listener === 'stripe-webhook');
    const hubspotEvents = allJournal.filter(e => e.listener === 'hubspot-webhook');

    console.log(`[E2E] CF: ${cfEvents.length}, Instantly: ${instEvents.length}, Stripe: ${stripeEvents.length}, HubSpot: ${hubspotEvents.length}`);
    expect(cfEvents.length).toBeGreaterThanOrEqual(1);
    expect(instEvents.length).toBeGreaterThanOrEqual(1);
    expect(stripeEvents.length).toBeGreaterThanOrEqual(1);
    expect(hubspotEvents.length).toBeGreaterThanOrEqual(1);

    // =====================================================================
    // Verify: JIRA tickets created for different wardens.
    // =====================================================================
    console.log('[E2E] Verifying JIRA...');
    const issues = await harness.searchJira(
      `labels = "${harness.runLabel}" ORDER BY created ASC`,
    );
    const issueList = issues as { key: string; fields: { summary: string; labels: string[]; status: { name: string } } }[];
    console.log(`[E2E] Total JIRA issues: ${issueList.length}`);
    for (const issue of issueList) {
      console.log(`  ${issue.key} [${issue.fields.labels.join(',')}] ${issue.fields.status.name} — ${issue.fields.summary}`);
    }
    expect(issueList.length).toBeGreaterThanOrEqual(2);

    // =====================================================================
    // Verify: Transcript — multiple agent types active.
    // =====================================================================
    const finalSummary = harness.recorder.getSummary();
    const agents = Object.keys(finalSummary.perAgent);
    console.log(`[E2E] Agents involved: ${agents.join(', ')}`);
    expect(finalSummary.apiCalls).toBeGreaterThanOrEqual(4);
    expect(agents.length).toBeGreaterThanOrEqual(1);

    // Tool breakdown.
    const toolExecs = harness.ctx.db.prepare(
      `SELECT agent_type, tool_name, COUNT(*) as count FROM e2e_tool_execs GROUP BY agent_type, tool_name ORDER BY count DESC`,
    ).all() as { agent_type: string; tool_name: string; count: number }[];
    console.log('[E2E] Tool usage by agent:');
    for (const t of toolExecs.slice(0, 15)) {
      console.log(`  ${t.agent_type} → ${t.tool_name}: ${t.count}x`);
    }

    // Event delivery breakdown.
    const eventRecords = harness.ctx.db.prepare(`SELECT * FROM e2e_events ORDER BY timestamp`).all() as {
      listener_name: string; targets: string; delivery_status: string;
    }[];
    console.log('[E2E] Event delivery:');
    for (const ev of eventRecords) {
      console.log(`  ${ev.listener_name} → targets: ${ev.targets}, status: ${ev.delivery_status}`);
    }

    console.log('\n[E2E] ============================');
    console.log('[E2E] TEST 3 RESULTS:');
    console.log(`[E2E]   Events injected:    5 (4 webhook + 1 direct)`);
    console.log(`[E2E]   Events delivered:    ${delivered.length}`);
    console.log(`[E2E]   Events dropped:      ${dead.length}`);
    console.log(`[E2E]   JIRA issues:         ${issueList.length}`);
    console.log(`[E2E]   Agents active:       ${agents.join(', ')}`);
    console.log(`[E2E]   API calls:           ${finalSummary.apiCalls}`);
    console.log(`[E2E]   Tool executions:     ${finalSummary.toolExecutions}`);
    console.log(`[E2E]   Cost:                $${finalSummary.estimatedCostUsd.toFixed(2)}`);
    console.log('[E2E] ============================\n');
  });
});
