/**
 * 技能「接进 Agent」的关键行为断言。
 *
 * 之前的缺口（issue #26 实测）：`agent:mention` / `agent:event` 不是技能名，
 * `registry.resolve('agent:mention')` 恒为 undefined，装配层于是**什么都不注入** ——
 * 模型只看到一段基础提示词，只能自己编技能名（实测编出 `format-check`）、自己去翻退役配置。
 *
 * 这里固化三条：
 * 1. 能从触发文本里认出 `/技能名`（且只认已加载的名字，`/usr/bin` 不算）；
 * 2. 认不出来时注入 `## 可用技能` 目录（含 description），让模型有得选；
 * 3. 认出来时注入该技能正文（而不是目录）。
 */
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createPromptEnricher, pickRequestedSkill } from '../src/app/worker-deps.ts';

const AVAILABLE = [{ name: '/label-triage' }, { name: '/issue-format' }];

describe('pickRequestedSkill：谁来决定用哪个技能', () => {
  it('显式命令优先', () => {
    expect(pickRequestedSkill('/issue-format', '/label-triage 归类一下', AVAILABLE)).toBe('/issue-format');
  });

  it('结构化点名优先于触发文本', () => {
    expect(pickRequestedSkill('agent:mention', '随便', AVAILABLE, ['label-triage'])).toBe('/label-triage');
    expect(pickRequestedSkill('agent:mention', '@bot /label-triage 麻烦归类', AVAILABLE)).toBe('/label-triage');
    expect(pickRequestedSkill('agent:mention', '/issue-format\n看看信息够不够', AVAILABLE)).toBe('/issue-format');
  });

  it('未加载的技能名不算（模型不能凭文本自造技能）', () => {
    expect(pickRequestedSkill('agent:mention', '/format-check 帮忙看下', AVAILABLE)).toBeNull();
  });

  it('路径一类伪命令不会被当成技能', () => {
    expect(pickRequestedSkill('agent:mention', '看 /usr/bin 下的脚本', AVAILABLE)).toBeNull();
    expect(pickRequestedSkill('agent:mention', '没有斜杠命令', AVAILABLE)).toBeNull();
  });
});

describe('createPromptEnricher：技能真的进了提示词', () => {
  const enricher = (body: string) =>
    createPromptEnricher({
      context: { repo: 'acme/widgets', targetKind: 'issue', targetNumber: 7, body },
    });

  it('结构化点名（tasks.agent_skill_ids）→ 注入该技能正文', async () => {
    const prompt = await enricher('归类一下')({
      worktreeDir: tmpdir(),
      basePrompt: 'BASE-PROMPT',
      command: 'agent:mention',
      skillIds: ['label-triage'],
    });
    expect(prompt).toContain('BASE-PROMPT');
    expect(prompt).toContain('# 技能 /label-triage');
    expect(prompt).toContain('打标的唯一生效方式');
    expect(prompt).not.toContain('## 可用技能');
  });

  it('没有点名技能 → 注入技能目录（每个技能带 description）', async () => {
    const prompt = await enricher('这个 issue 帮我看看')({
      worktreeDir: tmpdir(),
      basePrompt: 'BASE-PROMPT',
      command: 'agent:event',
    });
    expect(prompt).toContain('## 可用技能');
    expect(prompt).toContain('- `/label-triage`：');
    expect(prompt).toContain('- `/issue-format`：');
    expect(prompt).toContain('只能从上面这份清单里选');
  });

  it('点名了未加载的技能 → 退回目录，不注入不存在的技能', async () => {
    const prompt = await enricher('/format-check 帮忙看下')({
      worktreeDir: tmpdir(),
      basePrompt: 'BASE-PROMPT',
      command: 'agent:mention',
    });
    expect(prompt).toContain('## 可用技能');
    expect(prompt).not.toContain('# 技能 /format-check');
  });
});
