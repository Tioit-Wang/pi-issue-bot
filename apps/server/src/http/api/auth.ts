/**
 * 面板鉴权的**注入点**（B10；契约 §0.2 的 401/403 语义）。
 *
 * 本切片只做「会话校验 + 组织成员校验的接口」，**不做 OAuth 流程**：
 * `GET /api/auth/login`、回调、cookie 下发、`Members:read` 调用都属于面板切片，
 * 这里把它们的产物（`panel_sessions` 行 + 成员判定）抽象成两个注入点：
 *
 *   - `store`：读 `panel_sessions`（真实实现是 `pg.Pool`）；
 *   - `isOrgMember`：GitHub `Members: read` 校验（可选；不传则跳过成员校验并记 warn）。
 *
 * 401 与 403 的分工（契约 §0.2，面板据此决定「跳登录」还是「显示不是成员」）：
 *   - 没有 `sid` cookie / 会话行不存在 / 已过期 → **401 unauthorized**
 *   - 会话有效但不在组织内 → **403 forbidden**
 *
 * TODO(owner: 面板切片)：OAuth 登录与回调（`panel_sessions` 写入、7 天过期、吊销）、
 * `isOrgMember` 的真实实现（`GET /orgs/{org}/members/{username}`，用 installation token 或 App JWT）。
 */
import type { FastifyRequest } from 'fastify';
import type { Logger } from '../../../../../packages/shared/src/index.ts';
import { httpError } from '../errors.ts';

/** 会话 cookie 名。cookie 里**只**放 `sid`，不放任何身份信息或签名载荷（tech-plan R3）。 */
export const PANEL_SESSION_COOKIE = 'sid';

/** 鉴权通过后的上下文（`login` 来自 `panel_sessions`，不是 cookie 里自报的）。 */
export type AuthContext = {
  readonly sid: string;
  readonly login: string;
};

/** 鉴权钩子：校验失败**抛** `HttpError`（401/403），成功返回上下文。 */
export type RequireAuth = (request: FastifyRequest) => Promise<AuthContext>;

/** 只读 `panel_sessions` 需要的最小接口（真实实现是 `pg.Pool`）。 */
export type SessionStore = {
  query: (text: string, values?: readonly unknown[]) => Promise<{
    readonly rows: unknown[];
  }>;
};

export const PANEL_SESSION_SQL = {
  /** $1 = sid → { sid, login, expires_at } */
  lookup: `SELECT "sid", "login", "expires_at" FROM "panel_sessions" WHERE "sid" = $1`,
} as const;

/** 从 `Cookie` 头里取一个 cookie（不引 cookie 解析库：只需要一个键，多一条依赖不值）。 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === '') {
    return null;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    if (key !== name) {
      continue;
    }
    const value = part.slice(index + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

export type CreateSessionAuthDeps = {
  readonly store: SessionStore;
  /** 组织成员校验；不传则跳过（仅 401 语义）。 */
  readonly isOrgMember?: (login: string) => Promise<boolean>;
  readonly logger?: Logger;
  readonly now?: () => Date;
};

/**
 * 建一个 `RequireAuth`：查 `panel_sessions` → 过期判定 → 成员判定。
 *
 * 为什么过期判定在 SQL 之外：`expires_at` 的比较要用**注入的时钟**，
 * 否则测试得等到真过期；而 SQL 里塞 `now()` 会让「时钟注入」失效。
 */
export function createSessionAuth(deps: CreateSessionAuthDeps): RequireAuth {
  const now = deps.now ?? ((): Date => new Date());

  return async (request) => {
    const sid = readCookie(request.headers.cookie, PANEL_SESSION_COOKIE);
    if (sid === null) {
      throw httpError('unauthorized', '未登录：缺少面板会话 cookie');
    }

    const result = await deps.store.query(PANEL_SESSION_SQL.lookup, [sid]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw httpError('unauthorized', '会话无效或已被吊销');
    }

    const expiresAt = row['expires_at'];
    const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
    if (Number.isNaN(expiresMs) || expiresMs <= now().getTime()) {
      throw httpError('unauthorized', '会话已过期，请重新登录');
    }

    const login = typeof row['login'] === 'string' ? row['login'] : '';
    if (login === '') {
      throw httpError('unauthorized', '会话缺少 login，请重新登录');
    }

    if (deps.isOrgMember !== undefined) {
      const member = await deps.isOrgMember(login);
      if (!member) {
        // 403 而不是 401：再登一次也一样（契约 §0.2）
        throw httpError('forbidden', `「${login}」不是组织成员`);
      }
    } else {
      deps.logger?.warn({ login }, '未注入组织成员校验（isOrgMember），仅做会话校验');
    }

    return { sid, login };
  };
}

/**
 * 本地/测试用的「放行」鉴权：**只**给 `--allow-anonymous` 之类的开发场景，
 * 生产路径必须用 `createSessionAuth`。
 */
export function createAllowAllAuth(login = 'local-dev'): RequireAuth {
  return async () => ({ sid: 'local-dev', login });
}
