/**
 * 角色成员匹配必须**以 GitHub 用户 id 为准**（需求 §6.6 坑一：login 会变；审计 `CC-3`）。
 *
 * 三条必测面：
 *  1. 改名后仍然命中 —— 同一个 id 换了 login，成员资格跟着 id 走；
 *  2. **旧 login 被别人占用不命中** —— 只按 login 比对时这类人会白拿权限（坑一本身）；
 *  3. id 缺失时降级按 login 匹配，但必须回传 `loginFallbacks` 留痕（不许静默）。
 *
 * 全部通过真配置层（`resolveCommentConfig`）喂进判定，避免「测试自己拼了一个假角色对象」
 * 把配置→判定的接线（`settings-v21` → `v21-settings` → `roles`）漏掉。
 */
import { describe, expect, it } from 'vitest';
import { resolveCommentConfig } from '../src/config/v21-settings.ts';
import { matchCommentRole } from '../src/trigger/roles.ts';

const ROLE = '值班同学';

/** 一份带「指定成员」角色的项目配置；成员写法可换（新对象 / 旧裸 login）。 */
function settingsWithMembers(members: readonly unknown[]) {
  return {
    comment: {
      mentions: [{ keyword: 'pi-bot' }],
      roles: [{ name: ROLE, by: 'members', members }],
    },
    triggers: {
      events: { 'issue_comment.created': { gates: { require_role: true, allow_roles: [ROLE] } } },
    },
  };
}

function match(settings: unknown, author: { readonly login: string | null; readonly id?: number | null }) {
  const resolved = resolveCommentConfig(settings);
  // 夹具本身必须是合法配置，否则解析会回退默认值、角色清单为空 → 用例变成空转。
  expect(resolved.ok).toBe(true);
  expect(resolved.roles).toHaveLength(1);
  return matchCommentRole({
    roles: resolved.roles,
    allowRoles: [ROLE],
    authorAssociation: 'NONE',
    authorLogin: author.login,
    authorId: author.id ?? null,
  });
}

describe('成员按 user id 匹配（CC-3）', () => {
  it('同一个 id 换了 login 仍然命中（改名不影响资格）', () => {
    const result = match(settingsWithMembers([{ login: 'alice', id: 1001 }]), {
      login: 'alice-renamed',
      id: 1001,
    });
    expect(result.allowed).toBe(true);
    expect(result.matchedRoles).toEqual([ROLE]);
    // 按 id 命中 = 没有降级
    expect(result.loginFallbacks).toEqual([]);
  });

  it('旧 login 被别人抢注后**不**命中（坑一：只按 login 比就是权限旁路）', () => {
    const result = match(settingsWithMembers([{ login: 'alice', id: 1001 }]), {
      login: 'alice',
      id: 2002,
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedRoles).toEqual([]);
    expect(result.loginFallbacks).toEqual([]);
  });

  it('login 不同、id 也不同 → 不命中', () => {
    const result = match(settingsWithMembers([{ login: 'alice', id: 1001 }]), {
      login: 'bob',
      id: 2002,
    });
    expect(result.allowed).toBe(false);
  });

  it('大小写不影响 id 匹配（login 拼写与 id 都看 id）', () => {
    const result = match(settingsWithMembers([{ login: 'Alice', id: 1001 }]), {
      login: 'ALICE',
      id: 1001,
    });
    expect(result.allowed).toBe(true);
    expect(result.loginFallbacks).toEqual([]);
  });
});

describe('缺 id 时的降级匹配必须留痕（CC-3 的兼容半）', () => {
  it('旧配置只有 login（无 id）→ 按 login 命中，并回传 member-without-id', () => {
    const result = match(settingsWithMembers(['alice']), { login: 'ALICE', id: 1001 });
    expect(result.allowed).toBe(true);
    expect(result.loginFallbacks).toEqual([{ role: ROLE, login: 'alice', reason: 'member-without-id' }]);
  });

  it('配置有 id 但载荷没给作者 id → 按 login 命中，并回传 author-without-id', () => {
    const result = match(settingsWithMembers([{ login: 'alice', id: 1001 }]), { login: 'alice', id: null });
    expect(result.allowed).toBe(true);
    expect(result.loginFallbacks).toEqual([{ role: ROLE, login: 'alice', reason: 'author-without-id' }]);
  });

  it('旧配置 + login 不匹配 → 不命中（降级不是放行）', () => {
    const result = match(settingsWithMembers(['alice']), { login: 'bob', id: 2002 });
    expect(result.allowed).toBe(false);
    expect(result.loginFallbacks).toEqual([]);
  });

  it('两侧都没有 id 且 login 缺失 → 不命中（不猜任何人）', () => {
    const result = match(settingsWithMembers(['alice']), { login: null });
    expect(result.allowed).toBe(false);
  });
});

describe('作者关联分支不受 id 改动影响', () => {
  it('association 仍然按 author_association 命中', () => {
    const resolved = resolveCommentConfig({
      comment: {
        mentions: [{ keyword: 'pi-bot' }],
        roles: [{ name: '维护者', by: 'association', any_of: ['OWNER', 'MEMBER'] }],
      },
      triggers: { events: { 'issue_comment.created': { gates: { require_role: true, allow_roles: ['维护者'] } } } },
    });
    expect(resolved.ok).toBe(true);
    const result = matchCommentRole({
      roles: resolved.roles,
      allowRoles: ['维护者'],
      authorAssociation: 'MEMBER',
      authorLogin: null,
      authorId: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.matchedRoles).toEqual(['维护者']);
    expect(result.loginFallbacks).toEqual([]);
  });
});
