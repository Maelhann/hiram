// ---------------------------------------------------------------------------
// MetricsTracker — records tool calls, agent spawns, and plugin invocations
// for test assertions.
// ---------------------------------------------------------------------------

export class MetricsTracker {
  toolCalls = new Map<string, number>();
  pluginInvocations = new Map<string, number>();
  workerSpawns = 0;
  wardenCreations = 0;
  pluginCreations = 0;

  /** Record a tool call. */
  recordToolCall(toolName: string): void {
    this.toolCalls.set(toolName, (this.toolCalls.get(toolName) ?? 0) + 1);
  }

  /** Record a plugin_invoke call. */
  recordPluginInvocation(pluginName: string, toolName: string): void {
    const key = `${pluginName}.${toolName}`;
    this.pluginInvocations.set(key, (this.pluginInvocations.get(key) ?? 0) + 1);
  }

  /** Record a run_worker call. */
  recordWorkerSpawn(): void {
    this.workerSpawns++;
  }

  /** Record a warden_create call. */
  recordWardenCreation(): void {
    this.wardenCreations++;
  }

  /** Record a plugin_create call. */
  recordPluginCreation(): void {
    this.pluginCreations++;
  }

  // -----------------------------------------------------------------------
  // Assertions
  // -----------------------------------------------------------------------

  assertToolCalled(name: string, opts: { min?: number; max?: number; exact?: number } = {}): void {
    const count = this.toolCalls.get(name) ?? 0;
    if (opts.exact !== undefined && count !== opts.exact) {
      throw new Error(`Expected ${name} to be called exactly ${opts.exact} times, got ${count}`);
    }
    if (opts.min !== undefined && count < opts.min) {
      throw new Error(`Expected ${name} to be called at least ${opts.min} times, got ${count}`);
    }
    if (opts.max !== undefined && count > opts.max) {
      throw new Error(`Expected ${name} to be called at most ${opts.max} times, got ${count}`);
    }
  }

  assertPluginInvoked(pluginDotTool: string, opts: { min?: number; max?: number; exact?: number } = {}): void {
    const count = this.pluginInvocations.get(pluginDotTool) ?? 0;
    if (opts.exact !== undefined && count !== opts.exact) {
      throw new Error(`Expected ${pluginDotTool} to be invoked exactly ${opts.exact} times, got ${count}`);
    }
    if (opts.min !== undefined && count < opts.min) {
      throw new Error(`Expected ${pluginDotTool} to be invoked at least ${opts.min} times, got ${count}`);
    }
    if (opts.max !== undefined && count > opts.max) {
      throw new Error(`Expected ${pluginDotTool} to be invoked at most ${opts.max} times, got ${count}`);
    }
  }

  assertWorkerSpawns(opts: { min?: number; max?: number; exact?: number } = {}): void {
    if (opts.exact !== undefined && this.workerSpawns !== opts.exact) {
      throw new Error(`Expected exactly ${opts.exact} worker spawns, got ${this.workerSpawns}`);
    }
    if (opts.min !== undefined && this.workerSpawns < opts.min) {
      throw new Error(`Expected at least ${opts.min} worker spawns, got ${this.workerSpawns}`);
    }
    if (opts.max !== undefined && this.workerSpawns > opts.max) {
      throw new Error(`Expected at most ${opts.max} worker spawns, got ${this.workerSpawns}`);
    }
  }

  // -----------------------------------------------------------------------
  // Reporting
  // -----------------------------------------------------------------------

  printSummary(): void {
    console.log('\n--- Metrics Summary ---');
    console.log(`  Worker spawns: ${this.workerSpawns}`);
    console.log(`  Warden creations: ${this.wardenCreations}`);
    console.log(`  Plugin creations: ${this.pluginCreations}`);
    if (this.toolCalls.size > 0) {
      console.log('  Tool calls:');
      for (const [name, count] of [...this.toolCalls.entries()].sort()) {
        console.log(`    ${name}: ${count}`);
      }
    }
    if (this.pluginInvocations.size > 0) {
      console.log('  Plugin invocations:');
      for (const [name, count] of [...this.pluginInvocations.entries()].sort()) {
        console.log(`    ${name}: ${count}`);
      }
    }
    console.log('');
  }

  /** Get distinct warden labels from plugin invocations that created issues. */
  getDistinctWardenLabels(): Set<string> {
    // This is tracked by the harness inspecting JIRA board state, not here.
    return new Set();
  }

  reset(): void {
    this.toolCalls.clear();
    this.pluginInvocations.clear();
    this.workerSpawns = 0;
    this.wardenCreations = 0;
    this.pluginCreations = 0;
  }
}
