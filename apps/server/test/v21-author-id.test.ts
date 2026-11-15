/**
 * 作者 id 必须真的进到判定链（需求 §6.6 坑一 / 审计 `CC-3` 的接线半）。
 *
 * `trigger/roles.ts` 里「以 id 为准」再正确，只要 webhook 解析没把 `comment.user.id` 传进去，
 * 线上就仍然是「按 login 匹配」。所以这里从**载荷**一路走到**判定结果**：
 *  1. 载荷带 id + 配置带 id → 命中且**没有**降级留痕；
 *  2. 载荷带 id、成员改名后 → 仍命中（按 id），不因 login 变化丢权限；
 *  3. 同 login 但 id 不同（旧 login 被别人抢注）→ **不命中**；
 *  4. 旧配置（成员无 id）→ 命中但带 `roleLoginFallbacks`（降级必须留痕）。
 */
import { describe, expect, it } from 'vitest';
import { decideV21Delivery, v21DecisionInputOf } from '../src/http/webhook-v21.ts';

/** 构造一条 `issue_comment.created` 载荷；`userId` 传 `undefined` = 载荷不带 id。 */
function payloadWith(user: { readonly login: string; readonly id?: number | undefined }) {
  const userObject: Record<string, unknown> = { login: user.login, type: 'User' };
  if (user.id !== undefined) {
    userObject['id'] = user.id;
  }
  return {
    issue: { number: 1, state: 'open' },
    comment: { body: '@pi-bot 帮我看看', author_association: 'NONE', user: userObject },
    sender: userObject,
  };
}

/** 带「指定成员」角色 + 角色闸门的项目配置（成员写法可换）。 */
function settingsWith(members: readonly unknown[]) {
  return {
    comment: {
      mentions: [{ keyword: 'pi-bot' }],
      roles: [{ name: '值班同学', by: 'members', members }],
    },
    triggers: {
      events: { 'issue_comment.created': { gates: { require_role: true, allow_roles: ['值班同学'] } } },
    },
  };
}

function decide(settings: unknown, payload: unknown) {
  return decideV21Delivery({ event: 'issue_comment', action: 'created', payload, settings });
}

describe('webhook 载荷 → 判定：作者 id 参与角色匹配', () => {
  it('v21DecisionInputOf 从 comment.user 取 authorId', () => {
    const input = v21DecisionInputOf({
      event: 'issue_comment',
      action: 'created',
      payload: payloadWith({ login: 'alice', id: 1001 }),
      settings: settingsWith([{ login: 'alice', id: 1001 }]),
    });
    expect(input?.comment?.authorId).toBe(1001);
  });

  it('载荷与配置的 id 一致 → 触发，且没有降级留痕', () => {
    const decision = decide(settingsWith([{ login: 'alice', id: 1001 }]), payloadWith({ login: 'alice', id: 1001 }));
    expect(decision).toMatchObject({ triggered: true });
    expect(decision?.roleLoginFallbacks).toBeUndefined();
  });

  it('成员改名（login 变了、id 没变）→ 仍然触发（权限跟着 id 走）', () => {
    const decision = decide(
      settingsWith([{ login: 'alice', id: 1001 }]),
      payloadWith({ login: 'alice-renamed', id: 1001 }),
    );
    expect(decision).toMatchObject({ triggered: true });
    expect(decision?.roleLoginFallbacks).toBeUndefined();
  });

  it('旧 login 被别人抢注（login 相同、id 不同）→ 不触发，reason=role-denied', () => {
    const decision = decide(settingsWith([{ login: 'alice', id: 1001 }]), payloadWith({ login: 'alice', id: 2002 }));
    expect(decision).toEqual({ triggered: false, event: 'issue_comment.created', reason: 'role-denied' });
  });

  it('旧配置（成员没有 id）→ 触发，但带 member-without-id 降级留痕', () => {
    const decision = decide(settingsWith(['alice']), payloadWith({ login: 'alice', id: 1001 }));
    expect(decision).toMatchObject({ triggered: true });
    expect(decision?.roleLoginFallbacks).toEqual([{ role: '值班同学', login: 'alice', reason: 'member-without-id' }]);
  });

  it('载荷没带 id 而配置有 id → 触发，但带 author-without-id 降级留痕', () => {
    const decision = decide(settingsWith([{ login: 'alice', id: 1001 }]), payloadWith({ login: 'alice' }));
    expect(decision).toMatchObject({ triggered: true });
    expect(decision?.roleLoginFallbacks).toEqual([{ role: '值班同学', login: 'alice', reason: 'author-without-id' }]);
  });
});
