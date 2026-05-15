// ---------------------------------------------------------------------------
// Cloudflare Tools MCP Server — direct Cloudflare REST API access.
//
// Replaces the @cloudflare/mcp-server-cloudflare npm package which has
// auth issues (401 on KV/domains despite valid token).
//
// Auth: Bearer token from CLOUDFLARE_API_TOKEN env var.
// Account ID from CLOUDFLARE_ACCOUNT_ID env var.
//
// Covers: DNS, Zones, Workers, KV, R2, Pages, D1, Registrar.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const BASE = 'https://api.cloudflare.com/client/v4';

async function cf(path: string, opts: RequestInit = {}): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

const server = new McpServer({ name: 'cloudflare-tools', version: '1.0.0' });

// == Zones ================================================================

server.tool(
  'zones_list',
  'List all DNS zones in the account.',
  {},
  async () => {
    const result = await cf('/zones?per_page=50');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'zone_get',
  'Get details about a specific zone.',
  { zoneId: z.string().describe('Zone ID') },
  async ({ zoneId }) => {
    const result = await cf(`/zones/${zoneId}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == DNS Records ==========================================================

server.tool(
  'dns_list',
  'List DNS records for a zone.',
  {
    zoneId: z.string().describe('Zone ID'),
    type: z.string().optional().describe('Filter by record type (A, AAAA, CNAME, TXT, MX, etc.)'),
    name: z.string().optional().describe('Filter by record name'),
  },
  async ({ zoneId, type, name }) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (name) params.set('name', name);
    const result = await cf(`/zones/${zoneId}/dns_records?${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'dns_create',
  'Create a DNS record in a zone.',
  {
    zoneId: z.string().describe('Zone ID'),
    type: z.string().describe('Record type (A, AAAA, CNAME, TXT, MX, etc.)'),
    name: z.string().describe('Record name (e.g. "pulsecheck" for pulsecheck.example.com)'),
    content: z.string().describe('Record content (IP address, hostname, text value)'),
    proxied: z.boolean().optional().describe('Whether to proxy through Cloudflare (default: false)'),
    ttl: z.number().optional().describe('TTL in seconds (1 = auto)'),
    priority: z.number().optional().describe('Priority (for MX records)'),
  },
  async ({ zoneId, type, name, content, proxied, ttl, priority }) => {
    const body: Record<string, unknown> = { type, name, content };
    if (proxied !== undefined) body.proxied = proxied;
    if (ttl !== undefined) body.ttl = ttl;
    if (priority !== undefined) body.priority = priority;
    const result = await cf(`/zones/${zoneId}/dns_records`, {
      method: 'POST', body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'dns_update',
  'Update an existing DNS record.',
  {
    zoneId: z.string().describe('Zone ID'),
    recordId: z.string().describe('DNS record ID'),
    type: z.string().describe('Record type'),
    name: z.string().describe('Record name'),
    content: z.string().describe('Record content'),
    proxied: z.boolean().optional().describe('Proxy through Cloudflare'),
    ttl: z.number().optional().describe('TTL in seconds'),
  },
  async ({ zoneId, recordId, type, name, content, proxied, ttl }) => {
    const body: Record<string, unknown> = { type, name, content };
    if (proxied !== undefined) body.proxied = proxied;
    if (ttl !== undefined) body.ttl = ttl;
    const result = await cf(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'dns_delete',
  'Delete a DNS record.',
  {
    zoneId: z.string().describe('Zone ID'),
    recordId: z.string().describe('DNS record ID'),
  },
  async ({ zoneId, recordId }) => {
    const result = await cf(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == KV Storage ===========================================================

server.tool(
  'kv_list_namespaces',
  'List all KV namespaces in the account.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'kv_create_namespace',
  'Create a new KV namespace.',
  { title: z.string().describe('Namespace title') },
  async ({ title }) => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces`, {
      method: 'POST', body: JSON.stringify({ title }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'kv_list_keys',
  'List keys in a KV namespace.',
  {
    namespaceId: z.string().describe('KV namespace ID'),
    prefix: z.string().optional().describe('Key prefix filter'),
    limit: z.number().optional().describe('Max keys to return (default 1000)'),
  },
  async ({ namespaceId, prefix, limit }) => {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (limit) params.set('limit', String(limit));
    const result = await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/keys?${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'kv_get',
  'Get a value from a KV namespace.',
  {
    namespaceId: z.string().describe('KV namespace ID'),
    key: z.string().describe('Key name'),
  },
  async ({ namespaceId, key }) => {
    const url = `${BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'kv_put',
  'Write a value to a KV namespace.',
  {
    namespaceId: z.string().describe('KV namespace ID'),
    key: z.string().describe('Key name'),
    value: z.string().describe('Value to store'),
  },
  async ({ namespaceId, key, value }) => {
    const url = `${BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
    });
    if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${await res.text()}`);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  },
);

server.tool(
  'kv_delete',
  'Delete a key from a KV namespace.',
  {
    namespaceId: z.string().describe('KV namespace ID'),
    key: z.string().describe('Key name'),
  },
  async ({ namespaceId, key }) => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == R2 Storage ===========================================================

server.tool(
  'r2_list_buckets',
  'List all R2 buckets in the account.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/r2/buckets`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'r2_create_bucket',
  'Create a new R2 bucket.',
  { name: z.string().describe('Bucket name') },
  async ({ name }) => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/r2/buckets`, {
      method: 'POST', body: JSON.stringify({ name }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'r2_delete_bucket',
  'Delete an R2 bucket.',
  { name: z.string().describe('Bucket name') },
  async ({ name }) => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/r2/buckets/${name}`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == Workers ==============================================================

server.tool(
  'workers_list',
  'List all Worker scripts in the account.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'worker_get',
  'Get a Worker script content.',
  { name: z.string().describe('Worker script name') },
  async ({ name }) => {
    const url = `${BASE}/accounts/${ACCOUNT_ID}/workers/scripts/${name}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/javascript' },
    });
    if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'workers_domains_list',
  'List custom domains attached to Workers.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/workers/domains`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == Pages ================================================================

server.tool(
  'pages_list_projects',
  'List all Cloudflare Pages projects.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/pages/projects`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'pages_get_project',
  'Get details of a Pages project.',
  { name: z.string().describe('Project name') },
  async ({ name }) => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${name}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == D1 Database ==========================================================

server.tool(
  'd1_list_databases',
  'List all D1 databases in the account.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/d1/database`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'd1_query',
  'Execute a SQL query on a D1 database.',
  {
    databaseId: z.string().describe('D1 database ID'),
    sql: z.string().describe('SQL query'),
    params: z.array(z.string()).optional().describe('Query parameters'),
  },
  async ({ databaseId, sql, params }) => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/d1/database/${databaseId}/query`, {
      method: 'POST', body: JSON.stringify({ sql, params }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == Registrar ============================================================

server.tool(
  'registrar_list_domains',
  'List domains registered with Cloudflare Registrar.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/registrar/domains`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'registrar_get_domain',
  'Get details of a registered domain.',
  { domain: z.string().describe('Domain name (e.g. example.com)') },
  async ({ domain }) => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/registrar/domains/${domain}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == Tunnels ==============================================================

server.tool(
  'tunnels_list',
  'List all Cloudflare Tunnels.',
  {},
  async () => {
    const result = await cf(`/accounts/${ACCOUNT_ID}/cfd_tunnel`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// == Start ================================================================

const transport = new StdioServerTransport();
await server.connect(transport);

process.stdin.resume();
process.on('uncaughtException', (err) => {
  process.stderr.write(`[cloudflare-tools] uncaughtException: ${err.message}\n${err.stack}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[cloudflare-tools] unhandledRejection: ${reason}\n`);
});
