/**
 * 角色成员契约：**必须能存 GitHub 用户 id，且必须仍能读旧配置**（需求 §6.6「两个坑」/ 审计 `CC-3`）。
 *
 * 三条断言面：
 *  1. 新写法 `{login, id}` 合法，`id` 必须是正整数（0 / 负数 / 小数 / 缺 id 一律拒收）；
 *  2. 旧写法裸 login 仍合法（`repos.settings` 是 jsonb，老行里存的就是 `['alice']`）；
 *  3. `resolveRoleMembers()` 只做形状归一：旧写法摊成 `{login, id: null}`，**不猜 id**。
 */
import { describe, expect, it } from 'vitest';
import { commentConfigSchema, resolveRoleMembers } from '../src/settings-v21.ts';

const config = (members: unknown) => ({
  mentions: [{ keyword: 'pi-bot' }],
  roles: [{ name: '值班同学', by: 'members', members }],
});

describe('成员可以带 GitHub 用户 id', () => {
  it('{login, id} 合法', () => {
    expect(commentConfigSchema.safeParse(config([{ login: 'alice', id: 1001 }])).success).toBe(true);
  });

  it('id 必须是正整数：0 / 负数 / 小数 / 字符串 / 缺失全部拒收', () => {
    for (const members of [
      [{ login: 'alice', id: 0 }],
      [{ login: 'alice', id: -1 }],
      [{ login: 'alice', id: 1.5 }],
      [{ login: 'alice', id: '1001' }],
      [{ login: 'alice' }],
    ]) {
      expect(commentConfigSchema.safeParse(config(members)).success, JSON.stringify(members)).toBe(false);
    }
  });

  it('未知键仍被拒收（.strict()）：写错成 userId 不会静默变成「没有 id」', () => {
    expect(commentConfigSchema.safeParse(config([{ login: 'alice', userId: 1001 }])).success).toBe(false);
  });

  it('成员 login 仍只支持个人账号：org/team 写法拒收', () => {
    expect(commentConfigSchema.safeParse(config([{ login: 'acme/team', id: 1001 }])).success).toBe(false);
  });
});

describe('旧配置（裸 login）仍可读', () => {
  it("['alice'] 合法（坑一之前写下的配置不会因为升级就打不开面板）", () => {
    expect(commentConfigSchema.safeParse(config(['alice', 'bob'])).success).toBe(true);
  });

  it('新旧写法可以混在同一条角色里', () => {
    const parsed = commentConfigSchema.safeParse(config(['alice', { login: 'bob', id: 2002 }]));
    expect(parsed.success).toBe(true);
  });
});

describe('resolveRoleMembers：只归一，不猜 id', () => {
  it('旧写法 → id 为 null（缺 id 是显式值，判定侧据此降级并留痕）', () => {
    expect(resolveRoleMembers(['alice', { login: 'bob', id: 2002 }])).toEqual([
      { login: 'alice', id: null },
      { login: 'bob', id: 2002 },
    ]);
  });
});
