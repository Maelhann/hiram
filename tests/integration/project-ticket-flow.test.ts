/**
 * Integration test: Project-per-product ticket flow.
 *
 * Makes REAL JIRA API calls. Requires JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 * in the environment.
 *
 * Tests the flow the Architect is expected to follow:
 *   1. Create a dedicated JIRA project for the product
 *   2. Create an Epic in that project
 *   3. Create Stories under the Epic with dependency ordering
 *   4. Verify ticket keys use the project prefix (TFLOW-1, not SCRUM-123)
 *   5. Verify hierarchy and dependency descriptions
 *   6. Clean up everything
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load JIRA credentials from .env (VAULT_ATLASSIAN_* vars) or process.env.
function loadJiraCreds(): { base: string; email: string; token: string } {
  // Try process.env first (set by daemon boot or CI).
  let email = process.env.JIRA_EMAIL || '';
  let token = process.env.JIRA_API_TOKEN || '';
  let base = process.env.JIRA_BASE_URL || '';

  if (!email || !token) {
    // Fall back to reading .env directly.
    try {
      const envPath = resolve(import.meta.dirname ?? '.', '../../.env');
      const envFile = readFileSync(envPath, 'utf-8');
      for (const line of envFile.split('\n')) {
        const m = line.match(/^(\w+)=(.+)$/);
        if (!m) continue;
        if (m[1] === 'VAULT_ATLASSIAN_EMAIL') email = m[2];
        if (m[1] === 'VAULT_ATLASSIAN_API_TOKEN') token = m[2];
        if (m[1] === 'VAULT_ATLASSIAN_SITE_URL') base = m[2];
      }
    } catch {}
  }

  return { base: base || 'https://yoursite.atlassian.net', email, token };
}

const creds = loadJiraCreds();

if (!creds.email || !creds.token) {
  describe.skip('Project ticket flow (no JIRA credentials)', () => {
    it('skipped', () => {});
  });
} else {

const JIRA_BASE = creds.base;
const JIRA_EMAIL = creds.email;
const JIRA_TOKEN = creds.token;

const AUTH = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`;

async function jira(path: string, opts: RequestInit = {}): Promise<unknown> {
  const url = `${JIRA_BASE}/rest/api/3${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: AUTH,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`JIRA ${res.status} ${opts.method ?? 'GET'} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Track everything we create for cleanup.
const createdIssues: string[] = [];
let createdProjectKey: string | null = null;

afterAll(async () => {
  // Delete issues in reverse order (children first).
  for (const key of [...createdIssues].reverse()) {
    try { await jira(`/issue/${key}`, { method: 'DELETE' }); } catch {}
  }
  // Permanently delete the project (enableUndo=false skips trash).
  if (createdProjectKey) {
    try { await jira(`/project/${createdProjectKey}?enableUndo=false`, { method: 'DELETE' }); } catch {}
  }
});

describe('Project-per-product ticket flow', () => {
  const PROJECT_KEY = 'TFLOW';
  const PROJECT_NAME = 'TestFlow Integration';

  it('should create a new JIRA project', async () => {
    // Get current user account ID for project lead.
    const me = await jira('/myself') as { accountId: string; displayName: string };
    expect(me.accountId).toBeTruthy();

    const result = await jira('/project', {
      method: 'POST',
      body: JSON.stringify({
        key: PROJECT_KEY,
        name: PROJECT_NAME,
        projectTypeKey: 'software',
        projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic',
        leadAccountId: me.accountId,
      }),
    }) as { key: string; id: string };

    expect(result.key).toBe(PROJECT_KEY);
    createdProjectKey = PROJECT_KEY;
    console.log(`Created project: ${result.key} (id: ${result.id})`);
  });

  let epicKey: string;

  it('should create an Epic in the new project', async () => {
    const result = await jira('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: PROJECT_KEY },
          issuetype: { name: 'Epic' },
          summary: '[TEST] Launch TestFlow MVP',
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Integration test epic — verifies project-per-product flow.' }] }],
          },
        },
      }),
    }) as { key: string };

    epicKey = result.key;
    createdIssues.push(epicKey);

    // Key must use the project prefix.
    expect(epicKey).toMatch(/^TFLOW-\d+$/);
    console.log(`Created Epic: ${epicKey}`);
  });

  let researchKey: string;
  let buildKey: string;
  let deployKey: string;
  let verifyKey: string;

  it('should create Stories under the Epic with dependency ordering', async () => {
    // Phase 1 — Research (no dependency)
    const research = await jira('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: PROJECT_KEY },
          issuetype: { name: 'Story' },
          summary: 'Research competitors and pricing models',
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Phase 1 — Research. No dependencies.' }] }],
          },
          priority: { name: 'Highest' },
          labels: ['warden:research'],
          parent: { key: epicKey },
        },
      }),
    }) as { key: string };
    researchKey = research.key;
    createdIssues.push(researchKey);
    expect(researchKey).toMatch(/^TFLOW-\d+$/);

    // Phase 2 — Build (depends on Research)
    const build = await jira('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: PROJECT_KEY },
          issuetype: { name: 'Story' },
          summary: 'Build TestFlow web application',
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `DEPENDS ON: ${researchKey} — do not start until that story is Done. Phase 2 — Build.` }] }],
          },
          priority: { name: 'High' },
          labels: ['warden:dev'],
          parent: { key: epicKey },
        },
      }),
    }) as { key: string };
    buildKey = build.key;
    createdIssues.push(buildKey);

    // Phase 3 — Deploy (depends on Build)
    const deploy = await jira('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: PROJECT_KEY },
          issuetype: { name: 'Story' },
          summary: 'Deploy TestFlow to production',
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `DEPENDS ON: ${buildKey} — do not start until that story is Done. Phase 3 — Deploy.` }] }],
          },
          priority: { name: 'High' },
          labels: ['warden:ops'],
          parent: { key: epicKey },
        },
      }),
    }) as { key: string };
    deployKey = deploy.key;
    createdIssues.push(deployKey);

    // Phase 4 — Verify (depends on Deploy)
    const verify = await jira('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: PROJECT_KEY },
          issuetype: { name: 'Story' },
          summary: 'QA testing with Playwright smoke tests',
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `DEPENDS ON: ${deployKey} — do not start until that story is Done. Phase 4 — Verify.` }] }],
          },
          priority: { name: 'Medium' },
          labels: ['warden:dev'],
          parent: { key: epicKey },
        },
      }),
    }) as { key: string };
    verifyKey = verify.key;
    createdIssues.push(verifyKey);

    console.log(`Created Stories: ${researchKey}, ${buildKey}, ${deployKey}, ${verifyKey}`);
    console.log(`All under Epic: ${epicKey}`);
  });

  it('should have all tickets with TFLOW prefix', () => {
    const allKeys = [epicKey, researchKey, buildKey, deployKey, verifyKey];
    for (const key of allKeys) {
      expect(key).toMatch(/^TFLOW-\d+$/);
    }
  });

  it('should verify parent-child hierarchy via GET', async () => {
    // Fetch each Story and verify its parent is the Epic.
    for (const storyKey of [researchKey, buildKey, deployKey, verifyKey]) {
      const issue = await jira(`/issue/${storyKey}?fields=parent,summary`) as {
        key: string;
        fields: { parent?: { key: string }; summary: string };
      };
      expect(issue.fields.parent?.key).toBe(epicKey);
    }
  });

  it('should verify dependency descriptions', async () => {
    // Build depends on Research
    const buildIssue = await jira(`/issue/${buildKey}?fields=description`) as {
      fields: { description: { content: { content: { text: string }[] }[] } };
    };
    const buildDesc = buildIssue.fields.description.content
      .flatMap(p => p.content.map(t => t.text)).join(' ');
    expect(buildDesc).toContain(`DEPENDS ON: ${researchKey}`);

    // Deploy depends on Build
    const deployIssue = await jira(`/issue/${deployKey}?fields=description`) as {
      fields: { description: { content: { content: { text: string }[] }[] } };
    };
    const deployDesc = deployIssue.fields.description.content
      .flatMap(p => p.content.map(t => t.text)).join(' ');
    expect(deployDesc).toContain(`DEPENDS ON: ${buildKey}`);

    // Verify depends on Deploy
    const verifyIssue = await jira(`/issue/${verifyKey}?fields=description`) as {
      fields: { description: { content: { content: { text: string }[] }[] } };
    };
    const verifyDesc = verifyIssue.fields.description.content
      .flatMap(p => p.content.map(t => t.text)).join(' ');
    expect(verifyDesc).toContain(`DEPENDS ON: ${deployKey}`);
  });

  it('should verify labels are set correctly', async () => {
    const check = async (key: string, expectedLabel: string) => {
      const issue = await jira(`/issue/${key}?fields=labels`) as {
        fields: { labels: string[] };
      };
      expect(issue.fields.labels).toContain(expectedLabel);
    };

    await check(researchKey, 'warden:research');
    await check(buildKey, 'warden:dev');
    await check(deployKey, 'warden:ops');
    await check(verifyKey, 'warden:dev');
  });

  it('should list the project and see our tickets via JQL', async () => {
    // Search for all issues in the project.
    const result = await jira('/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql: `project = ${PROJECT_KEY} ORDER BY created ASC`,
        maxResults: 20,
        fields: ['summary', 'issuetype', 'status', 'labels', 'parent'],
      }),
    }) as { issues: { key: string; fields: { issuetype: { name: string }; summary: string } }[] };

    expect(result.issues.length).toBe(5); // 1 Epic + 4 Stories

    const epic = result.issues.find(i => i.fields.issuetype.name === 'Epic');
    expect(epic).toBeDefined();
    expect(epic!.key).toBe(epicKey);

    const stories = result.issues.filter(i => i.fields.issuetype.name === 'Story');
    expect(stories.length).toBe(4);

    console.log('\nFinal board state:');
    for (const i of result.issues) {
      console.log(`  ${i.key} [${i.fields.issuetype.name}] ${i.fields.summary}`);
    }
  });
});

}
