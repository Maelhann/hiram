import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// SafeStdioClientTransport — prevents EPIPE crashes.
//
// The MCP SDK's StdioClientTransport doesn't attach 'error' listeners
// to the child process's stdin/stdout streams. When the child dies and
// we write to the broken pipe, Node emits an 'error' event on the
// Socket with no listener, which crashes the process BEFORE
// uncaughtException can catch it.
//
// This wrapper attaches error listeners after start() to absorb pipe
// errors gracefully, letting the reconnect loop handle the rest.
// ---------------------------------------------------------------------------

export class SafeStdioClientTransport extends StdioClientTransport {
  private pipeErrorHandler?: (err: NodeJS.ErrnoException) => void;

  constructor(
    params: ConstructorParameters<typeof StdioClientTransport>[0],
    onPipeError?: (err: NodeJS.ErrnoException) => void,
  ) {
    super(params);
    this.pipeErrorHandler = onPipeError;
  }

  async start(): Promise<void> {
    await super.start();

    // Attach error listeners to stdin/stdout to prevent EPIPE crashes.
    // Access the private _process field — unavoidable for safety.
    const proc = (this as unknown as { _process?: import('node:child_process').ChildProcess })._process;
    if (proc?.stdin) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (this.pipeErrorHandler) {
          this.pipeErrorHandler(err);
        }
        // Swallowed — no throw, no crash.
      });
    }
    if (proc?.stdout) {
      proc.stdout.on('error', (err: NodeJS.ErrnoException) => {
        if (this.pipeErrorHandler) {
          this.pipeErrorHandler(err);
        }
      });
    }
  }
}
