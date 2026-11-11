/**
 * 回归（P1-4）：`@` 单槽必须在**评论真的发出去之后**才落（§6 / D4）。
 *
 * 缺陷形状：`planClassifyOutcome()` 把 `mention_sent_at` / `mention_category` 与「阶段推进」
 * 合并到**同一个 transition** 里先落库，评论之后才 POST。评论失败（限流 / 权限 / 网络）时
 * 这一列已经写死 —— 单槽永不复位，那个 issue **再也不会 @ 任何人**。
 *
 * 修法：单槽单独成 `mentionSlot`，由 `executeClassifyPlan()` 在 `createIssueComment()` 成功之后
 * 才 `applyTransition()`；失败只 warn（下一次分类仍会补 `@`）。
 *
 * 三条断言：评论抛错 → `mention_sent_at` 仍 NULL；成功 → 写一次；第二次重分类不再追加 `@`。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_SETTINGS } from '../../../packages/contract/src/index.ts';
import type { RepoSettings } from '../../../packages/contract/src/index.ts';
import {
  executeClassifyPlan,
  planClassifyOutcome,
} from '../src/workflows/pipeline-classify.ts';
import type { ClassifyPlan, ClassifyWriteApi } from '../src/workflows/pipeline-classify.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const ISSUE = 42;
const AT = new Date('2026-06-01T12:00:00.000Z');
const MANAGER = 'alice';

/** 合法配置：`pipeline.managers` 非空（`@` 名单从它来）+ 词表带 role。 */
const SETTINGS: Pick<RepoSettings, 'labels' | 'limits' | 'pipeline'> = {
  labels: {
    ...DEFAULT_REPO_SETTINGS.labels,
    vocabulary: [{ name: '需求', role: 'requirement' }],
  },
  limits: DEFAULT_REPO_SETTINGS.limits,
  pipeline: { ...DEFAULT_REPO_SETTINGS.pipeline, managers: [MANAGER] },
};

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(AT);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table tasks, repos, issue_pipeline cascade');
});

function envelope(result: string, comment: string | null): unknown {
  return {
    stage: { name: 'classify', result },
    verdict: { kind: 'issue', labels: [], evidence: [] },
    actions: comment === null ? [] : [{ intent: 'comment', body: comment }],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

/** 假写面：`failComment` 为真时 `createIssueComment` 抛错（模拟限流 / 权限）。 */
function fakeApi(failComment = false): ClassifyWriteApi & {
  readonly comments: string[];
  readonly labels: string[][];
} {
  const comments: string[] = [];
  const labels: string[][] = [];
  return {
    comments,
    labels,
    async createIssueComment(input) {
      if (failComment) {
        throw new Error('403 Resource not accessible by integration');
      }
      comments.push(input.body);
      return { id: 1, htmlUrl: null };
    },
    async addLabels(input) {
      labels.push([...input.labels]);
    },
  };
}

async function seedClassifyPending(): Promise<void> {
  await ensurePipeline(
    db.pool,
    { repo: REPO, issueNumber: ISSUE },
    { stage: 'classify', state: 'pending', issueVersion: 'v1' },
  );
}

async function plan(): Promise<ClassifyPlan> {
  const pipeline = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
  return planClassifyOutcome({
    repo: REPO,
    issueNumber: ISSUE,
    pipeline,
    envelope: envelope('requirement', '需求理解：给保存加一个 pending 态。'),
    envelopeValid: true,
    runOutcome: 'succeeded',
    command: 'pipeline:classify',
    settings: SETTINGS,
    at: AT,
  });
}

describe('@ 单槽在评论成功后才落（P1-4）', () => {
  it('评论发送失败：mention_sent_at 仍为 NULL（不把单槽写死）', async () => {
    await seedClassifyPending();
    const planned = await plan();
    expect(planned.mention?.applied).toBe(true);
    // 单槽不在主转移里（主转移只推阶段）
    expect(planned.transition?.mentionSentAt).toBeUndefined();
    expect(planned.mentionSlot).toMatchObject({ mentionSentAt: AT, mentionCategory: 'requirement' });

    const api = fakeApi(true);
    const executed = await executeClassifyPlan({
      plan: planned,
      db: db.pool,
      key: { repo: REPO, issueNumber: ISSUE },
      api,
    });

    // 评论失败 → 这一列必须是 NULL（否则这个 issue 以后再也不会 @ 人）
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
    expect(row?.mentionSentAt).toBeNull();
    expect(row?.mentionCategory).toBeNull();
    expect(executed.errors.join('|')).toContain('comment:');
    expect(api.comments).toEqual([]);
    // 阶段推进照常（失败只影响单槽）
    expect(row).toMatchObject({ stage: 'agent', state: 'ready' });
  });

  it('评论发送成功：单槽写一次（mention_sent_at + mention_category）', async () => {
    await seedClassifyPending();
    const planned = await plan();
    const api = fakeApi(false);
    const executed = await executeClassifyPlan({
      plan: planned,
      db: db.pool,
      key: { repo: REPO, issueNumber: ISSUE },
      api,
    });

    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).toContain(`@${MANAGER}`);
    expect(executed.applied).toContain('mention');

    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
    expect(row?.mentionSentAt?.toISOString()).toBe(AT.toISOString());
    expect(row?.mentionCategory).toBe('requirement');
  });

  it('第二次重分类：单槽已占用 → 不再追加 @，也不改这一列', async () => {
    await seedClassifyPending();
    const first = await plan();
    await executeClassifyPlan({
      plan: first,
      db: db.pool,
      key: { repo: REPO, issueNumber: ISSUE },
      api: fakeApi(false),
    });

    // 打回 classify/pending 再跑一轮（`/pipeline prev` 的效果）
    await db.sql(
      'update issue_pipeline set stage = $3, state = $4 where repo = $1 and issue_number = $2',
      [REPO, ISSUE, 'classify', 'pending'],
    );
    const second = await plan();
    expect(second.mention?.applied).toBe(false);
    expect(second.mentionSlot).toBeNull();

    const api = fakeApi(false);
    await executeClassifyPlan({
      plan: second,
      db: db.pool,
      key: { repo: REPO, issueNumber: ISSUE },
      api,
    });
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).not.toContain(`@${MANAGER}`);

    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
    expect(row?.mentionSentAt?.toISOString()).toBe(AT.toISOString());
  });
});
