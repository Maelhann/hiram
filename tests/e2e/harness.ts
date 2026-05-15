import crypto from 'node:crypto';
import { boot, type DaemonContext } from '../../src/daemon.js';
import { TranscriptRecorder } from './recorder.js';

// ---------------------------------------------------------------------------
// E2E Test Harness — boots the real daemon with real API keys, injects a
// transcript recorder, and provides helpers for event injection, idle
// detection, and JIRA cleanup.
// ---------------------------------------------------------------------------

export class E2EHarness {
  ctx!: DaemonContext;
  recorder!: TranscriptRecorder;
  readonly testName: string;
  readonly runLabel: string;

  constructor(testName: string) {
    this.testName = testName;
    this.runLabel = `e2e-run-${crypto.randomUUID().slice(0, 8)}`;
  }

  async setup(): Promise<void> {
    const ts = Date.now();

    this.ctx = await boot({
      sqlitePath: `/tmp/hiram-e2e-${this.testName}-${ts}.db`,
      workspaceRoot: `/tmp/hiram-e2e-workspace-${this.testName}-${ts}`,
      skipRelayCheck: true,
    });

    this.recorder = new TranscriptRecorder(this.ctx.db);

    // Inject recorder into all agents + wardens.
    this.ctx.architect.setTranscriptRecorder(this.recorder);
    this.ctx.treasurer.setTranscriptRecorder(this.recorder);
    this.ctx.secretary.setTranscriptRecorder(this.recorder);
    this.ctx.expert.setTranscriptRecorder(this.recorder);
    this.ctx.wardenRegistry.setTranscriptRecorder(this.recorder);

    // Inject into EventBus.
    this.ctx.eventBus.setTranscriptRecorder(this.recorder);

    console.log(`\n[E2E] Harness ready: ${this.testName} (label: ${this.runLabel})`);
  }

  /** Inject an event via HTTP POST to the webhook server. */
  async injectEvent(path: string, payload: unknown): Promise<number> {
    const port = this.getWebhookPort();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.status;
  }

  /** Wait until all agents, wardens, and event processing settle. */
  async waitForIdle(maxWait = 3_600_000): Promise<void> {
    const start = Date.now();
    await this.sleep(5000);

    while (Date.now() - start < maxWait) {
      const architectBusy = this.ctx.architect.busy;
      const wardenStatuses = this.ctx.wardenRegistry.listWithStatus();
      const anyWardenBusy = wardenStatuses.some((s: { busy?: boolean; queueDepth?: number }) =>
        s.busy || (s.queueDepth ?? 0) > 0,
      );

      if (!architectBusy && !anyWardenBusy) {
        await this.sleep(3000);
        // Double-check after grace period.
        const recheck = this.ctx.wardenRegistry.listWithStatus();
        if (
          !this.ctx.architect.busy &&
          !recheck.some((s: { busy?: boolean; queueDepth?: number }) => s.busy || (s.queueDepth ?? 0) > 0)
        ) {
          return;
        }
      }
      await this.sleep(2000);
    }
    console.warn(`[E2E] waitForIdle timed out after ${maxWait}ms`);
  }

  /** Query the event_journal table for assertions. */
  queryEventJournal(status?: string): { id: string; listener: string; status: string; targets: string; delivered: string; failed: string; attempts: number }[] {
    if (status) {
      return this.ctx.db.prepare(`SELECT * FROM event_journal WHERE status = ?`).all(status) as any[];
    }
    return this.ctx.db.prepare(`SELECT * FROM event_journal`).all() as any[];
  }

  /** Search JIRA for issues created during this test run. */
  async searchJira(jql: string): Promise<unknown[]> {
    try {
      console.log(`[E2E] searchJira: ${jql}`);
      const result = await this.ctx.pluginRegistry.invoke('atlassian', 'search_issues', {
        jql,
        maxResults: 50,
      });
      const parsed = JSON.parse(result);
      const issues = parsed.issues ?? parsed.results ?? [];
      console.log(`[E2E] searchJira: found ${issues.length} issue(s)`);
      return issues;
    } catch (err) {
      console.error(`[E2E] searchJira FAILED:`, err instanceof Error ? err.message : err);
      return [];
    }
  }

  /** Clean up JIRA tickets created during this test run. */
  async cleanupJira(): Promise<void> {
    try {
      const issues = await this.searchJira(`labels = "${this.runLabel}" ORDER BY created DESC`);
      for (const issue of issues as { key: string }[]) {
        try {
          await this.ctx.pluginRegistry.invoke('atlassian', 'delete_issue', { issueKey: issue.key });
        } catch {
          // Some MCP servers may not support delete — that's fine.
        }
      }
      if ((issues as unknown[]).length > 0) {
        console.log(`[E2E] Cleaned up ${(issues as unknown[]).length} JIRA issue(s) with label ${this.runLabel}`);
      }
    } catch {
      console.warn('[E2E] JIRA cleanup failed — issues may remain');
    }
  }

  /** Export transcript to JSON files and print summary. */
  exportTranscript(outputDir = './test-transcripts'): void {
    this.recorder.exportJson(this.testName, outputDir);

    const summary = this.recorder.getSummary();
    console.log(`\n[E2E] === Transcript Summary: ${this.testName} ===`);
    console.log(`  API calls:      ${summary.apiCalls}`);
    console.log(`  Tokens in:      ${summary.totalTokensIn.toLocaleString()} (cache: ${summary.totalCacheRead.toLocaleString()})`);
    console.log(`  Tokens out:     ${summary.totalTokensOut.toLocaleString()}`);
    console.log(`  Tool executions: ${summary.toolExecutions} (${summary.toolErrors} errors)`);
    console.log(`  Events:         ${summary.events}`);
    console.log(`  Est. cost:      $${summary.estimatedCostUsd.toFixed(2)}`);
    if (Object.keys(summary.perAgent).length > 0) {
      console.log(`  Per agent:`);
      for (const [agent, stats] of Object.entries(summary.perAgent)) {
        console.log(`    ${agent}: ${stats.apiCalls} calls, ${stats.tokensIn.toLocaleString()} in, ${stats.tokensOut.toLocaleString()} out`);
      }
    }
  }

  async teardown(): Promise<void> {
    this.exportTranscript();
    await this.cleanupJira();
    await this.ctx.shutdown();
    console.log(`[E2E] Harness torn down: ${this.testName}\n`);
  }

  private getWebhookPort(): number {
    const addr = (this.ctx.webhookServer as any).server?.address();
    return typeof addr === 'object' ? addr?.port ?? 7401 : 7401;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
