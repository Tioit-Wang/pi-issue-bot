/**
 * 四类提示词的**默认模板 + 渲染 + 保存期校验**（`docs/plan-fixed-pipeline.md` §5 / §15 / §16.3）。
 *
 * 纯函数测试：不碰库、不碰文件系统、不碰网络。
 *
 * 钉住的性质：
 *  1. 三套内置默认都含 §15 要求的占位符，且**末尾都提醒交 JSON 信封**（契约由控制面追加，模板只提醒）；
 *  2. `renderStagePrompt()` 单次扫描插值、未知占位符原样保留（不静默吞）；
 *  3. `{{body}}` = 补充评论段（最近 3 条、每条 ≤1000、**置顶**）+ 正文，总长 ≤ 4000，
 *     截断处显式标注原文长度并记进 `truncated` / `dropped`；
 *  4. `{{labels}}` 渲染词表时带 `role` 与 `meaning`（`name [role] — meaning`）；
 *  5. 保存期三种失败各自可定位：未知占位符 / `format_check` 缺 title·body / 超上限。
 */
import { describe, expect, it } from 'vitest';

import {
  STAGE_PROMPT_DEFAULTS,
  STAGE_PROMPT_KINDS,
  STAGE_PROMPT_PLACEHOLDERS,
  PIPELINE_PROMPT_LIMITS,
  GATE_NOTICE_PROMPT,
  isStageKind,
  pipelinePromptLimit,
  stagePromptDefault,
} from '../src/skills/stage-prompts.ts';
import {
  PROMPT_LIMITS,
  STAGE_SUPPLEMENT_LIMITS,
  renderGateNoticePrompt,
  renderStageLabelList,
  renderStagePrompt,
  validateStagePrompt,
} from '../src/skills/prompt.ts';

const VOCABULARY = [
  { name: '需求', role: 'requirement' as const, meaning: '想要的新能力' },
  { name: '缺陷', role: 'defect' as const, meaning: '功能不符合预期' },
];

const VARS = {
  repo: 'octo/demo',
  target: 'issue #7',
  title: '导入 CSV 时崩溃',
  body: '点导入就崩了，堆栈见附件。',
  labels: VOCABULARY,
  author: 'alice',
  url: 'https://github.com/octo/demo/issues/7',
};

describe('内置默认模板（§15）', () => {
  it('三套默认模板都在，且都含 §15 列出的占位符', () => {
    expect(STAGE_PROMPT_KINDS).toEqual(['format_check', 'classify', 'agent']);
    for (const kind of STAGE_PROMPT_KINDS) {
      const text = stagePromptDefault(kind);
      expect(text.length).toBeGreaterThan(0);
      // 每个模板都至少用到 title / body（判定对象必须进上下文）
      expect(text).toContain('{{title}}');
      expect(text).toContain('{{body}}');
      // 只能用登记过的占位符（否则保存期校验会拒掉自己的默认模板）
      for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]{1,40})\s*\}\}/gu)) {
        expect(STAGE_PROMPT_PLACEHOLDERS as readonly string[]).toContain(match[1]);
      }
    }
    // §5 列出的 8 个占位符在 format_check 里都能用上
    for (const name of ['repo', 'target', 'labels', 'author', 'url', 'recheck']) {
      expect(STAGE_PROMPT_DEFAULTS.format_check).toContain(`{{${name}}}`);
    }
  });

  it('每个模板末尾都提醒交出 JSON 信封（输出契约本身由控制面追加）', () => {
    for (const text of [STAGE_PROMPT_DEFAULTS.format_check, STAGE_PROMPT_DEFAULTS.classify, STAGE_PROMPT_DEFAULTS.agent]) {
      const tail = text.slice(-200);
      expect(tail).toContain('JSON');
    }
    // 门禁回执同样提醒（但明说不要在这里写 JSON）
    expect(GATE_NOTICE_PROMPT).toContain('输出契约');
    expect(GATE_NOTICE_PROMPT).toContain('{{gate_state}}');
  });

  it('project 没有默认正文：version=0 就是「不注入」', () => {
    expect(stagePromptDefault('project')).toBe('');
    expect(isStageKind('project')).toBe(false);
    expect(isStageKind('classify')).toBe(true);
  });

  it('上限表：agent 4000（与 P1 同档），format_check/classify 8000', () => {
    expect(PIPELINE_PROMPT_LIMITS).toEqual({
      project: 4_000,
      format_check: 8_000,
      classify: 8_000,
      agent: 4_000,
    });
    expect(pipelinePromptLimit('agent')).toBe(4_000);
    expect(pipelinePromptLimit('classify')).toBe(8_000);
  });

  it('默认模板自身都通过保存期校验（否则「恢复默认」不可用）', () => {
    for (const kind of STAGE_PROMPT_KINDS) {
      const issues = validateStagePrompt({ kind, body: STAGE_PROMPT_DEFAULTS[kind] });
      expect(issues).toMatchObject({ ok: true, unknown: [], missing: [], tooLong: false });
    }
  });
});

describe('renderStagePrompt · 插值', () => {
  it('八个占位符全部替换；值里的花括号被中和（不再扫描成占位符）', () => {
    const rendered = renderStagePrompt({
      kind: 'format_check',
      body: [
        '{{repo}} {{target}}',
        '标题：{{title}}',
        '作者：{{author}} 链接：{{url}}',
        '标签：{{labels}}',
        '复查：{{recheck}}',
        '正文：{{body}}',
      ].join('\n'),
      vars: { ...VARS, title: '标题里有 {{secret}}', recheck: true },
    });

    expect(rendered.text).toContain('octo/demo issue #7');
    expect(rendered.text).toContain('作者：alice 链接：https://github.com/octo/demo/issues/7');
    expect(rendered.text).toContain('需求 [requirement] — 想要的新能力');
    expect(rendered.text).toContain('缺陷 [defect] — 功能不符合预期');
    expect(rendered.text).toContain('复查：true');
    expect(rendered.text).toContain('正文：点导入就崩了');
    // 不可信标题里的占位符被中和，不会在第二轮被当成模板占位符
    expect(rendered.text).toContain('{ {secret} }');
    expect(rendered.unknownPlaceholders).toEqual([]);
  });

  it('未知占位符原样保留，并记进 unknownPlaceholders（不静默吞）', () => {
    const rendered = renderStagePrompt({
      kind: 'classify',
      body: 'A {{title}} B {{nope}} C {{ also_bad }}',
      vars: VARS,
    });
    expect(rendered.text).toContain('{{nope}}');
    expect(rendered.text).toContain('{{ also_bad }}');
    expect(rendered.unknownPlaceholders).toEqual(['also_bad', 'nope']);
  });

  it('空词表时明说「不要猜标签名」', () => {
    expect(renderStageLabelList([])).toContain('未配置标签词表');
    expect(renderStageLabelList(undefined)).toContain('不猜标签名');
  });
});

describe('renderStagePrompt · {{body}}（E4 评论优先）', () => {
  const supplements = [
    { author: 'alice', createdAt: '2026-06-01T10:00:00.000Z', body: '第一条补充' },
    { author: 'bob', createdAt: '2026-06-01T10:05:00.000Z', body: '第二条补充' },
    { author: 'alice', createdAt: '2026-06-01T10:10:00.000Z', body: '第三条补充' },
    { author: 'carol', createdAt: '2026-06-01T10:15:00.000Z', body: '第四条补充' },
  ];

  it('补充评论段置顶、只取最近 3 条、按新→旧；被丢掉的那条记进 dropped', () => {
    const rendered = renderStagePrompt({ kind: 'format_check', body: '{{body}}', vars: VARS, supplements });

    const indexSupplement = rendered.text.indexOf('【补充评论');
    const indexBody = rendered.text.indexOf('点导入就崩了');
    expect(indexSupplement).toBeGreaterThan(-1);
    // 置顶：补充段在 issue 正文之前（评论内容优先被判定）
    expect(indexSupplement).toBeLessThan(indexBody);

    // 最近 3 条按新→旧；最早那条（第一条补充）不进上下文
    const order = ['第四条补充', '第三条补充', '第二条补充'].map((text) => rendered.text.indexOf(text));
    expect(order.every((index) => index > -1)).toBe(true);
    const [newest = -1, middle = -1, oldest = -1] = order;
    expect(newest).toBeLessThan(middle);
    expect(middle).toBeLessThan(oldest);
    expect(rendered.text).not.toContain('第一条补充');
    expect(rendered.dropped).toContain('supplement#1');
    // 作者与时间都在
    expect(rendered.text).toContain('@carol 2026-06-01T10:15:00.000Z');
  });

  it('单条补充评论超过 1000 字符时截断，并记进 dropped / truncated', () => {
    const long = { author: 'dave', createdAt: '2026-06-01T11:00:00.000Z', body: 'x'.repeat(1_400) };
    const rendered = renderStagePrompt({ kind: 'format_check', body: '{{body}}', vars: VARS, supplements: [long] });

    expect(rendered.truncated).toBe(true);
    expect(rendered.dropped).toContain('supplement@dave');
    expect(rendered.text).toContain('已截断');
    expect(rendered.text.length).toBeLessThan(PROMPT_LIMITS.body + 200);
  });

  it('正文超长：`{{body}}` 不超过 4000，截断处标注原文长度', () => {
    const rendered = renderStagePrompt({
      kind: 'format_check',
      body: '正文：{{body}}',
      vars: { ...VARS, body: 'y'.repeat(12_000) },
      supplements: [],
    });

    const start = rendered.text.indexOf('正文：');
    expect(rendered.text.slice(start)).toContain('…（正文已截断，原长 12000 字符）');
    expect(rendered.truncated).toBe(true);
    expect(rendered.dropped).toContain('body');
    // 模板之外的字节 + 4000 上限：整段不会失控
    expect(rendered.text.length).toBeLessThan(4_100);
  });

  it('补充段与正文共享 4000 额度：两者都超长时总长仍受限', () => {
    const big = Array.from({ length: STAGE_SUPPLEMENT_LIMITS.count }, (_, index) => ({
      author: `u${String(index)}`,
      createdAt: '2026-06-01T11:00:00.000Z',
      body: 'z'.repeat(STAGE_SUPPLEMENT_LIMITS.perComment),
    }));
    const rendered = renderStagePrompt({
      kind: 'classify',
      body: '{{body}}',
      vars: { ...VARS, body: 'w'.repeat(9_000) },
      supplements: big,
    });

    const bodyValue = rendered.text;
    expect(bodyValue.length).toBeLessThanOrEqual(PROMPT_LIMITS.body);
    expect(rendered.truncated).toBe(true);
    expect(rendered.dropped).toContain('body');
  });

  it('没有补充评论时只有正文；空正文给一句占位说明', () => {
    const rendered = renderStagePrompt({ kind: 'classify', body: '{{body}}', vars: { ...VARS, body: '' } });
    expect(rendered.text).toBe('（无正文）');
    expect(rendered.truncated).toBe(false);
    expect(rendered.dropped).toEqual([]);
  });
});

describe('validateStagePrompt · 保存期校验（§16.3 末尾）', () => {
  it('未知占位符 → ok=false 并列出名字', () => {
    const issues = validateStagePrompt({ kind: 'classify', body: '{{title}} {{oops}} {{typo}}' });
    expect(issues.ok).toBe(false);
    expect(issues.unknown).toEqual(['oops', 'typo']);
  });

  it('format_check 缺 {{title}} / {{body}} → ok=false 并列出缺的名字', () => {
    const issues = validateStagePrompt({ kind: 'format_check', body: '只有 {{repo}} 与 {{title}}' });
    expect(issues.ok).toBe(false);
    expect(issues.missing).toEqual(['body']);

    const both = validateStagePrompt({ kind: 'format_check', body: '什么都不带' });
    expect(both.missing).toEqual(['title', 'body']);
  });

  it('classify / agent 不强制任何占位符；project 不校验未知占位符', () => {
    expect(validateStagePrompt({ kind: 'classify', body: '随便写' }).ok).toBe(true);
    expect(validateStagePrompt({ kind: 'agent', body: '随便写' }).ok).toBe(true);
    expect(validateStagePrompt({ kind: 'project', body: '{{anything}} 都可以' }).ok).toBe(true);
  });

  it('超过上限 → ok=false 且带上 chars / limit', () => {
    const classify = validateStagePrompt({ kind: 'classify', body: 'a'.repeat(8_001) });
    expect(classify.ok).toBe(false);
    expect(classify.tooLong).toBe(true);
    expect(classify.limit).toBe(8_000);

    const agent = validateStagePrompt({ kind: 'agent', body: 'a'.repeat(4_001) });
    expect(agent.tooLong).toBe(true);
    // 正好 4000 是允许的（V18 的前提就是「agent 存满 4000」）
    expect(validateStagePrompt({ kind: 'agent', body: 'a'.repeat(4_000) }).ok).toBe(true);
  });
});

describe('renderGateNoticePrompt · 门禁回执（Q8）', () => {
  it('把 {{gate_state}} 插进模板，产出只有一段话（不含命令指令）', () => {
    const text = renderGateNoticePrompt({
      repo: 'octo/demo',
      target: 'issue #7',
      gateState: 'format/awaiting_info',
    });
    expect(text).toContain('format/awaiting_info');
    expect(text).toContain('octo/demo issue #7');
    expect(text).not.toContain('{{');
    expect(text).toContain('不要执行任何命令');
  });
});
