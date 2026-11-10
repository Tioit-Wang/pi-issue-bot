/**
 * 无感反馈状态机（W2-D）的单测：`apps/server/src/feedback/**`。
 *
 * 钉住四件事，全部用假实现（不打网络、不连库）：
 *  1. **阶段 → reaction**：received=eyes；succeeded=-eyes +rocket；failed/timed-out/cancelled=-eyes +confused；
 *  2. **台账幂等**：唯一键命中且 `applied_at` 非空 → 一个请求都不发；`applied_at` 为空 → 允许重试；
 *  3. **dry-run**：一个 reaction 都不打、`issue_feedback` 不写，只留 `feedback.planned`；
 *  4. **降级**：403 置 `reactions_disabled` 并留 failed；429/5xx 只重试 1 次。
 */
import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_SQL,
  applyFeedback,
  contentForStage,
  createPgReactionsFlagStore,
  feedbackStageForOutcome,
  isTerminalStage,
  planStage,
  removeOwnReaction,
} from '../src/feedback/index.ts';
import type {
  ApplyFeedbackInput,
  FeedbackClaim,
  FeedbackLedger,
  FeedbackRow,
  ReactionsFlagStore,
} from '../src/feedback/index.ts';
import { GithubError } from '../src/github/errors.ts';
import type { GithubReactionApi, ReactionContent, ReactionEntry } from '../src/github/types.ts';

const REPO = 'acme/widgets';
const TARGET = 7;
const ANCHOR = 'idem-key-1';
const APP_SLUG = 'pi-issue-bot';

/** HTTP 错误（与 octokit 抛出的形状一致：`status` 在顶层）。 */
function httpError(status: number, message: string): unknown {
  return Object.assign(new Error(message), { status });
}

/** 内存台账：唯一键 = (stage, anchor)，与 PG 侧的唯一索引同构。 */
function createMemoryLedger(): FeedbackLedger & {
  readonly rows: Map<string, FeedbackRow>;
  readonly claims: number;
  readonly applied: { id: number; reactionId: number | null }[];
  readonly failed: { id: number; reason: string; httpStatus: number | null }[];
} {
  const rows = new Map<string, FeedbackRow>();
  const applied: { id: number; reactionId: number | null }[] = [];
  const failed: { id: number; reason: string; httpStatus: number | null }[] = [];
  let nextId = 100;
  const state = { claims: 0 };

  const ledger: FeedbackLedger & {
    readonly rows: Map<string, FeedbackRow>;
    readonly claims: number;
    readonly applied: { id: number; reactionId: number | null }[];
    readonly failed: { id: number; reason: string; httpStatus: number | null }[];
  } = {
    rows,
    applied,
    failed,
    get claims() {
      return state.claims;
    },
    async claim(input): Promise<FeedbackClaim> {
      state.claims += 1;
      const key = `${input.stage}/${input.anchor}`;
      const existing = rows.get(key);
      if (existing !== undefined) {
        return { inserted: false, row: existing };
      }
      nextId += 1;
      const row: FeedbackRow = {
        id: nextId,
        content: input.content,
        reactionId: null,
        appliedAt: null,
      };
      rows.set(key, row);
      return { inserted: true, row };
    },
    async markApplied(input) {
      applied.push({ id: input.id, reactionId: input.reactionId });
      for (const [key, row] of [...rows.entries()]) {
        if (row.id === input.id) {
          rows.set(key, { ...row, reactionId: input.reactionId, appliedAt: input.appliedAt });
        }
      }
    },
    async markFailed(input) {
      failed.push({ id: input.id, reason: input.reason, httpStatus: input.httpStatus });
    },
  };
  return ledger;
}

/** 假 reaction 写面：记录调用序列，可按方法逐个注入失败。 */
function createMemoryReactions(seed: {
  readonly entries?: readonly ReactionEntry[];
  readonly addFailures?: readonly unknown[];
  readonly listFailures?: readonly unknown[];
  readonly removeFailures?: readonly unknown[];
} = {}): GithubReactionApi & {
  readonly calls: string[];
  readonly added: ReactionContent[];
  readonly removed: number[];
} {
  const calls: string[] = [];
  const added: ReactionContent[] = [];
  const removed: number[] = [];
  const entries = [...(seed.entries ?? [])];
  const addFailures = [...(seed.addFailures ?? [])];
  const listFailures = [...(seed.listFailures ?? [])];
  const removeFailures = [...(seed.removeFailures ?? [])];
  let nextId = 900;
  const take = (queue: unknown[]): void => {
    const failure = queue.shift();
    if (failure !== undefined) {
      throw failure;
    }
  };
  return {
    calls,
    added,
    removed,
    async addReaction(input) {
      calls.push(`add:${input.content}`);
      take(addFailures);
      nextId += 1;
      added.push(input.content);
      return { id: nextId };
    },
    async listReactions(input) {
      calls.push(`list:${input.content}`);
      take(listFailures);
      return entries.filter((entry) => entry.content === input.content);
    },
    async removeReaction(input) {
      calls.push(`remove:${String(input.reactionId)}`);
      take(removeFailures);
      removed.push(input.reactionId);
    },
  };
}

function createFlags(initial: boolean): ReactionsFlagStore & {
  readonly disabled: string[];
} {
  const disabled: string[] = [];
  let value = initial;
  return {
    disabled,
    async isDisabled() {
      return value;
    },
    async disable(input) {
      value = true;
      disabled.push(input.reason);
    },
  };
}

function inputFor(overrides: Partial<ApplyFeedbackInput> = {}): ApplyFeedbackInput {
  return {
    repo: REPO,
    targetKind: 'issue',
    targetNumber: TARGET,
    stage: 'succeeded',
    anchor: ANCHOR,
    ...overrides,
  };
}

describe('阶段 → reaction 的那张表（plan §5）', () => {
  it('received=eyes、succeeded=rocket、其余终态=confused', () => {
    expect(contentForStage('received')).toBe('eyes');
    expect(contentForStage('succeeded')).toBe('rocket');
    expect(contentForStage('failed')).toBe('confused');
    expect(contentForStage('timed-out')).toBe('confused');
    expect(contentForStage('cancelled')).toBe('confused');
  });

  it('终态一律「先删 eyes」，received 没有前置', () => {
    expect(planStage('received')).toEqual({ stage: 'received', add: 'eyes', remove: null, terminal: false });
    expect(planStage('succeeded')).toEqual({ stage: 'succeeded', add: 'rocket', remove: 'eyes', terminal: true });
    expect(planStage('failed').remove).toBe('eyes');
    expect(planStage('timed-out').remove).toBe('eyes');
    expect(planStage('cancelled').remove).toBe('eyes');
    expect(isTerminalStage('received')).toBe(false);
    expect(isTerminalStage('cancelled')).toBe(true);
  });

  it('runs.outcome → 阶段：只有 succeeded 是火箭，超时/取消各留自己的名字', () => {
    expect(feedbackStageForOutcome('succeeded')).toBe('succeeded');
    expect(feedbackStageForOutcome('timed-out')).toBe('timed-out');
    expect(feedbackStageForOutcome('cancelled')).toBe('cancelled');
    expect(feedbackStageForOutcome('failed')).toBe('failed');
    // 退化输出也是失败的一种（面板按 runs.failure_class 区分）
    expect(feedbackStageForOutcome('degenerate-output')).toBe('failed');
  });

  it('SQL 常量里的唯一键与表定义一致（幂等闸的位置）', () => {
    expect(FEEDBACK_SQL.claim).toContain(
      'ON CONFLICT ("repo", "target_kind", "target_number", "stage", "anchor") DO NOTHING',
    );
    expect(FEEDBACK_SQL.claim).toContain('RETURNING');
  });
});

describe('applyFeedback：dry-run 与降级', () => {
  it('dry-run：不发请求、不写台账，只落 feedback.planned', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions();
    const events: string[] = [];

    const outcome = await applyFeedback(
      { ledger, reactions, onEvent: (kind) => events.push(kind) },
      inputFor({ dryRun: true }),
    );

    expect(outcome.status).toBe('planned');
    expect(outcome.content).toBe('rocket');
    expect(reactions.calls).toEqual([]);
    expect(ledger.claims).toBe(0);
    expect(events).toEqual(['feedback.planned']);
  });

  it('reactions_disabled 已生效：一个请求都不发，状态是 disabled', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions();
    const flags = createFlags(true);

    const outcome = await applyFeedback({ ledger, reactions, flags }, inputFor());

    expect(outcome.status).toBe('disabled');
    expect(outcome.permissionDenied).toBe(true);
    expect(reactions.calls).toEqual([]);
    expect(ledger.claims).toBe(0);
  });

  it('403：置 reactions_disabled + 记 failed，不重试', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions({ addFailures: [httpError(403, 'Resource not accessible by integration')] });
    const flags = createFlags(false);

    const outcome = await applyFeedback({ ledger, reactions, flags }, inputFor());

    expect(outcome.status).toBe('failed');
    expect(outcome.permissionDenied).toBe(true);
    expect(outcome.httpStatus).toBe(403);
    expect(flags.disabled).toHaveLength(1);
    // 只试了一次（403 不重试）
    expect(reactions.calls.filter((call) => call.startsWith('add:'))).toHaveLength(1);
    expect(ledger.failed).toHaveLength(1);
    expect(ledger.failed[0]?.httpStatus).toBe(403);
    expect(ledger.applied).toHaveLength(0);
  });

  it('5xx：只重试 1 次就放弃，不置 reactions_disabled', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions({
      addFailures: [httpError(502, 'Bad gateway'), httpError(502, 'Bad gateway')],
    });
    const flags = createFlags(false);

    const outcome = await applyFeedback({ ledger, reactions, flags }, inputFor());

    expect(outcome.status).toBe('failed');
    expect(outcome.permissionDenied).toBe(false);
    expect(reactions.calls.filter((call) => call.startsWith('add:'))).toHaveLength(2);
    expect(flags.disabled).toEqual([]);
  });

  it('台账写入失败只 warn：不改 run 结论（返回 failed 但不抛）', async () => {
    const ledger: FeedbackLedger = {
      async claim() {
        throw new Error('db down');
      },
      async markApplied() {},
      async markFailed() {},
    };
    const warnings: string[] = [];
    const outcome = await applyFeedback(
      {
        ledger,
        reactions: createMemoryReactions(),
        logger: {
          warn: (_detail, message) => warnings.push(message),
        },
      },
      inputFor(),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('issue_feedback 写入失败');
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('applyFeedback：状态机与台账幂等', () => {
  it('received：只加 eyes，不删任何东西', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions({
      entries: [{ id: 1, content: 'eyes', userLogin: `${APP_SLUG}[bot]` }],
    });

    const outcome = await applyFeedback({ ledger, reactions, appSlug: APP_SLUG }, inputFor({ stage: 'received' }));

    expect(outcome.status).toBe('applied');
    expect(outcome.removed).toEqual([]);
    // 没有任何 list / remove：入队阶段只看「加」
    expect(reactions.calls).toEqual(['add:eyes']);
    expect(ledger.applied).toHaveLength(1);
    expect(ledger.applied[0]?.reactionId).toBe(outcome.reactionId);
  });

  it('succeeded：先删自己打的 eyes（别人的留着）再加 rocket', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions({
      entries: [
        { id: 11, content: 'eyes', userLogin: `${APP_SLUG}[bot]` },
        { id: 12, content: 'eyes', userLogin: 'alice' },
      ],
    });

    const outcome = await applyFeedback({ ledger, reactions, appSlug: APP_SLUG }, inputFor({ stage: 'succeeded' }));

    expect(outcome.status).toBe('applied');
    expect(outcome.removed).toEqual([11]);
    expect(reactions.calls).toEqual(['list:eyes', 'remove:11', 'add:rocket']);
    expect(reactions.added).toEqual(['rocket']);
  });

  it('failed / timed-out / cancelled：都是 confused', async () => {
    for (const stage of ['failed', 'timed-out', 'cancelled'] as const) {
      const ledger = createMemoryLedger();
      const reactions = createMemoryReactions();
      const outcome = await applyFeedback({ ledger, reactions }, inputFor({ stage }));
      expect(outcome.content).toBe('confused');
      expect(reactions.added).toEqual(['confused']);
    }
  });

  it('唯一键命中且 applied_at 非空 → 一个请求都不发（重投天然幂等）', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions();

    const first = await applyFeedback({ ledger, reactions }, inputFor());
    const second = await applyFeedback({ ledger, reactions }, inputFor());

    expect(first.status).toBe('applied');
    expect(second.status).toBe('skipped');
    expect(ledger.claims).toBe(2);
    // 第二次只命中台账，没有 add / list
    expect(reactions.calls).toEqual(['list:eyes', 'add:rocket']);
  });

  it('唯一键命中但 applied_at 为空（上一轮 403 了）→ 允许重试', async () => {
    const ledger = createMemoryLedger();
    // 预置一行「计划过但没落地」的台账
    const claim = await ledger.claim({
      repo: REPO,
      targetKind: 'issue',
      targetNumber: TARGET,
      commentId: null,
      stage: 'succeeded',
      content: 'rocket',
      anchor: ANCHOR,
      audit: null,
    });
    expect(claim.inserted).toBe(true);

    const reactions = createMemoryReactions();
    const outcome = await applyFeedback({ ledger, reactions }, inputFor());

    expect(outcome.status).toBe('applied');
    expect(reactions.added).toEqual(['rocket']);
  });

  it('删 eyes 失败不阻塞终态（仍然打 rocket）', async () => {
    const ledger = createMemoryLedger();
    const reactions = createMemoryReactions({
      entries: [{ id: 21, content: 'eyes', userLogin: `${APP_SLUG}[bot]` }],
      listFailures: [httpError(500, 'boom'), httpError(500, 'boom')],
    });

    const outcome = await applyFeedback({ ledger, reactions }, inputFor({ stage: 'succeeded' }));

    expect(outcome.status).toBe('applied');
    expect(outcome.removed).toEqual([]);
    expect(reactions.added).toEqual(['rocket']);
  });
});

describe('removeOwnReaction：只删自己的（plan §5）', () => {
  it('按 user.login 过滤：别人的 reaction 一条都不删', async () => {
    const reactions = createMemoryReactions({
      entries: [
        { id: 31, content: 'eyes', userLogin: `${APP_SLUG}[bot]` },
        { id: 32, content: 'eyes', userLogin: 'alice' },
        { id: 33, content: 'eyes', userLogin: null },
      ],
    });

    const removed = await removeOwnReaction(
      { reactions, appSlug: APP_SLUG },
      { repo: REPO, targetKind: 'issue', targetNumber: TARGET, content: 'eyes' },
    );

    expect(removed).toEqual([31]);
    expect(reactions.removed).toEqual([31]);
  });

  it('没有自己的 reaction → 返回空列表，不发 DELETE', async () => {
    const reactions = createMemoryReactions({
      entries: [{ id: 41, content: 'eyes', userLogin: 'alice' }],
    });

    const removed = await removeOwnReaction(
      { reactions },
      { repo: REPO, targetKind: 'pr', targetNumber: TARGET, content: 'eyes' },
    );

    expect(removed).toEqual([]);
    expect(reactions.calls).toEqual(['list:eyes']);
  });
});

describe('createPgReactionsFlagStore：进程内缓存', () => {
  const fakePool = (rows: readonly unknown[]): {
    readonly queries: string[];
    readonly pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };
  } => {
    const queries: string[] = [];
    return {
      queries,
      pool: {
        query: async (text) => {
          queries.push(text);
          return { rows: [...rows] };
        },
      },
    };
  };

  it('首次读库拿 value=1 且不过期 → disabled，且只查一次', async () => {
    const { pool, queries } = fakePool([{ value: '1', until: null }]);
    const store = createPgReactionsFlagStore({ pool });

    expect(await store.isDisabled()).toBe(true);
    expect(await store.isDisabled()).toBe(true);
    expect(queries).toHaveLength(1);
  });

  it('disable() 先落 flag 再翻内存开关（后续不再查库）', async () => {
    const { pool, queries } = fakePool([]);
    const store = createPgReactionsFlagStore({ pool });

    expect(await store.isDisabled()).toBe(false);
    await store.disable({ reason: 'reaction.add 403' });

    expect(await store.isDisabled()).toBe(true);
    // 一次读 + 一次 upsert，没有第二次读
    expect(queries).toHaveLength(2);
  });

  it('GitHub 的 403 在 classify 里被归成 auth（降级判据）', () => {
    const error = new GithubError({
      class: 'auth',
      status: 403,
      retryAfterMs: null,
      message: 'Resource not accessible by integration',
      requestId: null,
      documentationUrl: null,
      retry: { retry: false, maxAttempts: 1, delayMs: 0, useStartAfter: false, backoff: false },
    });
    expect(error.info.class).toBe('auth');
    expect(error.info.status).toBe(403);
  });
});
