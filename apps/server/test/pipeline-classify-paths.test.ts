/**
 * 阶段 1（分类）的四分支：`planClassifyOutcome()` 的规划 + `executeClassifyPlan()` 的真落库
 * （`docs/plan-fixed-pipeline.md` §6 / §12 V5·V6·V7 / §1.8 Q6 修订）。
 *
 * 真库（`issue_pipeline` 的列真被写了）+ 假 GitHub（评论 / 标签的调用次数与正文）。
 * 断言的**不是「跑通了」**，而是每一分支的动作集合：
 *
 * | 结论 | 标签 | 评论 | `@` | 状态行 |
 * |---|---|---|---|---|
 * | requirement | role=requirement | 1 条 | 追加一次 | `agent/ready` + `ready_at` + `category` |
 * | defect | role=defect | 1 条 | 追加一次 | 同上 |
 * | not-found | **无** | 1 条（含已查范围） | 追加一次 | `classify/awaiting_info` + `info_requested_at=NULL` |
 * | other | role=other | **0 条** | **无** | `agent/ready` |
 *
 * 另外三条容易写错的地方各有一组用例：
 *  1. **`defect` 没有 `path:line` → 降级 `not-found`**（不打缺陷标签、停在等管理员）；
 *  2. **`@` 单槽**：`mention_sent_at` 非空后再分类也不补 `@`（整个 issue 只 @ 一次）；
 *  3. **非法信封 → `blocked` 且零写入**（不评论、不打标、不 @）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { decideSupplementOutcome } from '../src/http/webhook.ts';
import type { PipelineSupplementDecision } from '../src/http/webhook.ts';
import {
  executeClassifyPlan,
  planClassifyOutcome,
} from '../src/workflows/pipeline-classify.ts';
import type {
  ClassifyPlan,
  ClassifyPlanInput,
  ClassifyWriteApi,
} from '../src/workflows/pipeline-classify.ts';
import { decideTransition, ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import type { PipelineRow } from '../src/workflows/pipeline.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import {
  TEST_MANAGER,
  parseValidSettings,
  vocabularyWithRoles,
} from './helpers/repo-settings.ts';

const REPO = 'test/classify-paths';
const ISSUE = 61;
const AT = new Date('2026-06-01T12:00:00.000Z');

/** 一份合法配置：三个 role 各一个标签，管理员 = `alice`（§4.5 / Q4 的硬要求）。 */
const SETTINGS = parseValidSettings({
  labels: {
    vocabulary: vocabularyWithRoles([{ name: '需求' }, { name: '缺陷' }, { name: '咨询' }]),
  },
});

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('delete from issue_pipeline where repo = $1', [REPO]);
});

const row = async (): Promise<PipelineRow | null> =>
  loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });

/** 假 GitHub 写面：只记录调用，不发请求。 */
function createFakeApi(): ClassifyWriteApi & {
  readonly comments: string[];
  readonly labels: string[][];
} {
  const comments: string[] = [];
  const labels: string[][] = [];
  return {
    comments,
    labels,
    createIssueComment: async (input) => {
      comments.push(input.body);
      return { id: comments.length };
    },
    addLabels: async (input) => {
      labels.push([...input.labels]);
    },
  };
}

/** 分类阶段的信封（`stage` 是唯一扩展，§4.1）。 */
function envelope(
  result: 'requirement' | 'defect' | 'not-found' | 'other' | 'pass',
  comment: string | null,
  evidence: readonly { readonly rule: string; readonly quote: string }[] = [],
  stageName: 'classify' | 'format' = 'classify',
): unknown {
  return {
    stage: { name: stageName, result },
    verdict: { kind: 'issue', labels: [], evidence },
    actions: comment === null ? [] : [{ intent: 'comment', body: comment }],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

/** 种一行 `classify/pending` 并返回它。 */
async function seedClassifyPending(over: { mentionSentAt?: Date | null } = {}): Promise<PipelineRow> {
  const created = await ensurePipeline(
    db.pool,
    { repo: REPO, issueNumber: ISSUE },
    { stage: 'classify', state: 'pending', issueVersion: 'v1' },
  );
  if (over.mentionSentAt !== undefined) {
    await db.sql(
      'update issue_pipeline set mention_sent_at = $3 where repo = $1 and issue_number = $2',
      [REPO, ISSUE, over.mentionSentAt],
    );
  }
  return created;
}

async function plan(over: Partial<ClassifyPlanInput> = {}): Promise<ClassifyPlan> {
  const current = await row();
  return planClassifyOutcome({
    repo: REPO,
    issueNumber: ISSUE,
    pipeline: current,
    envelope: envelope('requirement', '需求理解：给「保存」加一个显式 pending 态。'),
    envelopeValid: true,
    runOutcome: 'succeeded',
    command: 'pipeline:classify',
    settings: SETTINGS,
    at: AT,
    ...over,
  });
}

async function run(over: Partial<ClassifyPlanInput> = {}, dryRun = false) {
  const planned = await plan(over);
  const api = createFakeApi();
  const executed = await executeClassifyPlan({
    plan: planned,
    db: db.pool,
    key: { repo: REPO, issueNumber: ISSUE },
    api,
    dryRun,
  });
  return { planned, api, executed };
}

describe('requirement（V5）', () => {
  it('打 role=requirement 标签 + 1 条评论（含 /cc @managers）+ 状态推进到 agent/ready', async () => {
    await seedClassifyPending();

    const { api, planned } = await run();

    expect(planned.outcome).toBe('requirement');
    expect(api.labels).toEqual([['需求']]);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).toContain('需求理解');
    expect(api.comments[0]).toContain(`/cc @${TEST_MANAGER}`);

    const after = await row();
    expect(after).toMatchObject({
      stage: 'agent',
      state: 'ready',
      category: 'requirement',
      classifyAttempts: 1,
      mentionCategory: 'requirement',
    });
    expect(after?.readyAt).toEqual(AT);
    expect(after?.mentionSentAt).toEqual(AT);
    expect(after?.infoRequestedAt).toBeNull();
  });
});

describe('defect（V6 前半）', () => {
  it('有 path:line 证据：打 role=defect 标签 + 评论 + @ + 直接 ready', async () => {
    await seedClassifyPending();

    const { api, planned } = await run({
      envelope: envelope(
        'defect',
        '缺陷报告：`src/save.ts:42` 少了空值判断。',
        [{ rule: 'code:src/save.ts', quote: 'src/save.ts:42 这里少判了空值' }],
      ),
    });

    expect(planned.outcome).toBe('defect');
    expect(api.labels).toEqual([['缺陷']]);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).toContain(`/cc @${TEST_MANAGER}`);

    const after = await row();
    expect(after).toMatchObject({ stage: 'agent', state: 'ready', category: 'defect' });
    expect(after?.readyAt).toEqual(AT);
  });

  it('没有 path:line → 降级 not-found：不打缺陷标签、停在 classify/awaiting_info、仍然 @managers', async () => {
    await seedClassifyPending();

    const warns: string[] = [];
    const { api, planned } = await run({
      envelope: envelope('defect', '这条看着像缺陷，但我定位不到具体行。', [
        { rule: 'checked:src/', quote: 'src/ 下扫了一遍，没有找到保存路径' },
      ]),
      logger: {
        warn: (_fields: Record<string, unknown> | string, message?: string) => {
          warns.push(String(message));
        },
      },
    });

    expect(planned.outcome).toBe('not-found');
    expect(planned.notes.join('|')).toContain('downgraded');
    // 降级必须留痕（warn 一次）
    expect(warns.join('|')).toContain('not-found');
    // D3：虚拟缺陷不打缺陷标签
    expect(api.labels).toEqual([]);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).toContain(`/cc @${TEST_MANAGER}`);

    const after = await row();
    expect(after).toMatchObject({
      stage: 'classify',
      state: 'awaiting_info',
      category: 'not-found',
    });
    // 等**管理员**：这一列必须 NULL，否则 48h 作业会把躺着等管理员的 issue 关掉
    expect(after?.infoRequestedAt).toBeNull();
    expect(after?.mentionSentAt).toEqual(AT);
  });
});

describe('not-found（V6 后半 / Q6 修订）', () => {
  it('无标签 + 1 条评论（查不到 + 已查范围 + 需要什么）+ @；停在等管理员', async () => {
    await seedClassifyPending();

    const { api, planned } = await run({
      envelope: envelope(
        'not-found',
        '当前查不到足够的证据来判定类型。还需要：完整复现步骤、相关文件与行号、期望结果。',
        [
          { rule: 'checked:src/save.ts', quote: 'src/save.ts 全文（没有保存失败的报错分支）' },
        ],
      ),
    });

    expect(planned.outcome).toBe('not-found');
    expect(api.labels).toEqual([]);
    expect(api.comments).toHaveLength(1);
    const comment = api.comments[0] ?? '';
    expect(comment).toContain('查不到');
    expect(comment).toContain('还需要');
    // 「已查范围」控制面补一段（模型没写时）——「查不到」不能是一句无法验证的话
    expect(comment).toContain('已查范围：');
    expect(comment).toContain('src/save.ts 全文');
    expect(comment).toContain(`/cc @${TEST_MANAGER}`);

    const after = await row();
    expect(after).toMatchObject({ stage: 'classify', state: 'awaiting_info', category: 'not-found' });
  });

  it('模型自己写了「已查范围」：控制面不再补第二段', async () => {
    await seedClassifyPending();

    const { api } = await run({
      envelope: envelope('not-found', '当前查不到。已查范围：src/save.ts、src/state.ts。还需要：报错日志。', [
        { rule: 'checked:src/save.ts', quote: 'src/save.ts 全文' },
      ]),
    });

    const occurrences = (api.comments[0] ?? '').split('已查范围：').length - 1;
    expect(occurrences).toBe(1);
  });

  it('模型没写评论：用兜底句 + warn（状态照常推进）', async () => {
    await seedClassifyPending();

    const warns: string[] = [];
    const { api } = await run({
      envelope: envelope('not-found', null),
      logger: {
        warn: (_fields: Record<string, unknown> | string, message?: string) => {
          warns.push(String(message));
        },
      },
    });

    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).toContain('无法完成分类');
    expect(warns.join('|')).toContain('兜底句');
    expect((await row())?.state).toBe('awaiting_info');
  });
});

describe('other（V7）', () => {
  it('只打 role=other 标签：0 条评论、0 个 @、直接 ready', async () => {
    await seedClassifyPending();

    const { api, planned } = await run({ envelope: envelope('other', '这是一条咨询。') });

    expect(planned.outcome).toBe('other');
    expect(api.labels).toEqual([['咨询']]);
    expect(api.comments).toEqual([]);
    expect(planned.mention?.applied).toBe(false);

    const after = await row();
    expect(after).toMatchObject({ stage: 'agent', state: 'ready', category: 'other' });
    // `@` 单槽没被占用：other 不发 @，也就不该写 `mention_sent_at`
    expect(after?.mentionSentAt).toBeNull();
  });
});

describe('@ 单槽（D4：整个 issue 只 @ 一次）', () => {
  it('已有 mention_sent_at：重分类不再追加 @，也不改这一列', async () => {
    const earlier = new Date('2026-05-01T00:00:00.000Z');
    await seedClassifyPending({ mentionSentAt: earlier });

    const { api, planned } = await run({
      envelope: envelope('requirement', '需求理解：……'),
    });

    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).not.toContain('@alice');
    expect(planned.mention?.applied).toBe(false);

    const after = await row();
    expect(after?.mentionSentAt).toEqual(earlier);
    expect(after?.mentionCategory).toBeNull();
  });
});

describe('非法信封 / 运行失败：blocked 且零写入（§2 末段）', () => {
  it('stage 名不匹配（format 信封冒充 classify）：blocked，一个字都不写', async () => {
    await seedClassifyPending();

    const { api } = await run({
      envelope: envelope('pass', '不该出现', [], 'format'),
      consecutiveFailures: 2,
    });

    expect(api.comments).toEqual([]);
    expect(api.labels).toEqual([]);
    const after = await row();
    expect(after?.state).toBe('blocked');
    expect(after?.blockedReason ?? '').toContain('stage');
    // 零写入：没有 category、没有 mention、没有任何分类进度
    expect(after?.category).toBeNull();
    expect(after?.mentionSentAt).toBeNull();
  });

  it('result 不在允许集合（classify 用 pass）：同样 blocked', async () => {
    await seedClassifyPending();

    const { api, planned } = await run({
      envelope: envelope('pass', '通过？', []),
      consecutiveFailures: 2,
    });

    expect(planned.outcome).toBe('blocked');
    expect(api.comments).toEqual([]);
    expect((await row())?.state).toBe('blocked');
  });

  it('第一次失败（连续 1 次）：不动用户可见的东西，也不 blocked', async () => {
    await seedClassifyPending();

    const { api, planned } = await run({ runOutcome: 'failed', consecutiveFailures: 1 });

    expect(planned.outcome).toBe('noop');
    expect(api.comments).toEqual([]);
    expect((await row())?.state).toBe('pending');
  });
});

describe('重投与限速', () => {
  it('同版本重投：状态已不在 classify/pending → noop，第二条评论不出现', async () => {
    await seedClassifyPending();

    await run({ envelope: envelope('requirement', '需求理解：……') });
    const second = await run({ envelope: envelope('requirement', '重投') });

    expect(second.planned.outcome).toBe('noop');
    expect(second.api.comments).toEqual([]);
    expect(second.api.labels).toEqual([]);
  });

  it('频率上限：超过 limits.max_comments_per_hour → 丢评论，但状态照常推进', async () => {
    await seedClassifyPending();

    const { api, planned } = await run({
      envelope: envelope('requirement', '需求理解：……'),
      commentsLastHour: 10,
    });

    expect(api.comments).toEqual([]);
    expect(planned.notes.join('|')).toContain('comment-rate-limited');
    const after = await row();
    expect(after).toMatchObject({ stage: 'agent', state: 'ready', category: 'requirement' });
  });

  it('dry-run：GitHub 一个请求都不发，状态也不写', async () => {
    await seedClassifyPending();

    const { api, executed } = await run({ envelope: envelope('requirement', '……') }, true);

    expect(api.comments).toEqual([]);
    expect(api.labels).toEqual([]);
    expect(executed.applied).toContain('comment:dry-run');
    expect((await row())?.state).toBe('pending');
  });
});

/* ── S1 的转移表 + 补充通道：分类停住之后怎么继续（Q6 修订 / Q7）───────────────── */

function supplementDecision(over: Partial<PipelineSupplementDecision> = {}): PipelineSupplementDecision {
  return {
    action: 'pipeline-supplement',
    targetNumber: ISSUE,
    isPullRequest: false,
    actorLogin: TEST_MANAGER,
    association: 'MEMBER',
    commentId: 9001,
    body: '这是管理员补充的定位线索：src/save.ts:42。',
    issueVersion: 'v2',
    title: null,
    issueBody: null,
    issueAuthor: 'bob',
    ...over,
  };
}

describe('停在 classify/awaiting_info 之后（S1 的 manager-comment，Q6 修订）', () => {
  /** 走到「not-found 等管理员」这一步（真库）。 */
  async function reachAwaitingManager(): Promise<PipelineRow> {
    await seedClassifyPending();
    await run({ envelope: envelope('not-found', '当前查不到。还需要：相关文件与行号。') });
    const after = await row();
    expect(after?.stage).toBe('classify');
    expect(after?.state).toBe('awaiting_info');
    return after as PipelineRow;
  }

  it('managers 的评论 → 重跑分类（manager-comment → classify/pending + 入队 pipeline:classify）', async () => {
    const current = await reachAwaitingManager();
    const outcome = decideSupplementOutcome(
      current,
      supplementDecision(),
      { pipeline: { managers: [TEST_MANAGER] } } as never,
    );
    expect(outcome).toEqual({ kind: 'rerun', channel: 'classify', actor: 'manager' });

    const transition = decideTransition(current, {
      kind: 'manager-comment',
      fromManager: true,
      at: AT,
      issueVersion: 'v2',
    });
    expect(transition.ignore).toBeUndefined();
    expect(transition).toMatchObject({ stage: 'classify', state: 'pending' });
    expect(transition.effects?.enqueue).toBe('pipeline:classify');
  });

  it('作者（非 managers）的评论 → 只记录，不重跑', async () => {
    const current = await reachAwaitingManager();
    const outcome = decideSupplementOutcome(
      current,
      supplementDecision({ actorLogin: 'bob', association: 'NONE' }),
      { pipeline: { managers: [TEST_MANAGER] } } as never,
    );
    expect(outcome).toEqual({ kind: 'ignore', reason: 'classify-awaiting-manager' });

    const transition = decideTransition(current, {
      kind: 'manager-comment',
      fromManager: false,
      at: AT,
    });
    expect(transition.ignore).toBe('manager-comment-not-from-manager');
  });

  it('/pipeline next（managers）→ 直接 agent/ready（V20 的分类段）', async () => {
    const current = await reachAwaitingManager();

    const transition = decideTransition(current, {
      kind: 'manual-next',
      fromManager: true,
      at: AT,
    });

    expect(transition).toMatchObject({ stage: 'agent', state: 'ready' });
    expect(transition.readyAt).toEqual(AT);
    expect(transition.effects?.enqueue ?? null).toBeNull();
  });
});
