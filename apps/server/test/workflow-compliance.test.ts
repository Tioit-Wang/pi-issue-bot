/**
 * 标准合规 + `issue_states` 的 UPSERT（**真库**，plan §6.2 / tech-plan §7.2 F4）。
 *
 * 这一组用例就是 M1 的验收条件：
 *  - 连续三次「编辑后重算、缺失项不变」→ 评论只发一次（同一句话不催第二次）；
 *  - 人先打的标签重算后仍在，且 `bot_labels` 里**没有**它那一行（只动自己的）；
 *  - 缺失项变化 → 再发一次，并把 `first_seen_at` 重置（48h 从新集合开始算）；
 *  - 集合变空 → `first_seen_at` 置 NULL 并撤掉 `needs-info`（只撤自己打过的）；
 *  - 集合变空后 close-gate 立刻不成立。
 *
 * 为什么必须真库：`ON CONFLICT ... CASE WHEN` 的语义、partial 唯一索引、`NULL` 比较
 * 这三件事在内存假实现里全是「看起来对」，只有 PG 会真的拒绝。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseRepoConfig } from '../../../packages/contract/src/index.ts';
import type { Verdict } from '../../../packages/envelope/src/index.ts';
import { createPgBotLabelLedger, listBotLabels } from '../src/workflows/bot-labels.ts';
import { applyCompliance, missingSetHashOf } from '../src/workflows/compliance.ts';
import { loadCloseGateDecision } from '../src/workflows/close-gate.ts';
import { toSqlRunner } from '../src/workflows/ports.ts';
import type { SqlRunner } from '../src/workflows/ports.ts';
import { createFakeWriteApi } from './helpers/fake-github.ts';
import type { RecordedWriteCall } from './helpers/fake-github.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/**
 * 这些用例都持有 pi_issue_bot_test 的 advisory lock（openTestDb 的设计）——
 * 全量跑时多个文件排队等锁，默认 10s 的 hook 超时不够用，所以显式放宽。
 */
const HOOK_TIMEOUT_MS = 60_000;

const REPO = 'acme/widgets';
const ISSUE = 7;
const T0 = new Date('2026-06-01T00:00:00.000Z');
const HOUR = 3_600_000;

const config = parseRepoConfig({
  version: 1,
  labels: { map: { bug: 'bug', 'needs-info': 'needs-info' } },
  compliance: { rules: [{ id: 'repro-steps' }, { id: 'version' }] },
});

/** 构造一封 verdict：`failing` 里的规则判 fail。 */
function verdict(failing: readonly string[]): Verdict {
  return {
    kind: 'issue',
    labels: ['bug'],
    evidence: [
      { rule: 'repro-steps', quote: '先点这里再点那里', passed: !failing.includes('repro-steps') },
      { rule: 'version', quote: '0.1.0', passed: !failing.includes('version') },
    ],
  };
}

/** 把假执行器记录到的调用镜像成一个「GitHub 现状」标签数组（模拟下一次读出来的值）。 */
function mirror(labels: readonly string[], calls: readonly RecordedWriteCall[], from: number): string[] {
  let next = [...labels];
  for (const call of calls.slice(from)) {
    if (call.method === 'addLabels') {
      for (const label of call.input['labels'] as readonly string[]) {
        if (!next.includes(label)) {
          next.push(label);
        }
      }
    }
    if (call.method === 'removeLabel') {
      const label = call.input['label'] as string;
      next = next.filter((item) => item !== label);
    }
  }
  return next;
}

let db: TestDb;
let sql: SqlRunner;

beforeAll(async () => {
  db = await openTestDb();
  sql = toSqlRunner(db.pool);
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.truncate();
});

afterAll(async () => {
  await db.close();
}, HOOK_TIMEOUT_MS);

async function stateRow(): Promise<{ hash: string | null; firstSeen: Date | null; nudged: Date | null }> {
  const rows = await db.sql(
    'select missing_set_hash, first_seen_at, last_nudge_at from issue_states where repo = $1 and issue_number = $2',
    [REPO, ISSUE],
  );
  const row = rows[0] ?? {};
  return {
    hash: (row['missing_set_hash'] as string | null) ?? null,
    firstSeen: (row['first_seen_at'] as Date | null) ?? null,
    nudged: (row['last_nudge_at'] as Date | null) ?? null,
  };
}

describe('applyCompliance + issue_states（真库）', () => {
  it('连续三次重算且缺失项不变 → 评论只发 1 次；人打的 bug 不受影响', async () => {
    const api = createFakeWriteApi();
    const ledger = createPgBotLabelLedger(sql);
    let labels: string[] = ['bug']; // 人先打的
    let botLabels: string[] = [];
    const failing = ['repro-steps', 'version'];

    const first = await applyCompliance(
      { db: sql, github: api, ledger, now: () => T0 },
      { repo: REPO, issueNumber: ISSUE, config, verdict: verdict(failing), currentLabels: labels, botLabels },
    );
    expect(first.outcome).toBe('nudged');
    labels = mirror(labels, api.calls, 0);
    botLabels = await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE });
    expect(labels).toContain('needs-info');
    expect(botLabels).toEqual(['needs-info']);
    expect(first.verdict.missingSetHash).toBe(missingSetHashOf(['repro-steps', 'version']));

    const afterFirst = await stateRow();
    expect(afterFirst.hash).toBe(first.verdict.missingSetHash);

    // 第 2、3 次：issue 被编辑、重算，但缺失项一模一样
    const cursor = api.calls.length;
    for (const offset of [1, 2]) {
      const later = await applyCompliance(
        { db: sql, github: api, ledger, now: () => new Date(T0.getTime() + offset * HOUR) },
        { repo: REPO, issueNumber: ISSUE, config, verdict: verdict(failing), currentLabels: labels, botLabels },
      );
      expect(later.outcome).toBe('unchanged');
      expect(later.missingSetChanged).toBe(false);
      labels = mirror(labels, api.calls, cursor);
      botLabels = await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE });
    }

    // 只发了一条评论；且 first_seen_at / last_nudge_at 都没被后续重算推进
    const commentCalls = api.calls.filter((call) => call.method === 'createIssueComment');
    expect(commentCalls).toHaveLength(1);
    const afterThree = await stateRow();
    expect(afterThree.firstSeen?.toISOString()).toBe(T0.toISOString());
    expect(afterThree.nudged?.toISOString()).toBe(T0.toISOString());

    // 人打的 bug 仍在，且 bot_labels 里没有它那一行（我们没打它）
    expect(labels).toContain('bug');
    const botBugRows = await db.sql(
      `select 1 from bot_labels where repo = $1 and issue_number = $2 and label = 'bug'`,
      [REPO, ISSUE],
    );
    expect(botBugRows).toHaveLength(0);
  });

  it('缺失项变化 → 再发一次，并把 first_seen_at 重置到本轮', async () => {
    const api = createFakeWriteApi();
    const ledger = createPgBotLabelLedger(sql);
    let labels: string[] = ['bug'];

    await applyCompliance(
      { db: sql, github: api, ledger, now: () => T0 },
      { repo: REPO, issueNumber: ISSUE, config, verdict: verdict(['repro-steps', 'version']), currentLabels: labels, botLabels: [] },
    );
    labels = mirror(labels, api.calls, 0);

    const T1 = new Date(T0.getTime() + 5 * HOUR);
    const second = await applyCompliance(
      { db: sql, github: api, ledger, now: () => T1 },
      { repo: REPO, issueNumber: ISSUE, config, verdict: verdict(['version']), currentLabels: labels, botLabels: ['needs-info'] },
    );

    expect(second.outcome).toBe('nudged');
    expect(second.missingSetChanged).toBe(true);
    expect(second.verdict.missingSetHash).toBe(missingSetHashOf(['version']));
    expect(api.calls.filter((call) => call.method === 'createIssueComment')).toHaveLength(2);

    const state = await stateRow();
    expect(state.firstSeen?.toISOString()).toBe(T1.toISOString());
    expect(state.nudged?.toISOString()).toBe(T1.toISOString());
  });

  it('集合变空 → first_seen_at = NULL 并撤掉自己打的 needs-info；close-gate 立刻不成立', async () => {
    const api = createFakeWriteApi();
    const ledger = createPgBotLabelLedger(sql);
    let labels: string[] = ['bug'];

    await applyCompliance(
      { db: sql, github: api, ledger, now: () => T0 },
      { repo: REPO, issueNumber: ISSUE, config, verdict: verdict(['repro-steps']), currentLabels: labels, botLabels: [] },
    );
    labels = mirror(labels, api.calls, 0);
    expect(labels).toEqual(['bug', 'needs-info']);

    const T1 = new Date(T0.getTime() + HOUR);
    const pass = await applyCompliance(
      { db: sql, github: api, ledger, now: () => T1 },
      { repo: REPO, issueNumber: ISSUE, config, verdict: verdict([]), currentLabels: labels, botLabels: ['needs-info'] },
    );
    expect(pass.outcome).toBe('pass');
    expect(pass.delta?.remove).toEqual(['needs-info']);
    labels = mirror(labels, api.calls, 0);
    expect(labels).toEqual(['bug']);

    const state = await stateRow();
    expect(state.hash).toBeNull();
    expect(state.firstSeen).toBeNull();

    const active = await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE });
    expect(active).toEqual([]);

    // 撤标是置位不是删除：历史仍在，才能答「这个标签当初是谁打的」
    const allRows = await db.sql(
      'select removed_at from bot_labels where repo = $1 and issue_number = $2',
      [REPO, ISSUE],
    );
    expect(allRows).toHaveLength(1);
    expect(allRows[0]?.['removed_at']).not.toBeNull();

    const gate = await loadCloseGateDecision(sql, { repo: REPO, issueNumber: ISSUE, now: T1 });
    expect(gate.shouldClose).toBe(false);
  });

  it('缺证据的规则算 fail（「没证据」不等于「通过了」）', async () => {
    const api = createFakeWriteApi();
    const ledger = createPgBotLabelLedger(sql);
    const partial: Verdict = {
      kind: 'issue',
      labels: [],
      evidence: [{ rule: 'repro-steps', quote: '步骤', passed: true }],
    };
    const result = await applyCompliance(
      { db: sql, github: api, ledger, now: () => T0 },
      { repo: REPO, issueNumber: ISSUE, config, verdict: partial, currentLabels: [], botLabels: [] },
    );
    expect(result.verdict.failedRuleIds).toEqual(['version']);
    expect(result.verdict.rules.find((row) => row.rule === 'version')?.note).toContain('没有这条规则的证据');
  });

  it('dry-run 只算不写：库里不留行，也不发评论不打标', async () => {
    const api = createFakeWriteApi();
    const result = await applyCompliance(
      { db: sql, github: api, now: () => T0 },
      { repo: REPO, issueNumber: ISSUE, config, verdict: verdict(['repro-steps']), currentLabels: ['bug'], botLabels: [], dryRun: true },
    );
    expect(result.outcome).toBe('dry-run');
    expect(api.calls.filter((call) => call.method !== 'listIssueComments')).toHaveLength(0);
    expect(await db.sql('select 1 from issue_states')).toHaveLength(0);
  });

  it('compliance.enabled=false → 不判定、不回复、不写库', async () => {
    const api = createFakeWriteApi();
    const disabled = parseRepoConfig({ version: 1, compliance: { enabled: false } });
    const result = await applyCompliance(
      { db: sql, github: api, now: () => T0 },
      { repo: REPO, issueNumber: ISSUE, config: disabled, verdict: verdict(['repro-steps']), currentLabels: [], botLabels: [] },
    );
    expect(result.outcome).toBe('disabled');
    expect(api.calls).toHaveLength(0);
    expect(await db.sql('select 1 from issue_states')).toHaveLength(0);
  });

  it('labels.map 缺 needs-info → 只评论不打标并记 warn（R4：不发明标签）', async () => {
    const api = createFakeWriteApi();
    const noNeedsInfo = parseRepoConfig({
      version: 1,
      labels: { map: { bug: 'bug' } },
      compliance: { rules: [{ id: 'repro-steps' }] },
    });
    const result = await applyCompliance(
      { db: sql, github: api, now: () => T0 },
      { repo: REPO, issueNumber: ISSUE, config: noNeedsInfo, verdict: verdict(['repro-steps']), currentLabels: [], botLabels: [] },
    );
    expect(result.outcome).toBe('nudged');
    expect(result.warnings.join('\n')).toContain('needs-info');
    expect(api.calls.filter((call) => call.method === 'addLabels')).toHaveLength(0);
    expect(api.calls.filter((call) => call.method === 'createIssueComment')).toHaveLength(1);
  });
});