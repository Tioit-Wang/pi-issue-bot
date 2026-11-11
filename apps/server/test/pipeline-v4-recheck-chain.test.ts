/**
 * V4 的**端到端链路**（`docs/test-plan-fixed-pipeline.md` §6.1 P1-2 / `docs/plan-fixed-pipeline.md`
 * §5 第 2 行 + D8 / §12 V4）。
 *
 * 判据横跨两个文件，这里一次跑完：
 * ```
 * format/awaiting_info ──作者补充评论──▶ 新 pipeline:format（锚含 commentId，state 回 pending）
 *    └─ 假 RACP 返回 **pass 且没有 comment 动作** ─▶ 控制面兜底确认评论（恰好 1 条）+ rocket
 *         ─▶ 行变 classify/pending · 分类任务已入队
 * ```
 *
 * 为什么这条用例必须单独存在：`WH` 只测到「评论 → 建了一行任务」，`FP` 只测到「重检通过要有确认
 * 评论」，中间的 `executeFormatPlan()` / `effects.enqueue` 在装配层（`app/compose.ts`）没有任何
 * 一条用例把它们串起来 —— 两段各自绿、串起来不发评论是很典型的一种回归。
 *
 * 计数口径（与实现核对过，见 `app/compose.ts::enqueueStageTask`）：
 *  - `createIssueComment` **恰好 1 次**：本轮之前那次「不通过」的评论发生在用例窗口之外（行是种进去的），
 *    所以窗口内唯一一条评论就是重检通过的确认句；
 *  - `tasks` **恰好 2 行**：① 评论触发的 `pipeline:format` 重跑任务；② pass 之后阶段交接写下的
 *    `pipeline:classify`（阶段任务入队同样落一行 `tasks`，这是 U 型链路的第二个可见产物）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import type { GithubWriteApi, IssueComment } from '../src/github/index.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import { FORMAT_PASS_COMMENT_FALLBACK } from '../src/workflows/pipeline-format.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import { idempotencyKeyFor, issueVersionHash } from '../src/http/index.ts';
import { supplementPlanFor } from '../src/http/webhook.ts';
import type { PipelineSupplementDecision } from '../src/http/webhook.ts';
import {
  E2E_WEBHOOK_SECRET,
  FakeRacpHost,
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  signBody,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import type { FakeQueue, FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson, vocabularyWithRoles } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const ISSUE = 7;
const NOW = new Date('2026-06-01T12:00:00.000Z');
/** 载荷里的 `issue.updated_at`：锚的前半段就是它的 hash（`issueVersionHash()`）。 */
const UPDATED_AT = '2026-05-31T00:00:00Z';
const SUPPLEMENT_COMMENT_ID = 777;
const SUPPLEMENT_BODY = '补上复现步骤：1. 打开设置页 2. 点保存 3. 500';

/**
 * 合法配置：`pipeline.managers` 非空 + 词表按 role 各一条（`repoSettingsSchema` 的跨字段约束）。
 * 一律走夹具工厂，不手写字表（§4.5 / Q4）。
 */
const SETTINGS = {
  labels: { vocabulary: vocabularyWithRoles([{ name: '需求' }, { name: '缺陷' }]) },
};

/**
 * 重检通过的信封：`stage.result=pass` 且 **actions 为空**（模型没写确认评论）。
 * 这正是 D8 兜底句生效的前提 —— 也是这条用例要钉的那条路径。
 */
const FORMAT_PASS_NO_COMMENT = [
  '格式齐了，进入分类。',
  '```json',
  JSON.stringify({
    stage: { name: 'format', result: 'pass' },
    verdict: {
      kind: 'issue',
      labels: [],
      evidence: [{ rule: 'has-repro-steps', quote: '复现步骤：1. 打开设置页', passed: true }],
    },
    actions: [],
    usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.002 },
  }),
  '```',
].join('\n');

/* ── 可断言的假 GitHub 写面（记录评论正文，`createCountingGithubApi` 只记方法名）── */

interface RecordingGithub {
  readonly api: GithubWriteApi;
  readonly comments: Array<{ readonly issueNumber: number; readonly body: string }>;
  readonly labels: Array<{ readonly issueNumber: number; readonly labels: readonly string[] }>;
  readonly closes: number[];
  nonCommentWrites(): string[];
}

function createRecordingGithub(): RecordingGithub {
  const comments: Array<{ issueNumber: number; body: string }> = [];
  const labels: Array<{ issueNumber: number; labels: readonly string[] }> = [];
  const closes: number[] = [];
  let nextId = 9_000;
  const api: GithubWriteApi = {
    async listIssueComments(): Promise<readonly IssueComment[]> {
      return [];
    },
    async createIssueComment(input) {
      comments.push({ issueNumber: input.issueNumber, body: input.body });
      nextId += 1;
      return { id: nextId, htmlUrl: null };
    },
    async addLabels(input) {
      labels.push({ issueNumber: input.issueNumber, labels: [...input.labels] });
    },
    async removeLabel() {},
    async createIssue() {
      nextId += 1;
      return { number: nextId };
    },
    async closeIssue(input) {
      closes.push(input.issueNumber);
    },
  };
  return {
    api,
    comments,
    labels,
    closes,
    nonCommentWrites: () => [
      ...labels.map((item) => `addLabels:${item.labels.join(',')}`),
      ...closes.map((issue) => `closeIssue:${String(issue)}`),
    ],
  };
}

let db: TestDb;
let app: Application;
let host: FakeHost;
let github: RecordingGithub;
let queue: FakeQueue;

beforeAll(async () => {
  db = await openTestDb(NOW);
  await db.truncate();
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, validSettingsJson(SETTINGS)],
  );
  host = await FakeRacpHost.start({ script: { text: FORMAT_PASS_NO_COMMENT } });
  github = createRecordingGithub();
  queue = createFakeQueue();
  const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
  app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false' }), {
    pool: poolWithNoopEnd(db.pool),
    queue,
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
    'truncate table tasks, runs, run_events, envelopes, actions, webhook_deliveries, issue_pipeline cascade',
  );
  github.comments.length = 0;
  github.labels.length = 0;
  github.closes.length = 0;
  queue.record.sent.length = 0;
});

/** `format/awaiting_info`：上一轮（用例窗口之外）已经不通过过一次，所以 `format_fail_count=1`。 */
async function seedAwaitingInfo(): Promise<void> {
  await ensurePipeline(
    db.pool,
    { repo: REPO, issueNumber: ISSUE },
    { stage: 'format', state: 'awaiting_info', issueVersion: 'v1', infoRequestedAt: NOW, readyAt: null },
  );
  await db.sql(
    `update issue_pipeline
        set format_attempts = 1, format_fail_count = 1, info_requested_at = $3
      where repo = $1 and issue_number = $2`,
    [REPO, ISSUE, NOW],
  );
}

/** 作者补充评论（既没命令也没 `@` → 走 E4 的补充通道）。 */
async function deliverSupplement(commentId = SUPPLEMENT_COMMENT_ID): Promise<void> {
  const body = JSON.stringify({
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: 'author', type: 'User' },
    issue: {
      number: ISSUE,
      title: '保存时偶发 500',
      body: '点击保存后偶发 500。',
      user: { login: 'author' },
      author_association: 'OWNER',
      updated_at: UPDATED_AT,
    },
    comment: {
      id: commentId,
      body: SUPPLEMENT_BODY,
      author_association: 'OWNER',
      user: { login: 'author', type: 'User' },
    },
  });
  const response = await app.server.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': `d-v4-${String(commentId)}`,
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
    },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ action: 'enqueued' });
}

async function taskRows(): Promise<Array<Record<string, unknown>>> {
  return db.sql(
    `select id, command, source, idempotency_key, target_supplement
       from tasks where repo = $1 and target_number = $2
      order by command`,
    [REPO, ISSUE],
  );
}

/** 与 webhook 同一条公式：`supplementPlanFor()` 的锚原料 + `idempotencyKeyFor()`。 */
function supplementKey(commentId: number): string {
  const decision: PipelineSupplementDecision = {
    action: 'pipeline-supplement',
    targetNumber: ISSUE,
    isPullRequest: false,
    actorLogin: 'author',
    association: 'OWNER',
    commentId,
    body: SUPPLEMENT_BODY,
    issueVersion: issueVersionHash(UPDATED_AT),
    title: '保存时偶发 500',
    issueBody: '点击保存后偶发 500。',
    issueAuthor: 'author',
  };
  return idempotencyKeyFor(supplementPlanFor(decision, 'format'), REPO);
}

describe('V4：补充评论 → 重跑 pass → 恰好一条确认评论（P1-2）', () => {
  it('评论触发新 pipeline:format（锚含 commentId）→ pass 后 1 条兜底确认句、行 classify/pending、分类已入队', async () => {
    await seedAwaitingInfo();
    await deliverSupplement();

    /* ① 触发段：新任务 + 锚含 commentId + 状态回 pending + 补充正文置顶原料 */
    const before = await taskRows();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ command: 'pipeline:format', source: 'pipeline' });
    // 补充段：这一条评论的 id / 作者 / 正文就是重跑任务的输入（`at` 取自真实时钟，不断言具体值）
    expect(before[0]?.['target_supplement']).toEqual([
      expect.objectContaining({ commentId: SUPPLEMENT_COMMENT_ID, author: 'author', body: SUPPLEMENT_BODY }),
    ]);
    // ★ 锚 = `<issueVersion hash>:<commentId>` —— 用的是与 webhook 完全同一条公式
    expect(before[0]?.['idempotency_key']).toBe(supplementKey(SUPPLEMENT_COMMENT_ID));
    // 反向钉住：换一个 commentId 就是另一个锚（否则补充信息会被静默吞掉）
    expect(before[0]?.['idempotency_key']).not.toBe(supplementKey(SUPPLEMENT_COMMENT_ID + 1));
    const pending = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
    expect(pending).toMatchObject({ stage: 'format', state: 'pending' });

    /* ② 执行段：假 RACP 返回 pass 且没有 comment 动作 */
    const report = await app.executeTask({ taskId: String(before[0]?.['id']) });
    expect(report.outcome).toBe('succeeded');
    expect(report.envelope?.valid).toBe(true);
    expect(report.sessionMode).toBe('ephemeral');

    /* ③ ★ 恰好一条评论，且是控制面兜底确认句（模型没写 → D8 的唯一例外） */
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.issueNumber).toBe(ISSUE);
    expect(github.comments[0]?.body).toBe(FORMAT_PASS_COMMENT_FALLBACK);
    expect(github.comments[0]?.body).toBe('已收到补充信息，格式检查通过。');
    // pass 的其它写面：零标签、零关单
    expect(github.nonCommentWrites()).toEqual([]);

    /* ④ 状态：classify/pending；info_requested_at 清空 */
    const after = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
    expect(after).toMatchObject({ stage: 'classify', state: 'pending', infoRequestedAt: null });

    /* ⑤ tasks 恰好 2 行：重跑任务 + 阶段交接任务 */
    const rows = await taskRows();
    expect(rows.map((row) => row['command'])).toEqual(['pipeline:classify', 'pipeline:format']);
    expect(rows.map((row) => row['source'])).toEqual(['pipeline', 'pipeline']);

    /* ⑥ 分类任务真的入队了（队列里 1 条 pipeline:classify，且指向新任务行） */
    const classifyRow = rows.find((row) => row['command'] === 'pipeline:classify');
    const enqueued = queue.record.sent.filter((job) => job.data.command === 'pipeline:classify');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.data.taskId).toBe(String(classifyRow?.['id']));
    expect(enqueued[0]?.data.repo).toBe(REPO);
    // 评论触发的那一条也走了同一条入队通道（共 2 次 send）
    expect(queue.record.sent.filter((job) => job.data.command === 'pipeline:format')).toHaveLength(1);
  }, 120_000);
});
