/**
 * 保存配置时的**角色成员校验与解析**（需求 §6.6「两个坑」：CC-3 存 user id / CC-4 校验账号存在）。
 *
 * 一段代码同时堵两个坑，因为它们是同一个 GitHub 请求的两半：
 *  - 拼错一个字母 → `GET /users/{login}` 返回 404 → **拒绝保存**（坑二：不许永久静默失效）；
 *  - 拼对了 → 拿到 `{id}` → 连同 login 一起写回配置（坑一：login 会变，判定以 id 为准）。
 *
 * 三条硬规则：
 * 1. **校验失败必须显式失败**：`null`（不存在）与「请求失败」分开两种结论，
 *    两者都让保存失败——「先存下、以后再校验」正是坑二的成因。
 * 2. **没有可用的 GitHub 凭据时不许静默放行**：要么显式拒绝保存并说明原因，
 *    要么用户永远不知道自己拼错了。
 * 3. **同一个 login 只查一次**（大小写归一）：50 个成员的角色清单不该打 50 次重复请求。
 */
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';
import type { GithubUserLookup, GithubUserRef } from '../github/users.ts';

/**
 * 端口类型的**再出口**：`http/api` 的 eslint zone 不许它直接 import `github/`（`tech-plan §8.2`
 * 的「http/api 不得直接碰执行面」）。这里只搬类型、不复制定义 —— 唯一声明与实现仍在
 * `github/users.ts`，所以「假实现要满足什么」只有一处。
 */
export type { GithubUserLookup, GithubUserRef };

/** 校验结论：成功时带回**改写后的 settings**（成员已补上 id 与 GitHub 上的规范 login）。 */
export type CommentMemberVerification =
  | {
      readonly ok: true;
      readonly settings: RepoConfig;
      /** 本次解析出的成员（按角色/成员顺序，含规范 login 与 id），供调用方记日志或回显 */
      readonly resolved: readonly CommentMemberResolution[];
    }
  | {
      readonly ok: false;
      /**
       * - `unknown-user`：账号不存在（拼错）→ HTTP 400
       * - `lookup-failed`：GitHub 请求失败（鉴权 / 限流 / 网络）→ HTTP 503
       * - `lookup-unavailable`：本部署没有 GitHub 凭据，无法校验 → HTTP 503
       */
      readonly kind: 'unknown-user' | 'lookup-failed' | 'lookup-unavailable';
      /** 可直接展示给面板用户的一句话（截到 500 字，与 `repos.settings_error` 同口径） */
      readonly error: string;
      /** 逐条细节（面板 `details.issues` 就是它） */
      readonly issues: readonly string[];
    };

/** 一条被解析过的成员：角色的哪个成员换成了哪个 id。 */
export type CommentMemberResolution = {
  readonly role: string;
  readonly login: string;
  readonly id: number;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取所有「按成员定义」的角色里的成员 login（保持顺序、按小写去重）。 */
function memberLogins(settings: RepoConfig): string[] {
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const role of settings.comment.roles) {
    if (role.by !== 'members') {
      continue;
    }
    for (const member of role.members) {
      const login = (typeof member === 'string' ? member : member.login).trim();
      const key = login.toLowerCase();
      if (login === '' || seen.has(key)) {
        continue;
      }
      seen.add(key);
      logins.push(login);
    }
  }
  return logins;
}

/**
 * 校验并解析角色成员账号。
 *
 * @param settings 已通过 `repoSettingsSchema` 的配置（保存路径先跑 zod，再跑这里）
 * @param lookup GitHub 用户查询端口；`undefined` = 本部署没有 GitHub 凭据
 */
export async function verifyCommentRoleMembers(
  settings: RepoConfig,
  lookup: GithubUserLookup | undefined,
): Promise<CommentMemberVerification> {
  const logins = memberLogins(settings);
  if (logins.length === 0) {
    return { ok: true, settings, resolved: [] };
  }

  if (lookup === undefined) {
    return {
      ok: false,
      kind: 'lookup-unavailable',
      error:
        '本部署没有可用的 GitHub 凭据（未配置 GitHub App / token），无法校验角色成员账号，已拒绝保存；' +
        '去掉「指定成员」角色后可以保存，或在配置好凭据后重试（否则拼错的 login 会让该成员永久无法触发且没有任何提示）',
      issues: logins.map((login) => `comment.roles: 无法校验 @${login}（缺少 GitHub 凭据）`),
    };
  }

  const found = new Map<string, GithubUserRef>();
  const missing: string[] = [];
  const failures: string[] = [];

  for (const login of logins) {
    try {
      const user = await lookup.findUser(login);
      if (user === null) {
        missing.push(login);
      } else {
        // 大小写以 GitHub 为准：配置里留的是「用户当时怎么写的」，显示与降级匹配都按真实 login。
        found.set(login.toLowerCase(), user);
      }
    } catch (error) {
      failures.push(`@${login}: ${describeError(error)}`);
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      kind: 'lookup-failed',
      error: `校验角色成员账号失败（GitHub 请求未成功，未保存）：${failures.join('; ')}`.slice(0, 500),
      issues: failures,
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'unknown-user',
      error: `角色成员账号不存在：${missing.map((login) => `@${login}`).join('、')}（拼错的 login 会让该成员永久无法触发，已拒绝保存）`.slice(
        0,
        500,
      ),
      issues: missing.map((login) => `comment.roles.members: GitHub 上不存在账号 @${login}`),
    };
  }

  const resolved: CommentMemberResolution[] = [];
  const roles = settings.comment.roles.map((role) => {
    if (role.by !== 'members') {
      return role;
    }
    const members = role.members.map((member) => {
      const login = (typeof member === 'string' ? member : member.login).trim();
      const user = found.get(login.toLowerCase());
      // `missing` 已保证每个 login 都能查到，这里的兜底只为类型收窄（真走到就是 bug，宁可抛）。
      if (user === undefined) {
        throw new Error(`verifyCommentRoleMembers: 成员 @${login} 未解析出 id（内部错误）`);
      }
      resolved.push({ role: role.name, login: user.login, id: user.id });
      return { login: user.login, id: user.id };
    });
    return { ...role, members };
  });

  return {
    ok: true,
    settings: { ...settings, comment: { ...settings.comment, roles } },
    resolved,
  };
}
