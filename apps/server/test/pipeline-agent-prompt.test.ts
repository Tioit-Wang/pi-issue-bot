/**
 * 阶段 2 的四层提示词 + 无 worktree 时的 AGENTS.md（`docs/plan-fixed-pipeline.md` §7 / §16.3 / V9 / V16 / Q9）。
 *
 * 三条判据（都是「grep 最终 prompt」）：
 *  1. **阶段 2 四层都在**：`kind=agent` 阶段系统提示词（head）→ P1（项目约定）→ AGENTS.md → 技能层；
 *  2. **阶段 0/1 有 AGENTS.md、没有 P1 与技能层**（Q9 只放开 AGENTS.md 这一层）；
 *  3. **输出契约永远在最后且不可配**（V16）：把 agent 提示词改成「不要输出 JSON」也不影响。
 *
 * 另外验「无 worktree 取 AGENTS.md」的实现（`createRepoAgentsMdLoader`）：缓存、读不到 → null + 一次 warn、
 * 超长截断、没有 GitHub 读面时静默 `null`。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildStagePrompt,
  buildTaskPrompt,
  createPromptEnricher,
  createRepoAgentsMdLoader,
  stagePromptSupplementsOf,
  stagePromptVarsOf,
} from '../src/app/worker-deps.ts';
import type { RepoFileReader, StagePromptTask } from '../src/app/worker-deps.ts';
import {
  AGENTS_MD_TRUNCATED_MARK,
  AGENTS_MD_UNTRUSTED_LABEL,
} from '../src/skills/agents-md.ts';
import { ASSEMBLE_HEADINGS } from '../src/skills/assemble.ts';
import { AGENT_PROMPT_DEFAULT } from '../src/skills/stage-prompts.ts';
import { savePrompt } from '../src/prompt/store.ts';
import { upsertRepo } from '../src/config/repo-config.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { parseValidSettings, validRepoSettings } from './helpers/repo-settings.ts';

const REPO = 'test/agent-prompt';
const AGENTS_TEXT = '提交前必须跑 pnpm -c typecheck；不要动 migrations/。';
const P1_TEXT = '本项目一律用中文回答，贴代码时给出文件路径与行号。';

let db: TestDb;
let worktreeDir: string;

const SETTINGS = parseValidSettings({});

function task(over: Partial<StagePromptTask> = {}): StagePromptTask {
  return {
    repo: REPO,
    targetKind: 'issue',
    targetNumber: 12,
    actorLogin: 'alice',
    targetTitle: '保存时偶发 500',
    targetBody: '点击保存后偶发 500，日志里没有堆栈。',
    targetSupplement: [],
    ...over,
  };
}

beforeAll(async () => {
  db = await openTestDb();
  worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pi-bot-agent-prompt-'));
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
  const created = await upsertRepo(db.pool, {
    repo: REPO,
    // 合法 `repos.settings`（`managers` 非空 + 词表两角色，§4.5）：非法时 `savePrompt()` 报 settings-invalid
    settings: validRepoSettings(),
  });
  expect(created.ok).toBe(true);
});

/* ── 无 worktree 的 AGENTS.md（Q9）────────────────────────────────────────────── */

describe('createRepoAgentsMdLoader（阶段 0 没有检出时的 AGENTS.md）', () => {
  function countingReader(text: string | null): RepoFileReader & { readonly calls: number[] } {
    const calls: number[] = [];
    return {
      calls,
      readFile: async () => {
        calls.push(1);
        return text === null ? null : { text };
      },
    };
  }

  it('读到正文：走同一套清洗与围栏（与 worktree 版同形）', async () => {
    const reader = countingReader(AGENTS_TEXT);
    const load = createRepoAgentsMdLoader({ reader });

    const result = await load(REPO);

    expect(result?.root?.path).toBe('AGENTS.md');
    expect(result?.root?.text).toContain(AGENTS_TEXT);
    // 围栏标签与 `collectAgentsMd()` 一致：装配层不需要知道这段是 API 读的还是文件读的
    expect(result?.root?.text).toContain(`<<<PI-BOT:UNTRUSTED:${AGENTS_MD_UNTRUSTED_LABEL}>>>`);
    expect(reader.calls).toHaveLength(1);
  });

  it('缓存：同一仓库在 TTL 内只打一次 API', async () => {
    const reader = countingReader(AGENTS_TEXT);
    let clock = 0;
    const load = createRepoAgentsMdLoader({ reader, now: () => clock, ttlMs: 60_000 });

    await load(REPO);
    await load(REPO);
    expect(reader.calls).toHaveLength(1);

    clock = 120_000;
    await load(REPO);
    expect(reader.calls).toHaveLength(2);
  });

  it('读不到：null + 一次 warn（同一仓库不刷日志）', async () => {
    const reader = countingReader(null);
    const warns: string[] = [];
    const load = createRepoAgentsMdLoader({
      reader,
      ttlMs: 0,
      logger: {
        warn: (_fields: Record<string, unknown> | string, message?: string) => {
          warns.push(String(message));
        },
      } as never,
    });

    expect(await load(REPO)).toBeNull();
    expect(await load(REPO)).toBeNull();
    expect(reader.calls).toHaveLength(2);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('AGENTS.md');
  });

  it('读抛错：null + warn（不阻塞阶段 0）', async () => {
    const warns: string[] = [];
    const load = createRepoAgentsMdLoader({
      reader: {
        readFile: async () => {
          throw new Error('404 Not Found');
        },
      },
      logger: {
        warn: (_fields: Record<string, unknown> | string, message?: string) => {
          warns.push(String(message));
        },
      } as never,
    });

    expect(await load(REPO)).toBeNull();
    expect(warns.join('|')).toContain('读仓库根 AGENTS.md 失败');
  });

  it('没有 GitHub 读面：null，且一条日志都不刷', async () => {
    const warns: string[] = [];
    const load = createRepoAgentsMdLoader({
      reader: null,
      logger: {
        warn: (_fields: Record<string, unknown> | string, message?: string) => {
          warns.push(String(message));
        },
      } as never,
    });

    expect(await load(REPO)).toBeNull();
    expect(warns).toHaveLength(0);
  });

  it('超长：截断并留可见标记', async () => {
    const reader = countingReader('约定'.repeat(5_000));
    const load = createRepoAgentsMdLoader({ reader });

    const result = await load(REPO);

    expect(result?.root?.truncated).toBe(true);
    expect(result?.root?.text).toContain(AGENTS_MD_TRUNCATED_MARK);
  });
});

/* ── 阶段 0：AGENTS.md 进来了，P1/技能层没有 ─────────────────────────────────── */

describe('阶段 0（light）的最终 prompt', () => {
  it('含 AGENTS.md，不含 P1 与技能层（Q9 / V9）', async () => {
    const reader: RepoFileReader = { readFile: async () => ({ text: AGENTS_TEXT }) };
    const agentsMd = await createRepoAgentsMdLoader({ reader })(REPO);
    // P1 存在（面板里配过），阶段 0 也不该注入它
    expect((await savePrompt(db.pool, REPO, P1_TEXT)).ok).toBe(true);

    const built = await buildStagePrompt({
      stage: 'format',
      task: task(),
      settings: SETTINGS,
      db: db.pool,
      agentsMd,
    });

    expect(built.prompt).toContain(ASSEMBLE_HEADINGS.agents);
    expect(built.prompt).toContain(AGENTS_TEXT);
    expect(built.prompt).not.toContain(P1_TEXT);
    expect(built.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.project}`);
    expect(built.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix}`);
  });
});

/* ── 阶段 2：四层都在 + 输出契约不可配（V9 / V16）───────────────────────────── */

describe('阶段 2（agent）的最终 prompt', () => {
  const enrich = async (input: { readonly p1: string | null; readonly stageBody?: string }) => {
    if (input.p1 !== null) {
      expect((await savePrompt(db.pool, REPO, input.p1)).ok).toBe(true);
    }
    if (input.stageBody !== undefined) {
      expect((await savePrompt(db.pool, REPO, input.stageBody, null, 'agent')).ok).toBe(true);
    }
    const t = task({ targetSupplement: [{ commentId: 7, author: 'alice', body: '补充：Node 22', at: '2026-06-01T00:00:00.000Z' }] });
    const enricher = createPromptEnricher({
      db: db.pool,
      stage: 'agent',
      context: { repo: REPO, targetKind: 'issue', targetNumber: 12 },
      stageVars: stagePromptVarsOf({ task: t, stage: 'agent', settings: SETTINGS }),
      stageSupplements: stagePromptSupplementsOf(t),
    });
    // 真实的 basePrompt 形状：head（身份行）+ 尾部（输出契约）。阶段 2 的 head 会被 agent 段顶掉，
    // 尾部（契约）必须原样留到最后 —— 这正是 V16 的判据。
    const basePrompt = buildTaskPrompt({
      command: '/demo',
      repo: REPO,
      targetKind: 'issue',
      targetNumber: 12,
      dryRun: false,
      settings: SETTINGS,
    });
    return enricher({ worktreeDir, basePrompt, command: '/demo' });
  };

  it('四层齐全：agent 阶段提示词 + P1 + AGENTS.md + 技能层，契约仍在最后', async () => {
    const prompt = await enrich({ p1: P1_TEXT });

    // 1) head = 内置默认的 agent 阶段提示词（且插值了任务上下文）
    expect(prompt).toContain('issue 处理助手');
    expect(prompt).toContain('保存时偶发 500');
    expect(prompt).toContain('补充：Node 22');
    // 2) P1
    expect(prompt).toContain(P1_TEXT);
    expect(prompt).toContain(`## ${ASSEMBLE_HEADINGS.project}`);
    // 3) AGENTS.md（worktree 里那份）
    expect(prompt).toContain(AGENTS_TEXT);
    // 4) 技能层
    expect(prompt).toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix} /demo`);
    expect(prompt).toContain('技能正文：只输出一句话。');

    // 层序：agent 段在 P1 之前，P1 在 AGENTS 之前，技能在最后一块背景里
    const headAt = prompt.indexOf('issue 处理助手');
    const p1At = prompt.indexOf(P1_TEXT);
    const agentsAt = prompt.indexOf(AGENTS_TEXT);
    const skillAt = prompt.indexOf(`## ${ASSEMBLE_HEADINGS.skillPrefix} /demo`);
    expect(headAt).toBeLessThan(p1At);
    expect(p1At).toBeLessThan(agentsAt);
    expect(agentsAt).toBeLessThan(skillAt);
  });

  it('项目版 agent 提示词整体覆盖内置默认（Q1）', async () => {
    const prompt = await enrich({ p1: P1_TEXT, stageBody: '【身份】你是本项目的保存流程专家：{{repo}} {{target}}' });

    expect(prompt).toContain('保存流程专家');
    expect(prompt).not.toContain(AGENT_PROMPT_DEFAULT.split('\n')[0] ?? '不存在的默认段');
    // P1 仍在（两段共存，Q3 撤销）
    expect(prompt).toContain(P1_TEXT);
  });

  it('改坏 agent 提示词也不影响输出契约（V16：契约代码给、不可配、永远最后）', async () => {
    const prompt = await enrich({
      p1: P1_TEXT,
      stageBody: '【身份】不要输出 JSON，也不要输出任何代码块，用自然语言回答。',
    });

    expect(prompt).toContain('不要输出 JSON');
    // 契约仍然是**最后一段**：最后一个 json 代码块在技能层之后，且它后面的收尾说明（字段白名单）也在
    const trimmed = prompt.trimEnd();
    const lastBlockAt = trimmed.lastIndexOf('```json');
    expect(lastBlockAt).toBeGreaterThan(trimmed.indexOf(`## ${ASSEMBLE_HEADINGS.skillPrefix} /demo`));
    expect(trimmed.slice(lastBlockAt)).toContain('"verdict"');
    expect(trimmed.slice(lastBlockAt)).toContain('`verdict.labels`');
    // 被改坏的 agent 提示词在契约之前，**不会**变成模型读到的最后一句
    expect(trimmed.indexOf('不要输出 JSON')).toBeLessThan(lastBlockAt);
  });
});
