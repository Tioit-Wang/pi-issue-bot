/**
 * 回归（P0-2）：`pipeline:notice` 必须真的发出**恰好一条**评论（§8 / Q8）。
 *
 * 缺陷形状（两条叠加，缺一即「一条回执都发不出来」）：
 *  1. `executeActions()` 没把 `command` 传进写回闸门 → `isWriteBackAllowed({intent:'comment',
 *     source:'pipeline', command:undefined})` 判 false，模型写的那条回执被 skipped；
 *  2. `persistPipelineAfterRun()` 的 notice 分支直接 return，注释却写「worker 已发出」。
 *
 * 拍板：**阶段评论统一由控制面发**（format / classify 本来就是这样），worker 的 pipeline 写回
 * 保持「只允许 comment 但仍然什么都不发」。所以 notice 分支必须自己用
 * `githubWrite.createIssueComment()` 发那一条，且失败只 warn。
 *
 * 四条断言：awaiting_info → 恰好 1 条且正文非空、零标签/零关单；`running` → 0 条（只 eyes）；
 * 一小时内第二次 @ → 仍 0 条；模型没写评论 → 用兜底句，仍然只有一条。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import {
  E2E_WEBHOOK_SECRET,
  FakeRacpHost,
  createCountingGithubApi,
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  signBody,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import type { CountingGithubApi, FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-01T12:00:00.000Z');

/** 门禁回执的信封：模型写的一条评论（Q8：AI 撰写）。 */
const NOTICE_ENVELOPE_TEXT = [
  '这条 issue 还在等补充信息，先把复现步骤补齐我再跑一次。',
  '```json',
  JSON.stringify({
    verdict: {
      kind: 'issue',
      labels: [],
      evidence: [{ rule: 'gate-notice', quote: '状态是 format/awaiting_info', passed: true }],
    },
    actions: [{ intent: 'comment', body: '这条 issue 还在等补充信息，先把复现步骤补齐我再跑一次。' }],
    usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.001 },
  }),
  '```',
].join('\n');

let db: TestDb;
let app: Application;
let host: FakeHost;
let github: CountingGithubApi;
const eyes: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  db = await openTestDb(NOW);
  await db.truncate();
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, validSettingsJson()],
  );
  host = await FakeRacpHost.start({ script: { text: NOTICE_ENVELOPE_TEXT } });
  github = createCountingGithubApi();
  const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
  app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false' }), {
    pool: poolWithNoopEnd(db.pool),
    queue: createFakeQueue(),
    ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
    metrics: quietMetrics(),
    metricsServer: stubMetricsServer(),
    ack: {
      addEyesReaction: async (input) => {
        eyes.push({ ...input });
      },
    },
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
  github.calls.length = 0;
  eyes.length = 0;
});

function commentBody(issueNumber: number, commentId: number): string {
  return JSON.stringify({
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: issueNumber,
      title: '登录时报 500',
      body: '复现步骤：……',
      user: { login: 'author' },
      author_association: 'OWNER',
      updated_at: '2026-05-31T00:00:00Z',
    },
    comment: {
      id: commentId,
      body: '@pi-bot /review-pr 看下',
      author_association: 'MEMBER',
      user: { login: 'alice', type: 'User' },
    },
  });
}

async function deliver(issueNumber: number, commentId: number, deliveryId: string): Promise<void> {
  const body = commentBody(issueNumber, commentId);
  const response = await app.server.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
    },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
}

async function seedRow(issueNumber: number, stage: string, state: string): Promise<void> {
  await db.sql(
    `insert into issue_pipeline (repo, issue_number, stage, state, issue_version)
     values ($1, $2, $3, $4, 'v1')`,
    [REPO, issueNumber, stage, state],
  );
}

async function tasks(): Promise<Array<Record<string, unknown>>> {
  return db.sql('select id, command, source from tasks order by queued_at, command');
}

function commentCalls(): Array<{ readonly method: string }> {
  return github.calls.filter((call) => call.method.startsWith('createIssueComment'));
}

/** 写面的「非注释」调用（标签 / 关 issue / 建 issue / 删标签）—— notice 一条都不该有。 */
function nonCommentWrites(): string[] {
  return github.calls
    .filter((call) => call.nonGet && !call.method.startsWith('createIssueComment'))
    .map((call) => call.method);
}

describe('pipeline:notice 发且只发一条评论（P0-2）', () => {
  it('format/awaiting_info：@命令 → 恰好 1 条评论、零标签/零关单、状态机不动', async () => {
    await seedRow(7, 'format', 'awaiting_info');
    await deliver(7, 501, 'd-notice-1');

    const rows = await tasks();
    expect(rows.map((row) => row['command'])).toEqual(['pipeline:notice']);

    const report = await app.executeTask({ taskId: String(rows[0]?.['id']) });
    expect(report.outcome).toBe('succeeded');

    // ★ 恰好一条评论，且打在这个 issue 上
    const comments = commentCalls();
    expect(comments).toHaveLength(1);
    expect(comments[0]?.method).toBe('createIssueComment:7');
    // ★ 没有其它写动作（标签 / 关单 / 建 issue / 删标签）
    expect(nonCommentWrites()).toEqual([]);

    // 状态机不动（回执只产评论）
    const row = await db.sql(
      'select stage, state from issue_pipeline where repo = $1 and issue_number = 7',
      [REPO],
    );
    expect(row[0]).toMatchObject({ stage: 'format', state: 'awaiting_info' });

    // 控制面直发**不走 worker 的 actions 记账**：0 行反而能防「有人又把评论塞回写回通道」
    expect(await db.sql('select intent, target from actions')).toEqual([]);
    // webhook 的 eyes 回执照打
    expect(eyes).toHaveLength(1);
  }, 60_000);

  it('format/running：只打 eyes，零任务、零评论', async () => {
    await seedRow(8, 'format', 'running');
    await deliver(8, 502, 'd-notice-running');

    expect(await tasks()).toHaveLength(0);
    expect(eyes).toHaveLength(1);
    expect(github.calls).toEqual([]);
  }, 60_000);

  it('同一 issue 一小时内第二次 @：限速 → 仍然只发过那一条', async () => {
    await seedRow(9, 'classify', 'awaiting_info');
    await deliver(9, 601, 'd-notice-rate-1');
    const first = await tasks();
    expect(first.map((row) => row['command'])).toEqual(['pipeline:notice']);
    await app.executeTask({ taskId: String(first[0]?.['id']) });
    expect(commentCalls()).toHaveLength(1);

    // 第二条 @：`gate_notice_at` 已写 → 降级成 eyes，不建任务
    await deliver(9, 602, 'd-notice-rate-2');
    expect(await tasks()).toHaveLength(1);
    // 只有一条评论（第二条 @ 没有任务，也就没有第二次发送）
    expect(commentCalls()).toHaveLength(1);
    // 两次都打了 eyes（回执可以省，回应不能省）
    expect(eyes).toHaveLength(2);
  }, 60_000);

  it('模型没写评论时用控制面兜底句（仍然只有一条）', async () => {
    await seedRow(10, 'format', 'awaiting_info');
    // 换一份「没有 actions」的信封：valid 但 comment 缺失
    host.setScript({
      text: [
        '（这次模型什么都没写）',
        '```json',
        JSON.stringify({
          verdict: { kind: 'issue', labels: [], evidence: [{ rule: 'gate', quote: 'x', passed: true }] },
          actions: [],
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
        }),
        '```',
      ].join('\n'),
    });
    try {
      await deliver(10, 701, 'd-notice-fallback');
      const rows = await tasks();
      await app.executeTask({ taskId: String(rows[0]?.['id']) });
      expect(commentCalls()).toHaveLength(1);
    } finally {
      host.setScript({ text: NOTICE_ENVELOPE_TEXT });
    }
  }, 60_000);
});

/** 兜底句本身是纯函数，直接钉住三种门禁状态的文案（不经过模型）。 */
describe('notice 兜底句（控制面唯一允许的文案）', () => {
  it('按 gate_state 给不同提示，且有模型评论时优先用模型那句', async () => {
    const { noticeFallbackBody, noticeCommentBodyOf } = await import('../src/app/compose.ts');
    expect(noticeFallbackBody('format/awaiting_info')).toContain('补充信息');
    expect(noticeFallbackBody('classify/awaiting_info')).toContain('管理员');
    expect(noticeFallbackBody('blocked')).toContain('/recheck --force');
    expect(noticeFallbackBody('unknown')).not.toBe('');
    expect(
      noticeCommentBodyOf({
        envelope: { actions: [{ intent: 'comment', body: '模型写的回执' }] },
        gateState: 'format/awaiting_info',
      }),
    ).toBe('模型写的回执');
    expect(noticeCommentBodyOf({ envelope: null, gateState: 'blocked' })).toBe(
      noticeFallbackBody('blocked'),
    );
  });
});
