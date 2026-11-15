/**
 * 保存配置时的角色成员校验（需求 §6.6 坑二 / 审计 `CC-4`）与 login→id 解析（坑一 / `CC-3`）。
 *
 * 断言的全是**可观察事实**：
 *  - 账号不存在 → 校验失败，错误消息里有点名的 login，且**没有**任何「写回」结果；
 *  - 账号存在 → 写回后的成员是 `{login, id}`，其中 login 用 GitHub 的规范写法；
 *  - 同一个 login 只查一次（大小写归一）；
 *  - 缺凭据 / 请求失败 → 显式失败，绝不静默放行（那正是坑二本身）。
 *
 * 假件是**注入的端口**（`GithubUserLookup`），不是 `vi.mock`（仓库硬规则）。
 */
import { describe, expect, it } from 'vitest';
import { repoSettingsSchema } from '../../../packages/contract/src/index.ts';
import { verifyCommentRoleMembers } from '../src/config/comment-members.ts';
import type { GithubUserLookup, GithubUserRef } from '../src/github/users.ts';
import { parseValidSettings } from './helpers/repo-settings.ts';

/** 一个会记账的假查询端口：`known` 是「GitHub 上真实存在」的账号表。 */
function fakeLookup(known: Readonly<Record<string, GithubUserRef>>, options: { readonly fail?: string } = {}) {
  const calls: string[] = [];
  const lookup: GithubUserLookup = {
    async findUser(login: string): Promise<GithubUserRef | null> {
      calls.push(login);
      if (options.fail !== undefined && login.toLowerCase() === options.fail.toLowerCase()) {
        throw new Error('HTTP 502 Bad Gateway');
      }
      return known[login.toLowerCase()] ?? null;
    },
  };
  return { lookup, calls };
}

const ALICE: GithubUserRef = { login: 'Alice', id: 1001 };

/** 一份带「指定成员」角色的合法配置（成员写法可换）。 */
function settingsWithMembers(members: readonly unknown[]) {
  return parseValidSettings({
    comment: {
      mentions: [{ keyword: 'pi-bot' }],
      roles: [{ name: '值班同学', by: 'members', members }],
    },
  });
}

/** 读回写后的成员数组（断言只看这一格）。 */
function membersOf(settings: ReturnType<typeof settingsWithMembers>): unknown {
  const role = settings.comment.roles.find((item) => item.name === '值班同学');
  return role === undefined || role.by !== 'members' ? null : role.members;
}

describe('CC-4：账号不存在就拒绝保存', () => {
  it('拼错一个字母 → 校验失败，错误点名字被拒的 login，且没有写出任何配置', async () => {
    const { lookup } = fakeLookup({ alice: ALICE });
    const result = await verifyCommentRoleMembers(settingsWithMembers(['alcie']), lookup);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe('unknown-user');
    expect(result.error).toContain('@alcie');
    expect(result.error).toContain('已拒绝保存');
    expect(result.issues).toEqual(['comment.roles.members: GitHub 上不存在账号 @alcie']);
  });

  it('多个成员里只有一个不存在 → 整体拒绝（不做部分保存）', async () => {
    const { lookup } = fakeLookup({ alice: ALICE });
    const result = await verifyCommentRoleMembers(settingsWithMembers(['alice', 'bob']), lookup);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('@bob');
    expect(result.error).not.toContain('@alice');
  });
});

describe('CC-3：保存时把 login 解析成 user id', () => {
  it('旧写法（裸 login）→ 写回后是 {login, id}，login 用 GitHub 的规范大小写', async () => {
    const { lookup } = fakeLookup({ alice: ALICE });
    const result = await verifyCommentRoleMembers(settingsWithMembers(['alice']), lookup);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(membersOf(result.settings)).toEqual([{ login: 'Alice', id: 1001 }]);
    expect(result.resolved).toEqual([{ role: '值班同学', login: 'Alice', id: 1001 }]);
    // 写回的配置仍必须能通过契约（否则「保存成功但库里是非法配置」）
    expect(repoSettingsSchema.safeParse(result.settings).success).toBe(true);
  });

  it('新写法（已有 id）也会被 GitHub 的真值覆盖：id 以查询结果为准', async () => {
    const { lookup } = fakeLookup({ alice: ALICE });
    const result = await verifyCommentRoleMembers(settingsWithMembers([{ login: 'alice', id: 9 }]), lookup);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(membersOf(result.settings)).toEqual([{ login: 'Alice', id: 1001 }]);
  });

  it('同一个 login 出现两处只查一次（大小写归一）', async () => {
    const { lookup, calls } = fakeLookup({ alice: ALICE });
    const settings = parseValidSettings({
      comment: {
        mentions: [{ keyword: 'pi-bot' }],
        roles: [
          { name: '值班', by: 'members', members: ['alice'] },
          { name: '备份', by: 'members', members: ['ALICE'] },
        ],
      },
    });
    const result = await verifyCommentRoleMembers(settings, lookup);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['alice']);
  });

  it('没有任何成员角色时一次请求都不发', async () => {
    const { lookup, calls } = fakeLookup({});
    const settings = parseValidSettings({
      comment: { mentions: [{ keyword: 'pi-bot' }], roles: [{ name: '维护者', by: 'association', any_of: ['OWNER'] }] },
    });
    const result = await verifyCommentRoleMembers(settings, lookup);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('查询失败不是「查不到」：两者都必须拒绝保存', () => {
  it('GitHub 请求失败 → lookup-failed（不是 unknown-user，也不是放行）', async () => {
    const { lookup } = fakeLookup({ alice: ALICE }, { fail: 'alice' });
    const result = await verifyCommentRoleMembers(settingsWithMembers(['alice']), lookup);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe('lookup-failed');
    expect(result.error).toContain('HTTP 502');
  });

  it('本部署没有 GitHub 凭据 → lookup-unavailable，并说明为什么拒绝', async () => {
    const result = await verifyCommentRoleMembers(settingsWithMembers(['alice']), undefined);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe('lookup-unavailable');
    expect(result.error).toContain('没有可用的 GitHub 凭据');
    expect(result.issues).toEqual(['comment.roles: 无法校验 @alice（缺少 GitHub 凭据）']);
  });
});
