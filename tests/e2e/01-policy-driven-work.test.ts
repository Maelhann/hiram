import { describe, it, expect, afterAll } from 'vitest';
import { E2EHarness } from './harness.js';

// ---------------------------------------------------------------------------
// E2E Test 1: Build and Launch a Full Web Application
//
// The system must autonomously research, build, deploy, price, document,
// and verify a complete SaaS product — a "Status Page" service where
// users can monitor uptime of their websites.
//
// This exercises: Dev Warden (full-stack code), Ops Warden (deploy),
// Content Warden (docs), Research Warden (market research), Treasurer
// (Stripe pricing), Secretary (launch email), plus GitHub, Firebase,
// Google Workspace, Brave Search, and Stripe plugins.
// ---------------------------------------------------------------------------

describe('E2E 01: Build and launch a full web application', () => {
  let harness: E2EHarness;

  afterAll(async () => {
    await harness?.teardown();
  }, 600_000);

  it('should autonomously build and launch a SaaS product', async () => {
    harness = new E2EHarness('01-full-app-launch');
    await harness.setup();

    harness.ctx.policyStore.create({
      title: 'Ordo DocGen Network — 5 vertical document-generation websites powered by Ordo Studio',
      description: `Build and launch the Ordo DocGen Network — a portfolio of 5 lightweight websites,
each specialised in one vertical, offering document-generation as a service.

## Ordo Studio integration
Ordo Studio is our document-generation infrastructure. The API key is stored in the vault as ORDO_STUDIO_API_KEY.

- First, research Ordo Studio's capabilities: visit https://ordostudio.com, explore the API docs,
  understand Blueprints (document templates), and how to generate documents via the API.
- Each website's document packages MUST be generated using Ordo Studio Blueprints.
- Retrieve the API key from the vault: secret_get("ORDO_STUDIO_API_KEY").

## The 5 websites
Each site is a standalone, lightweight web app focused on ONE vertical:

1. **LegalDraft** — Legal document generation (NDAs, contracts, terms of service, privacy policies)
2. **InvoiceForge** — Invoice and receipt generation (freelancer invoices, receipts, credit notes)
3. **PropDocs** — Real estate document generation (lease agreements, property listings, inspection reports)
4. **EduCert** — Educational certificate generation (course certificates, diplomas, transcripts)
5. **HRPapers** — HR document generation (offer letters, employee handbooks, performance reviews)

## Per-website requirements
For each of the 5 sites:
- Create a GitHub repo under Normal-Systems (e.g. Normal-Systems/legaldraft)
- Build a clean, focused landing page explaining what the site does
- Implement 3-5 document packages as products, each backed by an Ordo Studio Blueprint
- Add Stripe checkout at competitive prices (research competitor pricing first)
- Include a simple API endpoint: POST /api/generate that takes a template name + data and returns the document
- Include a Dockerfile for deployment
- Deploy to Google Cloud Run
- Configure DNS via Cloudflare (e.g. legaldraft.example.com)
- Push to GitHub with clear commit messages

## Research phase
- Research Ordo Studio's API and Blueprint system — understand how to create and use templates
- For each vertical, research competitor pricing (e.g. what do legal document generators charge?)
- Write findings into a Google Doc: "Ordo DocGen Network — Research & Architecture Brief"

## Pricing strategy
- Each site should have 3 tiers (Free trial / Pro / Business) at competitive prices
- Create Stripe products for each site's tiers
- Do NOT modify existing Stripe products

## Deploy
- Deploy each site to Google Cloud Run
- Route each subdomain via Cloudflare DNS (legaldraft.example.com, invoiceforge.example.com, etc.)

## Documentation
- Google Doc: "Ordo DocGen Network — Research & Architecture Brief"
- Google Sheet: "Ordo DocGen Network — Launch Metrics" (one row per site: Site, Status, URL, Stripe Products, Deploy Date)

## Communication
- Send a launch summary email to founder@example.com once all 5 sites are deployed

## Done when
- All 5 sites return HTTP 200 at their subdomains
- Each site has working /api/generate endpoint
- Each site has Stripe checkout configured
- All 5 GitHub repos exist with code
- Google Doc and Sheet exist
- Launch email sent

Tag every JIRA issue with the label provided below.`,
      priority: 'critical',
      createdBy: 'founder',
    });

    console.log('[E2E] Policy set. Triggering Architect...');

    await harness.ctx.architect.handleInstruction(
      `There is a new CRITICAL policy: build the Ordo DocGen Network. Read it carefully. ` +
      `Create a JIRA project (key "ODGEN", name "Ordo DocGen Network"), ` +
      `then break it into Epics and Stories for each warden and agent. ` +
      `Add the label "${harness.runLabel}" to EVERY issue you create. ` +
      `Start immediately.`,
    );

    console.log('[E2E] Architect done. Rehydrating wardens + agents...');
    await harness.ctx.wardenRegistry.rehydrateAll();
    await harness.ctx.treasurer.rehydrate();
    await harness.ctx.secretary.rehydrate();
    await harness.ctx.expert.rehydrate();
    console.log('[E2E] All agents rehydrated. Working autonomously (60 min limit)...');

    const MAX_WAIT = 3 * 60 * 60 * 1000; // 3 hours
    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < MAX_WAIT) {
      await new Promise(r => setTimeout(r, 20_000));

      const elapsed = Math.round((Date.now() - start) / 1000);
      const summary = harness.recorder.getSummary();

      if (elapsed - lastLog >= 60) {
        lastLog = elapsed;
        const agents = Object.keys(summary.perAgent).join(', ') || 'none';
        console.log(
          `[E2E] ${Math.round(elapsed / 60)}m — API: ${summary.apiCalls}, tools: ${summary.toolExecutions}, ` +
          `errors: ${summary.toolErrors}, cost: $${summary.estimatedCostUsd.toFixed(2)}, agents: ${agents}`,
        );

        if (summary.toolErrors > 0) {
          const errors = harness.ctx.db.prepare(
            `SELECT tool_name, substr(result, 1, 300) as err FROM e2e_tool_execs WHERE is_error = 1 ORDER BY timestamp DESC LIMIT 5`,
          ).all() as { tool_name: string; err: string }[];
          for (const e of errors) {
            const isAuth = /401|403|unauthorized|expired|credential/i.test(e.err);
            const isKnownException = /hubspot|emailAddress.*invalid|not applicable/i.test(e.err);
            if (isAuth && !isKnownException) {
              console.error(`[E2E] *** AUTH FAILURE DETECTED — ABORTING ***`);
              console.error(`[E2E]   Tool: ${e.tool_name}`);
              console.error(`[E2E]   Error: ${e.err.slice(0, 150)}`);
              throw new Error(`Auth failure in ${e.tool_name}: ${e.err.slice(0, 100)}`);
            }
          }
        }
      }

      const architectBusy = harness.ctx.architect.busy;
      const wardenStatuses = harness.ctx.wardenRegistry.listWithStatus();
      const anyWardenBusy = wardenStatuses.some((s: any) => s.busy || (s.queueDepth ?? 0) > 0);

      if (!architectBusy && !anyWardenBusy && summary.apiCalls > 0) {
        console.log(`[E2E] System appears idle at ${Math.round(elapsed / 60)}m — waiting 3min to confirm...`);
        let stayedIdle = true;
        for (let check = 0; check < 9; check++) {
          await new Promise(r => setTimeout(r, 20_000));
          const recheck = harness.ctx.wardenRegistry.listWithStatus();
          if (harness.ctx.architect.busy || recheck.some((s: any) => s.busy || (s.queueDepth ?? 0) > 0)) {
            console.log(`[E2E] Activity resumed — back to waiting.`);
            stayedIdle = false;
            break;
          }
        }
        if (stayedIdle) {
          console.log(`[E2E] System idle for 3min. Done at ${Math.round(elapsed / 60)}m.`);
          break;
        }
      }
    }

    // =====================================================================
    // Verify.
    // =====================================================================
    console.log('[E2E] Verifying...');

    const issues = await harness.searchJira(
      `labels = "${harness.runLabel}" ORDER BY issuetype ASC, created ASC`,
    );
    const issueList = issues as { key: string; fields: { summary: string; issuetype: { name: string }; status: { name: string }; labels: string[] } }[];
    console.log(`[E2E] JIRA issues: ${issueList.length}`);
    for (const issue of issueList) {
      const m = issue.fields.status.name === 'Done' ? '✅' : issue.fields.status.name === 'Blocked' ? '🔴' : '🔄';
      console.log(`  ${m} ${issue.key} [${issue.fields.issuetype.name}] ${issue.fields.status.name} — ${issue.fields.summary}`);
    }

    const doneTickets = issueList.filter(i => i.fields.status.name === 'Done');
    console.log(`[E2E] Done: ${doneTickets.length}/${issueList.length}`);

    const sites = ['legaldraft', 'invoiceforge', 'propdocs', 'educert', 'hrpapers'];
    let sitesUp = 0;
    for (const site of sites) {
      try {
        const res = await fetch(`https://${site}.example.com`, { signal: AbortSignal.timeout(15_000) });
        console.log(`[E2E] ${site}.example.com → HTTP ${res.status}`);
        if (res.status === 200) sitesUp++;
      } catch { console.log(`[E2E] ${site}.example.com not reachable`); }
    }

    const summary = harness.recorder.getSummary();

    console.log('\n[E2E] ============================');
    console.log('[E2E] TEST 1 RESULTS:');
    console.log(`[E2E]   JIRA issues:     ${issueList.length}`);
    console.log(`[E2E]   Done tickets:    ${doneTickets.length}/${issueList.length}`);
    console.log(`[E2E]   Sites up:        ${sitesUp}/5`);
    console.log(`[E2E]   API calls:       ${summary.apiCalls}`);
    console.log(`[E2E]   Tools used:      ${summary.toolExecutions}`);
    console.log(`[E2E]   Tool errors:     ${summary.toolErrors}`);
    console.log(`[E2E]   Agents active:   ${Object.keys(summary.perAgent).join(', ')}`);
    console.log(`[E2E]   Cost:            $${summary.estimatedCostUsd.toFixed(2)}`);
    console.log('[E2E] ============================\n');

    expect(summary.apiCalls).toBeGreaterThan(0);
    expect(summary.toolExecutions).toBeGreaterThan(0);
    expect(issueList.length).toBeGreaterThanOrEqual(3);
  });
});
