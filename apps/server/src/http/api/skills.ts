/**
 * 面板技能管理接口（`/api/skills`）—— `docs/spec/skill-management.md` §6 的落地。
 *
 * 这一层只做四件事，**不写 SQL、不碰磁盘**：
 *  1. 鉴权（沿用既有 `requireAuth`）与**写面防护**（`X-Pi-Bot-CSRF` + Origin/Sec-Fetch-Site + loopback）；
 *  2. zod 校验与序列化（schema 全部来自 `packages/contract`）；
 *  3. 把原始 zip 字节交给 `skills/bundle.ts` 解成技能包；
 *  4. 把 `SkillStoreError` / `ZipError` 翻成契约错误码。
 *
 * 为什么写接口要单独一道防护：面板不会暴露到公网，但**浏览器里的任意网页**也能向
 * `localhost:3000` 发 POST —— 那是 CSRF，不是公网暴露。要求一个自定义头
 * （跨域时必须预检、预检过不去）+ 来源校验，成本很低，挡住的是「你开着面板时随手点开的
 * 一个钓鱼页」。spec R11。
 */
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  skillDeleteResponseSchema,
  skillFilesResponseSchema,
  skillFileWriteSchema,
  skillImportResponseSchema,
  skillDetailSchema,
  skillPatchSchema,
  skillRollbackBodySchema,
  skillUploadQuerySchema,
  skillUploadResponseSchema,
  skillVersionsResponseSchema,
  skillsQuerySchema,
  skillsResponseSchema,
} from '../../../../../packages/contract/src/index.ts';
import type { SkillsQuery } from '../../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../../packages/shared/src/index.ts';
import { SkillStoreError } from '../../skills/store.ts';
import type { SkillStore } from '../../skills/store.ts';
import { seedProjectDefaults } from '../../skills/defaults.ts';
import { parseSkillFile } from '../../skills/frontmatter.ts';
import { ZipError, extractSkillBundle } from '../../skills/bundle.ts';
import {
  bundleFromFiles,
  isEditableSkillPath,
  normalizeSkillFilePath,
  replaceFileIn,
  splitZipBundles,
} from '../../skills/files.ts';
import { httpError } from '../errors.ts';
import type { ZodFastify } from '../types.ts';
import type { RequireAuth } from './auth.ts';

/** 默认上传上限（spec §6：5 MB）。zip 炸弹的**解压后**限额在 `skills/zip.ts` 里。 */
export const SKILL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** 写面策略：`off` 全禁、`loopback` 只收本机、`any` 不限制来源地址（仍需 CSRF 头）。 */
export type SkillWriteMode = 'off' | 'loopback' | 'any';

export type SkillApiDeps = {
  readonly store: SkillStore;
  readonly requireAuth: RequireAuth;
  readonly logger?: Logger;
  readonly writeMode?: SkillWriteMode;
};

/** 列表筛选：`enabled` 是 `'true'|'false'` 字符串，存储层要 boolean。 */
const listFilterOf = (query: SkillsQuery) => ({
  repo: query.repo,
  enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
  source: query.source,
});

/**
 * 路由层用的列表查询串：**在契约 schema 上把 `repo` 放宽成可选**。
 *
 * 为什么放宽：契约里 `repo` 必填（技能只有项目级），但 fastify 的 zod 校验失败只会回
 * 一句泛泛的「请求参数不合法」；这里让 handler 自己抛一条中文可读的错误，告诉调用方
 * 「全局技能已移除」，比让面板猜 issue 靠谱。`.strict()` 仍然保留 —— 传 `scope=...` 一律 400。
 */
const skillsListQuerySchema = skillsQuerySchema.extend({
  repo: skillsQuerySchema.shape.repo.optional(),
});

const isLoopbackAddress = (address: string | undefined): boolean => {
  if (address === undefined) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
};

/** 技能 id 是 uuid（也允许测试用短 id）：长度上限与 `skillListItemSchema.id` 对齐。 */
const skillIdParams = z.object({ id: z.string().min(1).max(64) }).strict();

/** `Origin` 的 host 是否属于本机（面板 dev server 5173 → API 3000 也在此列）。 */
const isLocalHostName = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname === '[::1]' ||
  hostname.endsWith('.localhost');

/** `Origin` → hostname；不是合法 URL 时 `null`（调用方决定拒绝还是放行）。 */
const originHostOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
};

/* ── 读写守卫（技能与项目提示词共用一份）───────────────────────────────────── */

/**
 * 「读接口鉴权 + 写接口三道写面约束」的唯一实现。
 *
 * 为什么提出来：`/api/skills` 与 `/api/repos/:owner/:name/prompt` 的写面策略必须**完全一致**
 * （同一份 CSRF/来源/loopback 规则）。各写一份的话，两边迟早会漂——而漂的方向通常是「少了一道检查」。
 */
export function createApiGuards(input: {
  readonly requireAuth: RequireAuth;
  readonly writeMode?: SkillWriteMode;
}): {
  readonly guard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly writeGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
} {
  const mode: SkillWriteMode = input.writeMode ?? 'loopback';

  /** 读接口：鉴权 + 禁止缓存（与既有 `/api/*` 一致）。 */
  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await input.requireAuth(request);
    reply.header('cache-control', 'no-store');
  };

  /**
   * 写接口：读接口的全部约束 + 三道写面约束。
   *
   * 顺序是刻意的：**先判策略、再判来源、最后判 CSRF 头** —— 最便宜的检查放最前面，
   * 拒掉的请求不产生副作用也不写审计。
   */
  const writeGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await guard(request, reply);
    if (mode === 'off') {
      throw httpError('forbidden', '写接口已关闭（PI_BOT_PANEL_WRITE=off）');
    }
    if (mode === 'loopback' && !isLoopbackAddress(request.raw.socket.remoteAddress ?? undefined)) {
      throw httpError('forbidden', '写接口只接受本机来源（PI_BOT_PANEL_WRITE=loopback）');
    }

    // `Sec-Fetch-Site: cross-site` 是浏览器自己给的信号，比 Origin 更难伪造。
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      throw httpError('forbidden', `拒绝跨站写入（Sec-Fetch-Site: ${site}）`);
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      const hostname = originHostOf(origin);
      if (hostname === null) throw httpError('forbidden', `Origin 不是合法 URL：${origin}`);
      if (!isLocalHostName(hostname)) {
        throw httpError('forbidden', `拒绝跨站写入（Origin: ${origin}）`);
      }
    }

    // 自定义头：表单/跨站默认发不出来，跨域时必须过预检。
    const csrf = request.headers['x-pi-bot-csrf'];
    if (csrf !== '1') {
      throw httpError('forbidden', '缺少 X-Pi-Bot-CSRF: 1 头（写接口的 CSRF 防护）');
    }
  };

  return { guard, writeGuard };
}

export function registerSkillRoutes(app: ZodFastify, deps: SkillApiDeps): void {
  const { guard, writeGuard } = createApiGuards({
    requireAuth: deps.requireAuth,
    ...(deps.writeMode === undefined ? {} : { writeMode: deps.writeMode }),
  });

  // 原始 zip 字节：不引入 `@fastify/multipart`（spec §6 的「不引入新依赖」）。
  app.addContentTypeParser(
    'application/zip',
    { parseAs: 'buffer', bodyLimit: SKILL_UPLOAD_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /** 存储层的错误 → 契约错误码。集中一处，路由里不再各写各的。 */
  const mapStoreError = (error: unknown): never => {
    if (error instanceof SkillStoreError) {
      switch (error.code) {
        case 'not-found':
          throw httpError('not-found', error.message);
        case 'conflict':
          throw httpError('conflict', error.message);
        case 'invalid-skill':
        case 'bad-request':
          throw httpError('bad-request', error.message);
      }
    }
    if (error instanceof ZipError) {
      // zip 结构性错误是「你传的东西不是我们能解的技能包」，一律 400（spec §9）。
      throw httpError('bad-request', `zip 解析失败（${error.code}）：${error.message}`, {
        code: error.code,
      });
    }
    // 唯一索引/主键冲突：并发保存或并发导入同名技能时会出现。翻成 409 而不是裸 500 ——
    // 「另一个保存刚刚抢先落了一个版本」是可理解的结果，用户可以刷新后重试，而不是以为系统挂了。
    const code = (error as { code?: unknown }).code;
    if (code === '23505' || code === '23514' || code === '23503') {
      throw httpError('conflict', '并发写入冲突：请刷新后重试（同一技能正在被另一个请求保存）', {
        pgCode: code,
      });
    }
    throw error;
  };

  /** 解析上传的原始字节 → 技能包。校验不过直接 400（spec R3：失败不入库）。 */
  const bundleOf = (body: unknown) => {
    if (!Buffer.isBuffer(body)) {
      throw httpError('bad-request', 'body 必须是原始 zip 字节（Content-Type: application/zip）');
    }
    try {
      const bundle = extractSkillBundle(new Uint8Array(body));
      if (!bundle.validation.ok) {
        throw httpError('bad-request', `技能校验不通过：${bundle.validation.errors.join('；')}`, {
          errors: bundle.validation.errors,
        });
      }
      return bundle;
    } catch (error) {
      return mapStoreError(error);
    }
  };

  const actorOf = (request: FastifyRequest): string | null => {
    const raw = request.headers['x-pi-bot-actor'];
    return typeof raw === 'string' && raw !== '' ? raw.slice(0, 120) : null;
  };

  // ── 1. GET /api/skills ────────────────────────────────────────────────────
  app.get(
    '/api/skills',
    {
      schema: { querystring: skillsListQuerySchema, response: { 200: skillsResponseSchema } },
      preHandler: guard,
    },
    async (request) => {
      const repo = request.query.repo;
      if (repo === undefined) {
        throw httpError('bad-request', '必须指定 repo=owner/name：全局技能已移除');
      }
      // 顺带补齐「三个默认技能」（幂等）：首次打开项目技能页就能看到并可编辑。
      await seedProjectDefaults(deps.store, repo).catch(() => undefined);
      return {
        generatedAt: new Date().toISOString(),
        skills: await deps.store.list(listFilterOf({ ...request.query, repo })),
      };
    },
  );

  // ── 2. GET /api/skills/:id ────────────────────────────────────────────────
  app.get(
    '/api/skills/:id',
    {
      schema: { params: skillIdParams, response: { 200: skillDetailSchema } },
      preHandler: guard,
    },
    async (request) => {
      const detail = await deps.store.get(request.params.id);
      if (detail === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
      return detail;
    },
  );

  // ── 3. GET /api/skills/:id/versions ───────────────────────────────────────
  app.get(
    '/api/skills/:id/versions',
    {
      schema: { params: skillIdParams, response: { 200: skillVersionsResponseSchema } },
      preHandler: guard,
    },
    async (request) => ({
      generatedAt: new Date().toISOString(),
      skillId: request.params.id,
      versions: await deps.store.versions(request.params.id),
    }),
  );

  // ── 4. POST /api/skills（上传 zip：新建或新版本）───────────────────────────
  app.post(
    '/api/skills',
    {
      schema: { querystring: skillUploadQuerySchema, response: { 200: skillUploadResponseSchema } },
      preHandler: writeGuard,
    },
    async (request) => {
      const bundle = bundleOf(request.body);
      const query = request.query;
      try {
        const result = await deps.store.upload({
          bundle,
          repo: query.repo,
          enabled: query.enabled === 'true',
          actor: actorOf(request),
        });
        deps.logger?.info(
          {
            skillId: result.skill.id,
            name: result.skill.name,
            version: result.version,
            created: result.created,
            bytes: result.skill.sizeBytes,
          },
          '技能已上传并生效',
        );
        return { skill: result.skill, version: result.version, validation: result.validation };
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  // ── 5. POST /api/skills/:id/versions（同名新版本）─────────────────────────
  app.post(
    '/api/skills/:id/versions',
    {
      schema: { params: skillIdParams, response: { 200: skillUploadResponseSchema } },
      preHandler: writeGuard,
    },
    async (request) => {
      const existing = await deps.store.get(request.params.id);
      if (existing === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
      const repo = existing.repo;
      // `skills.repo` 已是 NOT NULL（migration 0008），不需要再判空。
      const bundle = bundleOf(request.body);
      if (bundle.name !== existing.name) {
        throw httpError(
          'bad-request',
          `新版本的技能名必须与既有技能一致（期望 ${existing.name}，收到 ${bundle.name}）`,
        );
      }
      try {
        const result = await deps.store.upload({
          bundle,
          repo,
          enabled: existing.enabled,
          actor: actorOf(request),
        });
        return { skill: result.skill, version: result.version, validation: result.validation };
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  // ── 6. PATCH /api/skills/:id（启停 / 描述 / 正文）─────────────────────────
  app.patch(
    '/api/skills/:id',
    {
      schema: { params: skillIdParams, body: skillPatchSchema, response: { 200: skillDetailSchema } },
      preHandler: writeGuard,
    },
    async (request) => {
      try {
        const detail = await deps.store.patch({
          id: request.params.id,
          patch: request.body,
          actor: actorOf(request),
        });
        if (detail === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
        return detail;
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  // ── 7. POST /api/skills/:id/rollback（回到旧版本 = 新建一个指向旧内容的新版本）──
  app.post(
    '/api/skills/:id/rollback',
    {
      schema: { params: skillIdParams, body: skillRollbackBodySchema, response: { 200: skillDetailSchema } },
      preHandler: writeGuard,
    },
    async (request) => {
      try {
        const version = await deps.store.rollback({
          id: request.params.id,
          version: request.body.version,
          actor: actorOf(request),
        });
        if (version === null) {
          throw httpError(
            'not-found',
            `技能或版本不存在：${request.params.id} v${String(request.body.version)}`,
          );
        }
        const detail = await deps.store.get(request.params.id);
        if (detail === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
        return detail;
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  // ── 8. DELETE /api/skills/:id（默认软删；?hard=true 仅限上传来源）──────────
  app.delete(
    '/api/skills/:id',
    {
      schema: {
        params: skillIdParams,
        querystring: z.object({ hard: z.enum(['true', 'false']).optional() }).strict(),
        response: { 200: skillDeleteResponseSchema },
      },
      preHandler: writeGuard,
    },
    async (request) => {
      const hard = request.query.hard === 'true';
      try {
        const ok = await deps.store.remove({
          id: request.params.id,
          hard,
          actor: actorOf(request),
        });
        if (!ok) throw httpError('not-found', `技能不存在：${request.params.id}`);
        return { ok: true, id: request.params.id, hard };
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  /**
   * `PUT /api/skills/:id` —— 面板「在线编辑」保存**整份 SKILL.md**（frontmatter + 正文）。
   *
   * 与 `PATCH` 的分工：`PATCH` 是字段级局部更新（`enabled` / `description` / `body`），
   * 这个接口收编辑器里的整份文本，只在这里拆开；frontmatter 仍走 `parseSkillFile` 的同一套校验
   * （面板自己的解析不可信）。
   */
  app.put(
    '/api/skills/:id',
    {
      schema: {
        params: skillIdParams,
        body: z.object({ text: z.string().min(20).max(200_000) }).strict(),
        response: { 200: skillDetailSchema },
      },
      preHandler: writeGuard,
    },
    async (request) => {
      const parsed = parseSkillFile(request.body.text);
      if (!parsed.ok) {
        // 走错误处理中间件映射成 400（这条路只声明了 200，不能 reply.status(400)）
        throw httpError('bad-request', `SKILL_FRONTMATTER_INVALID：${parsed.detail}`);
      }
      const detail = await deps.store.get(request.params.id);
      if (detail === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
      if (parsed.name !== null && parsed.name !== detail.name) {
        throw httpError(
          'bad-request',
          `不允许在编辑器里改技能名（当前 ${detail.name}，收到 ${parsed.name}）：请新建技能后再删旧的`,
        );
      }
      const current = await deps.store.fileTexts({ id: request.params.id });
      if (current === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
      // 整份 SKILL.md 覆盖：必须走「重建整包 + upload」，不能走 `store.patch({body})` ——
      // patch 明确只换正文、保留原 frontmatter 原文，于是改 `allowed-tools` / `timeout` /
      // `outputs` 的人看到「保存成功」，运行时却仍按旧配置（磁盘上的 SKILL.md 也没变）。
      const bundle = bundleFromFiles(replaceFileIn(current, 'SKILL.md', request.body.text));
      if (!bundle.validation.ok) {
        throw httpError('bad-request', `技能校验不通过：${bundle.validation.errors.join('；')}`, {
          errors: bundle.validation.errors,
        });
      }
      try {
        await deps.store.upload({
          bundle,
          repo: detail.repo,
          enabled: detail.enabled,
          actor: actorOf(request),
        });
        const next = await deps.store.get(request.params.id);
        if (next === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
        return next;
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  /**
   * `GET /api/skills/:id/files` —— 技能目录里**每个文本文件的内容**。
   *
   * 面板模态框要显示目录树并允许改任意一个 markdown，所以一次全拉（技能包 ≤200 个文件、
   * 单个 ≤5 MB，一次全量比逐文件请求省事且没有路径编码问题）。
   */
  app.get(
    '/api/skills/:id/files',
    {
      schema: { params: skillIdParams, response: { 200: skillFilesResponseSchema } },
      preHandler: guard,
    },
    async (request) => {
      const files = await deps.store.fileTexts({ id: request.params.id });
      if (files === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
      return { generatedAt: new Date().toISOString(), skillId: request.params.id, files };
    },
  );

  /**
   * `PUT /api/skills/:id/files` —— 保存**一个**文件（要求 2「支持 markdown 文件的修改」）。
   *
   * 做法：取出当前版本的全部文件文本 → 替换目标文件 → `bundleFromFiles` 重建技能包 →
   * `store.upload` 落成**新版本**（既有版本的审计/回滚能力因此自动继承，无需新的写库路径）。
   *
   * 两道额外约束：
   * - 只接受文本文件扩展名（二进制在 bundle 层就被排除，改了也不该由编辑器发起）；
   * - 不允许改 `name`：改名会让 `upload` 变成「新建另一个技能」，用户以为在编辑，实际多出一个。
   */
  app.put(
    '/api/skills/:id/files',
    {
      schema: {
        params: skillIdParams,
        body: skillFileWriteSchema,
        response: { 200: skillDetailSchema },
      },
      preHandler: writeGuard,
    },
    async (request) => {
      const path = normalizeSkillFilePath(request.body.path);
      if (path === null) {
        throw httpError('bad-request', `非法的文件路径：${request.body.path.slice(0, 120)}`);
      }
      if (!isEditableSkillPath(path)) {
        throw httpError('bad-request', `只支持编辑文本文件（md / txt / json / yaml / toml）：${path}`);
      }
      const detail = await deps.store.get(request.params.id);
      if (detail === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
      const current = await deps.store.fileTexts({ id: request.params.id });
      if (current === null) throw httpError('not-found', `技能不存在：${request.params.id}`);

      const bundle = bundleFromFiles(replaceFileIn(current, path, request.body.text));
      if (!bundle.validation.ok) {
        throw httpError('bad-request', `技能校验不通过：${bundle.validation.errors.join('；')}`, {
          errors: bundle.validation.errors,
        });
      }
      if (bundle.name !== detail.name) {
        throw httpError(
          'bad-request',
          `不允许在编辑器里改技能名（当前 ${detail.name}，收到 ${bundle.name}）：请新建技能后再删旧的`,
        );
      }
      const repo = detail.repo;
      try {
        const result = await deps.store.upload({
          bundle,
          repo,
          enabled: detail.enabled,
          actor: actorOf(request),
        });
        const next = await deps.store.get(result.skill.id);
        if (next === null) throw httpError('not-found', `技能不存在：${request.params.id}`);
        deps.logger?.info(
          { skillId: next.id, name: next.name, path, version: result.version },
          '技能文件已保存为新版本',
        );
        return next;
      } catch (error) {
        return mapStoreError(error);
      }
    },
  );

  /**
   * `POST /api/skills/import` —— 一个 zip 里**多个技能目录**批量导入（要求 4）。
   *
   * 与 `POST /api/skills` 的区别：那个只认「一个 zip 一个技能」，多目录时会报错；
   * 这个按「每个含 SKILL.md 的目录 = 一个技能」拆开，逐个走同一个 `store.upload`。
   * 同名技能自然被覆盖成新版本（`created=false`）—— 这就是「上传覆盖」的语义，
   * 不需要额外的 mode 参数。
   *
   * 部分成功返回 200 + `errors`：客户端据此提示「导入 2 个，跳过 1 个」比整包失败更好用。
   */
  app.post(
    '/api/skills/import',
    {
      schema: { querystring: skillUploadQuerySchema, response: { 200: skillImportResponseSchema } },
      preHandler: writeGuard,
    },
    async (request) => {
      const query = request.query;
      if (!Buffer.isBuffer(request.body)) {
        throw httpError('bad-request', 'body 必须是原始 zip 字节（Content-Type: application/zip）');
      }
      let split;
      try {
        split = splitZipBundles(new Uint8Array(request.body));
      } catch (error) {
        if (error instanceof ZipError) {
          throw httpError('bad-request', `zip 解析失败：${error.message}`);
        }
        throw error;
      }

      const imported: {
        id: string;
        name: string;
        version: number;
        created: boolean;
      }[] = [];
      const errors = [...split.errors];
      const warnings: string[] = [];

      for (const bundle of split.bundles) {
        if (!bundle.validation.ok) {
          errors.push(`${bundle.name}：${bundle.validation.errors.join('；')}`);
          continue;
        }
        warnings.push(...bundle.validation.warnings);
        try {
          const result = await deps.store.upload({
            bundle,
            repo: query.repo,
            enabled: query.enabled === 'true',
            actor: actorOf(request),
          });
          imported.push({
            id: result.skill.id,
            name: result.skill.name,
            version: result.version,
            created: result.created,
          });
        } catch (error) {
          errors.push(
            `${bundle.name}：${error instanceof SkillStoreError ? error.message : String(error)}`,
          );
        }
      }

      deps.logger?.info(
        { imported: imported.length, skipped: errors.length, repo: query.repo ?? null },
        '技能 zip 已导入',
      );
      return {
        generatedAt: new Date().toISOString(),
        imported,
        errors: errors.slice(0, 50),
        warnings: [...new Set(warnings)].slice(0, 50),
      };
    },
  );
}
