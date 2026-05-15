import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Workspace — managed directory structure for agent work.
//
// /opt/hiram/
// ├── dev/                    ← persistent repos / codebases
// │   ├── service-x/
// │   └── service-y/
// ├── content/                ← persistent content assets (blog, docs, landing pages)
// │   ├── blog/
// │   └── docs/
// ├── ops/                    ← persistent infrastructure configs, scripts, IaC
// │   ├── terraform/
// │   └── scripts/
// ├── research/               ← persistent research reports and intel
// │   ├── competitors/
// │   └── evaluations/
// ├── scratch/{issue-key}/    ← ephemeral per-ticket workspace, cleaned up when Story closes
// │   └── ...
// ├── data/                   ← SQLite, logs (existing)
// ├── tools/                  ← plugins (existing)
// └── backups/                ← backups (existing)
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  root: string; // e.g. /opt/hiram
}

export class Workspace {
  readonly dev: string;
  readonly content: string;
  readonly ops: string;
  readonly research: string;
  readonly scratch: string;

  constructor(private config: WorkspaceConfig) {
    this.dev = path.join(config.root, 'dev');
    this.content = path.join(config.root, 'content');
    this.ops = path.join(config.root, 'ops');
    this.research = path.join(config.root, 'research');
    this.scratch = path.join(config.root, 'scratch');
  }

  /** Create all top-level directories on boot. */
  async init(): Promise<void> {
    await fs.mkdir(this.dev, { recursive: true });
    await fs.mkdir(this.content, { recursive: true });
    await fs.mkdir(this.ops, { recursive: true });
    await fs.mkdir(this.research, { recursive: true });
    await fs.mkdir(this.scratch, { recursive: true });
  }

  /** Create a scratch workspace for a ticket. Returns the path. */
  async createScratch(issueKey: string): Promise<string> {
    const dir = path.join(this.scratch, issueKey);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Clean up a scratch workspace when a ticket is done. */
  async cleanScratch(issueKey: string): Promise<void> {
    const dir = path.join(this.scratch, issueKey);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /** Get the full context string to inject into agent prompts. */
  describeForAgent(): string {
    return [
      '## Server workspace',
      `- **dev/** (${this.dev}) — persistent codebases and repos. Clone/pull repos here.`,
      `- **content/** (${this.content}) — persistent content assets: blog posts, documentation, landing pages.`,
      `- **ops/** (${this.ops}) — persistent infrastructure: Terraform configs, deployment scripts, IaC.`,
      `- **research/** (${this.research}) — persistent research reports, competitor intel, evaluations.`,
      `- **scratch/** (${this.scratch}) — temporary per-ticket workspace. Cleaned up when the Story closes.`,
      '',
      'Use the right directory for the right work. Code goes in dev/, content in content/, etc.',
      'For throwaway work (quick scripts, temp files), use the scratch/ directory with your ticket key.',
    ].join('\n');
  }
}
