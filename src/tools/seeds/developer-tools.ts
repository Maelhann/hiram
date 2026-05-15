// ---------------------------------------------------------------------------
// Developer Tools MCP Server — shell access, Claude Code, git, filesystem.
//
// Public plugin — any worker can use it when the task calls for it.
// The Development Warden's workers use it heavily; other workers may use
// shell_exec or write_file occasionally for quick scripting.
//
// Seeded on boot by the plugin seeder.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const server = new McpServer({ name: 'developer-tools', version: '1.0.0' });

// -- Shell execution ---------------------------------------------------------

server.tool(
  'shell_exec',
  'Execute a shell command and return stdout/stderr. Use for builds, tests, installs, or any CLI operation. Commands run in the specified working directory. No timeout by default — commands run until completion.',
  {
    command: z.string().describe('The command to run (e.g. "npm test", "ls -la")'),
    cwd: z.string().optional().describe('Working directory (defaults to home)'),
  },
  async ({ command, cwd }) => {
    try {
      const { stdout, stderr } = await execFileAsync(
        'bash', ['-c', command],
        {
          cwd: cwd ?? process.env.HOME,
          timeout: 0, // no timeout
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env: { ...process.env },
        },
      );
      const output = [
        stdout ? `STDOUT:\n${stdout}` : '',
        stderr ? `STDERR:\n${stderr}` : '',
      ].filter(Boolean).join('\n\n');
      return { content: [{ type: 'text', text: output || '(no output)' }] };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string; code?: number };
      return { content: [{ type: 'text', text: `EXIT CODE: ${e.code ?? 'unknown'}\nSTDOUT:\n${e.stdout ?? ''}\nSTDERR:\n${e.stderr ?? ''}\n${e.message}` }] };
    }
  },
);

// -- Claude Code invocation --------------------------------------------------

server.tool(
  'run_claude_code',
  'Invoke Claude Code CLI to perform an engineering task. Claude Code will read/write files, run tests, and return its output. Use this for complex coding tasks that benefit from Claude Code\'s full capabilities (file editing, multi-file changes, test iteration). No timeout — runs until completion.',
  {
    prompt: z.string().describe('Detailed instructions for Claude Code — what to build, fix, or change'),
    cwd: z.string().describe('Working directory (the repo/project root)'),
  },
  async ({ prompt, cwd }) => {
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const chunks: string[] = [];
        const proc = spawn('claude', [
          '--print',
          '--dangerously-skip-permissions',
          prompt,
        ], {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
        proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));
        proc.on('close', (code) => {
          if (code === 0) resolve(chunks.join(''));
          else reject(new Error(`Claude Code exited with code ${code}\n${chunks.join('')}`));
        });
        proc.on('error', reject);
      });
      return { content: [{ type: 'text', text: result }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Claude Code error: ${(err as Error).message}` }] };
    }
  },
);

// -- Filesystem operations ---------------------------------------------------

server.tool(
  'read_file',
  'Read the contents of a file.',
  {
    path: z.string().describe('Absolute or relative file path'),
    cwd: z.string().optional().describe('Base directory for relative paths'),
  },
  async ({ path: filePath, cwd: baseCwd }) => {
    try {
      const resolved = baseCwd ? path.resolve(baseCwd, filePath) : path.resolve(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      return { content: [{ type: 'text', text: content }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error reading file: ${(err as Error).message}` }] };
    }
  },
);

server.tool(
  'write_file',
  'Write content to a file. Creates parent directories if needed.',
  {
    path: z.string().describe('Absolute or relative file path'),
    content: z.string().describe('File content to write'),
    cwd: z.string().optional().describe('Base directory for relative paths'),
  },
  async ({ path: filePath, content, cwd: baseCwd }) => {
    try {
      const resolved = baseCwd ? path.resolve(baseCwd, filePath) : path.resolve(filePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      return { content: [{ type: 'text', text: `Written ${content.length} bytes to ${resolved}` }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error writing file: ${(err as Error).message}` }] };
    }
  },
);

server.tool(
  'list_directory',
  'List files and directories at a path.',
  {
    path: z.string().describe('Directory path'),
    recursive: z.boolean().optional().describe('List recursively (default false)'),
  },
  async ({ path: dirPath, recursive }) => {
    try {
      if (recursive) {
        const results: string[] = [];
        async function walk(dir: string, prefix: string): Promise<void> {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            results.push(entry.isDirectory() ? `${rel}/` : rel);
            if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
          }
        }
        await walk(dirPath, '');
        return { content: [{ type: 'text', text: results.join('\n') || '(empty directory)' }] };
      }
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines = entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name);
      return { content: [{ type: 'text', text: lines.join('\n') || '(empty directory)' }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error listing directory: ${(err as Error).message}` }] };
    }
  },
);

// -- Git operations ----------------------------------------------------------

server.tool(
  'git_status',
  'Get the git status of a repository.',
  { cwd: z.string().describe('Repository path') },
  async ({ cwd }) => {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-b'], { cwd });
    return { content: [{ type: 'text', text: stdout || '(clean)' }] };
  },
);

server.tool(
  'git_diff',
  'Get the git diff (staged or unstaged changes).',
  {
    cwd: z.string().describe('Repository path'),
    staged: z.boolean().optional().describe('Show staged changes (default: unstaged)'),
  },
  async ({ cwd, staged }) => {
    const args = staged ? ['diff', '--cached'] : ['diff'];
    const { stdout } = await execFileAsync('git', args, { cwd });
    return { content: [{ type: 'text', text: stdout || '(no changes)' }] };
  },
);

server.tool(
  'git_log',
  'Get recent git commit history.',
  {
    cwd: z.string().describe('Repository path'),
    count: z.number().optional().describe('Number of commits (default 10)'),
  },
  async ({ cwd, count }) => {
    const { stdout } = await execFileAsync(
      'git', ['log', `--oneline`, `-n`, String(count ?? 10)],
      { cwd },
    );
    return { content: [{ type: 'text', text: stdout || '(no commits)' }] };
  },
);

server.tool(
  'git_clone',
  'Clone a git repository.',
  {
    url: z.string().describe('Repository URL'),
    dest: z.string().describe('Destination directory'),
    branch: z.string().optional().describe('Branch to clone (default: default branch)'),
  },
  async ({ url, dest, branch }) => {
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push(url, dest);
    const { stdout, stderr } = await execFileAsync('git', args);
    return { content: [{ type: 'text', text: `${stdout}\n${stderr}`.trim() }] };
  },
);

server.tool(
  'git_commit',
  'Stage all changes and create a commit.',
  {
    cwd: z.string().describe('Repository path'),
    message: z.string().describe('Commit message'),
  },
  async ({ cwd, message }) => {
    await execFileAsync('git', ['add', '-A'], { cwd });
    const { stdout } = await execFileAsync('git', ['commit', '-m', message], { cwd });
    return { content: [{ type: 'text', text: stdout }] };
  },
);

server.tool(
  'git_push',
  'Push the current branch to the remote.',
  {
    cwd: z.string().describe('Repository path'),
    set_upstream: z.boolean().optional().describe('Set upstream tracking (for new branches)'),
  },
  async ({ cwd, set_upstream }) => {
    const args = ['push'];
    if (set_upstream) args.push('--set-upstream', 'origin', 'HEAD');
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return { content: [{ type: 'text', text: `${stdout}\n${stderr}`.trim() }] };
  },
);

server.tool(
  'git_checkout',
  'Create or switch to a branch.',
  {
    cwd: z.string().describe('Repository path'),
    branch: z.string().describe('Branch name'),
    create: z.boolean().optional().describe('Create the branch if it doesn\'t exist'),
  },
  async ({ cwd, branch, create }) => {
    const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return { content: [{ type: 'text', text: `${stdout}\n${stderr}`.trim() }] };
  },
);

// -- GitHub (via gh CLI) -----------------------------------------------------

// GitHub operations: use shell_exec("gh repo create ...", "gh pr create ...", etc.)
// The gh CLI is available in the environment and handles argument quoting correctly.

// -- Start -------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.resume();
