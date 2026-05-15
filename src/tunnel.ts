import { spawn, type ChildProcess } from 'node:child_process';
import type { Vault } from './secrets/vault.js';

// ---------------------------------------------------------------------------
// Cloudflare Tunnel — exposes HIRAM's webhook server to the internet.
//
// On boot, starts `cloudflared tunnel run` using the tunnel token from the
// vault. The tunnel routes your-domain.com → localhost:7401.
//
// The tunnel is configured remotely (via Cloudflare API), so cloudflared
// only needs the token — no local config files.
// ---------------------------------------------------------------------------

let tunnelProcess: ChildProcess | null = null;

export async function startTunnel(vault: Vault): Promise<void> {
  const token = vault.get('CLOUDFLARE_TUNNEL_TOKEN');
  if (!token) {
    console.log('[TUNNEL] CLOUDFLARE_TUNNEL_TOKEN not set — skipping tunnel start.');
    console.log('[TUNNEL] HIRAM will not be reachable from the internet.');
    return;
  }

  return new Promise((resolve) => {
    console.log('[TUNNEL] Starting cloudflared...');

    tunnelProcess = spawn('cloudflared', ['tunnel', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let resolved = false;

    tunnelProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[TUNNEL] ${line}`);
    });

    tunnelProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[TUNNEL] ${line}`);

      // cloudflared logs "Registered tunnel connection" to stderr when ready.
      if (!resolved && line.includes('Registered tunnel connection')) {
        resolved = true;
        const publicUrl = vault.get('HIRAM_PUBLIC_URL') ?? '';
        console.log(`[TUNNEL] Connected — HIRAM reachable at ${publicUrl}`);
        resolve();
      }
    });

    tunnelProcess.on('error', (err) => {
      console.error('[TUNNEL] Failed to start cloudflared:', err.message);
      console.error('[TUNNEL] Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      tunnelProcess = null;
      if (!resolved) { resolved = true; resolve(); }
    });

    tunnelProcess.on('exit', (code) => {
      console.warn(`[TUNNEL] cloudflared exited with code ${code}`);
      tunnelProcess = null;
      if (!resolved) { resolved = true; resolve(); }
    });

    // Don't block boot forever if tunnel is slow — resolve after 15s regardless.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log('[TUNNEL] Startup timeout — continuing boot (tunnel may still be connecting).');
        resolve();
      }
    }, 15_000);
  });
}

export function stopTunnel(): void {
  if (tunnelProcess) {
    console.log('[TUNNEL] Stopping cloudflared...');
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
  }
}
