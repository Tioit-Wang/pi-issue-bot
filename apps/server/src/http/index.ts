/**
 * `http/` 的公共出口（B10）。`cli.ts serve` 与 `test/*` 只从这里取。
 *
 * 分工：
 *  - `server.ts` —— `buildServer(deps)`：主 Fastify 实例（3000 端口）
 *  - `webhook.ts` —— 九步管线 + `POST /webhook` 注册 + `replay` 复用入口
 *  - `api/` —— 8 条 `/api/*` 只读路由 + 鉴权注入点 + 查询层注入形状（E12）
 *  - `metrics.ts` —— **独立** prom-client 实例（`127.0.0.1:9464`，不挂 `/api`）
 *  - `errors.ts` —— 统一错误映射（契约 §0.1）
 *  - `types.ts` —— `ZodFastify` / `/healthz` 响应类型
 */
export { APP_VERSION, buildServer, collectHealth } from './server.ts';
export type { BuildServerDeps, HealthProvider } from './server.ts';

export {
  COMMAND_MENTION_PATTERN,
  extractFreeQuestion,
  decodeFreeQuestion,
  encodeFreeQuestion,
  FREE_MENTION_PREFIX,
  ISSUE_ACTIONS,
  WEBHOOK_HEADERS,
  WEBHOOK_SQL,
  checkCommandGate,
  createGithubWebhookAck,
  createOctokitVerifier,
  createQueueEnqueuer,
  decideWebhookTask,
  extractCommand,
  handleWebhook,
  idempotencyKeyFor,
  issueVersionHash,
  registerWebhookRoute,
  replayDelivery,
} from './webhook.ts';
export type {
  CommandGateResult,
  TaskEnqueuer,
  WebhookAck,
  WebhookDecision,
  WebhookDeps,
  WebhookInput,
  WebhookResult,
  WebhookRouteOptions,
  WebhookTaskPlan,
  WebhookVerify,
} from './webhook.ts';

export { auditFileName, countCsvRows, registerApiRoutes } from './api/index.ts';
export type { ApiDeps } from './api/index.ts';
export type { Queries } from './api/queries.ts';
// 查询参数/响应类型从 E12 的唯一出口转出（`queries/index.ts`），http 侧不再手抄一份
export type {
  AuditQuery,
  AuditResponse,
  CostsQuery,
  CostsResponse,
  OverviewQuery,
  OverviewResponse,
  QualityQuery,
  RevertsResponse,
  SystemResponse,
  TaskDetailResponse,
  TasksQuery,
  TasksResponse,
} from '../queries/index.ts';
export {
  PANEL_SESSION_COOKIE,
  PANEL_SESSION_SQL,
  createAllowAllAuth,
  createSessionAuth,
  readCookie,
} from './api/auth.ts';
export type { AuthContext, CreateSessionAuthDeps, RequireAuth, SessionStore } from './api/auth.ts';

export { DEFAULT_METRICS_HOST, DEFAULT_METRICS_PORT, HTTP_DURATION_BUCKETS, METRIC_NAMES, createMetrics, createMetricsServer } from './metrics.ts';
export type { CreateMetricsOptions, Metrics, MetricsServer, MetricsServerOptions } from './metrics.ts';

export { HttpError, errorBodyOf, httpError, mapErrorToResponse, registerErrorHandling, statusOfCode } from './errors.ts';
export type { ErrorDetails, MappedError } from './errors.ts';

export type { HealthCheck, HealthReport, ZodFastify } from './types.ts';
