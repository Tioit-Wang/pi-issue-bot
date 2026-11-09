/**
 * `@bot /命令 参数` 的解析与解析期校验（契约 §2.1 / §4.2 第二行）。
 *
 * 这一层的失败**发生在入队之前**：不消耗容器、不计成本，只回一条用法说明。
 * 所以测试的重点是「该拒的都拒了，且每条拒绝都能说清原因」。
 */
import { describe, expect, it } from 'vitest';

import { parseRepoConfig } from '../../../packages/contract/src/index.ts';
import { createSkillRegistry, REPO_SKILLS_DIR } from '../src/skills/registry.ts';
import { parseCommand, parseCommandMention, usageMessage } from '../src/skills/command.ts';

const commands = parseRepoConfig({ version: 1 }).commands;

describe('parseCommandMention：只做词法切分', () => {
  it('找到提及 + 命令 + key=value', () => {
    expect(parseCommandMention('@bot /review-pr focus=tests')).toEqual({
      command: '/review-pr',
      args: { focus: 'tests' },
      mention: '@bot',
    });
  });

  it('提及大小写不敏感，命令归一化为小写', () => {
    const parsed = parseCommandMention('请 @Pi-Bot /Review-PR', '@pi-bot');
    expect(parsed?.command).toBe('/review-pr');
  });

  it('没有提及 / 提及后面不是命令 → null', () => {
    expect(parseCommandMention('随便一句话')).toBeNull();
    expect(parseCommandMention('@bot 帮我看看这个 issue')).toBeNull();
  });
});

describe('parseCommand：解析期校验', () => {
  const registry = createSkillRegistry();

  it('合法命令直接放行', () => {
    const result = parseCommand('@bot /issue-triage', { registry, commands });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.command.command).toBe('/issue-triage');
    expect(result.skill.name).toBe('/issue-triage');
  });

  it('没有命令 → no-command；没有提及 → no-mention', () => {
    const noCommand = parseCommand('@bot 看看这个', { registry, commands });
    expect(noCommand.ok).toBe(false);
    if (!noCommand.ok) {
      expect(noCommand.reason).toBe('no-command');
    }
    const noMention = parseCommand('看看这个', { registry, commands });
    expect(noMention.ok).toBe(false);
    if (!noMention.ok) {
      expect(noMention.reason).toBe('no-mention');
    }
  });

  it('仓库关闭命令功能 → commands-disabled（先于其它判定）', () => {
    const result = parseCommand('@bot /review-pr', {
      registry,
      commands: { ...commands, enabled: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('commands-disabled');
    }
  });

  it('不在白名单 → not-allowed', () => {
    const result = parseCommand('@bot /issue-repro', {
      registry,
      commands: { ...commands, allowed: ['/review-pr'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-allowed');
    }
  });

  it('未知命令 → unknown-command（不给 commands 时跳过白名单）', () => {
    const result = parseCommand('@bot /nope', { registry, commands: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown-command');
    }
  });

  it('技能被禁用 → skill-disabled，并带上禁用原因', () => {
    const broken = createSkillRegistry({
      repoSkills: [
        {
          path: `${REPO_SKILLS_DIR}/bad.md`,
          text: ['---', 'name: /issue-triage', 'description: 写坏的覆盖技能', 'allowed-tools: [Read]', 'outputs: [comment]', '---', ''].join('\n'),
        },
      ],
    });
    const result = parseCommand('@bot /issue-triage', { registry: broken, commands });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('skill-disabled');
      expect(result.detail).toMatch(/description/u);
    }
  });

  it('参数：未知 key / 值不合 pattern / 值带空格 → bad-args 并给出用法', () => {
    const unknownKey = parseCommand('@bot /review-pr foo=bar', { registry, commands });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) {
      expect(unknownKey.reason).toBe('bad-args');
      expect(unknownKey.message).toContain('/review-pr');
    }

    const badPattern = parseCommand('@bot /review-pr focus=Bad!', { registry, commands });
    expect(badPattern.ok).toBe(false);

    const spacedValue = parseCommand('@bot /review-pr focus=a b', { registry, commands });
    expect(spacedValue.ok).toBe(false);
    if (!spacedValue.ok) {
      expect(spacedValue.reason).toBe('bad-args');
      expect(spacedValue.message).toMatch(/key=value/u);
    }
  });

  it('pattern 合格的参数被接受', () => {
    const result = parseCommand('@bot /review-pr focus=tests', { registry, commands });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.command.args).toEqual({ focus: 'tests' });
  });

  it('必填参数缺失 → bad-args', () => {
    const withRequired = createSkillRegistry({
      repoSkills: [
        {
          path: `${REPO_SKILLS_DIR}/req.md`,
          text: [
            '---',
            'name: /needs-arg',
            'description: 有一个必填参数的技能',
            'allowed-tools: [Read]',
            'inputs:',
            '  - name: depth',
            '    required: true',
            'outputs: [comment]',
            '---',
            '',
          ].join('\n'),
        },
      ],
    });
    const missing = parseCommand('@bot /needs-arg', { registry: withRequired, commands: null });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toBe('bad-args');
      expect(missing.message).toContain('depth');
    }
    expect(parseCommand('@bot /needs-arg depth=2', { registry: withRequired, commands: null }).ok).toBe(true);
  });

  it('usageMessage 列出参数形状，方便直接回评论', () => {
    const skill = registry.resolve('/review-pr');
    expect(skill).toBeDefined();
    if (skill === undefined) {
      return;
    }
    const usage = usageMessage(skill);
    expect(usage).toContain('/review-pr');
    expect(usage).toContain('focus');
  });
});