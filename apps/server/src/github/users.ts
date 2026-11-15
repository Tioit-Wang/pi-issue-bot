/**
 * GitHub 用户查询端口（`GET /users/{login}`）—— 只服务一件事：**把角色成员的 login 解析成用户 id**，
 * 同时回答「这个账号到底存不存在」（需求 §6.6「两个坑」）。
 *
 * 为什么要单独一个端口而不是让人直接摸 octokit：
 *  - 保存配置那条路径在 `http/api` 里，它只该依赖一个「给 login 换 id」的函数，
 *    不该认识 Octokit 的 route/params（那是 `github/` 的职责）；
 *  - 单测需要一个不用网络的假实现（`vi.mock` 在本仓库是硬禁的），端口注入是唯一正道。
 *
 * 两条语义边界：
 *  1. **404 = 账号不存在 → `null`**，这是正常结论，不是错误（调用方据此拒绝保存配置）；
 *  2. 其它失败（401/403/5xx/网络）**一律抛**。绝不把「查不到」与「查询失败」混成一个 `null`——
 *     混了就等于「网络抖一下就把拼错的账号放进去」，正是坑二的成因。
 */
import { classifyGithubError, describeGithubError } from './errors.ts';
import type { GithubClient } from './types.ts';

/** 一个 GitHub 用户的最小投影：`id` 是跨改名的稳定标识，`login` 只用于显示。 */
export type GithubUserRef = {
  readonly login: string;
  readonly id: number;
};

/** 注入式端口：给 login 换 `{login, id}`。 */
export type GithubUserLookup = {
  /**
   * 查一个 login。
   *
   * @returns `{login, id}`；账号不存在（HTTP 404）返回 `null`
   * @throws GitHub 侧其它失败（鉴权 / 限流 / 5xx / 网络）：**不吞**，调用方必须显式失败
   */
  readonly findUser: (login: string) => Promise<GithubUserRef | null>;
};

/** `GET /users/{username}` 里我们真正读的两个字段（其余一概不读，避免把用户隐私带进日志）。 */
type RawGithubUser = {
  readonly login?: unknown;
  readonly id?: unknown;
};

/** 用真实客户端实现端口。 */
export function createGithubUserLookup(client: GithubClient): GithubUserLookup {
  return {
    async findUser(login: string): Promise<GithubUserRef | null> {
      const username = login.trim();
      if (username === '') {
        // 空 login 不是「不存在」而是调用方给错了（配置形状层已拦），这里显式抛。
        throw new Error('createGithubUserLookup: login 不能为空');
      }
      let data: RawGithubUser;
      try {
        const response = await client.request<RawGithubUser>('GET /users/{username}', { username });
        data = response.data ?? {};
      } catch (error) {
        const info = classifyGithubError(error);
        if (info.status === 404) {
          return null;
        }
        throw new Error(`查询 GitHub 账号失败：@${username}（${describeGithubError(info)}）`, { cause: error });
      }
      const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0 ? data.id : null;
      const canonicalLogin = typeof data.login === 'string' && data.login !== '' ? data.login : null;
      if (id === null || canonicalLogin === null) {
        // 响应缺 id / login 属于协议异常：当成「查不到」会把坑二重新变成静默失效，所以抛。
        throw new Error(`查询 GitHub 账号失败：@${username} 的响应缺少 user.id / user.login`);
      }
      return { login: canonicalLogin, id };
    },
  };
}
