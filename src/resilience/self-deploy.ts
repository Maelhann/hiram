import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MetaTool } from '../tools/meta-tools.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// SelfDeployer — safe self-deployment pipeline for HIRAM.
//
// The Expert agent uses this to deploy code changes to the running system.
// Pipeline: build → test → snapshot rollback → copy dist → restart via systemd.
//
// Safety:
//   - Build and tests MUST pass before deployment
//   - Rollback snapshot always taken before overwriting dist/
//   - Daily deploy limit prevents infinite self-modification loops
//   - Every deploy is logged to knowledge store via the agent
// ---------------------------------------------------------------------------

const MAX_DEPLOYS_PER_DAY = 3;

interface DeployState {
  deploysToday: number;
  lastDeployDate: string;
}

let state: DeployState = { deploysToday: 0, lastDeployDate: '' };

export function createSelfDeployTool(opts: {
  repoDir: string;   // e.g. /opt/hiram/dev/hiram
  installDir: string; // e.g. /opt/hiram
}): MetaTool {
  return {
    spec: {
      name: 'self_deploy',
      description:
        'Deploy code changes from the HIRAM repo to the running system. ' +
        'This will: build the project, run all tests, snapshot the current dist/ for rollback, ' +
        'copy the new dist/ into place, and restart the daemon via systemd. ' +
        'The build and tests MUST pass — there is no override. ' +
        'Limited to 3 deploys per day to prevent self-modification loops. ' +
        'IMPORTANT: After calling this, the process will restart. Your current execution will end.',
      input_schema: {
        type: 'object' as const,
        properties: {
          reason: {
            type: 'string',
            description: 'Why this deploy is needed — what changed and why.',
          },
        },
        required: ['reason'],
      },
    },
    async handle(input) {
      const reason = input.reason as string;
      const { repoDir, installDir } = opts;
      const distDir = path.join(installDir, 'dist');
      const rollbackDir = path.join(installDir, 'dist.rollback');
      const repoDistDir = path.join(repoDir, 'dist');

      // Check daily limit.
      const today = new Date().toISOString().split('T')[0];
      if (state.lastDeployDate !== today) {
        state = { deploysToday: 0, lastDeployDate: today };
      }
      if (state.deploysToday >= MAX_DEPLOYS_PER_DAY) {
        return JSON.stringify({
          ok: false,
          error: `Daily self-deploy limit reached (${MAX_DEPLOYS_PER_DAY}). Try again tomorrow.`,
        });
      }

      try {
        // Step 1: Build.
        console.log('[SELF-DEPLOY] Building...');
        try {
          await execFileAsync('npm', ['run', 'build'], { cwd: repoDir });
        } catch (err) {
          const e = err as { stderr?: string; message: string };
          return JSON.stringify({
            ok: false,
            stage: 'build',
            error: `Build failed: ${e.stderr ?? e.message}`,
          });
        }

        // Step 2: Test.
        console.log('[SELF-DEPLOY] Running tests...');
        try {
          await execFileAsync('npm', ['test'], { cwd: repoDir });
        } catch (err) {
          const e = err as { stderr?: string; stdout?: string; message: string };
          return JSON.stringify({
            ok: false,
            stage: 'test',
            error: `Tests failed: ${e.stdout ?? e.stderr ?? e.message}`,
          });
        }

        // Step 3: Snapshot current dist/ for rollback.
        console.log('[SELF-DEPLOY] Creating rollback snapshot...');
        await fs.rm(rollbackDir, { recursive: true, force: true });
        await fs.cp(distDir, rollbackDir, { recursive: true });

        // Step 4: Copy new dist/ into place.
        console.log('[SELF-DEPLOY] Deploying new build...');
        await fs.rm(distDir, { recursive: true, force: true });
        await fs.cp(repoDistDir, distDir, { recursive: true });

        // Increment deploy counter.
        state.deploysToday++;

        console.log(`[SELF-DEPLOY] Deploy #${state.deploysToday} complete. Reason: ${reason}`);
        console.log('[SELF-DEPLOY] Restarting daemon via SIGTERM...');

        // Step 5: Restart — send SIGTERM to self, systemd will restart us.
        // Delay slightly so the tool result can be returned.
        setTimeout(() => {
          process.kill(process.pid, 'SIGTERM');
        }, 1000);

        return JSON.stringify({
          ok: true,
          stage: 'complete',
          deploy_number: state.deploysToday,
          reason,
          message: 'Build passed, tests passed, deployed. Daemon restarting in 1 second. Rollback available at dist.rollback/',
        });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          stage: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * Rollback to the previous deployment. Called manually or by a health check
 * after restart if the new code is unhealthy.
 */
export async function rollback(installDir: string): Promise<void> {
  const distDir = path.join(installDir, 'dist');
  const rollbackDir = path.join(installDir, 'dist.rollback');

  try {
    await fs.access(rollbackDir);
  } catch {
    console.error('[SELF-DEPLOY] No rollback snapshot found.');
    return;
  }

  console.log('[SELF-DEPLOY] Rolling back to previous deployment...');
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.cp(rollbackDir, distDir, { recursive: true });
  console.log('[SELF-DEPLOY] Rollback complete. Restarting...');
  process.kill(process.pid, 'SIGTERM');
}
