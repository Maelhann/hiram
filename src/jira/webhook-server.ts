import http from 'node:http';
import { URL } from 'node:url';
import type { JiraWebhookPayload, JiraWebhookEventType } from '../types/jira.js';
import { HealthCheckService, type HealthCheckResponse, type DetailedHealthCheckResponse } from '../health-endpoint.js';
import type Database from 'better-sqlite3';

export type WebhookHandler = (payload: JiraWebhookPayload) => Promise<void>;

export class WebhookServer {
  private server: http.Server | null = null;
  private handlers = new Map<string, WebhookHandler[]>();
  private healthService: HealthCheckService;

  constructor(
    private port: number,
    db: Database.Database | null = null,
  ) {
    this.healthService = new HealthCheckService('0.1.0', db);
  }

  on(event: JiraWebhookEventType | '*', handler: WebhookHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerDependencyCheck(name: string, check: () => Promise<void>): void {
    this.healthService.registerDependencyCheck({ name, check });
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/health')) {
        await this.handleHealthCheck(req, res);
        return;
      }

      // Prometheus scrape endpoint.
      if (req.method === 'GET' && req.url?.startsWith('/metrics/prometheus')) {
        if (this.telemetry) {
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(this.telemetry.toPrometheus());
        } else {
          res.writeHead(503);
          res.end('# Telemetry not available\n');
        }
        return;
      }

      // JSON metrics endpoint.
      if (req.method === 'GET' && req.url?.startsWith('/metrics')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (this.telemetry) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(this.telemetry.handleMetricsRequest(url));
        } else {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'Telemetry not available' }));
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/webhook/jira') {
        await this.handleWebhook(req, res);
        return;
      }

      // Dynamic event listener webhooks (e.g. /events/stripe, /events/github).
      if (req.method === 'POST' && req.url?.startsWith('/events/') && this.eventBus) {
        // Verify relay secret on protected paths (seeded relay endpoints).
        // Dynamically created listeners are NOT protected — agents can register
        // new webhook paths without needing to redeploy the relay function.
        if (this.relaySecret && this.relayProtectedPaths.has(req.url)) {
          const provided = req.headers['x-relay-secret'];
          if (provided !== this.relaySecret) {
            this.telemetry?.inc('webhook.relay_auth_failures');
            res.writeHead(401);
            res.end('Unauthorized');
            return;
          }
        }

        try {
          const body = await readBody(req);
          const payload = JSON.parse(body);
          const handled = await this.eventBus.handleWebhook(req.url, payload);
          res.writeHead(handled ? 200 : 404);
          res.end(handled ? 'OK' : 'No listener for this path');
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => {
        console.log(`Webhook server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleHealthCheck(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const start = performance.now();
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const isDetailed = url.searchParams.get('detailed') === 'true';

    try {
      let health: HealthCheckResponse | DetailedHealthCheckResponse;

      if (isDetailed) {
        health = await this.healthService.getDetailedStatus();
      } else {
        health = this.healthService.getStatus();
      }

      const elapsed = performance.now() - start;

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(health));

      if (elapsed > 100 && !isDetailed) {
        console.warn(`Health check took ${elapsed.toFixed(2)}ms (target: <100ms)`);
      }
      if (elapsed > 1000 && isDetailed) {
        console.warn(`Detailed health check took ${elapsed.toFixed(2)}ms (target: <1000ms)`);
      }
    } catch (err) {
      console.error('Health check error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'unhealthy',
        error: err instanceof Error ? err.message : 'Unknown error',
      }));
    }
  }

  private async handleWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body) as JiraWebhookPayload;

      res.writeHead(200);
      res.end();

      await this.dispatch(payload);
    } catch (err) {
      console.error('Webhook parse error:', err);
      res.writeHead(400);
      res.end('Bad request');
    }
  }

  private telemetry?: import('../telemetry/collector.js').TelemetryCollector;
  private eventBus?: import('../events/bus.js').EventBus;
  private relaySecret?: string;
  private relayProtectedPaths = new Set<string>();

  setTelemetry(tel: import('../telemetry/collector.js').TelemetryCollector): void {
    this.telemetry = tel;
  }

  setEventBus(bus: import('../events/bus.js').EventBus): void {
    this.eventBus = bus;
  }

  /**
   * Set the shared secret for authenticating relay → HIRAM webhook forwarding.
   * Only paths in `protectedPaths` require the secret. Dynamically created
   * listeners (by agents at runtime) are not protected, allowing fully
   * autonomous webhook registration without redeploying the relay function.
   */
  setRelaySecret(secret: string, protectedPaths: string[]): void {
    this.relaySecret = secret;
    this.relayProtectedPaths = new Set(protectedPaths);
  }

  private async dispatch(payload: JiraWebhookPayload): Promise<void> {
    const event = payload.webhookEvent;
    this.telemetry?.inc('webhook.events');
    this.telemetry?.inc(`webhook.events_by_type.${event}`);

    const t0 = Date.now();

    const specific = this.handlers.get(event) ?? [];
    const wildcard = this.handlers.get('*') ?? [];

    const all = [...specific, ...wildcard];
    for (const handler of all) {
      try {
        await handler(payload);
      } catch (err) {
        this.telemetry?.inc('webhook.errors');
        console.error(`Webhook handler error for ${event}:`, err);
      }
    }

    this.telemetry?.record('webhook.processing_ms', Date.now() - t0);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
