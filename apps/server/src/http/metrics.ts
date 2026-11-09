/**
 * `/metrics`：**独立**的 prom-client 指标实例（B10，tech-plan §10.1 的 F10）。
 *
 * 硬约束（不是为了好看）：
 *  1. **独立实例 + 独立端口**（默认 `127.0.0.1:9464`）。`/metrics` 会暴露队列深度、容器数量、
 *     失败率，属于内网信息；它又必须「无条件可抓」（Prometheus 抓不到就是告警失灵），
 *     所以不能挂在需要面板鉴权的 3000 实例后面。
 *  2. **本实例只挂 `/metrics`**，不注册任何 `/api` 路由；3000 实例上也**不挂** `/metrics`。
 *     两边各有一个「不越界」的测试（`test/http-metrics.test.ts`）。
 *  3. registry 是**实例内**的，不是 prom-client 的全局单例：一个进程里造多个（测试、`serve` +
 *     `doctor` 同进程）不会因为「指标名重复注册」而抛错。
 *
 * 指标清单（tech-plan §10.1 第一行）：
 *  - 进程 CPU/内存 → `collectDefaultMetrics`
 *  - 队列深度 → `queue_depth{queue,state}`
 *  - HTTP 延迟直方图 → `http_request_duration_seconds{method,route,status}`
 *  - 429 计数 → `github_rate_limit_total{repo}`
 *  - 容器数量 → `containers`
 *  - 磁盘水位 → `disk_watermark_ratio`
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../../packages/shared/src/index.ts';

/** 指标名（面板/告警/文档引用同一份常量）。 */
export const METRIC_NAMES = {
  queueDepth: 'pi_bot_queue_depth',
  httpDuration: 'pi_bot_http_request_duration_seconds',
  httpRequests: 'pi_bot_http_requests_total',
  rateLimited: 'pi_bot_github_rate_limit_total',
  containers: 'pi_bot_containers',
  diskWatermark: 'pi_bot_disk_watermark_ratio',
} as const;

/** HTTP 延迟直方图分桶（秒）：队列场景 p95 目标 90s，但 HTTP 面必须毫秒级。 */
export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5] as const;

export type MetricLabels = Readonly<Record<string, string | number>>;

/** `Metrics`：只暴露「写指标」与「读文本」，不暴露 registry 之外的内部对象。 */
export type Metrics = {
  readonly registry: Registry;
  readonly contentType: string;
  /** Prometheus 文本格式（`/metrics` 的响应体）。 */
  text(): Promise<string>;
  /** 记一次 HTTP 请求（`server.ts` 的 onResponse 调它）。 */
  observeHttp(input: {
    readonly method: string;
    readonly route: string;
    readonly status: number;
    readonly durationMs: number;
  }): void;
  /** 记一次 GitHub 429（worker 的熔断计数与 `/metrics` 是两条独立通道，§10.1）。 */
  incRateLimited(repo?: string): void;
  setQueueDepth(queue: string, state: 'pending' | 'active' | 'retry' | 'failed', value: number): void;
  setContainers(value: number): void;
  /** 磁盘水位（0–1）；清理任务的输入也是它（plan §8.3 的 85% 阈值）。 */
  setDiskWatermark(ratio: number): void;
};

export type CreateMetricsOptions = {
  /** 默认采集 Node 进程指标。测试里建议关掉（会起定时器）。 */
  readonly defaultMetrics?: boolean;
  /** 自定义 registry（测试注入）。不传则新建。 */
  readonly registry?: Registry;
};

export function createMetrics(options: CreateMetricsOptions = {}): Metrics {
  const registry = options.registry ?? new Registry();

  if (options.defaultMetrics === true) {
    collectDefaultMetrics({ register: registry });
  }

  const httpRequests = new Counter({
    name: METRIC_NAMES.httpRequests,
    help: 'HTTP 请求总数（按方法/路由/状态）',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: METRIC_NAMES.httpDuration,
    help: 'HTTP 请求延迟（秒）',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });

  const queueDepth = new Gauge({
    name: METRIC_NAMES.queueDepth,
    help: 'pg-boss 队列深度（按队列与状态）',
    labelNames: ['queue', 'state'] as const,
    registers: [registry],
  });

  const rateLimited = new Counter({
    name: METRIC_NAMES.rateLimited,
    help: 'GitHub 429 次数',
    labelNames: ['repo'] as const,
    registers: [registry],
  });

  const containers = new Gauge({
    name: METRIC_NAMES.containers,
    help: '当前沙箱容器数量',
    registers: [registry],
  });

  const diskWatermark = new Gauge({
    name: METRIC_NAMES.diskWatermark,
    help: '磁盘水位（0–1，清理阈值见 plan §8.3）',
    registers: [registry],
  });

  return {
    registry,
    get contentType(): string {
      return registry.contentType;
    },
    text: () => registry.metrics(),
    observeHttp: (input) => {
      const labels = {
        method: input.method,
        route: input.route,
        status: String(input.status),
      };
      httpRequests.inc(labels);
      httpDuration.observe(labels, Math.max(0, input.durationMs) / 1000);
    },
    incRateLimited: (repo) => {
      rateLimited.inc({ repo: repo ?? 'unknown' });
    },
    setQueueDepth: (queue, state, value) => {
      queueDepth.set({ queue, state }, Math.max(0, value));
    },
    setContainers: (value) => {
      containers.set(Math.max(0, value));
    },
    setDiskWatermark: (ratio) => {
      diskWatermark.set(Math.min(1, Math.max(0, ratio)));
    },
  };
}

export type MetricsServerOptions = {
  readonly metrics: Metrics;
  /** 默认 `127.0.0.1`（F10：只监听 loopback）。 */
  readonly host?: string;
  /** 默认 9464；测试传 0 让内核分配。 */
  readonly port?: number;
  readonly logger?: Logger;
};

export type MetricsServer = {
  /** **独立**于主实例的 Fastify（只有 `/metrics` 一条路由）。 */
  readonly instance: FastifyInstance;
  readonly host: string;
  readonly port: number;
  listen(): Promise<{ readonly host: string; readonly port: number }>;
  close(): Promise<void>;
};

export const DEFAULT_METRICS_HOST = '127.0.0.1';
export const DEFAULT_METRICS_PORT = 9464;

/**
 * 建（但不监听）指标服务。
 *
 * 用 Fastify 而不是裸 `http.createServer`：只是想复用已经装好的依赖，不多引一个库；
 * 两条路由都不注册的事实由测试守（访问 `/api/overview` 必须是 404）。
 */
export function createMetricsServer(options: MetricsServerOptions): MetricsServer {
  const host = options.host ?? DEFAULT_METRICS_HOST;
  const port = options.port ?? DEFAULT_METRICS_PORT;
  const app = Fastify({
    // 指标端点的日志没有价值（每 15s 抓一次），只在 listen/close 时打
    logger: false,
    trustProxy: false,
  });

  app.get('/metrics', async (_request, reply) => {
    const text = await options.metrics.text();
    return reply.type(options.metrics.contentType).send(text);
  });

  return {
    instance: app,
    host,
    port,
    async listen() {
      await app.listen({ host, port });
      const address = app.server.address();
      const actual =
        typeof address === 'object' && address !== null
          ? { host: address.address, port: address.port }
          : { host, port };
      options.logger?.info({ host: actual.host, port: actual.port }, 'metrics 实例已监听（仅 loopback）');
      return actual;
    },
    async close() {
      await app.close();
    },
  };
}
