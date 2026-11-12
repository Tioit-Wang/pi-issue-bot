/**
 * 「技能真的被用上」的端到端断言（针对 issue #26 的根因）。
 *
 * 三条曾经同时成立的错，导致 `@bot /label-triage` 完全不生效：
 *  1. 消息组装时把 `/label-triage` 从正文里**删掉**并改写成一句指令；
 *  2. 装配层（`worker-deps`）拿正文做正则找 `/name` —— 永远找不到；
 *  3. 提示词还让模型「用 Skill 工具按 id 取正文」—— 这个工具不存在。
 *
 * 这里把修好之后的链路钉住：结构化 `skillIds` 落库 → 读回 → 决定注入哪份正文。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { pickRequestedSkill } from '../src/app/worker-deps.ts';
import { AGENT_SKILL_CATALOG_HEADER, AGENT_SKILL_DIRECTIVE, composeAgentMessage } from '../src/agent/message.ts';
import { openTestDb } from './helpers/queries-db.ts';

const AVAILABLE = [{ name: '/issue-format' }, { name: '/label-triage' }];

describe('mention 消息：token 被摘掉后，技能名靠结构化字段传递', () => {
  const composed = composeAgentMessage({
    kind: 'mention',
    rawText: '@bot /label-triage 麻烦归类一下这个 issue',
    aliases: ['@bot'],
    catalog: [
      { id: 'issue-format', name: '格式检查' },
      { id: 'label-triage', name: '打标' },
    ],
    issue: { repo: 'acme/widgets', number: 7, title: '标题', body: '正文', updatedAt: '2026-01-01T00:00:00Z' },
    settings: {},
  });

  it('`/label-triage` 从正文里消失（所以服务端不能靠正则找它）', () => {
    expect(composed.text).not.toContain('/label-triage 麻烦');
  });

  it('但 skillIds 里还在 —— 这是装配层唯一可信的来源', () => {
    expect(composed.skillIds).toEqual(['label-triage']);
    expect(pickRequestedSkill('agent:mention', composed.text, AVAILABLE, composed.skillIds)).toBe(
      '/label-triage',
    );
  });

  it('提示词不再指示模型调用不存在的 Skill 工具', () => {
    expect(AGENT_SKILL_DIRECTIVE).not.toContain('Skill 工具');
    expect(AGENT_SKILL_CATALOG_HEADER).not.toContain('Skill 工具');
    expect(composed.text).not.toContain('Skill 工具');
  });
});

describe('pickRequestedSkill：优先级与误判面', () => {
  it('结构化点名 > 显式命令 > 文本 > null', () => {
    expect(pickRequestedSkill('/issue-format', 'x', AVAILABLE, ['label-triage'])).toBe('/label-triage');
    expect(pickRequestedSkill('/issue-format', 'x', AVAILABLE)).toBe('/issue-format');
    expect(pickRequestedSkill('agent:mention', '看 /label-triage', AVAILABLE)).toBe('/label-triage');
    expect(pickRequestedSkill('agent:mention', '随便说点什么', AVAILABLE)).toBeNull();
  });

  it('点名了但没加载到 → 不猜，交给目录兜底', () => {
    expect(pickRequestedSkill('agent:mention', '', AVAILABLE, ['format-check'])).toBeNull();
  });

  it('代码块里的 `/label-triage` 也算命中（只是兼容老路径；新路径不看文本）', () => {
    // 记录现状而不是假装它不存在：文本兜底没有围栏感知。真正的路径已经不依赖它。
    expect(pickRequestedSkill('agent:mention', '```\n/label-triage\n```', AVAILABLE)).toBe('/label-triage');
  });
});

describe('迁移 0009 真的把结构化字段建出来了', () => {
  it('`tasks.agent_skill_ids` 与 `agent_messages.skill_ids` 存在且默认空数组', async () => {
    const db = await openTestDb();
    try {
      for (const [table, column] of [
        ['tasks', 'agent_skill_ids'],
        ['agent_messages', 'skill_ids'],
      ] as const) {
        const rows = await db.sql(
          `select data_type, column_default, is_nullable
             from information_schema.columns
            where table_name = $1 and column_name = $2`,
          [table, column],
        );
        const row = rows[0];
        expect(row, `${table}.${column} 不存在`).toBeDefined();
        expect(row?.['data_type']).toBe('jsonb');
        expect(row?.['is_nullable']).toBe('NO');
        expect(String(row?.['column_default'])).toContain('[]');
      }
    } finally {
      await db.close();
    }
  });
});

describe('技能的取用方式写在文档里（防再次漂移）', () => {
  it('skill-authoring 规范明确「不要把工具清单写死在技能里」与「事实由提示词渲染」', () => {
    const doc = readFileSync(new URL('../../../docs/spec/skill-authoring.md', import.meta.url), 'utf8');
    expect(doc).toContain('技能正文里不许出现');
    expect(doc).toContain('工具怎么用');
  });
});
