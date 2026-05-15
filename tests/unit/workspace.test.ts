import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../../src/workspace.js';

describe('Workspace', () => {
  let tmpDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiram-workspace-test-'));
    workspace = new Workspace({ root: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create all top-level directories on init', async () => {
    await workspace.init();

    expect(fs.existsSync(workspace.dev)).toBe(true);
    expect(fs.existsSync(workspace.content)).toBe(true);
    expect(fs.existsSync(workspace.ops)).toBe(true);
    expect(fs.existsSync(workspace.research)).toBe(true);
    expect(fs.existsSync(workspace.scratch)).toBe(true);
  });

  it('should create and clean scratch workspaces', async () => {
    await workspace.init();

    const scratchPath = await workspace.createScratch('TEST-42');
    expect(fs.existsSync(scratchPath)).toBe(true);
    expect(scratchPath).toContain('TEST-42');

    // Write a file inside scratch to verify cleanup removes contents.
    fs.writeFileSync(path.join(scratchPath, 'temp.txt'), 'temporary');

    await workspace.cleanScratch('TEST-42');
    expect(fs.existsSync(scratchPath)).toBe(false);
  });

  it('should handle cleaning non-existent scratch without error', async () => {
    await workspace.init();
    // Should not throw.
    await workspace.cleanScratch('NONEXISTENT');
  });

  it('should produce a valid agent description', () => {
    const desc = workspace.describeForAgent();
    expect(desc).toContain('dev/');
    expect(desc).toContain('content/');
    expect(desc).toContain('ops/');
    expect(desc).toContain('research/');
    expect(desc).toContain('scratch/');
  });

  it('should be idempotent on multiple inits', async () => {
    await workspace.init();
    await workspace.init(); // Should not throw or duplicate.
    expect(fs.existsSync(workspace.dev)).toBe(true);
  });
});
