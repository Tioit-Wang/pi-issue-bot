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
  skillDetailSchema,
  skillPatchSchema,
  skillRollbackBodySchema,
  skillUploadQuerySchema,
  skillUploadResponseSchema,
  skillVersionsResponseSchema,
  skillsQuerySchema,
  skillsResponseSchema,
} from '../../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../../packages/shared/src/index.ts';
import { SkillStoreError } from '../../skills/store.ts';
import type { SkillStore } from '../../skills/store.ts';
import { ZipError, extractSkillBundle } from '../../skills/bundle.ts';
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

/** 默认只看启用的：`skillsQuerySchema.enabled` 是 `'true'|'false'` 字符串。 */
const listFilterOf = (query: z.infer<typeof skillsQuerySchema>) => ({
  scope: query.scope,
  repo: query.repo,
  enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
  source: query.source,
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
      schema: { querystring: skillsQuerySchema, response: { 200: skillsResponseSchema } },
      preHandler: guard,
    },
    async (request) => ({
      generatedAt: new Date().toISOString(),
      skills: await deps.store.list(listFilterOf(request.query)),
    }),
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
          scope: query.scope,
          repo: query.repo ?? null,
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
          scope: existing.scope,
          repo: existing.repo,
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
}
