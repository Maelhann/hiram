import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Vault } from './secrets/vault.js';
import type { BootLogger } from './boot-logger.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Git Configuration — sets up machine-level git credentials on boot.
//
// Uses the GITHUB_TOKEN from the vault to configure HTTPS authentication.
// Every git clone/push/pull from any agent (developer-tools, Expert, etc.)
// authenticates automatically via the credential helper.
// ---------------------------------------------------------------------------

export async function configureGit(vault: Vault, log: BootLogger): Promise<void> {
  const token = vault.get('GITHUB_TOKEN');
  if (!token) {
    log.warn('GITHUB_TOKEN not set — git push/clone will fail');
    return;
  }

  try {
    // Set identity.
    await exec('git', ['config', '--global', 'user.name', 'HIRAM']);
    const gitEmail = vault.get('GIT_EMAIL') ?? process.env.GIT_EMAIL ?? 'hiram@localhost';
    await exec('git', ['config', '--global', 'user.email', gitEmail]);

    // Configure credential helper to inject the token for all GitHub HTTPS URLs.
    // This rewrites https://github.com/ → https://hiram:{token}@github.com/
    await exec('git', ['config', '--global', `url.https://hiram:${token}@github.com/.insteadOf`, 'https://github.com/']);

    // Also handle git@ SSH-style URLs by rewriting them to HTTPS.
    await exec('git', ['config', '--global', `url.https://hiram:${token}@github.com/.insteadOf`, 'git@github.com:']);

    // Default branch name.
    await exec('git', ['config', '--global', 'init.defaultBranch', 'main']);

    // Authenticate gh CLI (used by agents for PRs, repos, Actions, releases).
    try {
      await exec('gh', ['auth', 'status'], { env: { ...process.env, GH_TOKEN: token } });
    } catch {
      // gh auth status fails if not logged in — that's fine, GH_TOKEN env is enough.
    }
    // Set GH_TOKEN globally so all child processes (shell_exec, run_claude_code) inherit it.
    process.env.GH_TOKEN = token;

    log.ok('Git + gh CLI configured (HIRAM @ GitHub)');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Git config failed: ${msg}`);
  }
}
