import type { Supervisor } from './supervisor.js';

/**
 * CLI Server — placeholder for future socket-based CLI access.
 * Currently a no-op. HIRAM is controlled via Telegram (Secretary) and JIRA.
 */
export class CliServer {
  constructor(
    private supervisor: Supervisor,
    private socketPath: string,
    private tcpPort: number,
  ) {}

  async start(): Promise<void> {
    void this.supervisor;
    void this.socketPath;
    void this.tcpPort;
  }

  async stop(): Promise<void> {}
}
