/**
 * 全局设置 API（需求 §6.8 / §6.9：CFG-8.1 / CFG-8.2 / CFG-8.3 / CFG-9.1 / CFG-9.2；AC-32 的后端半边）。
 *
 * 五条边界：
 *  1. **写接口一律走 `writeGuard`**（鉴权 + `PI_BOT_PANEL_WRITE` + 来源 + `X-Pi-Bot-CSRF`）：
 *     这里改的是模型端点、key 与人身份，比技能配置更敏感；
 *  2. **明文 key / PAT 只出现在请求体里**：落库前加密，响应里**永不返回**（只有掩码）；
 *  3. **加解密密钥从装配层注入**：本文件不读 env、不碰密钥库；
 *  4. **失败原因必须落地**（CFG-9.2）：退回 bot 时写 `identity_fallbacks`，面板能查到「为什么这次是 bot」；
 *  5. 契约取数与写库都在 `config/model-settings.ts`，这里只做参数校验、视图投影与错误码映射。
 */
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  MODEL_ROLE_KEYS,
  PANEL_IDENTITY_STATES,
  PROVIDER_CHECK_TIMEOUT_MS,
  classifyIdentityState,
  identityCheckResponseSchema,
  identityFallbacksQuerySchema,
  identityFallbacksResponseSchema,
  loginSchema,
  modelProvidersResponseSchema,
  modelRoleRowSchema,
  modelRolesResponseSchema,
  modelProviderIdSchema,
  panelIdentityResponseSchema,
  panelIdentitySchema,
  providerCheckResponseSchema,
  repoModelRoleRowSchema,
  saveModelProviderRequestSchema,
  saveModelRoleRequestSchema,
  savePanelIdentityRequestSchema,
  saveRepoModelRoleRequestSchema,
} from '../../../../../packages/contract/src/index.ts';
import type { ModelProvider, PanelIdentity, PanelIdentityState } from '../../../../../packages/contract/src/index.ts';
import {
  deleteIdentity,
  listFallbacks,
  listIdentities,
  listProviders,
  listRepoRoleSelections,
  listRoleBindings,
  priceOf,
  readIdentity,
  readIdentityToken,
  readProvider,
  readProviderKey,
  recordFallback,
  recordIdentityCheck,
  recordProviderCheck,
  saveIdentity,
  saveProvider,
  saveRepoRoleSelection,
  saveRoleBinding,
} from '../../config/model-settings.ts';
import type { IdentityView, ProviderView } from '../../config/model-settings.ts';
import type { SqlRunner } from '../../config/repo-config.ts';
import type { GithubIdentityProbe } from '../../app/github-auth.ts';
import { httpError } from '../errors.ts';
import type { ZodFastify } from '../types.ts';

/** 个人身份探测端口：拿明文 token 问 GitHub「这是谁、什么 scope、何时过期」。 */
export type GithubIdentityProbePort = (token: string) => Promise<GithubIdentityProbe>;

/**
 * 供应商连通性探测端口（注入）。
 *
 * 不注入时 `/check` 明确报 503 —— 假成功会让面板上的绿点变成谎言，比没有这个按钮更糟。
 */
export type ProviderProbePort = (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}) => Promise<{ readonly ok: boolean; readonly latencyMs: number; readonly error: string | null }>;

/**
 * 设置写面的依赖。`key` 是 AES-256 的 32 字节密钥（来自 `EnvironmentFile`）。
 *
 * 为什么密钥必须显式注入：本仓的加解密原语（`runtime/crypto.ts`）刻意不读 `process.env`，
 * 好让单测、`replay`、轮换脚本各塞各的密钥。
 */
export type SettingsApiDeps = {
  readonly db: SqlRunner;
  readonly key: Uint8Array;
  readonly identityProbe: GithubIdentityProbePort;
  readonly providerProbe?: ProviderProbePort | undefined;
  /** 时间源（注入：身份三态里有一项是时间比较，测试必须能摆位）。 */
  readonly now?: () => Date;
};

type RouteGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/* ── 读模型 → 契约形状（投影只在这里出现一次） ─────────────────────────────── */

/** 供应商 → 契约行。**真值永不出现**：只有 `key_configured` 与 `key_mask`。 */
function providerRowOf(provider: ProviderView): ProviderRow {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.baseUrl,
    key_configured: provider.keyConfigured,
    key_mask: provider.keyMask,
    models: [...provider.models],
    enabled: provider.enabled,
    status: provider.status,
    latency_ms: provider.latencyMs,
    checked_at: provider.checkedAt,
    check_error: provider.checkError,
    updated_at: provider.updatedAt,
  };
}

/** 供应商契约行的形状（`ModelProvider` 组件的 `z.infer`，不手抄第二份）。 */
type ProviderRow = ModelProvider;

/** 身份 → 契约行（掩码 + 三态 + scope + 过期时刻，**永不含明文**）。 */
function identityOf(identity: IdentityView): PanelIdentity {
  return panelIdentitySchema.parse({
    login: identity.login,
    token_mask: identity.tokenMask,
    state: identity.state,
    state_reason: identity.stateReason,
    scopes: identity.scopes === null ? null : [...identity.scopes],
    missing_scopes: [...identity.missingScopes],
    token_expires_at: identity.tokenExpiresAt,
    checked_at: identity.checkedAt,
    updated_at: identity.updatedAt,
  });
}

/** 一个 fallback 行 → 契约行（`state` 收敛到契约枚举，未知取值一律 `unchecked`）。 */
function fallbackStateOf(raw: string): PanelIdentityState {
  return (PANEL_IDENTITY_STATES as readonly string[]).includes(raw) ? (raw as PanelIdentityState) : 'unchecked';
}

const idParamsSchema = z.object({ id: modelProviderIdSchema }).strict();
const roleParamsSchema = z.object({ role: z.enum(MODEL_ROLE_KEYS) }).strict();
const loginParamsSchema = z.object({ login: loginSchema }).strict();
const repoParamsSchema = z
  .object({ owner: loginSchema, name: z.string().min(1).max(100) })
  .strict();
const repoRoleParamsSchema = z
  .object({ owner: loginSchema, name: z.string().min(1).max(100), role: z.enum(MODEL_ROLE_KEYS) })
  .strict();

/**
 * 注册全局设置路由（`/api/settings/*` 与 `/api/repos/:owner/:name/models*`）。
 *
 * 挂载条件是注入 `deps.settings`：不注入就整组不存在（与 `/api/repos`、`/api/skills` 同一套路），
 * 老的只读装配与最小单测不需要密钥与探测端口。
 */
export function registerSettingsRoutes(
  app: ZodFastify,
  deps: SettingsApiDeps,
  guard: RouteGuard,
  writeGuard: RouteGuard,
): void {
  const now = (): Date => deps.now?.() ?? new Date();

  /* ── 1. 供应商（CFG-8.1 / AC-32） ─────────────────────────────────────── */

  app.get(
    '/api/settings/providers',
    { schema: { response: { 200: modelProvidersResponseSchema } }, preHandler: guard },
    async () => ({ items: (await listProviders(deps.db)).map((item) => providerRowOf(item)) }),
  );

  app.put(
    '/api/settings/providers/:id',
    { schema: { params: idParamsSchema }, preHandler: writeGuard },
    async (request) => {
      const body = saveModelProviderRequestSchema.parse(request.body);
      const result = await saveProvider(
        deps.db,
        {
          id: request.params.id,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.base_url === undefined ? {} : { baseUrl: body.base_url }),
          ...(body.key === undefined ? {} : { key: body.key }),
          ...(body.clear_key === undefined ? {} : { clearKey: body.clear_key }),
          ...(body.models === undefined ? {} : { models: body.models }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        },
        deps.key,
      );
      if (!result.ok) {
        throw httpError('bad-request', result.error, { issues: result.issues });
      }
      return providerRowOf(result.provider);
    },
  );

  /**
   * 连通性测试（CFG-8.1「状态点 + 延迟，可手动测试」）。
   *
   * 语义要点：**失败也回 200**，把 `status: 'fail'` 与原因放进 body ——
   * 「点了测试之后网络不通」是正常结果，不是请求错误（面板要画状态点，不是错误横幅）。
   */
  app.post('/api/settings/providers/:id/check', { preHandler: writeGuard }, async (request) => {
    const id = idParamsSchema.parse(request.params).id;
    const provider = await readProvider(deps.db, id);
    if (provider === null) {
      throw httpError('not-found', `供应商不存在：${id}`);
    }
    if (deps.providerProbe === undefined) {
      throw httpError('unavailable', '未注入供应商探测端口：本进程无法测连通性');
    }
    const apiKey = await readProviderKey(deps.db, id, deps.key);
    if (apiKey === null || provider.baseUrl === null) {
      throw httpError(
        'bad-request',
        `供应商 ${id} 缺 ${apiKey === null ? 'key' : 'base URL'}：先把这一行填全再测连通性`,
      );
    }
    const probe = await deps.providerProbe({
      baseUrl: provider.baseUrl,
      apiKey,
      timeoutMs: PROVIDER_CHECK_TIMEOUT_MS,
    });
    const checkedAt = now();
    await recordProviderCheck(deps.db, {
      id,
      status: probe.ok ? 'ok' : 'fail',
      // 失败的时间不是「延迟」：`null` 与 `0ms` 必须可区分
      latencyMs: probe.ok ? probe.latencyMs : null,
      checkedAt,
      error: probe.error,
    });
    return providerCheckResponseSchema.parse({
      provider_id: id,
      status: probe.ok ? 'ok' : 'fail',
      latency_ms: probe.ok ? probe.latencyMs : null,
      checked_at: checkedAt.toISOString(),
      error: probe.error,
      models: null,
    });
  });

  /* ── 2. 模型角色四档（CFG-8.2 / AC-32） ──────────────────────────────── */

  app.get(
    '/api/settings/models',
    { schema: { response: { 200: modelRolesResponseSchema } }, preHandler: guard },
    async () => {
      const providers = await listProviders(deps.db);
      const bindings = await listRoleBindings(deps.db);
      return {
        items: bindings.map((binding) => {
          const provider =
            binding.providerId === null
              ? null
              : (providers.find((item) => item.id === binding.providerId) ?? null);
          return modelRoleRowSchema.parse({
            role: binding.role,
            configured: binding.configured,
            provider_id: binding.providerId,
            provider_name: provider?.name ?? null,
            model: binding.model,
            price: provider === null ? null : priceOf(provider.models, binding.model),
            updated_at: binding.updatedAt,
          });
        }),
      };
    },
  );

  app.put(
    '/api/settings/models/:role',
    { schema: { params: roleParamsSchema }, preHandler: writeGuard },
    async (request) => {
      const body = saveModelRoleRequestSchema.parse(request.body);
      const result = await saveRoleBinding(deps.db, {
        role: request.params.role,
        providerId: body.provider_id,
        model: body.model,
      });
      if (!result.ok) {
        throw httpError('bad-request', result.error, { issues: result.issues });
      }
      return { ok: true };
    },
  );

  /* ── 3. 项目级覆盖（CFG-8.3） ────────────────────────────────────────── */

  /**
   * 一个项目的四档选择。
   *
   * `inherit` 时 `effective` 填的是**全局值**：面板据此显示「继承全局（模型名）」，
   * 并且不需要自己再拉一次全局设置（两处各查一遍 = 两处可能不一致）。
   */
  app.get(
    '/api/repos/:owner/:name/models',
    { schema: { params: repoParamsSchema }, preHandler: guard },
    async (request) => {
      const repo = `${request.params.owner}/${request.params.name}`;
      const providers = await listProviders(deps.db);
      const bindings = await listRoleBindings(deps.db);
      const selections = await listRepoRoleSelections(deps.db, repo);
      const items = selections.map((selection) => {
        const overridden = selection.overridden && selection.providerId !== null && selection.model !== null;
        const global = bindings.find((item) => item.role === selection.role);
        const effectiveTarget = overridden
          ? { provider_id: selection.providerId as string, model: selection.model as string }
          : global !== undefined && global.providerId !== null && global.model !== null
            ? { provider_id: global.providerId, model: global.model }
            : null;
        const provider =
          effectiveTarget === null
            ? null
            : (providers.find((item) => item.id === effectiveTarget.provider_id) ?? null);
        return repoModelRoleRowSchema.parse({
          role: selection.role,
          selection: overridden
            ? { mode: 'override', provider_id: selection.providerId as string, model: selection.model as string }
            : { mode: 'inherit' },
          effective: effectiveTarget,
          effective_price:
            provider === null || effectiveTarget === null
              ? null
              : priceOf(provider.models, effectiveTarget.model),
          updated_at: selection.updatedAt,
        });
      });
      return { repo, items };
    },
  );

  app.put(
    '/api/repos/:owner/:name/models/:role',
    { schema: { params: repoRoleParamsSchema }, preHandler: writeGuard },
    async (request) => {
      const repo = `${request.params.owner}/${request.params.name}`;
      const body = saveRepoModelRoleRequestSchema.parse(request.body);
      const result = await saveRepoRoleSelection(deps.db, { repo, role: request.params.role, selection: body });
      if (!result.ok) {
        throw httpError('bad-request', result.error, { issues: result.issues });
      }
      return { ok: true };
    },
  );

  /* ── 4. 面板身份（CFG-9.1 / CFG-9.2） ───────────────────────────────── */

  /**
   * 当前身份。`effective` 是**显式**的（CFG-9.2 的「显式呈现」）：`bot` 合法（未配个人 PAT），
   * `user` 才以该用户提交；退回原因写在 `effective_reason` 里。
   *
   * 已知边界：多用户部署下这里取**第一行**。写回通道此刻没有「谁在操作」这个概念
   * （`panel_sessions` 里有 login，但 `worker` 的写面不传它），所以不假装支持多身份；
   * 这一点写进交付报告的残余风险。
   */
  app.get(
    '/api/settings/identity',
    { schema: { response: { 200: panelIdentityResponseSchema } }, preHandler: guard },
    async () => {
      const at = now();
      const identities = await listIdentities(deps.db, at);
      const first = identities[0];
      if (first === undefined) {
        return panelIdentityResponseSchema.parse({
          effective: 'bot',
          effective_reason: '未配置个人 PAT：一切写回以 bot 身份署名（这是合法默认）',
          identity: null,
          generated_at: at.toISOString(),
        });
      }
      const effective = first.state === 'ok' ? 'user' : 'bot';
      return panelIdentityResponseSchema.parse({
        effective,
        effective_reason:
          effective === 'user'
            ? `以 ${first.login} 身份提交评论与写回`
            : `${first.stateReason}（当前退回 bot 身份）`,
        identity: identityOf(first),
        generated_at: at.toISOString(),
      });
    },
  );

  /**
   * 存个人 PAT（需求明确「手动填 PAT，不做 OAuth device flow」）。
   *
   * 存完立刻回一次身份视图（含三态）：CFG-9.2 不让「存了但不知道能不能用」长期存在，
   * 面板拿到 `state` 就能直接画「可用 / scope 不足 / 已过期」。
   */
  app.put('/api/settings/identity', { preHandler: writeGuard }, async (request) => {
    const body = savePanelIdentityRequestSchema.parse(request.body);
    await saveIdentity(deps.db, { login: body.login, token: body.token }, deps.key);
    const at = now();
    const saved = await readIdentity(deps.db, body.login, at);
    return { ok: true, identity: saved === null ? null : identityOf(saved) };
  });

  /**
   * 「检查权限」（CFG-9.1 的 note）：`GET /user` 读 `X-OAuth-Scopes` 与
   * `github-authentication-token-expiration`，落 scope 快照 + 三态 + 留痕。
   */
  app.post('/api/settings/identity/:login/check', { preHandler: writeGuard }, async (request) => {
    const login = loginParamsSchema.parse(request.params).login;
    const token = await readIdentityToken(deps.db, login, deps.key);
    if (token === null) {
      throw httpError('not-found', `没有为 ${login} 存过个人 PAT`);
    }
    const at = now();
    let probe: GithubIdentityProbe;
    try {
      probe = await deps.identityProbe(token);
    } catch (error) {
      // 令牌被 GitHub 直接拒：这本身就是一种「不可用」，必须显式落下来（CFG-9.2）
      const reason = `个人 PAT 被 GitHub 拒绝（${error instanceof Error ? error.message : String(error)}），已退回 bot 身份`;
      await recordIdentityCheck(deps.db, {
        login,
        scopes: null,
        expiresAt: null,
        state: 'expired',
        detail: reason,
        checkedAt: at,
      });
      await recordFallback(deps.db, {
        login,
        state: 'expired',
        operation: 'identity-check',
        target: login,
        reason,
        at,
      });
      const after = await readIdentity(deps.db, login, at);
      if (after === null) throw httpError('not-found', `没有为 ${login} 存过个人 PAT`);
      return identityCheckResponseSchema.parse({
        identity: identityOf(after),
        remote_checked: true,
        generated_at: at.toISOString(),
      });
    }

    const classified = classifyIdentityState({
      configured: true,
      scopes: probe.scopes,
      expiresAt: probe.expiresAt,
      at,
    });
    await recordIdentityCheck(deps.db, {
      login,
      scopes: probe.scopes,
      expiresAt: probe.expiresAt,
      state: classified.state,
      detail: classified.reason,
      checkedAt: at,
    });
    if (classified.state !== 'ok') {
      // 不可用必须留痕：等「评论没出现」才发现，就是需求点名的「静默失败」
      await recordFallback(deps.db, {
        login,
        state: classified.state,
        operation: 'identity-check',
        target: login,
        reason: classified.reason,
        at,
      });
    }
    const after = await readIdentity(deps.db, login, at);
    if (after === null) throw httpError('not-found', `没有为 ${login} 存过个人 PAT`);
    return identityCheckResponseSchema.parse({
      identity: identityOf(after),
      remote_checked: true,
      generated_at: at.toISOString(),
    });
  });

  /** 清除个人令牌：显式退回 bot（同样留痕）。 */
  app.delete('/api/settings/identity/:login', { preHandler: writeGuard }, async (request) => {
    const login = loginParamsSchema.parse(request.params).login;
    const at = now();
    const existed = await readIdentity(deps.db, login, at);
    await deleteIdentity(deps.db, login);
    if (existed !== null) {
      await recordFallback(deps.db, {
        login,
        state: 'missing',
        operation: 'identity-delete',
        target: login,
        reason: '个人 PAT 已删除：此后一切写回以 bot 身份署名',
        at,
      });
    }
    return { ok: true, deleted: existed !== null };
  });

  /* ── 5. 退回留痕（CFG-9.2「可查」） ─────────────────────────────────── */

  app.get(
    '/api/settings/identity/fallbacks',
    { schema: { querystring: identityFallbacksQuerySchema, response: { 200: identityFallbacksResponseSchema } }, preHandler: guard },
    async (request) => {
      const query = request.query;
      const limit = query.limit ?? 50;
      // 多取一条判 `hasMore`（与其它列表接口同一口径；这里不做 keyset 游标，
      // 留痕表的用途是「最近发生了什么」，翻旧账用 /api/audit）
      const rows = await listFallbacks(deps.db, limit + 1);
      const filtered = rows.filter((row) => query.login === undefined || row.login === query.login);
      const hasMore = filtered.length > limit;
      const page = hasMore ? filtered.slice(0, limit) : filtered;
      return identityFallbacksResponseSchema.parse({
        items: page.map((row) => ({
          id: typeof row.id === 'number' ? row.id : Number(row.id),
          login: row.login,
          state: fallbackStateOf(row.state),
          operation: row.operation,
          target: row.target,
          reason: row.reason,
          created_at:
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : new Date(row.created_at).toISOString(),
        })),
        nextCursor: null,
        hasMore,
      });
    },
  );
}
