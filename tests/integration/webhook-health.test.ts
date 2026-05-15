import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebhookServer } from '../../src/jira/webhook-server.js';

describe('WebhookServer Health Endpoint', () => {
  let webhookServer: WebhookServer;
  let port = 9999;

  beforeEach(async () => {
    webhookServer = new WebhookServer(port, null);
    await webhookServer.start();
  });

  afterEach(async () => {
    await webhookServer.stop();
  });

  describe('GET /health', () => {
    it('should return lightweight health check', async () => {
      const response = await makeRequest('http://localhost:9999/health', 'GET');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body.status).toBe('healthy');
      expect(body.version).toBe('0.1.0');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('responseTime');
    });

    it('should support detailed query parameter', async () => {
      const response = await makeRequest('http://localhost:9999/health?detailed=true', 'GET');

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('database');
      expect(body).toHaveProperty('dependencies');
      expect(body).toHaveProperty('checks');
      expect(body.database).toHaveProperty('status');
      expect(body.checks).toHaveProperty('databaseOk');
    });

    it('should return 404 for unknown endpoints', async () => {
      const response = await makeRequest('http://localhost:9999/unknown', 'GET');
      expect(response.statusCode).toBe(404);
    });

    it('should support dependency registration', async () => {
      webhookServer.registerDependencyCheck(
        'test-dependency',
        async () => {
          // success
        },
      );

      const response = await makeRequest('http://localhost:9999/health?detailed=true', 'GET');
      const body = JSON.parse(response.body);

      expect(body.dependencies).toContainEqual(
        expect.objectContaining({
          name: 'test-dependency',
          status: 'healthy',
        }),
      );
    });

    it('should handle dependency failures gracefully', async () => {
      webhookServer.registerDependencyCheck(
        'failing-dep',
        async () => {
          throw new Error('Service unavailable');
        },
      );

      const response = await makeRequest('http://localhost:9999/health?detailed=true', 'GET');
      const body = JSON.parse(response.body);

      expect(body.dependencies).toContainEqual(
        expect.objectContaining({
          name: 'failing-dep',
          status: 'degraded',
        }),
      );
    });
  });
});

function makeRequest(url: string, method: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}
