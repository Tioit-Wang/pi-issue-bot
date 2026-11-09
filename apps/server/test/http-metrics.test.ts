/**
 * `/metrics` 独立实例（tech-plan §10.1 F10）的测试。
 *
 * 两条硬要求都要有测试：
 *  1. 指标真的暴露得出来（Prometheus 文本格式、含约定的指标名）
 *  2. **独立实例只挂 `/metrics`**：`/api/*` 在它上面必须 404；主实例上 `/metrics` 也必须 404
 *     （后者在 `test/http-server.test.ts`）
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { DEFAULT_METRICS_HOST, DEFAULT_METRICS_PORT, METRIC_NAMES, createMetrics, createMetricsServer } from '../src/http/index.ts';
import type { MetricsServer } from '../src/http/index.ts';

const servers: MetricsServer[] = [];

afterAll(async () => {
  for (const server of servers) {
    await server.close();
  }
});

describe('prom-client 指标', () => {
  it('默认端口/地址符合 tech-plan §10.1（127.0.0.1:9464）', () => {
    expect(DEFAULT_METRICS_HOST).toBe('127.0.0.1');
    expect(DEFAULT_METRICS_PORT).toBe(9464);
  });

  it('写进去的数值出现在文本里（队列深度 / 429 / 容器 / 磁盘水位 / HTTP 直方图）', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.setQueueDepth('run-task', 'pending', 3);
    metrics.incRateLimited('acme/widgets');
    metrics.setContainers(2);
    metrics.setDiskWatermark(0.42);
    metrics.observeHttp({ method: 'GET', route: '/api/overview', status: 200, durationMs: 12 });

    const text = await metrics.text();
    expect(text).toContain(METRIC_NAMES.queueDepth);
    expect(text).toContain('pi_bot_queue_depth{queue="run-task",state="pending"} 3');
    expect(text).toContain(METRIC_NAMES.rateLimited);
    expect(text).toContain('pi_bot_github_rate_limit_total{repo="acme/widgets"} 1');
    expect(text).toContain('pi_bot_containers 2');
    expect(text).toContain('pi_bot_disk_watermark_ratio 0.42');
    expect(text).toContain(METRIC_NAMES.httpDuration);
    expect(text).toContain('pi_bot_http_requests_total{method="GET",route="/api/overview",status="200"} 1');
  });

  it('每个实例有自己的 registry（并发建多个不会因重名注册而抛错）', () => {
    expect(() => {
      createMetrics({ defaultMetrics: false });
      createMetrics({ defaultMetrics: false });
    }).not.toThrow();
  });
});

describe('独立的 metrics 实例', () => {
  it('GET /metrics → 200 + Prometheus 文本', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.setContainers(1);
    const server = createMetricsServer({ metrics, host: '127.0.0.1', port: 0, logger: createNullLogger() });
    servers.push(server);
    const bound = await server.listen();

    const response = await fetch(`http://127.0.0.1:${String(bound.port)}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('pi_bot_containers 1');
  });

  it('不挂任何 /api 路由（403/404，绝不 200）', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    const server = createMetricsServer({ metrics, host: '127.0.0.1', port: 0 });
    servers.push(server);
    const bound = await server.listen();

    for (const path of ['/api/overview', '/api/tasks', '/healthz', '/webhook']) {
      const response = await fetch(`http://127.0.0.1:${String(bound.port)}${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});
