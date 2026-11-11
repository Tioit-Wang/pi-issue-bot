/**
 * 提示词面板接口 —— 四条版本线（`project` / `format_check` / `classify` / `agent`）。
 *
 * 依据：`docs/impl-multi-repo.md` §4 W3-G 第 4 条（P1 面板）、`docs/plan-fixed-pipeline.md`
 * §4.4（4 条版本线）、§16.3（作用域矩阵 + 保存期校验）。
 *
 * ```text
 * GET    /api/repos/:owner/:name/prompt?kind=…              当前版本 + 全部版本 + 预算 + 预览
 * GET    /api/repos/:owner/:name/prompt/versions?kind=…     只有历史版本（列表页用，不跑预览）
 * PUT    /api/repos/:owner/:name/prompt?kind=…              保存新版本（校验不过 400）
 * POST   /api/repos/:owner/:name/prompt/rollback?kind=…     回滚到旧版本（= 新建一个内容相同的新版本）
 * POST   /api/repos/:owner/:name/prompt/restore?kind=…      「恢复默认」= 指针回 0（不删历史）
 * ```
 *
 * 七条边界：
 *  1. **不写 SQL**：`prompt/store.ts` 是唯一碰 `prompt_versions` 的地方，这一层只做鉴权/校验/翻译错误。
 *  2. **`?kind=` 只允许四种取值**（`PROMPT_KINDS`），非法 `/` 缺省 = 400 / `project`（zod 枚举兜住）。
 *  3. **写面防护与 `/api/skills` 完全一致**（`createApiGuards`）：CSRF 头 + Origin/Sec-Fetch-Site + loopback。
 *     提示词正文会进模型上下文，它是**配置**不是数据，所以按写接口对待。
 *  4. **校验只有一份**（`store.ts` 的 `savePrompt()` → `validateStagePrompt()`）：
 *     未知占位符 / `format_check` 缺 title·body / 超上限全在那里判，这一层把错误码翻成 400 + 明细。
 *  5. **预览调的是运行时那个装配函数**（`skills/assemble.ts` 的 `assemblePrompt` / `stageLayers`），
 *     不在这里另拼一次；阶段 kind 用 `stage` 维度，项目版**整体覆盖**内置默认（Q1）。
 *  6. **输出契约不进任何响应**：它由控制面在运行期追加、不可配（§4.4 / V16），面板只看层序。
 *  7. **预算是提示，不是这一层的闸门**：`availableChars` 如实反映「P1 还能存多少」，
 *     `agent` 的长度会直接扣掉它（R6 / V18），面板要能看见这件事。
 */
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';

import { PROMPT_KINDS, loginSchema, promptKindSchema } from '../../../../../packages/contract/src/index.ts';
import type { PromptKind } from '../../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../../packages/shared/src/index.ts';
import { readRepoPolicy } from '../../config/repo-config.ts';
import type { SqlRunner } from '../../config/repo-config.ts';
import {
  getPrompt,
  isSystemDefault,
  listPromptVersions,
  planPromptBudget,
  previewBasePrompt,
  previewPrompt,
  promptLimitOf,
  readLastAssembleStats,
  resetPromptToDefault,
  rollbackPrompt,
  savePrompt,
} from '../../prompt/index.ts';
import type { PromptState, PromptVersion } from '../../prompt/index.ts';
import { assemblePrompt, stageLayers } from '../../skills/assemble.ts';
import type { AssemblePromptInput } from '../../skills/assemble.ts';
import {
  ASSEMBLE_STAGE_OF_KIND,
  isStageKind,
  pipelinePromptLimit,
  stagePromptDefault,
} from '../../skills/stage-prompts.ts';

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
   * 只对 `kind=project` 有效（阶段 kind 的 head 是阶段系统提示词，不用这个基座）。
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
 * `?kind=`（默认 `project`）。
 *
 * 枚举外的值由 zod 直接拒成 400 —— 这是「四个 tab」唯一的口径来源，
 * 不在路由里手写 `kind === 'agent'` 这种判断（改契约时只改一处）。
 */
const kindQuerySchema = z.object({ kind: promptKindSchema.optional() });

/**
 * 保存新版本的请求体。
 *
 * `body` 上限 20000 是**硬上限**（挡「贴了一整本书」），真正的闸门按 kind 分：
 *  - `project`：12k 预算预演（`prompt/budget.ts`）；
 *  - 三个阶段 kind：`PIPELINE_PROMPT_LIMITS[kind]`（8000 / 8000 / 4000）。
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
  kind: version.kind,
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

  /** `?kind=` → 四种之一（缺省 `project`）。 */
  const kindOf = (request: FastifyRequest): PromptKind => {
    const query = request.query as { kind?: PromptKind } | undefined;
    return query?.kind ?? 'project';
  };

  /**
   * 预算：`agent` 的长度如实计入 `baseChars` 那一侧（`stageBaseChars`），
   * 于是面板上「P1 还能存多少」在保存 `agent` 之后立刻变小（R6 / V18）。
   *
   * `project` 那一路不加 `stageBaseChars`：最近一次装配统计里的 `baseChars` 已经包含它了，
   * 再加一次就是双扣。
   */
  const budgetOf = async (repo: string, state: PromptState) => {
    const lastStats = await readLastAssembleStats(deps.db, repo);
    return planPromptBudget({
      body: state.kind === 'project' ? state.body : '',
      lastStats,
      stageBaseChars: isStageKind(state.kind) ? state.body.length : 0,
    });
  };

  /**
   * 一次完整视图：当前版本 + 版本列表 + 预算 + **真实装配**的预览。
   * GET / PUT / rollback / restore 都走它：四个接口返回同一个形状，面板不用分四套解析。
   */
  const viewOf = async (repo: string, kind: PromptKind) => {
    const [state, versions, budget] = await Promise.all([
      getPrompt(deps.db, repo, kind),
      listPromptVersions(deps.db, repo, kind),
      budgetOf(repo, await getPrompt(deps.db, repo, kind)),
    ]);
    const lastStats = await readLastAssembleStats(deps.db, repo);
    const limit = pipelinePromptLimit(kind);
    const systemDefault = stagePromptDefault(kind);
    const system = isSystemDefault(state);

    // 阶段 kind：head 是阶段系统提示词（项目版整体覆盖内置默认），P1/技能层按矩阵不出现。
    // 阶段 kind：head 是阶段系统提示词（项目版整体覆盖内置默认），P1/技能层按矩阵不出现。
    const stageInput: AssemblePromptInput = isStageKind(kind)
      ? { basePrompt: '', stage: ASSEMBLE_STAGE_OF_KIND[kind], stagePrompt: state.body }
      : { basePrompt: deps.basePrompt?.(repo) ?? previewBasePrompt(repo), projectPrompt: state.body };
    const assembled = assemblePrompt(stageInput);
    const layers = stageLayers(stageInput);
    const preview = isStageKind(kind)
      ? {
          text: assembled.prompt,
          stats: assembled.stats,
          omitted: ['输出契约（运行期由代码追加）', 'AGENTS.md（来自 worktree）'],
        }
      : previewPrompt({
          repo,
          body: state.enabled ? state.body : '',
          ...(deps.basePrompt === undefined ? {} : { basePrompt: deps.basePrompt(repo) }),
        });

    return {
      repo,
      kind,
      // 四个 tab 的取值来源（面板不必自己写死一份）
      kinds: PROMPT_KINDS,
      enabled: state.enabled,
      /** @deprecated 用 `activeVersion`（名字对齐 §4.5 的「版本指针」） */
      version: state.version,
      /** 该 kind 的版本指针；`0` = 没有项目版本（阶段 kind 用内置默认，`project` 不注入）。 */
      activeVersion: state.version,
      /** 指针是否指向一行真实存在的版本（行不在 = 配置能读、内容读不到）。 */
      present: state.present,
      /** 当前生效的正文：`project` = 项目版（空 = 不注入）；阶段 kind = 项目版或内置默认。 */
      body: state.body,
      /** 内置默认模板（只读展示；`project` 恒为空串 —— 它没有默认正文）。 */
      systemDefault,
      /** 当前是否在用内置默认（阶段 kind 的指针为 0 或行不在）。 */
      isSystemDefault: system,
      /** 该 kind 的保存期上限（`PIPELINE_PROMPT_LIMITS`）。 */
      limit,
      /** 还能存多少字符（阶段 kind 用 `limit`，`project` 用预算）。 */
      availableChars: kind === 'project' ? budget.available : Math.max(0, limit - state.body.length),
      versions: versions.map((version) => versionView(version, state.version)),
      budget,
      /** 层序（各层字符数 + 是否可丢弃），面板的「最终 prompt 预览」直接照它渲染。 */
      layers,
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
  app.get(
    '/api/repos/:owner/:name/prompt',
    { schema: { params: repoParamsSchema, querystring: kindQuerySchema }, preHandler: guard },
    async (request) => {
      const repo = repoOf(request);
      const policy = await readRepoPolicy(deps.db, repo);
      if (!policy.known) {
        throw httpError('not-found', `仓库不存在：${repo}（先用 POST /api/repos 添加）`);
      }
      return viewOf(repo, kindOf(request));
    },
  );

  // ── 2. GET /api/repos/:owner/:name/prompt/versions ────────────────────────
  app.get(
    '/api/repos/:owner/:name/prompt/versions',
    { schema: { params: repoParamsSchema, querystring: kindQuerySchema }, preHandler: guard },
    async (request) => {
      const repo = repoOf(request);
      const kind = kindOf(request);
      const policy = await readRepoPolicy(deps.db, repo);
      if (!policy.known) {
        throw httpError('not-found', `仓库不存在：${repo}（先用 POST /api/repos 添加）`);
      }
      const state = await getPrompt(deps.db, repo, kind);
      const versions = await listPromptVersions(deps.db, repo, kind);
      return {
        repo,
        kind,
        kinds: PROMPT_KINDS,
        activeVersion: state.version,
        isSystemDefault: isSystemDefault(state),
        limit: promptLimitOf(kind),
        versions: versions.map((version) => versionView(version, state.version)),
      };
    },
  );

  // ── 3. PUT /api/repos/:owner/:name/prompt（保存即新建版本）───────────────────
  app.put(
    '/api/repos/:owner/:name/prompt',
    { schema: { params: repoParamsSchema, querystring: kindQuerySchema, body: saveBodySchema }, preHandler: writeGuard },
    async (request) => {
      const repo = repoOf(request);
      const kind = kindOf(request);
      const result = await savePrompt(deps.db, repo, request.body.body, request.body.note ?? null, kind);
      if (!result.ok) {
        // 错误码映射：不存在 / 找不到那一版 → 404；其余（含校验与超预算）→ 400 + 明细。
        throw result.code === 'repo-not-found' || result.code === 'version-not-found'
          ? httpError('not-found', result.message)
          : httpError('bad-request', result.message, {
              code: result.code,
              kind,
              ...(result.budget === undefined ? {} : { budget: result.budget }),
              ...(result.unknownPlaceholders === undefined
                ? {}
                : { unknownPlaceholders: result.unknownPlaceholders }),
              ...(result.missingPlaceholders === undefined
                ? {}
                : { missingPlaceholders: result.missingPlaceholders }),
            });
      }
      deps.logger?.info(
        { repo, kind, version: result.version, chars: result.prompt.body.length },
        '提示词已保存为新版本',
      );
      return viewOf(repo, kind);
    },
  );

  // ── 4. POST /api/repos/:owner/:name/prompt/rollback（回滚 = 新建指向旧内容的新版本）──
  app.post(
    '/api/repos/:owner/:name/prompt/rollback',
    { schema: { params: repoParamsSchema, querystring: kindQuerySchema, body: rollbackBodySchema }, preHandler: writeGuard },
    async (request) => {
      const repo = repoOf(request);
      const kind = kindOf(request);
      const result = await rollbackPrompt(deps.db, repo, request.body.version, kind);
      if (!result.ok) {
        throw result.code === 'repo-not-found' || result.code === 'version-not-found'
          ? httpError('not-found', result.message)
          : httpError('bad-request', result.message, {
              code: result.code,
              kind,
              ...(result.budget === undefined ? {} : { budget: result.budget }),
            });
      }
      deps.logger?.info(
        { repo, kind, from: request.body.version, createdVersion: result.version },
        '提示词已回滚（新建版本）',
      );
      return viewOf(repo, kind);
    },
  );

  // ── 5. POST /api/repos/:owner/:name/prompt/restore（恢复默认：指针回 0，不删历史）──
  app.post(
    '/api/repos/:owner/:name/prompt/restore',
    { schema: { params: repoParamsSchema, querystring: kindQuerySchema }, preHandler: writeGuard },
    async (request) => {
      const repo = repoOf(request);
      const kind = kindOf(request);
      const policy = await readRepoPolicy(deps.db, repo);
      if (!policy.known) {
        throw httpError('not-found', `仓库不存在：${repo}（先用 POST /api/repos 添加）`);
      }
      const result = await resetPromptToDefault(deps.db, repo, kind);
      if (!result.ok) {
        throw httpError('bad-request', result.message);
      }
      deps.logger?.info({ repo, kind }, '提示词已恢复默认（版本指针回 0，历史保留）');
      return viewOf(repo, kind);
    },
  );
}
