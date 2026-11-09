/**
 * `http/` 内部的公共类型（B10）。
 *
 * 唯一的硬需求是 `ZodFastify`：`fastify-type-provider-zod` 是通过 `withTypeProvider<>()` 把
 * zod schema 接进路由泛型的，`app.register(...)` 里的 `scope` 会退回默认的 `FastifyInstance`。
 * 为了不让每个路由文件都自己写一遍那 5 个泛型参数，这里集中声明一次。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/** 带 zod type provider 的 Fastify 实例（`schema` 里可以放 zod，`request.query` 自动推导）。 */
export type ZodFastify = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** 健康检查里每一项的统一形状（`/healthz` 的响应体，不属面板契约）。 */
export type HealthCheck = {
  readonly id: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  /** 一句话说明（失败原因 / 观测值）；没有补充为 `null`。 */
  readonly detail: string | null;
};

/** `/healthz` 的响应体。`status='fail'` 时 HTTP 503（`/healthz` 是运维通道，不是 `/api`）。 */
export type HealthReport = {
  readonly status: 'ok' | 'warn' | 'fail';
  readonly app: string;
  readonly generatedAt: string;
  readonly checks: readonly HealthCheck[];
};
