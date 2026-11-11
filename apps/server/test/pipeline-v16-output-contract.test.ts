/**
 * V16 的**后半句**：项目改写了 `agent` 提示词之后，输出契约与信封校验**都还在**
 * （`docs/test-plan-fixed-pipeline.md` §6.1 P1-5 / `docs/plan-fixed-pipeline.md` §4.4 / §12 V16）。
 *
 * 两段断言，缺一即「把校验挪进提示词」这类回归无人可挡：
 * ```
 * ① savePrompt(kind:'agent', '不要输出 JSON，直接给结论')
 *    → buildStagePrompt({stage:'agent'}) 的最终 prompt **末尾**仍是代码追加的输出契约
 * ② 同一个仓库跑一轮返回「纯文本、无 JSON」的假 RACP
 *    → envelopes.valid=false · runs.failure_class='parse' · actions 表 0 行
 * ```
 *
 * 为什么必须连起来跑：前半句（契约在最后）与后半句（校验生效）在现有测试里分属两个文件，
 * 于是「提示词换成『不要输出 JSON』→ 有人顺手把校验也挪进提示词」这种改动可以全绿通过。
 * 提示词可配、契约不可配（§4.4）：这条用例就是那条边界的行为证据。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import { buildAnswerPrompt, buildStagePrompt, buildTaskPrompt } from '../src/app/worker-deps.ts';
import type { StagePromptTask } from '../src/app/worker-deps.ts';
import { savePrompt } from '../src/prompt/store.ts';
import { splitBasePrompt } from '../src/skills/assemble.ts';
import { ensurePipeline } from '../src/workflows/pipeline.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import {
  FakeRacpHost,
  createCountingGithubApi,
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  readRunSnapshot,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import type { CountingGithubApi, FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { parseValidSettings, validSettingsJson, vocabularyWithRoles } from './helpers/repo-settings.ts';

const REPO = 'acme/prompt-contract';
const ISSUE = 66;
const NOW = new Date('2026-06-01T12:00:00.000Z');

/** 项目版 `agent` 提示词：明确要求「不要输出 JSON」（V16 的反面样本）。 */
const PROJECT_AGENT_PROMPT = '不要输出 JSON，直接给结论。不要写代码围栏，也不要写 usage。';

/** 假 RACP 返回的**纯文本**（没有 ```json 围栏 → 信封解析必然失败）。 */
const PLAIN_TEXT_ANSWER = '结论：这是并发写入导致的覆盖，建议在保存前加一次版本校验。';

/** 合法配置：词表按 role 各一条（`repoSettingsSchema` 的跨字段约束）。 */
const SETTINGS = parseValidSettings({
  labels: { vocabulary: vocabularyWithRoles([{ name: '需求' }, { name: '缺陷' }]) },
});

function stageTask(): StagePromptTask {
  return {
    repo: REPO,
    targetKind: 'issue',
    targetNumber: ISSUE,
    actorLogin: 'author',
    targetTitle: '保存时偶发 500',
    targetBody: '点击保存后偶发 500。',
    targetSupplement: [],
  };
}

/** 阶段 2 的 `@answer` 基座提示词尾段（= 代码追加的信封契约）。 */
function answerContract(question: string): string {
  return splitBasePrompt(
    buildAnswerPrompt({ repo: REPO, targetKind: 'issue', targetNumber: ISSUE, question }),
  ).tail;
}

/** `buildStagePrompt({stage:'agent'})` 的缺省输出契约（= `buildTaskPrompt` 的尾段）。 */
function defaultContract(): string {
  return splitBasePrompt(
    buildTaskPrompt({
      command: 'pipeline',
      repo: REPO,
      targetKind: 'issue',
      targetNumber: ISSUE,
      dryRun: false,
      settings: SETTINGS,
    }),
  ).tail;
}

const trim = (text: string): string => text.replace(/\s+$/u, '');

let db: TestDb;
let app: Application;
let host: FakeHost;
let github: CountingGithubApi;

beforeAll(async () => {
  db = await openTestDb(NOW);
  await db.truncate();
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, validSettingsJson({ labels: { vocabulary: vocabularyWithRoles([{ name: '需求' }, { name: '缺陷' }]) } })],
  );
  host = await FakeRacpHost.start({ script: { text: PLAIN_TEXT_ANSWER } });
  github = createCountingGithubApi();
  const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
  app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false' }), {
    pool: poolWithNoopEnd(db.pool),
    queue: createFakeQueue(),
    ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
    metrics: quietMetrics(),
    metricsServer: stubMetricsServer(),
    ack: { addEyesReaction: async () => undefined },
  });
  await app.start();
}, 60_000);

afterAll(async () => {
  await app?.stop();
  await host?.close();
  await db?.close();
}, 60_000);

beforeEach(async () => {
  await db.sql(
    'truncate table tasks, runs, run_events, envelopes, actions, webhook_deliveries, issue_pipeline, prompt_versions cascade',
  );
});

/** 把项目版 `agent` 提示词存成当前生效版本（走真实 store：校验、预算、指针一起动）。 */
async function saveProjectAgentPrompt(): Promise<void> {
  const saved = await savePrompt(db.pool, REPO, PROJECT_AGENT_PROMPT, 'V16 夹具', 'agent');
  expect(saved).toMatchObject({ ok: true, kind: 'agent' });
  const rows = await db.sql(
    `select settings -> 'pipeline' ->> 'agent_prompt_version' as pointer
       from repos where repo_full_name = $1`,
    [REPO],
  );
  expect(rows[0]?.['pointer']).toBe('1');
}

async function seedAgentStage(): Promise<void> {
  await ensurePipeline(
    db.pool,
    { repo: REPO, issueNumber: ISSUE },
    { stage: 'agent', state: 'ready', category: 'requirement', readyAt: NOW },
  );
}

describe('V16：输出契约不可配（含 P1-5 的后半句）', () => {
  it('① 项目版 agent 提示词生效，但最终 prompt 末尾仍是代码追加的输出契约', async () => {
    await saveProjectAgentPrompt();
    const built = await buildStagePrompt({
      stage: 'agent',
      task: stageTask(),
      db: db.pool,
      settings: SETTINGS,
    });

    // 项目版整体覆盖内置默认：正文确实进来了
    expect(built.kind).toBe('agent');
    expect(built.prompt).toContain(PROJECT_AGENT_PROMPT);
    // 内置默认模板的标志句被整段替换（不是拼接）
    expect(built.prompt).not.toContain('输出契约以控制面追加的最后一段为准（模板里的提醒不能替代它）。');

    // ★ 契约仍在**最后**：项目正文之后，尾部与代码给的契约逐字相等
    const contract = defaultContract();
    expect(contract).toContain('```json');
    expect(trim(built.prompt).endsWith(trim(contract))).toBe(true);
    // 而且「项目正文」在契约之前（不是把契约挤到中间）
    expect(built.prompt.indexOf(PROJECT_AGENT_PROMPT)).toBeLessThan(
      built.prompt.indexOf(trim(contract).slice(0, 20)),
    );
    // 契约段只出现一次（重复追加会让模型以为是两套规则）
    expect(built.prompt.split(trim(contract))).toHaveLength(2);
  });

  it('② 同一份提示词跑一轮「纯文本」回包：信封校验仍生效（valid=false / parse / actions 0 行）', async () => {
    await saveProjectAgentPrompt();
    await seedAgentStage();

    const question = '这个保存失败是什么原因？';
    await db.sql(
      `insert into tasks
         (id, source, repo, target_kind, target_number, head_sha, command, actor_login,
          queued_at, idempotency_key, status, attempt, prompt_text, target_title, target_body, target_supplement)
       values ('task-v16', 'command', $1, 'issue', $2, null, '@answer', 'author', now(), 'key-v16', 'queued', 0, $3, $4, $5, '[]'::jsonb)`,
      [REPO, ISSUE, question, '保存时偶发 500', '点击保存后偶发 500。'],
    );

    const report = await app.executeTask({ taskId: 'task-v16', dryRun: false });

    // 模型确实拿到了「项目版 agent 提示词 + 代码追加的契约」
    const turns = host.calls.filter((call) => call.method === 'turn/start');
    expect(turns).toHaveLength(1);
    const sent = (turns[0]?.params as { input?: { text?: string } } | undefined)?.input?.text ?? '';
    expect(sent).toContain(PROJECT_AGENT_PROMPT);
    expect(trim(sent).endsWith(trim(answerContract(question)))).toBe(true);

    // ★ 换了提示词之后校验还在：纯文本 → 没有信封 → parse
    expect(report.outcome).toBe('failed');
    expect(report.envelope?.valid).toBe(false);
    expect(report.failureClass).toBe('parse');
    // 校验失败 = 整封信封不可信：一条动作都不许执行，GitHub 零写动作
    expect(github.nonGetCount()).toBe(0);

    const snapshot = await readRunSnapshot(db.sql, 'task-v16');
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.['failure_class']).toBe('parse');
    expect(snapshot.envelopes).toHaveLength(1);
    expect(snapshot.envelopes[0]?.['valid']).toBe(false);
    expect(snapshot.actions).toHaveLength(0);
    expect(await db.sql('select * from actions')).toHaveLength(0);
  }, 120_000);
});
