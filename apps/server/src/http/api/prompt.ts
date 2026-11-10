/**
 * 项目提示词层（P1）的面板接口 —— `docs/impl-multi-repo.md` §4 W3-G 第 4 条。
 *
 * ```
 * GET  /api/repos/:owner/:name/prompt             当前版本 + 全部版本 + 最终装配预览 + 预算
 * PUT  /api/repos/:owner/:name/prompt             保存新版本（超预算 400）
 * POST /api/repos/:owner/:name/prompt/rollback    回滚到旧版本（= 新建一个内容相同的新版本）
 * ```
 *
 * 五条边界：
 *  1. **不写 SQL**：`prompt/store.ts` 是唯一碰 `prompt_versions` 的地方，这一层只做鉴权/校验/翻译错误。
 *  2. **写面防护与 `/api/skills` 完全一致**（`createApiGuards`）：CSRF 头 + Origin/Sec-Fetch-Site + loopback。
 *     提示词正文会进模型上下文，它是**配置**不是数据，所以按写接口对待。
 *  3. **预览调的是运行时那个装配函数**（`prompt/preview.ts` → `skills/assemble.ts`），
 *     返回体里的 `ref` / `sha` 目前是占位（`null`）：面板这一刻没有 worktree，
 *     拿不到 AGENTS.md 所在的那次提交；谁有的话（`compose.ts` / `serve`）通过
 *     `PromptApiDeps.env` 注入，形状见汇报。
 *  4. **不声明 response schema**：这一组响应形状还没进 `packages/contract/src/api.ts`
 *     （那是 W3-H 的文件）。等契约补上之后再挂 schema，避免两处各写一份形状。
 *  5. **预算是保存期的硬闸门**：超了返回 400 + `details.budget = {available, requested}`，
 *     一行都不写。运行期的整段丢弃兜底另算（见 `skills/assemble.ts` 的 `stats.truncated`）。
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';

import { loginSchema } from '../../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../../packages/shared/src/index.ts';
import { readRepoPolicy } from '../../config/repo-config.ts';
import type { SqlRunner } from '../../config/repo-config.ts';
import {
  getPrompt,
  listPromptVersions,
  planPromptBudget,
  previewPrompt,
  readLastAssembleStats,
  rollbackPrompt,
  savePrompt,
} from '../../prompt/index.ts';
import type { PromptVersion } from '../../prompt/index.ts';
import { createApiGuards } from './skills.ts';
import type { SkillWriteMode } from './skills.ts';
import type { RequireAuth } from './auth.ts';
import { httpError } from '../errors.ts';
import type { ZodFastify } from '../types.ts';

/** 只读那一列（面板展示「上次装配有多满」）；`ref@sha` 占位的形状也在这里。 */
export type PromptPreviewEnv = {
  /** 预览用的 git ref；面板没有 worktree，默认 `null`。 */
  readonly ref?: string | null;
  /** 预览用的 commit sha；默认 `null`。 */
  readonly sha?: string | null;
};

export type PromptApiDeps = {
  readonly db: SqlRunner;
  readonly requireAuth: RequireAuth;
  readonly logger?: Logger;
  /** 写面策略，必须与 `/api/skills` 用同一个值（默认 `loopback`）。 */
  readonly writeMode?: SkillWriteMode;
  /**
   * 预览基座（可选）：真实实现可传 `buildTaskPrompt({...})` 的产出，
   * 让预览与运行期的整段文本完全一致。缺省用 `prompt/preview.ts` 的示例基座。
   */
  readonly basePrompt?: (repo: string) => string;
  /** `ref@sha` 占位（面板这一刻拿不到工作区版本时留空）。 */
  readonly env?: PromptPreviewEnv;
};

/** 路径参数：`owner/name` 两段（`repo` 含 `/`，用 `:repo` 会吞掉后面的段）。 */
const repoParamsSchema = z
  .object({
    owner: loginSchema,
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  })
  .strict();

/**
 * 保存新版本的请求体。
 *
 * `body` 上限 20000 是**硬上限**（挡「贴了一整本书」），真正的闸门是预算预演；
 * 两个数字分开是有意的：前者防误操作，后者是产品口径。
 */
const saveBodySchema = z
  .object({
    body: z.string().min(1).max(20_000),
    note: z.string().max(500).optional(),
  })
  .strict();

const rollbackBodySchema = z.object({ version: z.number().int().min(1).max(1_000_000) }).strict();

/** 面板/测试都能读的一版摘要（正文单独给，避免版本列表把响应撑爆）。 */
const versionView = (version: PromptVersion, current: number) => ({
  version: version.version,
  note: version.note,
  createdAt: version.createdAt,
  chars: version.body.length,
  current: version.version === current,
});

export function registerPromptRoutes(app: ZodFastify, deps: PromptApiDeps): void {
  const { guard, writeGuard } = createApiGuards({
    requireAuth: deps.requireAuth,
    ...(deps.writeMode === undefined ? {} : { writeMode: deps.writeMode }),
  });

  const repoOf = (request: FastifyRequest): string => {
    const { owner, name } = request.params as { owner: string; name: string };
    return `${owner}/${name}`;
  };

  /**
   * 一次完整视图：当前版本 + 版本列表 + 预算 + **真实装配**的预览。
   *
   * GET / PUT / rollback 都走它：三个接口返回同一个形状，面板不用分三套解析。
   */
  const viewOf = async (repo: string) => {
    const [state, versions, lastStats] = await Promise.all([
      getPrompt(deps.db, repo),
      listPromptVersions(deps.db, repo),
      readLastAssembleStats(deps.db, repo),
    ]);
    const budget = planPromptBudget({ body: state.body, lastStats });
    const preview = previewPrompt({
      repo,
      body: state.enabled ? state.body : '',
      ...(deps.basePrompt === undefined ? {} : { basePrompt: deps.basePrompt(repo) }),
    });
    return {
      repo,
      enabled: state.enabled,
      version: state.version,
      // `present=false` = settings 指着一版、库里没有那一行（手删过库）：面板要能看见。
      present: state.present,
      body: state.body,
      versions: versions.map((version) => versionView(version, state.version)),
      budget,
      preview: {
        text: preview.text,
        stats: preview.stats,
        omitted: preview.omitted,
        // `ref@sha` 占位：面板这一刻没有 worktree；见 `PromptPreviewEnv`。
        ref: deps.env?.ref ?? null,
        sha: deps.env?.sha ?? null,
      },
      lastAssembly: lastStats,
    };
  };

  // ── 1. GET /api/repos/:owner/:name/prompt ──────────────────────────────────
  app.get('/api/repos/:owner/:name/prompt', { schema: { params: repoParamsSchema }, preHandler: guard }, async (request) => {
    const repo = repoOf(request);
    const policy = await readRepoPolicy(deps.db, repo);
    if (!policy.known) {
      throw httpError('not-found', `仓库不存在：${repo}（先用 POST /api/repos 添加）`);
    }
    return viewOf(repo);
  });

  // ── 2. PUT /api/repos/:owner/:name/prompt（保存即新建版本）───────────────────
  app.put(
    '/api/repos/:owner/:name/prompt',
    { schema: { params: repoParamsSchema, body: saveBodySchema }, preHandler: writeGuard },
    async (request) => {
      const repo = repoOf(request);
      const result = await savePrompt(deps.db, repo, request.body.body, request.body.note ?? null);
      if (!result.ok) {
        // 错误码映射：不存在 → 404；其余（含超预算）→ 400，并把 budget 数字带出去。
        throw result.code === 'repo-not-found'
          ? httpError('not-found', result.message)
          : httpError('bad-request', result.message, {
              code: result.code,
              ...(result.budget === undefined ? {} : { budget: result.budget }),
            });
      }
      deps.logger?.info({ repo, version: result.version, chars: result.prompt.body.length }, 'P1 提示词已保存为新版本');
      return viewOf(repo);
    },
  );

  // ── 3. POST /api/repos/:owner/:name/prompt/rollback（回滚 = 新建指向旧内容的新版本）──
  app.post(
    '/api/repos/:owner/:name/prompt/rollback',
    { schema: { params: repoParamsSchema, body: rollbackBodySchema }, preHandler: writeGuard },
    async (request) => {
      const repo = repoOf(request);
      const result = await rollbackPrompt(deps.db, repo, request.body.version);
      if (!result.ok) {
        throw result.code === 'repo-not-found' || result.code === 'version-not-found'
          ? httpError('not-found', result.message)
          : httpError('bad-request', result.message, {
              code: result.code,
              ...(result.budget === undefined ? {} : { budget: result.budget }),
            });
      }
      deps.logger?.info(
        { repo, from: request.body.version, createdVersion: result.version },
        'P1 提示词已回滚（新建版本）',
      );
      return viewOf(repo);
    },
  );
}
