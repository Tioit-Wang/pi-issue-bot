/**
 * 回归（P2-1 / P2-2 / P2-3 / P2-5）：固定流水线的四处「次级缺陷」。
 *
 *  - **P2-1**：`decideTransition({kind:'issue-opened'})` 注释说「新一轮从零计失败次数」但没重置
 *    `format_fail_count` / `format_attempts` / `info_requested_at` → 重开一轮带着旧账，
 *    下一次 fail 就可能直接撞上限把关单（Q5 语义）；
 *  - **P2-2**：`issue_version` 两种口径（列里带 `pipeline:format:` 前缀 vs 裸 hash），
 *    入队处又拼一次前缀 → 同一个 issue 出现 `pipeline:classify:pipeline:format:x` 与
 *    `pipeline:classify:x` 两种锚。统一：**列里只存裸 issueVersion，锚只在入队处拼一次**；
 *  - **P2-3**：`planAgentSession()` 恒传 `after: sessionCursor`（缺省 0），使 turn-driver
 *    「没给 `after` 时用 attach 快照游标兜底」分支永不生效 → cursor 未回填时会 `subscribe{after:0}`
 *    重放整段旧事件；
 *  - **P2-5**：`PIPELINE_CLASSIFY_MAX_MINUTES` 无消费点 → `pipeline:classify` 的任务时限取
 *    `min(settings.limits.max_task_minutes, PIPELINE_CLASSIFY_MAX_MINUTES)`（系统常量是硬上限）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_SETTINGS } from '../../../packages/contract/src/index.ts';
import { classifyTimeoutMsOf, planAgentSession } from '../src/app/compose.ts';
import { PIPELINE_CLASSIFY_MAX_MINUTES } from '../src/config/pipeline-constants.ts';
import {
  applyTransition,
  bareIssueVersion,
  decideTransition,
  ensurePipeline,
  loadPipeline,
  pipelineAnchor,
} from '../src/workflows/pipeline.ts';
import type { PipelineRow } from '../src/workflows/pipeline.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const AT = new Date('2026-06-01T12:00:00.000Z');

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
    issueVersion: 'abcdef0123456789',
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

describe('P2-1：issue 重开一轮从零计失败次数', () => {
  it('issue-opened 清掉 format_fail_count / format_attempts / info_requested_at / blocked_reason', () => {
    const before = row({
      state: 'awaiting_info',
      formatAttempts: 4,
      formatFailCount: 4,
      infoRequestedAt: AT,
      blockedReason: '早期卡住的理由',
    });
    const t = decideTransition(before, {
      kind: 'issue-opened',
      at: AT,
      issueVersion: 'abcdef0123456789',
    });

    expect(t.ignore).toBeUndefined();
    expect(t).toMatchObject({
      stage: 'format',
      state: 'pending',
      formatAttempts: 0,
      formatFailCount: 0,
      infoRequestedAt: null,
      blockedReason: null,
      issueVersion: 'abcdef0123456789',
      effects: { enqueue: 'pipeline:format' },
    });
  });

  it('blocked 行被重开：旧账不带到新一轮（下一次 fail 不会直接关单）', () => {
    const before = row({
      stage: 'classify',
      state: 'blocked',
      formatFailCount: 4,
      blockedReason: '连续 2 次失败',
    });
    const t = decideTransition(before, { kind: 'issue-opened', at: AT });
    expect(t.formatFailCount).toBe(0);
    expect(t.blockedReason).toBeNull();
    expect(t.infoRequestedAt).toBeNull();
  });
});

describe('P2-2：issue_version 只存裸版本，锚只拼一次', () => {
  it('bareIssueVersion 剥掉历史前缀（含嵌套的旧数据）', () => {
    expect(bareIssueVersion('abcdef0123456789')).toBe('abcdef0123456789');
    expect(bareIssueVersion('pipeline:format:abcdef0123456789')).toBe('abcdef0123456789');
    expect(bareIssueVersion('pipeline:classify:abcdef0123456789')).toBe('abcdef0123456789');
    // 老数据里那种双重前缀也要剥干净
    expect(bareIssueVersion('pipeline:classify:pipeline:format:x')).toBe('x');
    expect(bareIssueVersion(null)).toBeNull();
  });

  it('pipelineAnchor 在裸版本上只拼一次前缀', () => {
    expect(pipelineAnchor('classify', 'abcdef0123456789')).toBe('pipeline:classify:abcdef0123456789');
    expect(pipelineAnchor('classify', bareIssueVersion('pipeline:format:abcdef0123456789'))).toBe(
      'pipeline:classify:abcdef0123456789',
    );
  });
});

describe('P2-3：只在真的有过游标时才传 after', () => {
  it('session_id 有值但 session_cursor = 0 → 不带 after（交给 attach 快照兜底）', () => {
    const plan = planAgentSession({
      pipeline: row({ stage: 'agent', state: 'ready', sessionId: 'session-old', sessionCursor: 0 }),
      at: AT,
    });
    expect(plan.session).toEqual({ mode: 'persistent', sessionId: 'session-old' });
    expect(plan.session !== undefined && 'after' in plan.session).toBe(false);
  });

  it('session_cursor > 0 → 带上 after（防重放旧事件）', () => {
    const plan = planAgentSession({
      pipeline: row({ stage: 'agent', state: 'ready', sessionId: 'session-old', sessionCursor: 3 }),
      at: AT,
    });
    expect(plan.session).toEqual({ mode: 'persistent', sessionId: 'session-old', after: 3 });
  });
});

describe('P2-5：pipeline:classify 的任务时限 = min(项目上限, 系统硬上限)', () => {
  const limitsWith = (maxTaskMinutes: number): Pick<typeof DEFAULT_REPO_SETTINGS, 'limits'> => ({
    limits: { ...DEFAULT_REPO_SETTINGS.limits, max_task_minutes: maxTaskMinutes },
  });

  it('项目上限更低 → 用项目值', () => {
    expect(classifyTimeoutMsOf(limitsWith(10))).toBe(10 * 60_000);
  });

  it('项目上限更高 → 被系统硬上限截断', () => {
    expect(classifyTimeoutMsOf(limitsWith(PIPELINE_CLASSIFY_MAX_MINUTES + 30))).toBe(
      PIPELINE_CLASSIFY_MAX_MINUTES * 60_000,
    );
  });

  it('settings 缺失 → 系统硬上限', () => {
    expect(classifyTimeoutMsOf(null)).toBe(PIPELINE_CLASSIFY_MAX_MINUTES * 60_000);
    expect(classifyTimeoutMsOf(undefined)).toBe(PIPELINE_CLASSIFY_MAX_MINUTES * 60_000);
  });
});

describe('P2-2：写库路径会把 issue_version 剥成裸版本（真 PG）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await openTestDb(AT);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.sql('truncate table issue_pipeline cascade');
  });

  it('applyTransition 收到带前缀的版本 → 列里仍是裸 hash', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { issueVersion: 'v1' });
    await applyTransition(db.pool, { repo: REPO, issueNumber: 7 }, {
      issueVersion: 'pipeline:format:abcdef0123456789',
    });
    const loaded = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(loaded?.issueVersion).toBe('abcdef0123456789');
  });

  it('ensurePipeline 的初值不被改写（只有 UPDATE 走剥离）', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 8 }, { issueVersion: 'v2' });
    const loaded = await loadPipeline(db.pool, { repo: REPO, issueNumber: 8 });
    expect(loaded?.issueVersion).toBe('v2');
  });
});
