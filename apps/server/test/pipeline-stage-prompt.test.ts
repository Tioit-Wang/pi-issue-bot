/**
 * 阶段提示词的装配与作用域（`app/worker-deps.ts` 的 `buildStagePrompt` / `buildNoticePrompt` /
 * `createPromptEnricher({stage})`，§16.3 矩阵 / V9 / V11 / V16）。
 *
 * V9 的判据是**最终 prompt 里 grep 到什么**：
 *  - 阶段 0/1：grep **不到** P1（`## 项目约定`）与技能层（`## 任务技能`），
 *    但**能** grep 到 AGENTS.md（Q9）与各自阶段系统提示词；
 *  - 缺省（不传 stage）：P1 与技能层照常出现 —— 装配结果与接线前一致。
 *
 * 另一条硬约束：输出契约（信封形状）永远在最后一段，且**不可配**（V16）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildNoticePrompt,
  buildStagePrompt,
  createPromptEnricher,
  gateStateOfPromptText,
  isRecheckTask,
  STAGE_PROMPT_KIND_OF,
  toSupplements,
} from '../src/app/worker-deps.ts';
import type { StagePromptTask } from '../src/app/worker-deps.ts';
import { AGENTS_MD_TRUNCATED_MARK } from '../src/skills/agents-md.ts';
import { ASSEMBLE_HEADINGS } from '../src/skills/assemble.ts';
import { savePrompt } from '../src/prompt/store.ts';
import { upsertRepo } from '../src/config/repo-config.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'test/stage-prompt';
const P1_TEXT = '本项目一律用中文回答，贴代码时给出文件路径与行号。';
const AGENTS_TEXT = '提交前必须跑 pnpm -c typecheck。';

let db: TestDb;
let worktreeDir: string;

function task(over: Partial<StagePromptTask> = {}): StagePromptTask {
  return {
    repo: REPO,
    targetKind: 'issue',
    targetNumber: 7,
    actorLogin: 'alice',
    targetTitle: '保存时偶发 500',
    targetBody: '点击保存后偶发 500，日志里没有堆栈。',
    targetSupplement: [],
    ...over,
  };
}

beforeAll(async () => {
  db = await openTestDb();
  // 真目录：AGENTS.md 与仓库技能都从 worktree 读（Q9 的注入源）
  worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pi-bot-stage-prompt-'));
  await writeFile(path.join(worktreeDir, 'AGENTS.md'), AGENTS_TEXT, 'utf8');
  await mkdir(path.join(worktreeDir, '.github', 'pi-bot', 'skills'), { recursive: true });
  await writeFile(
    path.join(worktreeDir, '.github', 'pi-bot', 'skills', 'demo.md'),
    [
      '---',
      'name: /demo',
      'description: 演示技能：只输出一句话的技能正文',
      'allowed-tools: [Read]',
      'outputs: [comment]',
      '---',
      '技能正文：只输出一句话。',
    ].join('\n'),
    'utf8',
  );
});

afterAll(async () => {
  await rm(worktreeDir, { recursive: true, force: true });
  await db.sql('delete from prompt_versions where repo = $1', [REPO]);
  await db.sql('delete from repos where repo_full_name = $1', [REPO]);
  await db.close();
});

beforeEach(async () => {
  await db.sql('delete from prompt_versions where repo = $1', [REPO]);
  await db.sql('delete from repos where repo_full_name = $1', [REPO]);
});

describe('buildStagePrompt：阶段 0（light，无 worktree）', () => {
  it('用内置默认模板渲染 title / body / recheck，且不含 P1 与技能层', async () => {
    const built = await buildStagePrompt({ stage: 'format', task: task() });

    expect(built.kind).toBe(STAGE_PROMPT_KIND_OF.format);
    expect(built.kind).toBe('format_check');
    // 内置默认模板的标志句 + 插值结果
    expect(built.prompt).toContain('判断这个 issue');
    expect(built.prompt).toContain('保存时偶发 500');
    expect(built.prompt).toContain('点击保存后偶发 500');
    expect(built.prompt).toContain('issue #7');
    // recheck 默认 false（模板里写成「{{recheck}} 为 true 表示…」）
    expect(built.recheck).toBe(false);
    expect(built.prompt).toMatch(/false\s+为 true 表示/u);
    // 阶段 0 不注入 P1 / 技能层
    expect(built.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.project}`);
    expect(built.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix}`);
    // 输出契约仍然在最后（V16）
    expect(built.prompt).toContain('```json');
    expect(built.prompt.trimEnd().endsWith('```') || built.prompt.includes('`verdict.kind`')).toBe(true);
  });

  it('AGENTS.md 照常注入（Q9：任意时刻生效）', async () => {
    const built = await buildStagePrompt({
      stage: 'format',
      task: task(),
      agentsMd: {
        root: { path: 'AGENTS.md', text: AGENTS_TEXT, truncated: false, bytes: AGENTS_TEXT.length },
        nearby: [],
        skipped: [AGENTS_MD_TRUNCATED_MARK],
      },
    });

    expect(built.prompt).toContain(ASSEMBLE_HEADINGS.agents);
    expect(built.prompt).toContain(AGENTS_TEXT);
  });

  it('重跑：recheck=true（D8 要求通过也要回一句确认）', async () => {
    const built = await buildStagePrompt({
      stage: 'format',
      task: task({ targetSupplement: [{ commentId: 1, author: 'alice', body: '补充：复现步骤见下', at: '2026-06-01T00:00:00.000Z' }] }),
      pipeline: {
        repo: REPO,
        issueNumber: 7,
        stage: 'format',
        state: 'pending',
        category: null,
        formatAttempts: 1,
        formatFailCount: 2,
        classifyAttempts: 0,
        issueVersion: 'v2',
        infoRequestedAt: null,
        lastRecheckAt: null,
        mentionSentAt: null,
        mentionCategory: null,
        gateNoticeAt: null,
        sessionId: null,
        sessionCursor: 0,
        sessionTurns: 0,
        sessionStartedAt: null,
        staleAt: null,
        blockedReason: null,
        readyAt: null,
        closedAt: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });

    expect(built.recheck).toBe(true);
    expect(built.prompt).toContain('true 表示');
  });

  it('补充评论置顶在正文之前（评论优先，E4）', async () => {
    const built = await buildStagePrompt({
      stage: 'format',
      task: task({
        targetSupplement: [{ commentId: 2, author: 'alice', body: '【补充】环境是 Node 22', at: '2026-06-01T00:00:00.000Z' }],
      }),
    });

    const supplementAt = built.prompt.indexOf('【补充】环境是 Node 22');
    const bodyAt = built.prompt.indexOf('点击保存后偶发 500');
    expect(supplementAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(-1);
    expect(supplementAt).toBeLessThan(bodyAt);
  });

  it('项目版阶段提示词整体覆盖内置默认（Q1）', async () => {
    const created = await upsertRepo(db.pool, {
      repo: REPO,
      settings: { pipeline: { managers: ['alice'] } },
    });
    expect(created.ok).toBe(true);
    const saved = await savePrompt(
      db.pool,
      REPO,
      '自定义格式检查：{{title}}\n{{body}}\n{{recheck}}',
      null,
      'format_check',
    );
    expect(saved.ok).toBe(true);

    const built = await buildStagePrompt({ stage: 'format', task: task(), db: db.pool });

    expect(built.prompt).toContain('自定义格式检查：');
    // 内置默认的那句被整段替换掉（不拼接）
    expect(built.prompt).not.toContain('判断这个 issue');
  });
});

describe('buildStagePrompt：阶段 1（classify）', () => {
  it('用 classify 的模板，仍然不含 P1 / 技能层，但含 AGENTS.md', async () => {
    const built = await buildStagePrompt({
      stage: 'classify',
      task: task(),
      settings: {
        labels: {
          vocabulary: [{ name: 'bug', role: 'defect', meaning: '缺陷' }],
        },
      } as never,
      agentsMd: {
        root: { path: 'AGENTS.md', text: AGENTS_TEXT, truncated: false, bytes: AGENTS_TEXT.length },
        nearby: [],
        skipped: [],
      },
    });

    expect(built.kind).toBe('classify');
    expect(built.prompt).toContain('判断');
    expect(built.prompt).toContain('bug [defect]');
    expect(built.prompt).toContain(AGENTS_TEXT);
    expect(built.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.project}`);
    expect(built.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix}`);
  });
});

describe('buildNoticePrompt（门禁回执，Q8）', () => {
  it('从 prompt_text 取 gate_state 并渲染内置模板', () => {
    const built = buildNoticePrompt({
      task: { ...task(), promptText: 'gate_state=format/awaiting_info; blocked_command=/review-pr' },
    });

    expect(built.gateState).toBe('format/awaiting_info');
    expect(built.prompt).toContain('format/awaiting_info');
    // 回执不注入 P1（light + 内置模板）
    expect(built.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.project}`);
  });

  it('gate_state 缺失时不抛，给 unknown', () => {
    expect(gateStateOfPromptText(null)).toBe('unknown');
    expect(gateStateOfPromptText('blocked_command=/x')).toBe('unknown');
  });
});

describe('createPromptEnricher 的 stage 作用域（V9）', () => {
  const enrich = async (stage: 'format' | 'classify' | null) => {
    const enricher = createPromptEnricher({
      db: db.pool,
      stage,
      context: { repo: REPO, targetKind: 'issue', targetNumber: 7 },
    });
    return enricher({ worktreeDir, basePrompt: '第一段头\n\n输出契约（尾部）', command: '/demo' });
  };

  beforeEach(async () => {
    const created = await upsertRepo(db.pool, {
      repo: REPO,
      settings: { pipeline: { managers: ['alice'] } },
    });
    expect(created.ok).toBe(true);
    const saved = await savePrompt(db.pool, REPO, P1_TEXT);
    expect(saved.ok).toBe(true);
  });

  it('stage=format：有 AGENTS.md，没有 P1、没有技能层', async () => {
    const prompt = await enrich('format');

    expect(prompt).toContain(AGENTS_TEXT);
    expect(prompt).not.toContain(P1_TEXT);
    expect(prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.project}`);
    expect(prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix}`);
  });

  it('stage=classify：同样只加 AGENTS.md（Q9）', async () => {
    const prompt = await enrich('classify');

    expect(prompt).toContain(AGENTS_TEXT);
    expect(prompt).not.toContain(P1_TEXT);
    expect(prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix}`);
  });

  it('不传 stage：P1 与技能层照旧（与接线前一致）', async () => {
    const prompt = await enrich(null);

    expect(prompt).toContain(P1_TEXT);
    expect(prompt).toContain(AGENTS_TEXT);
    expect(prompt).toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix}`);
  });
});

describe('小工具', () => {
  it('isRecheckTask：补充评论 或 format_fail_count>0', () => {
    expect(isRecheckTask({ pipeline: null, supplements: [] })).toBe(false);
    expect(
      isRecheckTask({
        pipeline: null,
        supplements: [{ commentId: 1, author: 'a', body: 'b', at: '' }],
      }),
    ).toBe(true);
    expect(
      isRecheckTask({
        pipeline: { formatFailCount: 1 } as never,
        supplements: [],
      }),
    ).toBe(true);
  });

  it('toSupplements：坏 jsonb 只丢那一条，不整条失败', () => {
    expect(
      toSupplements([
        { commentId: 3, author: 'alice', body: '补充', at: '2026-06-01T00:00:00.000Z' },
        { body: '' },
        'not-an-object',
      ]),
    ).toEqual([{ commentId: 3, author: 'alice', body: '补充', at: '2026-06-01T00:00:00.000Z' }]);
    expect(toSupplements(null)).toEqual([]);
  });
});
