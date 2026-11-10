/**
 * 面板只读 API（B10，tech-plan §8.3 的 8 条 GET；契约 `docs/spec/contract-api.md`）。
 *
 * 五条边界：
 *  1. **只读、无副作用**：路由只调 `deps.queries`，不写库、不入队（契约 §8.3「面板不做任何写操作」）。
 *  2. **查询参数用契约的 `querySchemas` 校验**：schema 直接挂在路由上，Fastify 用 zod 编译器校验，
 *     不合法 → `{error:{code:'bad-request'}}` + 400（由 `errors.ts` 统一映射）。
 *  3. **响应用契约的 `responseSchemas` 序列化**：多出字段会被裁掉，少字段会暴露成错误，
 *     面板拿到的永远是契约形状。
 *  4. **鉴权是注入的 `requireAuth`**：401/403 语义在 `auth.ts`，OAuth 流程不在本切片。
 *  5. `Cache-Control: no-store` 只加在 `/api/*`（契约 §0），不影响 `/webhook` 与 `/healthz`。
 *
 * 取数一律经 `deps.queries`（E12 冻结的注入面）：http 不碰 SQL，也不 import `db/`。
 */
import {
  AUDIT_EXPORT_LIMIT,
  auditQuerySchema,
  auditResponseSchema,
  costsQuerySchema,
  costsResponseSchema,
  issueSessionParamsSchema,
  issueSessionResponseSchema,
  issuesListResponseSchema,
  issuesQuerySchema,
  overviewQuerySchema,
  overviewResponseSchema,
  qualityQuerySchema,
  revertsResponseSchema,
  systemResponseSchema,
  taskDetailResponseSchema,
  tasksQuerySchema,
  tasksResponseSchema,
} from '../../../../../packages/contract/src/index.ts';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../../../packages/shared/src/index.ts';
import type { RequireAuth } from './auth.ts';
import type { Queries } from './queries.ts';
import { httpError } from '../errors.ts';
import type { ZodFastify } from '../types.ts';

/** 装配 8 条读路由需要的东西：查询面 + 鉴权钩子（其余都从 contract 取）。 */
export type ApiDeps = {
  readonly queries: Queries;
  readonly requireAuth: RequireAuth;
  readonly logger?: Logger;
};

/** `/api/tasks/:id` 的路径参数。`shortIdSchema` 的长度上限是 64（`common.ts`）。 */
const taskIdParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();

/**
 * 注册全部面板读路由。
 *
 * 注意：**不**用 `app.register(..., {prefix:'/api'})`。`withTypeProvider` 的泛型不会穿过
 * 插件封装，路由文件就得自己重复 5 个泛型参数；用绝对路径换来「一处类型、处处可用」。
 */
export function registerApiRoutes(app: ZodFastify, deps: ApiDeps): void {
  /** 所有 `/api/*` 的公共前置：鉴权 + 禁止缓存。 */
  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await deps.requireAuth(request);
    reply.header('cache-control', 'no-store');
  };

  // ── 1. GET /api/overview ────────────────────────────────────────────────────
  app.get(
    '/api/overview',
    {
      schema: { querystring: overviewQuerySchema, response: { 200: overviewResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.overview(request.query),
  );

  // ── 2. GET /api/tasks ───────────────────────────────────────────────────────
  app.get(
    '/api/tasks',
    {
      schema: { querystring: tasksQuerySchema, response: { 200: tasksResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.tasks(request.query),
  );

  // ── 3. GET /api/tasks/:id ───────────────────────────────────────────────────
  app.get(
    '/api/tasks/:id',
    {
      schema: { params: taskIdParamsSchema, response: { 200: taskDetailResponseSchema } },
      preHandler: guard,
    },
    async (request) => {
      const detail = await deps.queries.taskDetail(request.params.id);
      if (detail === null) {
        // 查询层用 null 表示「没有这个任务」，404 的语义由 HTTP 层决定
        throw httpError('not-found', `任务不存在：${request.params.id}`);
      }
      return detail;
    },
  );

  // ── 4. GET /api/costs ───────────────────────────────────────────────────────
  app.get(
    '/api/costs',
    {
      schema: { querystring: costsQuerySchema, response: { 200: costsResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.costs(request.query),
  );

  // ── 5. GET /api/quality/reverts ─────────────────────────────────────────────
  app.get(
    '/api/quality/reverts',
    {
      schema: { querystring: qualityQuerySchema, response: { 200: revertsResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.reverts(request.query),
  );

  // ── 6. GET /api/audit ───────────────────────────────────────────────────────
  app.get(
    '/api/audit',
    {
      schema: { querystring: auditQuerySchema, response: { 200: auditResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.audit(request.query),
  );

  // ── 7. GET /api/audit/export.csv（流式导出，`text/csv`）─────────────────────
  app.get(
    '/api/audit/export.csv',
    {
      // 不声明 response schema：这是 CSV 不是 JSON（契约 §7）
      schema: { querystring: auditQuerySchema },
      preHandler: guard,
    },
    async (request, reply) => {
      // schema 已在路由上校验过；这里再 parse 一次只为拿到类型（`request.query` 在无 response schema
      // 的路由上会被推导成 unknown）
      const query = auditQuerySchema.parse(request.query);
      const csv = await deps.queries.auditCsv(query);
      const rows = countCsvRows(csv);
      reply.type('text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${auditFileName(query.from, query.to)}"`);
      if (rows >= AUDIT_EXPORT_LIMIT) {
        // 截断了就明说，不静默丢数据（契约 §7）
        reply.header('x-pi-bot-truncated', 'true');
      }
      // UTF-8 BOM：Excel 打开中文不乱码（契约 §7）
      return reply.send(`\uFEFF${csv}`);
    },
  );

  // ── 8. GET /api/system ──────────────────────────────────────────────────────
  app.get(
    '/api/system',
    {
      schema: { response: { 200: systemResponseSchema } },
      preHandler: guard,
    },
    async () => deps.queries.system(),
  );

  // ── 9. GET /api/issues（按 issue 聚合的列表，`lastActivityAt` 倒序 + keyset 游标）─────
  app.get(
    '/api/issues',
    {
      schema: { querystring: issuesQuerySchema, response: { 200: issuesListResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.issues(request.query),
  );

  // ── 10. GET /api/issues/:owner/:name/:kind/:number（一个 issue 的会话）─────────────
  // 路径是四段而不是 `:repo`：`repo` 含 `/`，`:repo` 会吞掉后面的段（spec §3.2 末段）。
  app.get(
    '/api/issues/:owner/:name/:kind/:number',
    {
      schema: { params: issueSessionParamsSchema, response: { 200: issueSessionResponseSchema } },
      preHandler: guard,
    },
    async (request) => {
      const { owner, name, kind, number } = request.params;
      const session = await deps.queries.issueSession({ owner, name, kind, number });
      if (session === null) {
        // 查询层用 null 表示「这条 issue 没有任何任务」，404 的语义由 HTTP 层决定
        throw httpError('not-found', `没有处理过这个 ${kind}：${owner}/${name}#${String(number)}`);
      }
      return session;
    },
  );
}

/** CSV 的数据行数（去掉表头与空行）；只用于判断是否达到导出口径。 */
export function countCsvRows(csv: string): number {
  const lines = csv.split(/\r?\n/u).filter((line) => line.trim() !== '');
  return Math.max(0, lines.length - 1);
}

/** `audit-<from>-<to>.csv`：文件名只留安全字符（来自查询参数，属外部输入）。 */
export function auditFileName(from: string | undefined, to: string | undefined): string {
  const clean = (value: string | undefined, fallback: string): string =>
    value === undefined || value === ''
      ? fallback
      : value.replace(/[^0-9A-Za-z._-]+/gu, '_').slice(0, 40);
  return `audit-${clean(from, 'all')}-${clean(to, 'now')}.csv`;
}
