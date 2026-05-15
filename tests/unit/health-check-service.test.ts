import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HealthCheckService } from '../../src/health-endpoint.js';

describe('HealthCheckService', () => {
  let healthService: HealthCheckService;

  beforeEach(() => {
    healthService = new HealthCheckService('1.0.0', null);
  });

  describe('getStatus', () => {
    it('should return lightweight health status', () => {
      const status = healthService.getStatus();
      expect(status).toHaveProperty('status');
      expect(status).toHaveProperty('timestamp');
      expect(status).toHaveProperty('version');
      expect(status).toHaveProperty('uptime');
      expect(status).toHaveProperty('responseTime');
      expect(status).toHaveProperty('systemMetrics');
    });

    it('should have healthy status by default', () => {
      const status = healthService.getStatus();
      expect(status.status).toBe('healthy');
    });

    it('should have correct version', () => {
      const status = healthService.getStatus();
      expect(status.version).toBe('1.0.0');
    });

    it('should have valid timestamp in ISO format', () => {
      const status = healthService.getStatus();
      expect(() => new Date(status.timestamp)).not.toThrow();
      expect(status.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should complete in less than 100ms', () => {
      const start = performance.now();
      healthService.getStatus();
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('getDetailedStatus', () => {
    it('should return detailed health status with database check', async () => {
      const status = await healthService.getDetailedStatus();
      expect(status).toHaveProperty('database');
      expect(status).toHaveProperty('dependencies');
      expect(status).toHaveProperty('checks');
    });

    it('should be healthy without database or dependencies', async () => {
      const status = await healthService.getDetailedStatus();
      expect(status.status).toBe('healthy');
    });

    it('should complete within 1 second', async () => {
      const start = performance.now();
      await healthService.getDetailedStatus();
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it('should handle registered dependencies', async () => {
      const mockDependency = vi.fn().mockResolvedValue(undefined);
      healthService.registerDependencyCheck({
        name: 'test-service',
        check: mockDependency,
      });

      const status = await healthService.getDetailedStatus();
      expect(status.dependencies).toHaveLength(1);
      expect(status.dependencies[0].name).toBe('test-service');
      expect(mockDependency).toHaveBeenCalled();
    });

    it('should be unhealthy when database is unhealthy', async () => {
      const mockDb = {
        prepare: () => ({
          get: () => {
            throw new Error('Database connection lost');
          },
        }),
      };

      const service = new HealthCheckService('1.0.0', mockDb as any);
      const status = await service.getDetailedStatus();
      expect(status.database.status).toBe('unhealthy');
      expect(status.checks.databaseOk).toBe(false);
    });
  });
});
