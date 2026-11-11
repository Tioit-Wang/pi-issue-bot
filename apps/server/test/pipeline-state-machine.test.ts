/**
 * 固定流水线的状态机（`workflows/pipeline.ts`）—— `docs/plan-fixed-pipeline.md` §2 转移表逐行。
 *
 * 两类断言刻意分开：
 *  1. **纯函数**：`decideTransition()` 对每个事件给出哪些列（含 `effects` 与 `ignore` 原因），
 *     不碰库、不读时钟（`at` 由事件带进来，所以每个用例都能断言到具体时间戳）；
 *  2. **真库读写**：`ensurePipeline` / `createReadyRow` / `applyTransition` / `loadPipeline`
 *     打的列名与 §4.3 的 DDL 一致（手写 camelCase ↔ snake_case 的地方最容易错）。
 *
 * 本文件最要紧的一条：**两种 `awaiting_info` 的 `info_requested_at` 差异**
 *  - `format/awaiting_info`（等用户）→ 非空，进 48h 关闭扫描；
 *  - `classify/awaiting_info`（等管理员）→ **NULL**，不进扫描。
 * 写错这一列，躺在等管理员的 issue 会被 48h 作业误关。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTransition,
  createReadyRow,
  decideTransition,
  ensurePipeline,
  loadPipeline,
} from '../src/workflows/pipeline.ts';
import type { PipelineRow } from '../src/workflows/pipeline.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const AT = new Date('2026-06-01T12:00:00.000Z');
const HOUR = 3_600_000;

/** 一行「刚建好」的状态：`format/pending`。 */
function row(over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    repo: REPO,
    issueNumber: 7,
    stage: 'format',
    state: 'pending',
    category: null,
    formatAttempts: 0,
    formatFailCount: 0,
    classifyAttempts: 0,
    issueVersion: 'v1',
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
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

describe('decideTransition：§2 转移表', () => {
  it('issues.opened（无行）→ format/pending + 入队 pipeline:format', () => {
    const t = decideTransition(null, { kind: 'issue-opened', at: AT, issueVersion: 'v1' });
    expect(t).toMatchObject({
      stage: 'format',
      state: 'pending',
      issueVersion: 'v1',
      effects: { enqueue: 'pipeline:format' },
    });
    expect(t.ignore).toBeUndefined();
  });

  it('issues.opened 在 ready 之后 → 忽略（D7 不回退）', () => {
    const t = decideTransition(row({ stage: 'agent', state: 'ready' }), {
      kind: 'issue-opened',
      at: AT,
    });
    expect(t.ignore).toBe('already-ready');
  });

  it('issues.opened 在 closed 之后 → 忽略', () => {
    const t = decideTransition(row({ stage: 'closed', state: 'closed' }), {
      kind: 'issue-opened',
      at: AT,
    });
    expect(t.ignore).toBe('closed');
  });

  it('格式 pass（首次）→ classify/pending，无确认评论', () => {
    const t = decideTransition(row({ state: 'running' }), { kind: 'format-pass-first', at: AT });
    expect(t).toMatchObject({
      stage: 'classify',
      state: 'pending',
      formatAttempts: 1,
      infoRequestedAt: null,
      effects: { enqueue: 'pipeline:classify', confirmComment: false },
    });
    // 通过不计入失败次数（Q5）
    expect(t.formatFailCount).toBeUndefined();
  });

  it('格式 pass（重检）→ 要有确认评论（D8），失败次数不变', () => {
    const t = decideTransition(row({ state: 'running', formatFailCount: 2, formatAttempts: 2 }), {
      kind: 'format-pass-recheck',
      at: AT,
    });
    expect(t).toMatchObject({
      stage: 'classify',
      state: 'pending',
      formatAttempts: 3,
      effects: { enqueue: 'pipeline:classify', confirmComment: true },
    });
    expect(t.formatFailCount).toBeUndefined();
  });

  it('格式 fail → format/awaiting_info + info_requested_at=now（进 48h 扫描）', () => {
    const t = decideTransition(row({ state: 'running' }), { kind: 'format-fail', at: AT });
    expect(t).toMatchObject({
      stage: 'format',
      state: 'awaiting_info',
      formatAttempts: 1,
      formatFailCount: 1,
      infoRequestedAt: AT,
    });
    expect(t.effects?.closeIssue).toBeUndefined();
  });

  it('第 5 次格式不通过 → 自动关 issue（Q5）', () => {
    const t = decideTransition(row({ state: 'running', formatFailCount: 4, formatAttempts: 4 }), {
      kind: 'format-fail',
      at: AT,
    });
    expect(t).toMatchObject({
      stage: 'closed',
      state: 'closed',
      formatFailCount: 5,
      closedAt: AT,
      infoRequestedAt: null,
      effects: { closeIssue: true },
    });
  });

  it('formatMaxFails 可注入（V19：注入 2 → 第 2 次就关）', () => {
    const t = decideTransition(row({ state: 'running', formatFailCount: 1 }), {
      kind: 'format-fail',
      at: AT,
      formatMaxFails: 2,
    });
    expect(t.state).toBe('closed');
    expect(t.effects?.closeIssue).toBe(true);
  });

  it('补充评论（作者）→ 立即重跑，清 info_requested_at、记 last_recheck_at', () => {
    const t = decideTransition(
      row({ stage: 'format', state: 'awaiting_info', infoRequestedAt: AT }),
      { kind: 'supplement-comment', actor: 'author', commentId: 42, at: AT },
    );
    expect(t).toMatchObject({
      stage: 'format',
      state: 'pending',
      infoRequestedAt: null,
      lastRecheckAt: AT,
      effects: { enqueue: 'pipeline:format' },
    });
  });

  it('补充评论（路人）→ 忽略；不在 awaiting_info 的评论也忽略', () => {
    expect(
      decideTransition(row({ stage: 'format', state: 'awaiting_info', infoRequestedAt: AT }), {
        kind: 'supplement-comment',
        actor: 'other',
        at: AT,
      }).ignore,
    ).toBe('supplement-actor-not-allowed');
    expect(
      decideTransition(row({ stage: 'format', state: 'pending' }), {
        kind: 'supplement-comment',
        actor: 'author',
        at: AT,
      }).ignore,
    ).toBe('not-format-awaiting-info:format/pending');
  });

  it('classify/awaiting_info + managers 评论 → 重跑分类（info_requested_at 保持 NULL）', () => {
    const t = decideTransition(row({ stage: 'classify', state: 'awaiting_info' }), {
      kind: 'manager-comment',
      fromManager: true,
      at: AT,
    });
    expect(t).toMatchObject({
      stage: 'classify',
      state: 'pending',
      infoRequestedAt: null,
      effects: { enqueue: 'pipeline:classify' },
    });
  });

  it('classify/awaiting_info 的非 managers 评论 → 不重跑（§1.8 Q6 修订）', () => {
    expect(
      decideTransition(row({ stage: 'classify', state: 'awaiting_info' }), {
        kind: 'manager-comment',
        fromManager: false,
        at: AT,
      }).ignore,
    ).toBe('manager-comment-not-from-manager');
  });

  it('分类 requirement / defect / other → agent/ready（真实类别直接放行）', () => {
    for (const result of ['requirement', 'defect', 'other'] as const) {
      const t = decideTransition(row({ stage: 'classify', state: 'running' }), {
        kind: 'classify-result',
        result,
        at: AT,
      });
      expect(t).toMatchObject({
        stage: 'agent',
        state: 'ready',
        category: result,
        readyAt: AT,
        infoRequestedAt: null,
        classifyAttempts: 1,
      });
    }
  });

  it('分类 not-found → classify/awaiting_info，且 info_requested_at 必须为 NULL', () => {
    const t = decideTransition(row({ stage: 'classify', state: 'running' }), {
      kind: 'classify-result',
      result: 'not-found',
      at: AT,
    });
    expect(t).toMatchObject({
      stage: 'classify',
      state: 'awaiting_info',
      category: 'not-found',
    });
    // **关键断言**：等管理员 ≠ 等用户，这一列必须显式为 null（不是「不写」）
    expect(t.infoRequestedAt).toBeNull();
    expect(t.readyAt).toBeUndefined();
  });

  it('连续 2 次运行失败 / 信封不合法 → blocked；第 1 次只回 pending', () => {
    expect(
      decideTransition(row({ stage: 'classify', state: 'running' }), {
        kind: 'run-invalid',
        consecutive: 1,
        at: AT,
      }),
    ).toMatchObject({ state: 'pending', blockedReason: null });
    const blocked = decideTransition(row({ stage: 'classify', state: 'running' }), {
      kind: 'run-invalid',
      consecutive: 2,
      reason: '信封不合法',
      at: AT,
    });
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toContain('连续 2 次');
  });

  it('/pipeline next：format→classify、classify→ready、agent → 没有下一步', () => {
    const fromFormat = decideTransition(row({ stage: 'format', state: 'awaiting_info' }), {
      kind: 'manual-next',
      fromManager: true,
      at: AT,
    });
    expect(fromFormat).toMatchObject({
      stage: 'classify',
      state: 'pending',
      infoRequestedAt: null,
      effects: { enqueue: 'pipeline:classify' },
    });

    const fromClassify = decideTransition(row({ stage: 'classify', state: 'awaiting_info' }), {
      kind: 'manual-next',
      fromManager: true,
      at: AT,
    });
    expect(fromClassify).toMatchObject({ stage: 'agent', state: 'ready', readyAt: AT });

    expect(
      decideTransition(row({ stage: 'agent', state: 'ready' }), {
        kind: 'manual-next',
        fromManager: true,
        at: AT,
      }).ignore,
    ).toBe('already-last-stage');
  });

  it('/pipeline next 的 blocked 等价解禁；非 managers 被拒', () => {
    const unblock = decideTransition(row({ stage: 'classify', state: 'blocked', blockedReason: 'x' }), {
      kind: 'manual-next',
      fromManager: true,
      at: AT,
    });
    expect(unblock.blockedReason).toBeNull();
    expect(unblock.stage).toBe('agent');

    expect(
      decideTransition(row({ stage: 'format', state: 'pending' }), {
        kind: 'manual-next',
        fromManager: false,
        at: AT,
      }).ignore,
    ).toBe('not-manager');
  });

  it('/pipeline prev：agent→classify（清旧结论）、classify→format、format → 没有上一步', () => {
    const fromAgent = decideTransition(row({ stage: 'agent', state: 'ready', category: 'defect' }), {
      kind: 'manual-prev',
      fromManager: true,
      at: AT,
    });
    expect(fromAgent).toMatchObject({
      stage: 'classify',
      state: 'pending',
      category: null,
      effects: { enqueue: 'pipeline:classify' },
    });

    const fromClassify = decideTransition(row({ stage: 'classify', state: 'pending' }), {
      kind: 'manual-prev',
      fromManager: true,
      at: AT,
    });
    expect(fromClassify).toMatchObject({
      stage: 'format',
      state: 'pending',
      effects: { enqueue: 'pipeline:format' },
    });

    expect(
      decideTransition(row({ stage: 'format', state: 'pending' }), {
        kind: 'manual-prev',
        fromManager: true,
        at: AT,
      }).ignore,
    ).toBe('already-first-stage');
  });

  it('/recheck：重跑当前阶段；`--force` 才清 blocked_reason；agent 阶段没有重跑', () => {
    const plain = decideTransition(row({ stage: 'classify', state: 'blocked', blockedReason: 'x' }), {
      kind: 'manual-recheck',
      at: AT,
    });
    expect(plain).toMatchObject({
      stage: 'classify',
      state: 'pending',
      lastRecheckAt: AT,
      effects: { enqueue: 'pipeline:classify' },
    });
    expect(plain.blockedReason).toBeUndefined();

    const forced = decideTransition(row({ stage: 'classify', state: 'blocked', blockedReason: 'x' }), {
      kind: 'manual-recheck',
      force: true,
      at: AT,
    });
    expect(forced.blockedReason).toBeNull();

    expect(
      decideTransition(row({ stage: 'agent', state: 'ready' }), { kind: 'manual-recheck', at: AT }).ignore,
    ).toBe('agent-stage-has-no-recheck');
  });

  it('48h 无补充 → 关（auto-close），没到点不动', () => {
    const expired = decideTransition(
      row({ stage: 'format', state: 'awaiting_info', infoRequestedAt: new Date(AT.getTime() - 49 * HOUR) }),
      { kind: 'auto-close', at: AT },
    );
    expect(expired).toMatchObject({
      stage: 'closed',
      state: 'closed',
      closedAt: AT,
      effects: { closeIssue: true },
    });

    const notYet = decideTransition(
      row({ stage: 'format', state: 'awaiting_info', infoRequestedAt: new Date(AT.getTime() - 47 * HOUR) }),
      { kind: 'auto-close', at: AT },
    );
    expect(notYet.ignore).toBe('not-expired-yet');
  });

  it('classify/awaiting_info（等管理员）永远不会被 48h 关掉', () => {
    // info_requested_at 为 NULL → 扫描器根本看不到它（§9）
    expect(
      decideTransition(row({ stage: 'classify', state: 'awaiting_info', infoRequestedAt: null }), {
        kind: 'auto-close',
        at: AT,
      }).ignore,
    ).toBe('info-not-requested');
  });

  it('issues.closed → closed；已经 closed 的不重复写', () => {
    expect(decideTransition(row({ stage: 'agent', state: 'ready' }), { kind: 'issue-closed', at: AT })).toMatchObject({
      stage: 'closed',
      state: 'closed',
      closedAt: AT,
    });
    expect(
      decideTransition(row({ stage: 'closed', state: 'closed' }), { kind: 'issue-closed', at: AT }).ignore,
    ).toBe('already-closed');
  });

  it('issues.edited（format 阶段）→ 重跑；ready → 只记 stale_at（D7）', () => {
    const rerun = decideTransition(row({ stage: 'format', state: 'awaiting_info', infoRequestedAt: AT }), {
      kind: 'issue-edited',
      at: AT,
      issueVersion: 'v2',
    });
    expect(rerun).toMatchObject({
      stage: 'format',
      state: 'pending',
      issueVersion: 'v2',
      lastRecheckAt: AT,
      effects: { enqueue: 'pipeline:format' },
    });

    const stale = decideTransition(row({ stage: 'agent', state: 'ready' }), {
      kind: 'issue-edited',
      at: AT,
    });
    expect(stale).toEqual({ staleAt: AT });
  });
});

/* ── 真库：读写与列名 ─────────────────────────────────────────────────────── */

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(AT);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table issue_pipeline');
});

describe('issue_pipeline 读写（真库）', () => {
  it('无行 → loadPipeline 返回 null（§1.3 无行放行）', async () => {
    expect(await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 })).toBeNull();
  });

  it('ensurePipeline 建 format/pending，且第二次调用不覆盖已有进度', async () => {
    const created = await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { issueVersion: 'v1' });
    expect(created).toMatchObject({ stage: 'format', state: 'pending', issueVersion: 'v1' });

    await applyTransition(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'classify', state: 'pending' });
    const again = await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { issueVersion: 'v2' });
    // 已有行不被重置（ON CONFLICT DO NOTHING）
    expect(again).toMatchObject({ stage: 'classify', state: 'pending', issueVersion: 'v1' });
  });

  it('createReadyRow → agent/ready + ready_at（存量 issue 懒创建）', async () => {
    const created = await createReadyRow(db.pool, { repo: REPO, issueNumber: 9 }, AT);
    expect(created.stage).toBe('agent');
    expect(created.state).toBe('ready');
    expect(created.readyAt?.toISOString()).toBe(AT.toISOString());
  });

  it('applyTransition 写的列名与 §4.3 一致（含把 info_requested_at 显式写成 NULL）', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 });
    const at = AT;
    // 先进入 format/awaiting_info（写入时间戳）
    await applyTransition(
      db.pool,
      { repo: REPO, issueNumber: 7 },
      decideTransition(row(), { kind: 'format-fail', at }),
    );
    const waiting = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(waiting?.infoRequestedAt?.toISOString()).toBe(at.toISOString());
    expect(waiting?.formatFailCount).toBe(1);

    // 手动指定 NULL 必须真的写进库（不是「不写」）
    await applyTransition(db.pool, { repo: REPO, issueNumber: 7 }, { infoRequestedAt: null });
    const cleared = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(cleared?.infoRequestedAt).toBeNull();
    // 其他列不被顺带清掉
    expect(cleared?.formatFailCount).toBe(1);
  });

  it('两种 awaiting_info 落库后：一个非空、一个恒为 NULL', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 11 });
    const at = AT;
    await applyTransition(
      db.pool,
      { repo: REPO, issueNumber: 11 },
      decideTransition(row({ issueNumber: 11 }), { kind: 'format-fail', at }),
    );
    const formatWaiting = await loadPipeline(db.pool, { repo: REPO, issueNumber: 11 });
    expect(formatWaiting?.stage).toBe('format');
    expect(formatWaiting?.infoRequestedAt).not.toBeNull();

    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 12 }, { stage: 'classify' });
    await applyTransition(
      db.pool,
      { repo: REPO, issueNumber: 12 },
      decideTransition(row({ issueNumber: 12, stage: 'classify' }), {
        kind: 'classify-result',
        result: 'not-found',
        at: AT,
      }),
    );
    const classifyWaiting = await loadPipeline(db.pool, { repo: REPO, issueNumber: 12 });
    expect(classifyWaiting?.stage).toBe('classify');
    expect(classifyWaiting?.state).toBe('awaiting_info');
    expect(classifyWaiting?.infoRequestedAt).toBeNull();

    // 关闭扫描的 SQL 只看得到前者（§9）
    const scannable = await db.sql(
      `select issue_number from issue_pipeline
       where state = 'awaiting_info' and info_requested_at is not null
         and info_requested_at < now() + interval '1 hour'`,
    );
    expect(scannable.map((item) => item['issue_number'])).toEqual([11]);
  });

  it('applyTransition 对 ignore 型转移一行都不写（返回 0）', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 });
    const affected = await applyTransition(
      db.pool,
      { repo: REPO, issueNumber: 7 },
      decideTransition(row({ stage: 'closed', state: 'closed' }), { kind: 'issue-opened', at: AT }),
    );
    expect(affected).toBe(0);
    const still = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(still?.stage).toBe('format');
  });
});
