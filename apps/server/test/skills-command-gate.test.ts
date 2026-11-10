/**
 * `checkCommandGate` 与「面板上传技能」的关系（纯函数，不需要库）。
 *
 * 这条约束是**功能**而不是安全边界：`/demo` 是面板刚上传的技能，仓库配置里不会有它，
 * 如果门禁只认 `commands.allowed`，上传完立刻调用会被判「不在白名单」——
 * 那就违背了 spec D0「上传即生效」。反过来，`commands.enabled=false` 与
 * `author_associations` 这两道闸仍然生效（面板上传不能绕过仓库策略）。
 */
import { describe, expect, it } from 'vitest';

import { checkCommandGate } from '../src/http/webhook.ts';
import type { WebhookTaskPlan } from '../src/http/webhook.ts';
import type { RepoConfig } from '../../../packages/contract/src/index.ts';

const basePlan: WebhookTaskPlan = {
  source: 'command',
  command: '/demo',
  kind: 'command:/demo',
  targetKind: 'issue',
  targetNumber: 1,
  headSha: null,
  issueVersionHash: null,
  actorLogin: 'alice',
  association: 'OWNER',
  commentId: 1,
  ackStyle: 'reaction',
};

/** 最小可用配置：命令开、白名单只有 `/review-pr`、所有者可触发。 */
const configOf = (overrides: Partial<RepoConfig['commands']> = {}): RepoConfig =>
  ({
    commands: {
      enabled: true,
      allowed: ['/review-pr'],
      allow_users: [],
      author_associations: ['OWNER', 'MEMBER'],
      ...overrides,
    },
  }) as RepoConfig;

describe('checkCommandGate × 面板上传技能', () => {
  it('上传技能在 knownSkills 里 → 放行（不必进仓库配置）', () => {
    expect(checkCommandGate(basePlan, configOf(), ['/demo']).allowed).toBe(true);
  });

  it('knownSkills 里没有、配置里也没有 → 拒（原有行为不变）', () => {
    const result = checkCommandGate(basePlan, configOf(), []);
    expect(result.allowed).toBe(false);
    expect(result.allowed === false ? result.reason : '').toContain('不在白名单');
  });

  it('配置里本来就有 → 仍然放行（knownSkills 不影响既有路径）', () => {
    expect(checkCommandGate({ ...basePlan, command: '/review-pr' }, configOf(), []).allowed).toBe(true);
  });

  it('commands.enabled=false 时上传技能也进不来（仓库策略优先）', () => {
    const result = checkCommandGate(basePlan, configOf({ enabled: false }), ['/demo']);
    expect(result.allowed).toBe(false);
  });

  it('author_association 不在白名单时上传技能也进不来', () => {
    const result = checkCommandGate({ ...basePlan, association: 'NONE' }, configOf(), ['/demo']);
    expect(result.allowed).toBe(false);
    expect(result.allowed === false ? result.reason : '').toContain('author_association');
  });

  it('非命令来源（判定类事件）不受命令门禁影响', () => {
    const plan = { ...basePlan, source: 'webhook' as const, command: 'auto:triage' };
    expect(checkCommandGate(plan, configOf({ enabled: false }), []).allowed).toBe(true);
  });
});
