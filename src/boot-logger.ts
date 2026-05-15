// ---------------------------------------------------------------------------
// Boot Logger — structured progress display for HIRAM's startup sequence.
//
// Replaces raw console.log during boot with a clean, step-by-step display
// showing progress bars, status indicators, and timing.
// ---------------------------------------------------------------------------

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[0;36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const CHECKMARK = `${GREEN}✓${RESET}`;
const CROSS = `${RED}✗${RESET}`;
const WARN = `${YELLOW}⚠${RESET}`;
const ARROW = `${CYAN}▸${RESET}`;
const DOT = `${DIM}·${RESET}`;

export class BootLogger {
  private stepStart = 0;
  private totalStart = Date.now();
  private currentStep = '';
  private stepCount = 0;
  private totalSteps: number;

  constructor(totalSteps: number) {
    this.totalSteps = totalSteps;
  }

  banner(): void {
    console.log('');
    console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${BOLD}║                                                          ║${RESET}`);
    console.log(`${BOLD}║   ${CYAN}H I R A M${RESET}${BOLD}   —   Autonomous Agent Daemon              ║${RESET}`);
    console.log(`${BOLD}║                                                          ║${RESET}`);
    console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
    console.log('');
  }

  step(name: string): void {
    // Close previous step.
    if (this.currentStep) {
      this.stepDone();
    }
    this.stepCount++;
    this.currentStep = name;
    this.stepStart = Date.now();
    const progress = this.progressBar(this.stepCount, this.totalSteps);
    console.log(`\n${progress}  ${CYAN}${BOLD}${name}${RESET}`);
  }

  ok(msg: string): void {
    console.log(`  ${CHECKMARK} ${msg}`);
  }

  warn(msg: string): void {
    console.log(`  ${WARN} ${msg}`);
  }

  fail(msg: string): void {
    console.log(`  ${CROSS} ${msg}`);
  }

  info(msg: string): void {
    console.log(`  ${DIM}${msg}${RESET}`);
  }

  detail(label: string, value: string): void {
    console.log(`  ${DOT} ${DIM}${label}:${RESET} ${value}`);
  }

  count(label: string, passed: number, failed: number, total: number): void {
    const parts: string[] = [];
    if (passed > 0) parts.push(`${GREEN}${passed} ok${RESET}`);
    if (failed > 0) parts.push(`${RED}${failed} failed${RESET}`);
    const skipped = total - passed - failed;
    if (skipped > 0) parts.push(`${DIM}${skipped} skipped${RESET}`);
    console.log(`  ${ARROW} ${label}: ${parts.join(', ')} ${DIM}(${total} total)${RESET}`);
  }

  private stepDone(): void {
    const elapsed = Date.now() - this.stepStart;
    if (elapsed > 100) {
      console.log(`  ${DIM}└ ${elapsed}ms${RESET}`);
    }
  }

  ready(): void {
    if (this.currentStep) this.stepDone();
    const totalElapsed = ((Date.now() - this.totalStart) / 1000).toFixed(1);

    console.log('');
    console.log(`${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${BOLD}║                                                          ║${RESET}`);
    console.log(`${BOLD}║   ${GREEN}HIRAM daemon ready${RESET}${BOLD}   ${DIM}(${totalElapsed}s)${RESET}${BOLD}                         ║${RESET}`);
    console.log(`${BOLD}║                                                          ║${RESET}`);
    console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`);
    console.log('');
  }

  private progressBar(current: number, total: number): string {
    const width = 20;
    const filled = Math.round((current / total) * width);
    const empty = width - filled;
    const bar = `${GREEN}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
    const pct = Math.round((current / total) * 100);
    return `${DIM}[${RESET}${bar}${DIM}]${RESET} ${BOLD}${pct}%${RESET}  ${DIM}(${current}/${total})${RESET}`;
  }
}
