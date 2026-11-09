/**
 * Fastify 主实例装配（B10，tech-plan §8.2 的 `http/` 模块）。
 *
 * 这个文件只做「接线」，不含业务：webhook 管线在 `webhook.ts`，读接口在 `api/`，
 * 指标实例在 `metrics.ts`（**独立进程端口**，不在这里挂）。装配清单：
 *
 *  1. zod type provider（`validatorCompiler` / `serializerCompiler`）→ 路由 schema 用契约的 zod
 *  2. 统一错误映射（`errors.ts`）→ 所有 4xx/5xx 都是 `{error:{code,message,details?}}`
 *  3. `POST /webhook`（raw body，验签在 handler 里）
 *  4. 8 条 `/api/*` 只读路由（鉴权钩子注入）
 *  5. `/healthz`（DB ping + 队列探针 + doctor 摘要占位；失败 503）
 *  6. 可选 `/openapi.json`（`@fastify/swagger` 从 zod 生成）
 *  7. 请求级日志与 HTTP 直方图（`delivery_id` 走 webhook 的子 logger）
 *
 * **不**在这里做的事：`/metrics`（独立实例，见 `metrics.ts`）、worker 注册（`cli.ts serve`）、
 * doctor 的真实检查（W3 的 `doctor/`，用 `doctor` 注入点接进来）。
 */
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { CONTRACT_VERSION } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { ping } from '../db/index.ts';
import { registerApiRoutes } from './api/index.ts';
import type { ApiDeps } from './api/index.ts';
import { registerErrorHandling } from './errors.ts';
import type { Metrics } from './metrics.ts';
import { registerWebhookRoute } from './webhook.ts';
import type { WebhookDeps } from './webhook.ts';
import type { HealthCheck, HealthReport, ZodFastify } from './types.ts';

/** 应用版本（`/api/system` 的 `version.app` 与 `/healthz` 的 `app`）。 */
export const APP_VERSION = '0.1.0';

/** 健康检查项提供者（队列探针 / doctor 摘要）。同步或异步都行。 */
export type HealthProvider = () => Promise<readonly HealthCheck[]> | readonly HealthCheck[];

export type BuildServerDeps = {
  readonly logger: Logger;
  /** 给 `/healthz` 的 DB 探针与（默认的）面板会话校验用。 */
  readonly pool: Pool;
  /** 面板读查询（E12 注入；实现归 W2-H 的 `queries/`）。 */
  readonly queries: ApiDeps['queries'];
  readonly requireAuth: ApiDeps['requireAuth'];
  /** webhook 的全部依赖（验签 / 入队 / ack / db / logger）。 */
  readonly webhook: WebhookDeps;
  /** 不传则建一个内部的（`serve` 会传进来，测试也可以不传）。 */
  readonly metrics?: Metrics;
  readonly appVersion?: string;
  /** 请求体上限；默认 25 MB（契约 §9）。 */
  readonly bodyLimitBytes?: number;
  /** 是否暴露 `/openapi.json`（默认不暴露：生产由 Caddy 决定要不要给）。 */
  readonly openapi?: boolean;
  /** 队列可用性探针（`serve` 里用 pg-boss 实现；不注入 → `/healthz` 标 `skip`）。 */
  readonly queueHealth?: HealthProvider;
  /** doctor 摘要（W3 的 `doctor/`；不注入 → 标 `skip`，不是 fail）。 */
  readonly doctor?: HealthProvider;
  readonly now?: () => Date;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 汇总健康检查。
 *
 * 三档语义（与契约的 doctor 状态一致）：
 *  - `fail` → HTTP 503（Caddy/系统层据此摘流量）
 *  - `warn` → 200（还能服务，但需要人看一眼）
 *  - `ok` → 200
 *
 * `skip` **不**算失败：`doctor` 与队列探针是可选注入，没接上不代表系统坏了。
 */
export async function collectHealth(deps: BuildServerDeps): Promise<HealthReport> {
  const now = deps.now ?? ((): Date => new Date());
  const checks: HealthCheck[] = [];

  // 1. 数据库：往返耗时既是探针也是观测值
  try {
    const result = await ping(deps.pool);
    checks.push({
      id: 'db',
      status: result.latencyMs > 2000 ? 'warn' : 'ok',
      detail: `select 1 ${String(result.latencyMs)}ms`,
    });
  } catch (error) {
    checks.push({ id: 'db', status: 'fail', detail: describeError(error) });
  }

  // 2. 队列
  if (deps.queueHealth === undefined) {
    checks.push({ id: 'queue', status: 'skip', detail: '未注入队列探针' });
  } else {
    try {
      checks.push(...(await deps.queueHealth()));
    } catch (error) {
      checks.push({ id: 'queue', status: 'fail', detail: describeError(error) });
    }
  }

  // 3. doctor 摘要（占位：W3 的 doctor/ 接进来后就是真实检查项）
  if (deps.doctor === undefined) {
    checks.push({ id: 'doctor', status: 'skip', detail: 'doctor 未运行（W3 接入 doctor/）' });
  } else {
    try {
      checks.push(...(await deps.doctor()));
    } catch (error) {
      checks.push({ id: 'doctor', status: 'fail', detail: describeError(error) });
    }
  }

  const status: HealthReport['status'] = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'ok';

  return {
    status,
    app: deps.appVersion ?? APP_VERSION,
    generatedAt: now().toISOString(),
    checks,
  };
}

/**
 * 装配并返回主实例（**不** listen：由 `serve` 决定端口与停机顺序）。
 */
export function buildServer(deps: BuildServerDeps): ZodFastify {
  const now = deps.now ?? ((): Date => new Date());
  const requestStartedAt = new WeakMap<FastifyRequest, number>();

  const app = Fastify({
    // 日志走我们自己的门面（`@pi-issue-bot/shared`），不让 Fastify 再建一套 pino
    logger: false,
    // 3000 端口只被 Caddy 反代：`X-Forwarded-*` 由它给
    trustProxy: true,
    bodyLimit: deps.bodyLimitBytes ?? 25 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app, {
    warn: (fields, message) => {
      deps.logger.warn(fields, message);
    },
    error: (fields, message) => {
      deps.logger.error(fields, message);
    },
  });

  if (deps.openapi === true) {
    app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'pi-issue-bot 控制面 API',
          version: CONTRACT_VERSION,
          description: '由 zod（packages/contract）生成的 OpenAPI 文档；契约版本与 /api/system 的 version.contract 一致。',
        },
      },
      transform: jsonSchemaTransform,
    });
    app.get('/openapi.json', async () => app.swagger());
  }

  // ── 请求级观测：一条日志 + 一次直方图观测 ─────────────────────────────────
  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, performance.now());
  });
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    const durationMs = startedAt === undefined ? 0 : Math.round(performance.now() - startedAt);
    // delivery_id 是一级关联键（tech-plan §10.2）：webhook 请求把它带进日志
    const deliveryId = request.headers['x-github-delivery'];
    const route = request.routeOptions.url ?? request.url;
    deps.metrics?.observeHttp({
      method: request.method,
      route,
      status: reply.statusCode,
      durationMs,
    });
    deps.logger.info(
      {
        reqId: request.id,
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs,
        deliveryId: typeof deliveryId === 'string' ? deliveryId : undefined,
      },
      'http 请求完成',
    );
  });

  // ── 业务路由放进一个子作用域 ─────────────────────────────────────────────
  // 为什么不用 `app.get(...)` 直接挂在根实例上：`@fastify/swagger` 通过 `onRoute` 钩子收集路由，
  // 而钩子是**按作用域**生效的 —— 根实例上后注册的路由不会被 swagger 看到（实测只有 `/webhook`
  // 进了 openapi.json）。所以业务路由统一走 `app.register`，`/openapi.json` 才完整。
  app.register(async (scope) => {
    // ── /healthz（运维通道：不是 /api，所以不受面板鉴权约束）───────────────
    scope.get('/healthz', async (_request, reply) => {
      const report = await collectHealth({ ...deps, now });
      // 失败用 503：Caddy / systemd 只看状态码
      return reply.status(report.status === 'fail' ? 503 : 200).send(report);
    });

    // ── POST /webhook（唯一写入口，但只入队）──────────────────────────────
    registerWebhookRoute(scope.withTypeProvider<ZodTypeProvider>(), deps.webhook, {
      bodyLimitBytes: deps.bodyLimitBytes ?? 25 * 1024 * 1024,
    });

    // ── /api/*（8 条只读）────────────────────────────────────────────────
    // `scope` 的静态类型退回了默认 provider（泛型不穿过封装），但运行时 provider 与编译器都跟着实例走，
    // 所以这里显式 `withTypeProvider` 后再断言一次；路由文件因此只需要一份 `ZodFastify` 声明。
    registerApiRoutes(scope.withTypeProvider<ZodTypeProvider>() as unknown as ZodFastify, {
      queries: deps.queries,
      requireAuth: deps.requireAuth,
      logger: deps.logger,
    });
  });

  return app;
}
