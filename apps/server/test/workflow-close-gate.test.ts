/**
 * 关闭闸门（plan §7）：五个条件、四个反例、一个正例。
 *
 * 关闭是唯一不可回收的自动动作，所以这里把「差一条就不关」逐条写死；
 * 最后一个用例走真库，证明判定确实只读 `issue_states` + `bot_labels` 这两张表。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluateCloseGate, loadCloseGateDecision, CLOSE_GRACE_MS } from '../src/workflows/close-gate.ts';
import { toSqlRunner } from '../src/workflows/ports.ts';
import type { IssueStateSnapshot } from '../src/workflows/issue-state.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/**
 * 这些用例都持有 pi_issue_bot_test 的 advisory lock（openTestDb 的设计）——
 * 全量跑时多个文件排队等锁，默认 10s 的 hook 超时不够用，所以显式放宽。
 */
const HOOK_TIMEOUT_MS = 60_000;

const NOW = new Date('2026-06-10T00:00:00.000Z');
const HOUR = 3_600_000;

function state(overrides: Partial<IssueStateSnapshot> = {}): IssueStateSnapshot {
  return {
    repo: 'acme/widgets',
    issueNumber: 7,
    missingSetHash: 'f'.repeat(64),
    firstSeenAt: new Date(NOW.getTime() - CLOSE_GRACE_MS - HOUR),
    lastHumanReplyAt: null,
    lastNudgeAt: new Date(NOW.getTime() - CLOSE_GRACE_MS - HOUR),
    closedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('evaluateCloseGate（纯判定）', () => {
  it('五个条件全满足 → 可以关，且五条明细都在', () => {
    const decision = evaluateCloseGate({ state: state(), botLabels: ['needs-info', 'bug'], now: NOW });
    expect(decision.shouldClose).toBe(true);
    expect(decision.checks).toHaveLength(5);
    expect(decision.checks.every((check) => check.passed)).toBe(true);
    expect(decision.reason).toContain('可以关闭');
  });

  it('反例 1：48h 内有人回复 → 不关', () => {
    const decision = evaluateCloseGate({
      state: state({ lastHumanReplyAt: new Date(NOW.getTime() - HOUR) }),
      botLabels: ['needs-info'],
      now: NOW,
    });
    expect(decision.shouldClose).toBe(false);
    expect(decision.reason).toContain('no-human-reply');
  });

  it('反例 2：缺失项变了（计时起点被重置，还没满 48h）→ 不关', () => {
    const decision = evaluateCloseGate({
      state: state({ firstSeenAt: new Date(NOW.getTime() - HOUR) }),
      botLabels: ['needs-info'],
      now: NOW,
    });
    expect(decision.shouldClose).toBe(false);
    expect(decision.reason).toContain('grace-elapsed');
  });

  it('反例 3：缺 needs-info → 不关', () => {
    const decision = evaluateCloseGate({ state: state(), botLabels: ['bug'], now: NOW });
    expect(decision.shouldClose).toBe(false);
    expect(decision.reason).toContain('needs-info-present');
  });

  it('反例 4：已经关过 → 不关（关闭不可回收，不重复关）', () => {
    const decision = evaluateCloseGate({
      state: state({ closedAt: new Date(NOW.getTime() - 30 * 60_000) }),
      botLabels: ['needs-info'],
      now: NOW,
    });
    expect(decision.shouldClose).toBe(false);
    expect(decision.reason).toContain('not-closed');
  });

  it('没有 issue_states 行 / 没有缺失项 → 都不关', () => {
    expect(evaluateCloseGate({ state: null, botLabels: ['needs-info'], now: NOW }).shouldClose).toBe(false);
    expect(
      evaluateCloseGate({ state: state({ missingSetHash: null }), botLabels: ['needs-info'], now: NOW }).shouldClose,
    ).toBe(false);
  });

  it('人工回复恰好等于 first_seen_at 不算「新回复」（同批事件）→ 仍然可以关', () => {
    const firstSeenAt = new Date(NOW.getTime() - CLOSE_GRACE_MS - HOUR);
    const decision = evaluateCloseGate({
      state: state({ firstSeenAt, lastHumanReplyAt: firstSeenAt }),
      botLabels: ['needs-info'],
      now: NOW,
    });
    expect(decision.shouldClose).toBe(true);
  });
});

describe('loadCloseGateDecision（只读 issue_states + bot_labels）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await openTestDb();
    await db.truncate();
    }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await db.close();
    }, HOOK_TIMEOUT_MS);

  it('两张表都满足 → shouldClose=true；撤掉 needs-info 后立刻变 false', async () => {
    const sql = toSqlRunner(db.pool);
    const firstSeenAt = new Date(NOW.getTime() - CLOSE_GRACE_MS - HOUR).toISOString();

    await db.pool.query(
      `insert into issue_states (repo, issue_number, missing_set_hash, first_seen_at, last_nudge_at)
       values ('acme/widgets', 7, $1, $2, $2)`,
      ['f'.repeat(64), firstSeenAt],
    );
    await db.pool.query(
      `insert into bot_labels (repo, issue_number, label) values ('acme/widgets', 7, 'needs-info')`,
    );

    const decision = await loadCloseGateDecision(sql, { repo: 'acme/widgets', issueNumber: 7, now: NOW });
    expect(decision.shouldClose).toBe(true);

    // 撤标 → 立刻不再满足（这就是「只读这两张表」的直接后果）
    await db.pool.query(
      `update bot_labels set removed_at = now() where repo = 'acme/widgets' and issue_number = 7`,
    );
    const after = await loadCloseGateDecision(sql, { repo: 'acme/widgets', issueNumber: 7, now: NOW });
    expect(after.shouldClose).toBe(false);
    expect(after.reason).toContain('needs-info-present');
  });
});