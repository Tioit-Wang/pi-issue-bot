/**
 * 四条提示词版本线（`prompt_versions.kind`）的**真库**测试（§4.4 / §16.3 / V15）。
 *
 * 断言的是「库里几行、哪个指针指哪儿、历史有没有被改写」——形状由 zod 契约保证。
 * 与 `skills-store.test.ts` 共用夹具与 advisory lock（同一套 `pi_issue_bot_test`）。
 *
 * 钉住的性质：
 *  1. **四条线互不干扰**：版本号各自从 1 开始，读一条读不到别人的行；
 *  2. **指针各去各的地方**：`project` → `prompt.current_version`，
 *     三个阶段 kind → `pipeline.{format,classify,agent}_prompt_version`；
 *  3. `version = 0`：阶段 kind 回落内置默认，`project` = 不注入；
 *  4. 保存期三种校验（未知占位符 / `format_check` 缺 title·body / 超上限）**一行都不写**；
 *  5. 「恢复默认」= 指针回 0，历史版本仍在。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Pool } from 'pg';
import { upsertRepo } from '../src/config/repo-config.ts';
import type { SqlRunner } from '../src/config/repo-config.ts';
import {
  activePromptBody,
  getPrompt,
  listPromptVersions,
  resetPromptToDefault,
  rollbackPrompt,
  savePrompt,
  setPromptEnabled,
} from '../src/prompt/index.ts';
import {
  AGENT_PROMPT_DEFAULT,
  CLASSIFY_PROMPT_DEFAULT,
  FORMAT_CHECK_PROMPT_DEFAULT,
} from '../src/skills/stage-prompts.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';

/** `pg.Pool` → `SqlRunner`（`values` 的可变/只读数组形状差异，包一层最省事）。 */
const runnerOf = (pool: Pool): SqlRunner => ({
  query: (text, values) => pool.query(text, values as unknown[]),
});

describe('prompt/store · 四条版本线（kind）', () => {
  let db: TestDb;
  let runner: SqlRunner;
  let settings: Record<string, unknown>;

  beforeAll(async () => {
    db = await openTestDb();
    runner = runnerOf(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.sql('truncate table prompt_versions, runtime_flags, repos cascade');
    // settings 必须合法（`pipeline.managers` 非空）：非法时 `savePrompt()` 一律报 settings-invalid。
    const created = await upsertRepo(runner, { repo: REPO, settings: { pipeline: { managers: ['alice'] } } });
    expect(created.ok).toBe(true);
    settings = await settingsOf();
  });

  /** `repos.settings` 的当前值（指针只有一处真源）。 */
  const settingsOf = async (): Promise<Record<string, unknown>> => {
    const rows = await db.sql('select settings from repos where repo_full_name = $1', [REPO]);
    return (rows[0] as { settings: Record<string, unknown> }).settings;
  };

  const rowCount = async (kind: string): Promise<number> => {
    const rows = await db.sql('select count(*)::int as n from prompt_versions where repo = $1 and kind = $2', [REPO, kind]);
    return (rows[0] as { n: number }).n;
  };

  it('四个 kind 各自独立取号：project v1 与 format_check v1 互不影响', async () => {
    const project = await savePrompt(runner, REPO, '项目人格层 v1', null, 'project');
    const format = await savePrompt(runner, REPO, FORMAT_CHECK_PROMPT_DEFAULT, null, 'format_check');
    const classify = await savePrompt(runner, REPO, CLASSIFY_PROMPT_DEFAULT, null, 'classify');
    const agent = await savePrompt(runner, REPO, AGENT_PROMPT_DEFAULT, null, 'agent');
    for (const result of [project, format, classify, agent]) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(1);
      expect(result.kind).toBe(result.prompt.kind);
    }

    // 每条线自己的第二个版本从 2 开始，不会因为别的线存过而跳号
    const second = await savePrompt(runner, REPO, `${FORMAT_CHECK_PROMPT_DEFAULT}\n（v2）`, null, 'format_check');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.version).toBe(2);

    expect(await rowCount('project')).toBe(1);
    expect(await rowCount('format_check')).toBe(2);
    expect(await rowCount('classify')).toBe(1);
    expect(await rowCount('agent')).toBe(1);
  });

  it('指针各去各的地方：project 用 prompt.current_version，其余用 pipeline.*_prompt_version', async () => {
    await savePrompt(runner, REPO, '项目人格层', null, 'project');
    await savePrompt(runner, REPO, FORMAT_CHECK_PROMPT_DEFAULT, null, 'format_check');
    await savePrompt(runner, REPO, CLASSIFY_PROMPT_DEFAULT, null, 'classify');
    await savePrompt(runner, REPO, AGENT_PROMPT_DEFAULT, null, 'agent');

    settings = await settingsOf();
    expect(settings['prompt']).toMatchObject({ current_version: 1 });
    expect(settings['pipeline']).toMatchObject({
      format_prompt_version: 1,
      classify_prompt_version: 1,
      agent_prompt_version: 1,
      // 别的 pipeline 字段一个字都不动
      managers: ['alice'],
    });

    // 再存一次 format_check：只动它自己的指针
    await savePrompt(runner, REPO, `${FORMAT_CHECK_PROMPT_DEFAULT}\n（v2）`, null, 'format_check');
    settings = await settingsOf();
    expect(settings['pipeline']).toMatchObject({ format_prompt_version: 2, classify_prompt_version: 1 });
    expect(settings['prompt']).toMatchObject({ current_version: 1 });
  });

  it('读取隔离：查 project 读不到 classify 的行', async () => {
    await savePrompt(runner, REPO, '项目人格层', null, 'project');
    await savePrompt(runner, REPO, CLASSIFY_PROMPT_DEFAULT, null, 'classify');

    const projectVersions = await listPromptVersions(runner, REPO, 'project');
    expect(projectVersions).toHaveLength(1);
    expect(projectVersions[0]?.body).toBe('项目人格层');
    expect(projectVersions[0]?.kind).toBe('project');

    const classifyVersions = await listPromptVersions(runner, REPO, 'classify');
    expect(classifyVersions).toHaveLength(1);
    expect(classifyVersions[0]?.body).toBe(CLASSIFY_PROMPT_DEFAULT);

    // 默认参数 = project（老调用点等价）
    expect((await listPromptVersions(runner, REPO)).map((row) => row.kind)).toEqual(['project']);

    // agent 还没存过：0 行，且读到的正文是**内置默认**
    expect(await listPromptVersions(runner, REPO, 'agent')).toHaveLength(0);
    expect(await getPrompt(runner, REPO, 'agent')).toEqual({
      kind: 'agent',
      version: 0,
      body: AGENT_PROMPT_DEFAULT,
      enabled: true,
      present: false,
    });
  });

  it('version=0：阶段 kind 用内置默认，project 不注入', async () => {
    expect(await activePromptBody(runner, REPO, 'format_check')).toBe(FORMAT_CHECK_PROMPT_DEFAULT);
    expect(await activePromptBody(runner, REPO, 'classify')).toBe(CLASSIFY_PROMPT_DEFAULT);
    expect(await activePromptBody(runner, REPO, 'agent')).toBe(AGENT_PROMPT_DEFAULT);
    expect(await activePromptBody(runner, REPO, 'project')).toBe('');
    expect(await activePromptBody(runner, REPO)).toBe('');

    // 项目版整体覆盖内置默认（Q1：不拼接）——format_check 必须带 {{title}} / {{body}} 才存得进去
    const saved = await savePrompt(runner, REPO, '只检查标题：{{title}} 正文：{{body}}', null, 'format_check');
    expect(saved.ok).toBe(true);
    expect(await activePromptBody(runner, REPO, 'format_check')).toBe('只检查标题：{{title}} 正文：{{body}}');
  });

  it('未知占位符 / 缺 title·body / 超上限：拒写且一行不留', async () => {
    const unknown = await savePrompt(runner, REPO, '标题 {{title}} 还有 {{oops}}', null, 'classify');
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe('placeholder-unknown');
    expect(unknown.unknownPlaceholders).toEqual(['oops']);
    expect(unknown.message).toContain('{{oops}}');

    const missing = await savePrompt(runner, REPO, '只判断 {{repo}}', null, 'format_check');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('placeholder-missing');
    expect(missing.missingPlaceholders).toEqual(['title', 'body']);

    const tooLong = await savePrompt(runner, REPO, 'a'.repeat(4_001), null, 'agent');
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.code).toBe('body-too-long');
    expect(tooLong.message).toContain('4000');

    // classify 的上限是 8000：4001 能过，8001 不能
    expect((await savePrompt(runner, REPO, 'a'.repeat(4_001), null, 'classify')).ok).toBe(true);
    const classifyTooLong = await savePrompt(runner, REPO, 'a'.repeat(8_001), null, 'classify');
    expect(classifyTooLong.ok).toBe(false);
    if (classifyTooLong.ok) return;
    expect(classifyTooLong.code).toBe('body-too-long');

    // 被拒的三种（外加 classify 的 8001）都没写库
    expect(await rowCount('agent')).toBe(0);
    expect(await rowCount('project')).toBe(0);
    expect(await rowCount('format_check')).toBe(0);
    expect(await rowCount('classify')).toBe(1);
  });

  it('project 的未知占位符不校验（沿用现状），但仍受 12k 预算管', async () => {
    const ok = await savePrompt(runner, REPO, '写法自由：{{anything}} 都在', null, 'project');
    expect(ok.ok).toBe(true);

    const tooBig = await savePrompt(runner, REPO, 'x'.repeat(3_000), null, 'project');
    expect(tooBig.ok).toBe(false);
    if (tooBig.ok) return;
    expect(tooBig.code).toBe('body-too-long');
    expect(tooBig.budget?.available).toBeGreaterThan(0);
  });

  it('回滚按 kind 独立：回滚 classify 不动 project 的指针与历史', async () => {
    await savePrompt(runner, REPO, '项目人格层 v1', null, 'project');
    await savePrompt(runner, REPO, `${CLASSIFY_PROMPT_DEFAULT}\n（v1）`, null, 'classify');
    await savePrompt(runner, REPO, `${CLASSIFY_PROMPT_DEFAULT}\n（v2）`, null, 'classify');

    const rolled = await rollbackPrompt(runner, REPO, 1, 'classify');
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.version).toBe(3);
    expect(rolled.prompt.body).toBe(`${CLASSIFY_PROMPT_DEFAULT}\n（v1）`);

    settings = await settingsOf();
    expect(settings['pipeline']).toMatchObject({ classify_prompt_version: 3, format_prompt_version: 0 });
    expect(settings['prompt']).toMatchObject({ current_version: 1 });

    // 拿 classify 的版本号去回滚 project 必须找不到
    const crossKind = await rollbackPrompt(runner, REPO, 3, 'project');
    expect(crossKind.ok).toBe(false);
    if (crossKind.ok) return;
    expect(crossKind.code).toBe('version-not-found');
  });

  it('恢复默认：指针回 0、历史仍在；之后还能回滚回项目版本', async () => {
    await savePrompt(runner, REPO, 'agent 项目版', null, 'agent');
    expect((await getPrompt(runner, REPO, 'agent')).body).toBe('agent 项目版');

    const restored = await resetPromptToDefault(runner, REPO, 'agent');
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.prompt.version).toBe(0);
    expect(restored.prompt.body).toBe(AGENT_PROMPT_DEFAULT);

    settings = await settingsOf();
    expect(settings['pipeline']).toMatchObject({ agent_prompt_version: 0 });
    // 历史版本没被删
    expect(await rowCount('agent')).toBe(1);

    // 「恢复默认」之后仍然能回滚回那一版
    const rolled = await rollbackPrompt(runner, REPO, 1, 'agent');
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.version).toBe(2);
    expect(await activePromptBody(runner, REPO, 'agent')).toBe('agent 项目版');
  });

  it('project 关掉开关 = 不注入（其它三条线不受影响）', async () => {
    await savePrompt(runner, REPO, '项目人格层', null, 'project');
    await savePrompt(runner, REPO, '格式检查项目版 {{title}} {{body}}', null, 'format_check');

    const off = await setPromptEnabled(runner, REPO, false);
    expect(off.ok).toBe(true);

    expect(await activePromptBody(runner, REPO, 'project')).toBe('');
    expect(await getPrompt(runner, REPO, 'project')).toMatchObject({ enabled: false, body: '项目人格层' });
    // 阶段线没有「关掉」这个概念（E1 全量切换：接入即必须走三段）
    expect(await getPrompt(runner, REPO, 'format_check')).toMatchObject({ enabled: true });
    expect(await activePromptBody(runner, REPO, 'format_check')).toBe('格式检查项目版 {{title}} {{body}}');
  });
});
