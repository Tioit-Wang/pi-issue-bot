/**
 * 阶段 0 的执行面：`executeFormatPlan()` 把计划变成真副作用（§5 / V2 / V3 / V19）。
 *
 * 真库（`issue_pipeline` 的列真被写了）+ 假 GitHub（评论 / 标签 / 关闭的调用次数与参数）。
 * 三条重点：
 *  1. **顺序**：先落状态、再发评论 —— 重投同版本时靠状态机挡住第二条评论；
 *  2. **第 N 次不通过恰好关一次**：连跑两轮，`closeIssue` 仍然只有一次（第二轮进 `noop`）；
 *  3. **dry-run 零副作用**：GitHub 一个请求都不发，但状态照样推进（`actions` 也不留痕）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPipelineLimits } from '../src/config/pipeline-constants.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import { executeFormatPlan, planFormatOutcome } from '../src/workflows/pipeline-format.ts';
import type { FormatPlanInput, FormatReactionApi, FormatWriteApi } from '../src/workflows/pipeline-format.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'test/format-exec';
const ISSUE = 41;
const AT = new Date('2026-06-01T12:00:00.000Z');

type Call = { readonly kind: string; readonly detail: string };

/** 假 GitHub 写面：只记录调用，不发请求。 */
function createFakeApi(options: { readonly failClose?: boolean } = {}): FormatWriteApi & {
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    createIssueComment: async (input) => {
      calls.push({ kind: 'comment', detail: input.body });
      return { id: 1 };
    },
    addLabels: async (input) => {
      calls.push({ kind: 'label', detail: input.labels.join(',') });
    },
    closeIssue: async (input) => {
      calls.push({ kind: 'closeIssue', detail: input.reason ?? 'completed' });
      if (options.failClose === true) {
        throw new Error('403 Resource not accessible by integration');
      }
    },
  };
}

function createFakeReactions(): FormatReactionApi & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    addReaction: async (input) => {
      calls.push(input.content);
      return { id: 1 };
    },
  };
}

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // `issue_pipeline` 不在公共 truncate 清单里（它是 0005 才有的表）：按自己的 repo 清理
  await db.sql('delete from issue_pipeline where repo = $1', [REPO]);
});

const row = async () => loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });

function envelope(result: 'pass' | 'fail', comment: string | null): unknown {
  return {
    stage: { name: 'format', result },
    verdict: { kind: 'issue', labels: [], evidence: [] },
    actions: comment === null ? [] : [{ intent: 'comment', body: comment }],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

async function run(
  over: Partial<FormatPlanInput>,
  api: FormatWriteApi,
  reactions?: FormatReactionApi,
  dryRun = false,
): Promise<Awaited<ReturnType<typeof executeFormatPlan>>> {
  const current = await row();
  const plan = planFormatOutcome({
    repo: REPO,
    issueNumber: ISSUE,
    pipeline: current,
    envelope: envelope('fail', '缺信息'),
    envelopeValid: true,
    runOutcome: 'succeeded',
    command: 'pipeline:format',
    limits: createPipelineLimits(),
    at: AT,
    ...over,
  });
  return executeFormatPlan({
    plan,
    db: db.pool,
    key: { repo: REPO, issueNumber: ISSUE },
    api,
    ...(reactions === undefined ? {} : { reactions }),
    dryRun,
  });
}

describe('pass 首次（V2）', () => {
  it('零评论、只有 rocket、状态推进到 classify/pending', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    const api = createFakeApi();
    const reactions = createFakeReactions();

    await run({ envelope: envelope('pass', null) }, api, reactions);

    expect(api.calls).toEqual([]);
    expect(reactions.calls).toEqual(['rocket']);
    const after = await row();
    expect(after).toMatchObject({ stage: 'classify', state: 'pending', formatAttempts: 1 });
    expect(after?.infoRequestedAt).toBeNull();
  });
});

describe('fail（V3）', () => {
  it('一条评论 + needs-info 标签 + confused；info_requested_at 落库', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    const api = createFakeApi();
    const reactions = createFakeReactions();

    await run({ envelope: envelope('fail', '请补复现步骤。') }, api, reactions);

    expect(api.calls.map((call) => call.kind)).toEqual(['comment', 'label']);
    expect(api.calls[1]?.detail).toBe('needs-info');
    expect(reactions.calls).toEqual(['confused']);
    const after = await row();
    expect(after).toMatchObject({
      stage: 'format',
      state: 'awaiting_info',
      formatAttempts: 1,
      formatFailCount: 1,
    });
    expect(after?.infoRequestedAt).toEqual(AT);
  });

  it('同版本重投：第二轮进 noop，不再发第二条评论', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    const api = createFakeApi();

    await run({ envelope: envelope('fail', '第一次') }, api);
    await run({ envelope: envelope('fail', '重投') }, api);

    expect(api.calls.filter((call) => call.kind === 'comment')).toHaveLength(1);
    const after = await row();
    expect(after?.formatFailCount).toBe(1);
  });
});

describe('累计不通过 → 关 issue（V19）', () => {
  it('第 5 次不通过：closeIssue 恰好 1 次、状态 closed、closed_at 落库', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    await db.sql(
      'update issue_pipeline set stage = $3, state = $4, format_fail_count = 4, format_attempts = 4 where repo = $1 and issue_number = $2',
      [REPO, ISSUE, 'format', 'pending'],
    );
    const api = createFakeApi();
    const reactions = createFakeReactions();

    const result = await run({ envelope: envelope('fail', '最后一次反馈') }, api, reactions);

    expect(result.applied).toContain('closeIssue');
    expect(api.calls.map((call) => call.kind)).toEqual(['comment', 'closeIssue']);
    // 关掉的 issue 上不再打 needs-info / confused
    expect(reactions.calls).toEqual([]);
    const after = await row();
    expect(after).toMatchObject({ stage: 'closed', state: 'closed', formatFailCount: 5 });
    expect(after?.closedAt).toEqual(AT);

    // 第二轮（重投）什么都不做：closeIssue 仍只有 1 次
    await run({ envelope: envelope('fail', '重投') }, api, reactions);
    expect(api.calls.filter((call) => call.kind === 'closeIssue')).toHaveLength(1);
  });

  it('注入 formatMaxFails=2：第 2 次不通过就关', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    await db.sql(
      'update issue_pipeline set format_fail_count = 1, format_attempts = 1 where repo = $1 and issue_number = $2',
      [REPO, ISSUE],
    );
    const api = createFakeApi();

    await run(
      { envelope: envelope('fail', '还是缺'), limits: createPipelineLimits({ formatMaxFails: 2 }) },
      api,
    );

    expect(api.calls.filter((call) => call.kind === 'closeIssue')).toHaveLength(1);
    expect((await row())?.state).toBe('closed');
  });

  it('关闭失败不抛：状态已 closed，issue 仍开着（下一轮不会重复触发）', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    await db.sql(
      'update issue_pipeline set format_fail_count = 4 where repo = $1 and issue_number = $2',
      [REPO, ISSUE],
    );
    const api = createFakeApi({ failClose: true });

    const result = await run({ envelope: envelope('fail', '最后一次') }, api);

    expect(result.errors.join('|')).toContain('closeIssue');
    expect((await row())?.state).toBe('closed');
  });
});

describe('dry-run 与无写面', () => {
  it('dry-run：GitHub 一个请求都不发，状态也不写（零副作用口径）', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    const api = createFakeApi();
    const reactions = createFakeReactions();

    const result = await run({ envelope: envelope('fail', '缺信息') }, api, reactions, true);

    expect(api.calls).toEqual([]);
    expect(reactions.calls).toEqual([]);
    expect(result.applied).toContain('comment:dry-run');
    // dry-run 连状态行都不动：否则下一轮会以为自己已经问过用户
    expect((await row())?.state).toBe('pending');
  });

  it('没注入 reaction 写面：不打 reaction，也不报错', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: ISSUE }, { issueVersion: 'v1' });
    const api = createFakeApi();

    const result = await run({ envelope: envelope('fail', '缺信息') }, api);

    expect(result.errors).toEqual([]);
    expect(api.calls.map((call) => call.kind)).toEqual(['comment', 'label']);
  });
});
