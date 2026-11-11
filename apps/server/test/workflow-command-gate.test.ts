/**
 * 命令门禁（plan §6.4）：谁能触发、谁一律不理、同一 head_sha 重跑为什么是空操作。
 *
 * 这一层是纯函数，所以可以逐条把「拒绝理由」钉住——拒绝理由的取值同时是回复文案的分支依据，
 * 改一个字就会改变用户看到的东西。
 */
import { describe, expect, it } from 'vitest';

import { parseRepoConfig } from '../../../packages/contract/src/index.ts';
import { buildIdempotencyKey } from '../src/queue/idempotency.ts';
import {
  commandIdempotencyKey,
  commandKind,
  evaluateCommandGate,
  targetOf,
} from '../src/workflows/command-gate.ts';
import type { CommandGateInput } from '../src/workflows/command-gate.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

// `pipeline.managers` 非空是配置解析前提（§4.5 / Q4）；本文件只关心 `commands` 段。
const config = parseRepoConfig(validRepoSettings({ version: 1 })).commands;

const base = (overrides: Partial<CommandGateInput> = {}): CommandGateInput => ({
  repo: 'acme/widgets',
  targetKind: 'pr',
  targetNumber: 12,
  actor: { login: 'alice', type: 'User', authorAssociation: 'MEMBER' },
  headSha: 'a'.repeat(40),
  lastProcessedHeadSha: null,
  command: '/review-pr',
  config,
  skill: { enabled: true },
  ...overrides,
});

describe('evaluateCommandGate', () => {
  it('OWNER / MEMBER / COLLABORATOR 放行，并给出幂等键', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      const decision = evaluateCommandGate(base({ actor: { login: 'u', type: 'User', authorAssociation: association } }));
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) {
        continue;
      }
      expect(decision.kind).toBe('command:/review-pr');
      expect(decision.idempotencyKey).toBe(
        buildIdempotencyKey({
          kind: 'command:/review-pr',
          repo: 'acme/widgets',
          target: 'pr#12',
          headSha: 'a'.repeat(40),
          triggerActor: 'u',
        }),
      );
    }
  });

  it('外部贡献者被拒（不是 noop：要回一条说明）', () => {
    const decision = evaluateCommandGate(
      base({ actor: { login: 'stranger', type: 'User', authorAssociation: 'CONTRIBUTOR' } }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      return;
    }
    expect(decision.reason).toBe('association-not-allowed');
    expect(decision.noop).toBe(false);
  });

  it('commands.allow_users 里的人即使 association 不够也放行', () => {
    const decision = evaluateCommandGate(
      base({
        actor: { login: 'trusted-friend', type: 'User', authorAssociation: 'CONTRIBUTOR' },
        config: { ...config, allow_users: ['trusted-friend'] },
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('机器人账号一律忽略——连回复都不给（否则两个 bot 会互相触发）', () => {
    const decision = evaluateCommandGate(
      base({ actor: { login: 'other-bot[bot]', type: 'Bot', authorAssociation: 'OWNER' } }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      return;
    }
    expect(decision.reason).toBe('bot-actor');
    expect(decision.noop).toBe(true);
  });

  it('仓库关闭命令功能 → commands-disabled（noop）', () => {
    const decision = evaluateCommandGate(base({ config: { ...config, enabled: false } }));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      return;
    }
    expect(decision.reason).toBe('commands-disabled');
    expect(decision.noop).toBe(true);
  });

  it('命令不存在 / 技能被禁用 → 各自的理由', () => {
    const unknown = evaluateCommandGate(base({ skill: null }));
    expect(unknown.allowed).toBe(false);
    if (!unknown.allowed) {
      expect(unknown.reason).toBe('unknown-command');
    }

    const disabled = evaluateCommandGate(base({ skill: { enabled: false, detail: 'frontmatter 非法' } }));
    expect(disabled.allowed).toBe(false);
    if (!disabled.allowed) {
      expect(disabled.reason).toBe('skill-unavailable');
      expect(disabled.message).toContain('frontmatter 非法');
    }
  });

  it('同一 head_sha 重跑 → 空操作（不入队、不回复）', () => {
    const decision = evaluateCommandGate(base({ lastProcessedHeadSha: 'a'.repeat(40) }));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      return;
    }
    expect(decision.reason).toBe('duplicate-head-sha');
    expect(decision.noop).toBe(true);
  });

  it('换了新提交 → 是一个新任务（幂等键随之变化）', () => {
    const first = commandIdempotencyKey({
      command: '/review-pr',
      repo: 'acme/widgets',
      targetKind: 'pr',
      targetNumber: 12,
      headSha: 'a'.repeat(40),
      triggerActor: 'alice',
    });
    const second = commandIdempotencyKey({
      command: '/review-pr',
      repo: 'acme/widgets',
      targetKind: 'pr',
      targetNumber: 12,
      headSha: 'b'.repeat(40),
      triggerActor: 'alice',
    });
    expect(first.key).not.toBe(second.key);
    expect(evaluateCommandGate(base({ lastProcessedHeadSha: 'a'.repeat(40), headSha: 'b'.repeat(40) })).allowed).toBe(true);
  });

  it('kind 与 target 的口径固定（面板按 kind 分组，两者都不能飘）', () => {
    expect(commandKind('/Review-PR')).toBe('command:/review-pr');
    expect(targetOf('issue', 7)).toBe('issue#7');
  });
});