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
  deliveriesQuerySchema,
  deliveriesResponseSchema,
  issueSessionParamsSchema,
  issueSessionResponseSchema,
  issueTraceResponseSchema,
  issuesListResponseSchema,
  issuesQuerySchema,
  loginSchema,
  overviewQuerySchema,
  overviewResponseSchema,
  qualityQuerySchema,
  repoFullNameSchema,
  repoSettingsResponseSchema,
  repoSettingsSchema,
  reposResponseSchema,
  revertsResponseSchema,
  systemQuerySchema,
  systemResponseSchema,
  taskDetailResponseSchema,
  tasksQuerySchema,
  tasksResponseSchema,
} from '../../../../../packages/contract/src/index.ts';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../../../packages/shared/src/index.ts';
import type { RepoSettingsResponse } from '../../../../../packages/contract/src/index.ts';
import { listRepos, readRepoPolicy, updateRepoSettings, upsertRepo, validateRepoSettings } from '../../config/repo-config.ts';
import type { RepoPolicy, SqlRunner } from '../../config/repo-config.ts';
import { verifyCommentRoleMembers } from '../../config/comment-members.ts';
import type { GithubUserLookup } from '../../config/comment-members.ts';
import type { RequireAuth } from './auth.ts';
import type { Queries } from './queries.ts';
import type { SkillStore } from '../../skills/store.ts';
import { createApiGuards, registerSkillRoutes } from './skills.ts';
import type { SkillWriteMode } from './skills.ts';
import { registerSettingsRoutes } from './settings.ts';
import type { SettingsApiDeps } from './settings.ts';
import { httpError } from '../errors.ts';
import type { ZodFastify } from '../types.ts';

/** 写入依赖（读接口只要 `queries`）。 */
export type ApiWriteWiring = {
  /** 真实实现是 `pg.Pool`，测试实现是几行假函数。 */
  readonly db: SqlRunner;
  /** AES-256 的 32 字节密钥（供应商 key 与个人 PAT 的加解密）。 */
  readonly secretKey: Uint8Array;
  /** 供应商连通性探测；不注入 → `/check` 明确 503。 */
  readonly providerProbe?: SettingsApiDeps['providerProbe'];
  /** 个人身份探测（`GET /user` 读 scope 与过期时间）。 */
  readonly identityProbe: SettingsApiDeps['identityProbe'];
  /** 写面策略（与 `/api/skills` 的写面同一份口径）；缺省 `loopback`。 */
  readonly writeMode?: SkillWriteMode;
};

/** 技能写面的依赖（不注入 = 技能接口整体不挂载，`serve` 一定注入）。 */
export type SkillApiWiring = {
  readonly store: SkillStore;
  readonly writeMode?: SkillWriteMode;
};

/**
 * 仓库写面（`/api/repos/*`）的依赖：只用来读写 `repos` 表。
 *
 * 与只读查询面（`queries`）分开注入是有意的：面板的 8 条只读接口不该有能力改配置。
 * **不注入 = 这组路由整体不挂载**（`serve` 传 `{ db: pool }`），这样老的装配与单测不用改。
 */
export type RepoApiWiring = {
  /** 真实实现是 `pg.Pool`，测试实现是几行假函数。 */
  readonly db: SqlRunner;
  /**
   * GitHub 账号查询端口（`GET /users/{login}`）：保存配置时用它**校验角色成员存在**并把 login 换成 id
   * （需求 §6.6 的两个坑）。
   *
   * 不注入 = 本部署没有 GitHub 凭据：带「指定成员」角色的配置会被**拒绝保存**（503 + 原因），
   * 不做静默放行——放行的后果正是「拼错一个字母，那个人永远触发不了且没有任何报错」。
   */
  readonly users?: GithubUserLookup | undefined;
};

/**
 * 装配面板路由需要的东西：查询面 + 鉴权钩子 + （可选）技能写面 + （可选）仓库写面。
 * 其余都从 contract 取。
 */
export type ApiDeps = {
  readonly queries: Queries;
  readonly requireAuth: RequireAuth;
  readonly logger?: Logger;
  readonly skills?: SkillApiWiring;
  readonly repos?: RepoApiWiring;
  /** 全局设置（供应商 / 模型角色 / 面板身份）；不注入这组路由就整组不存在。 */
  readonly settings?: ApiWriteWiring;
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

  // ── 8. GET /api/system（`?repo=` 只收窄 repos / flags 两段）────────────────────
  app.get(
    '/api/system',
    {
      schema: { querystring: systemQuerySchema, response: { 200: systemResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.system(request.query),
  );

  // ── 9. GET /api/issues（按 issue 聚合的列表，`lastActivityAt` 倒序 + keyset 游标）─────
  // 响应里带 `reactionState` / `labelDecisions` / `feedback`：形状由契约 `issueListItemSchema` 决定，
  // OpenAPI 一条链已经覆盖它，路由侧不需要额外的 schema。
  app.get(
    '/api/issues',
    {
      schema: { querystring: issuesQuerySchema, response: { 200: issuesListResponseSchema } },
      preHandler: guard,
    },
    async (request) => deps.queries.issues(request.query),
  );

  // ── 10. GET /api/issues/:owner/:name/:kind/:number（一个 issue 的会话）───────────
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

  // ── 11. /api/repos（仓库配置写面：列表 / 读 settings / 写 settings / 手动添加）────────
  // 不注入 `deps.repos` 就不挂载：老的装配与只读测试不需要 `repos` 表的写权限。
  if (deps.repos !== undefined) {
    registerRepoRoutes(app, deps.repos, guard);
  }

  // ── 12. /api/skills（技能管理：读 3 条 + 写 5 条，写面带 CSRF/来源校验）─────────
  // 不注入 `deps.skills` 就不挂载：读路由的测试与最小装配不需要建技能存储。
  if (deps.skills !== undefined) {
    registerSkillRoutes(app, {
      store: deps.skills.store,
      requireAuth: deps.requireAuth,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.skills.writeMode === undefined ? {} : { writeMode: deps.skills.writeMode }),
    });
  }

  // ── 13. GET /api/repos/:owner/:name/deliveries（BR-6：未触发的投递也要能查到原因）──
  // 为什么走这里而不是 `/api/audit`：这条链路回答的是「**投递**有没有进判定、没进的原因」，
  // 数据源是 `webhook_deliveries`（判定留痕），与 `actions` 为骨架的审计是两套事实。
  // 路径是 `:owner/:name` 两段而不是 `:repo`：`repo` 含 `/`，`:repo` 会吞掉后面的段。
  // 只挂在「查询面」上（`deps.queries`），不依赖 `deps.repos`：读留痕不需要仓库写权限。
  app.get(
    '/api/repos/:owner/:name/deliveries',
    {
      schema: {
        params: repoParamsSchema,
        querystring: deliveriesQuerySchema,
        response: { 200: deliveriesResponseSchema },
      },
      preHandler: guard,
    },
    async (request) =>
      deps.queries.deliveries(
        { repo: `${request.params.owner}/${request.params.name}` },
        request.query,
      ),
  );

  // ── 14. GET /api/issues/:owner/:name/:kind/:number/trace（一个 issue 的完整链路）──
  // 「投递 → 判定 → 执行 → 写回」四段一次给全（FR-6.4③ + FR-6.1/6.2/6.3 + NFR-6）。
  // 为什么入口是 issue 而不是 taskId：运维手里只有 issue 号；按 taskId 查要先翻一次列表，
  // 回放一个早期 issue 时链路就断了。
  // 路径四段而不是 `:repo`：`repo` 含 `/`，`:repo` 会吞掉后面的段（同第 10 条）。
  // 不存在时不 404：投递可能存在（被闸门拦下、没入队），空数组表达「查到但为空」。
  app.get(
    '/api/issues/:owner/:name/:kind/:number/trace',
    {
      schema: { params: issueSessionParamsSchema, response: { 200: issueTraceResponseSchema } },
      preHandler: guard,
    },
    async (request) => {
      const { owner, name, kind, number } = request.params;
      return deps.queries.issueTrace({ owner, name, kind, number });
    },
  );

  // ── 15. /api/settings/*（供应商 / 模型角色 / 面板身份；需求 §6.8、§6.9）──────────
  // 不注入 `deps.settings` 就不挂载：只读测试不需要密钥与探测端口。写面**必须**过写守卫
  // （鉴权 + PI_BOT_PANEL_WRITE + 来源 + X-Pi-Bot-CSRF）——它改的是模型端点、key 与人身份。
  if (deps.settings !== undefined) {
    const { writeGuard } = createApiGuards({
      requireAuth: deps.requireAuth,
      ...(deps.settings.writeMode === undefined ? {} : { writeMode: deps.settings.writeMode }),
    });
    registerSettingsRoutes(
      app,
      {
        db: deps.settings.db,
        key: deps.settings.secretKey,
        identityProbe: deps.settings.identityProbe,
        ...(deps.settings.providerProbe === undefined ? {} : { providerProbe: deps.settings.providerProbe }),
      },
      guard,
      writeGuard,
    );
  }
}

/* ── 仓库配置路由（`/api/repos/*`）────────────────────────────────────────────── */

/** 路径参数：`owner/name` 两段（`repo` 含 `/`，用 `:repo` 会吞掉后面的段）。 */
const repoParamsSchema = z
  .object({
    owner: loginSchema,
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  })
  .strict();

/** 手动添加仓库的请求体：只给 `owner/name`，其余用部署默认（`PI_BOT_DEFAULT_SETTINGS`）。 */
const addRepoBodySchema = z.object({ repo: repoFullNameSchema }).strict();

type RouteGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * 一个仓库的配置视图（读与写返回同一个形状，面板不用分两套）。
 *
 * 返回类型就是契约的 `RepoSettingsResponse`：`settingsValid = false` 时 `settings` 为 `null`
 * （库里留着 last-known-good 原文，但它不符合 schema，硬塞给面板只会让页面在渲染时才炸）。
 */
function repoView(repo: string, policy: RepoPolicy): RepoSettingsResponse {
  return {
    repo,
    enabled: policy.enabled,
    dryRun: policy.dryRun,
    settings: policy.settings,
    settingsValid: policy.settingsValid,
    settingsError: policy.settingsError,
    source: policy.source ?? 'manual',
    installationId: policy.installationId,
    archivedAt: policy.archivedAt,
  };
}

/**
 * 仓库配置的四条路由（`docs/impl-multi-repo.md` §4 W1-A / W3-H 补契约）。
 *
 * 错误语义沿用 `errors.ts` 的统一映射：body 非法 → 400 + `details.issues`（zod 自动给出），
 * 配置不符合 schema → 400 + issues，仓库不存在 → 404。
 */
function registerRepoRoutes(app: ZodFastify, deps: RepoApiWiring, guard: RouteGuard): void {
  // ── GET /api/repos：全部仓库 + 状态（面板仓库切换器 / 系统页）──
  // 响应挂契约 schema：多出来的字段会被裁掉、少字段会暴露成错误（面板拿到的是契约形状）。
  app.get(
    '/api/repos',
    { schema: { response: { 200: reposResponseSchema } }, preHandler: guard },
    async () => ({ items: [...(await listRepos(deps.db))] }),
  );

  // ── GET /api/repos/:owner/:name/settings ──
  app.get(
    '/api/repos/:owner/:name/settings',
    {
      schema: { params: repoParamsSchema, response: { 200: repoSettingsResponseSchema } },
      preHandler: guard,
    },
    async (request) => {
      const repo = `${request.params.owner}/${request.params.name}`;
      const policy = await readRepoPolicy(deps.db, repo);
      if (!policy.known) {
        throw httpError('not-found', `仓库不存在：${repo}（先用 POST /api/repos 添加）`);
      }
      return repoView(repo, policy);
    },
  );

  // ── PUT /api/repos/:owner/:name/settings：body 就是 settings ──
  app.put(
    '/api/repos/:owner/:name/settings',
    {
      schema: {
        params: repoParamsSchema,
        body: repoSettingsSchema,
        response: { 200: repoSettingsResponseSchema },
      },
      preHandler: guard,
    },
    async (request) => {
      const repo = `${request.params.owner}/${request.params.name}`;
      // ① 先跑一遍 zod：形状 + 跨字段约束与 `updateRepoSettings()` 内部同一份校验器，
      //    这里只是为了拿到「可以送去查 GitHub」的解析值（拿不到就没有校验成员的前提）。
      const validated = validateRepoSettings(request.body);
      if (!validated.ok) {
        throw httpError('bad-request', validated.error, { issues: validated.issues });
      }
      // ② 角色成员的 login 必须**真的存在**，且要换成用户 id 一起存（需求 §6.6 的两个坑）。
      //    校验不过就拒绝保存：先存下再「以后校验」等于让拼错的成员永久无法触发且没有报错。
      const verified = await verifyCommentRoleMembers(validated.settings, deps.users);
      if (!verified.ok) {
        // 账号不存在 = 用户写错了（400）；查不了（没凭据 / GitHub 请求失败）= 服务端暂时做不到（503）。
        // 两者都**不写库**：库里继续留着 last-known-good，webhook 行为不变。
        throw verified.kind === 'unknown-user'
          ? httpError('bad-request', verified.error, { issues: verified.issues })
          : httpError('unavailable', verified.error, { issues: verified.issues });
      }
      const result = await updateRepoSettings(deps.db, repo, verified.settings);
      if (!result.ok) {
        // 非法配置不写库（last-known-good 继续生效），错误原因回给面板
        throw result.notFound
          ? httpError('not-found', result.error)
          : httpError('bad-request', result.error, { issues: result.issues });
      }
      const policy = await readRepoPolicy(deps.db, repo);
      return repoView(repo, policy);
    },
  );

  // ── POST /api/repos：手动添加（部署默认 settings seed，source='manual'）──
  app.post(
    '/api/repos',
    {
      schema: { body: addRepoBodySchema, response: { 201: repoSettingsResponseSchema } },
      preHandler: guard,
    },
    async (request, reply) => {
      const result = await upsertRepo(deps.db, { repo: request.body.repo, source: 'manual' });
      if (!result.ok) {
        throw httpError('bad-request', result.error, { issues: result.issues });
      }
      const policy = await readRepoPolicy(deps.db, result.repo);
      return reply.status(201).send(repoView(result.repo, policy));
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
