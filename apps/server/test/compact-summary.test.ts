/**
 * 摘要提示词与解析的断言（FR-5.6「压缩方式」/「多次压缩」）。
 *
 * 重点不是文案，而是三条不许退让的语义：
 *  1. 首次 vs 增量的**输入不同**（首次=切点前全部消息；增量=上一版摘要+新增消息）；
 *  2. 增量是 UPDATE（保留 / 补充 / 迁移），不是重压全量；
 *  3. 空摘要与缺段一律算失败 —— 看起来成功实际丢了上下文，比直接失败更糟。
 */
import { describe, expect, it } from 'vitest';

import {
  SUMMARY_SECTIONS,
  buildSummaryPrompt,
  collectFileMentions,
  parseSummary,
} from '../src/compact/summary.ts';
import type { MessageLike } from '../src/compact/tokens.ts';

const MESSAGES: readonly MessageLike[] = [
  { role: 'user', content: '登录接口 500，麻烦查一下' },
  { role: 'assistant', content: '我先读 src/login.ts' },
  { role: 'tool', toolName: 'Read', toolCallId: 'call-1', content: '报错原文：TypeError at src/login.ts:88' },
];

const FULL_SUMMARY = [
  '## 目标',
  '修掉登录接口 500',
  '',
  '## 约束与偏好',
  '不得改 packages/**',
  '',
  '## 进度',
  '已完成：定位到 src/login.ts:88',
  '进行中：补单测',
  '受阻：（无）',
  '',
  '## 关键决策',
  '改 src/login.ts 而不是加 try/catch 兜底',
  '',
  '## 下一步',
  '跑 pnpm --filter @pi-issue-bot/server test',
  '',
  '## 关键上下文',
  '报错原文：TypeError: cannot read property x of undefined at src/login.ts:88',
].join('\n');

describe('buildSummaryPrompt · 首次摘要', () => {
  const prompt = buildSummaryPrompt({ messages: MESSAGES, generation: 1 });

  it('要求覆盖切点前的全部消息', () => {
    expect(prompt).toContain('全部');
    expect(prompt).toContain('一条都不能漏');
    // 三条消息都要出现在提示词里（漏一条就等于「消息离开上下文却没被摘要覆盖」）
    for (const message of MESSAGES) {
      expect(prompt).toContain(message.content);
    }
  });

  it('要求精确路径 / 函数名 / 报错原文原样保留', () => {
    expect(prompt).toContain('原样照抄');
    expect(prompt).toContain('文件路径');
    expect(prompt).toContain('报错原文');
  });

  it('六个小节标题全部列出', () => {
    for (const section of SUMMARY_SECTIONS) {
      expect(prompt).toContain(`## ${section}`);
    }
  });

  it('明确禁止拼接多份摘要', () => {
    expect(prompt).toContain('禁止把多份摘要拼接');
  });

  it('首次摘要不出现「上一版摘要」分区', () => {
    expect(prompt).not.toContain('【上一版摘要】');
    expect(prompt).not.toContain('保留（PRESERVE）');
  });

  it('带工具名与 callId，模型才知道这段输出是什么', () => {
    expect(prompt).toContain('tool=Read');
    expect(prompt).toContain('callId=call-1');
  });
});

describe('buildSummaryPrompt · 增量摘要', () => {
  const previousSummary = '## 目标\n修掉登录接口 500\n\n## 下一步\n补单测';
  const prompt = buildSummaryPrompt({
    previousSummary,
    messages: MESSAGES,
    generation: 2,
  });

  it('输入是「上一版摘要 + 新增消息」两块', () => {
    expect(prompt).toContain('【上一版摘要】');
    expect(prompt).toContain(previousSummary.trim());
    expect(prompt).toContain('新增的消息');
  });

  it('指令是 UPDATE 三动作，而不是重压全量', () => {
    expect(prompt).toContain('保留（PRESERVE）');
    expect(prompt).toContain('补充（ADD）');
    expect(prompt).toContain('迁移（MOVE）');
    expect(prompt).toContain('已完成');
    expect(prompt).toContain('进行中');
  });

  it('仍然要求输出完整六段，并禁止「贴回上一版再追加」', () => {
    for (const section of SUMMARY_SECTIONS) {
      expect(prompt).toContain(`## ${section}`);
    }
    expect(prompt).toContain('不是差异补丁');
    expect(prompt).toContain('禁止把多份摘要拼接');
    expect(prompt).toContain('不要把上一版摘要整段贴回来');
  });

  it('没有上一版摘要时退回首次语义（凭空增量只会得到自说自话的摘要）', () => {
    const fallback = buildSummaryPrompt({
      previousSummary: '   ',
      messages: MESSAGES,
      generation: 3,
    });
    expect(fallback).not.toContain('【上一版摘要】');
    expect(fallback).toContain('一条都不能漏');
  });

  it('文件清单作为「系统补充」出现（不依赖模型记忆）', () => {
    const withFiles = buildSummaryPrompt({
      previousSummary,
      messages: MESSAGES,
      generation: 2,
      fileList: ['src/login.ts'],
    });
    expect(withFiles).toContain('系统补充');
    expect(withFiles).toContain('- src/login.ts');
  });
});

describe('parseSummary', () => {
  it('空摘要视为失败（不是「压成空也得算成功」）', () => {
    for (const text of ['', '   ', '\n\n\t']) {
      const parsed = parseSummary(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe('empty');
        expect(parsed.missing).toHaveLength(SUMMARY_SECTIONS.length);
      }
    }
  });

  it('六段齐全 → 成功，并去掉首尾空白', () => {
    const parsed = parseSummary(`\n\n${FULL_SUMMARY}\n\n`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.summary).toBe(FULL_SUMMARY);
    }
  });

  it('缺任意一段 → missing-sections 并列出缺的段', () => {
    const onlyTarget = '## 目标\n修 500';
    const parsed = parseSummary(onlyTarget);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe('missing-sections');
      expect(parsed.missing).toContain('进度');
      expect(parsed.missing).toContain('下一步');
      expect(parsed.missing).not.toContain('目标');
      expect(parsed.missing).toHaveLength(SUMMARY_SECTIONS.length - 1);
    }
  });

  it('只缺一段也要判失败（缺「约束」等于允许模型越界）', () => {
    const text = FULL_SUMMARY.replace('## 约束与偏好', '## 别的');
    const parsed = parseSummary(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.missing).toEqual(['约束与偏好']);
    }
  });

  it('接受加粗与方括号写法（模型实际会混用）', () => {
    const bold = SUMMARY_SECTIONS.map((section) => `**${section}**\n内容`).join('\n\n');
    expect(parseSummary(bold).ok).toBe(true);

    const bracket = SUMMARY_SECTIONS.map((section) => `【${section}】\n内容`).join('\n\n');
    expect(parseSummary(bracket).ok).toBe(true);
  });

  it('三级标题也算（只要标题层级 ≤ 6）', () => {
    const text = SUMMARY_SECTIONS.map((section) => `### ${section}\n内容`).join('\n\n');
    expect(parseSummary(text).ok).toBe(true);
  });
});

describe('collectFileMentions', () => {
  it('从消息正文里抠路径并按出现顺序去重', () => {
    const files = collectFileMentions([
      { role: 'tool', content: '读 apps/server/src/compact/engine.ts 与 ./a.js' },
      { role: 'assistant', content: '再读一次 apps/server/src/compact/engine.ts' },
    ]);
    expect(files).toEqual(['apps/server/src/compact/engine.ts', './a.js']);
  });

  it('限制条数（不让清单把摘要撑爆）', () => {
    const content = Array.from({ length: 40 }, (_unused, index) => `f${String(index)}.ts`).join(' ');
    expect(collectFileMentions([{ role: 'user', content }], 5)).toHaveLength(5);
  });

  it('没有文件时返回空数组', () => {
    expect(collectFileMentions([{ role: 'user', content: '没有路径的一句话' }])).toEqual([]);
  });
});
