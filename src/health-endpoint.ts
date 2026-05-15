import { performance } from 'node:perf_hooks';
import os from 'node:os';
import type Database from 'better-sqlite3';

export interface SystemMetrics {
  memory: {
    used: number;
    total: number;
    usedPercent: number;
  };
  cpu?: {
    usage: number;
  };
}

export interface DatabaseHealthCheck {
  status: 'healthy' | 'unhealthy';
  responseTime: number;
  error?: string;
}

export interface DependencyCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime: number;
  error?: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  responseTime: number;
  systemMetrics: SystemMetrics;
}

export interface DetailedHealthCheckResponse extends HealthCheckResponse {
  database: DatabaseHealthCheck;
  dependencies: DependencyCheck[];
  checks: {
    memoryOk: boolean;
    responseTimeOk: boolean;
    databaseOk: boolean;
    allDependenciesOk: boolean;
  };
}

export interface DependencyCheckFn {
  name: string;
  check: () => Promise<void>;
}

export class HealthCheckService {
  private startTime: number;
  private dependencyChecks: DependencyCheckFn[] = [];

  constructor(
    private version: string,
    private db: Database.Database | null = null,
  ) {
    this.startTime = performance.now();
  }

  registerDependencyCheck(check: DependencyCheckFn): void {
    this.dependencyChecks.push(check);
  }

  getStatus(): HealthCheckResponse {
    const checkStart = performance.now();
    const systemMetrics = this.collectSystemMetrics();
    const responseTime = performance.now() - checkStart;

    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: this.version,
      uptime: this.getUptimeSeconds(),
      responseTime: Math.round(responseTime * 100) / 100,
      systemMetrics,
    };
  }

  async getDetailedStatus(): Promise<DetailedHealthCheckResponse> {
    const checkStart = performance.now();
    const baseStatus = this.getStatus();
    const systemMetrics = baseStatus.systemMetrics;
    const databaseCheck = await this.checkDatabase();

    const dependencyPromises = this.dependencyChecks.map((dep) =>
      this.checkDependency(dep).catch((err) => ({
        name: dep.name,
        status: 'unhealthy' as const,
        responseTime: 500,
        error: err instanceof Error ? err.message : String(err),
      })),
    );

    const dependencies = await Promise.all(dependencyPromises);
    const responseTime = Math.round((performance.now() - checkStart) * 100) / 100;

    const memoryOk = systemMetrics.memory.usedPercent < 95;
    const responseTimeOk = responseTime < 1000;
    const databaseOk = databaseCheck.status === 'healthy';
    const allDependenciesOk = dependencies.every((d) => d.status === 'healthy');

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (!responseTimeOk || !memoryOk) {
      status = 'degraded';
    }
    if (!databaseOk || !allDependenciesOk) {
      status = 'unhealthy';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      version: this.version,
      uptime: this.getUptimeSeconds(),
      responseTime,
      systemMetrics,
      database: databaseCheck,
      dependencies,
      checks: {
        memoryOk,
        responseTimeOk,
        databaseOk,
        allDependenciesOk,
      },
    };
  }

  private async checkDatabase(): Promise<DatabaseHealthCheck> {
    if (!this.db) {
      return {
        status: 'healthy',
        responseTime: 0,
      };
    }

    const start = performance.now();
    try {
      const result = this.db
        .prepare('SELECT 1 as status')
        .get() as Record<string, unknown> | undefined;

      const responseTime = Math.round((performance.now() - start) * 100) / 100;

      if (result && result.status === 1) {
        return {
          status: 'healthy',
          responseTime,
        };
      }

      return {
        status: 'unhealthy',
        responseTime,
        error: 'Database query returned unexpected result',
      };
    } catch (err) {
      const responseTime = Math.round((performance.now() - start) * 100) / 100;
      return {
        status: 'unhealthy',
        responseTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkDependency(
    dep: DependencyCheckFn,
  ): Promise<DependencyCheck> {
    const start = performance.now();

    try {
      await Promise.race([
        dep.check(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Dependency check timeout')), 500),
        ),
      ]);

      const responseTime = Math.round((performance.now() - start) * 100) / 100;

      return {
        name: dep.name,
        status: 'healthy',
        responseTime,
      };
    } catch (err) {
      const responseTime = Math.round((performance.now() - start) * 100) / 100;
      return {
        name: dep.name,
        status: 'degraded',
        responseTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getUptimeSeconds(): number {
    const elapsedMs = performance.now() - this.startTime;
    return Math.round(elapsedMs / 1000);
  }

  private collectSystemMetrics(): SystemMetrics {
    const memoryMetrics = this.getMemoryMetrics();
    const cpuMetrics = this.getCpuMetrics();

    return {
      memory: memoryMetrics,
      ...(cpuMetrics && { cpu: cpuMetrics }),
    };
  }

  private getMemoryMetrics(): SystemMetrics['memory'] {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return {
      used: Math.round(usedMemory / 1024 / 1024),
      total: Math.round(totalMemory / 1024 / 1024),
      usedPercent: Math.round((usedMemory / totalMemory) * 100),
    };
  }

  private getCpuMetrics(): SystemMetrics['cpu'] | undefined {
    try {
      const cpuUsage = process.cpuUsage();
      const totalCpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
      const uptimeMs = performance.now() - this.startTime;
      const cpuPercent = Math.min(100, Math.round((totalCpuMs / uptimeMs) * 100));

      return { usage: cpuPercent };
    } catch {
      return undefined;
    }
  }
}

export const HealthChecker = HealthCheckService;
