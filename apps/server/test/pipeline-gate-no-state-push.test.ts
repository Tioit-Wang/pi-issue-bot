/**
 * 回归（P0-1）：**门禁回执只产评论、绝不推状态**（`docs/plan-fixed-pipeline.md` §8 / §12 V8）。
 *
 * 缺陷形状：`handleWebhook()` 第 5.5 步 ⓒ 把被拦的 `@` 改写成 `pipeline:notice` 之后**没有 return**，
 * 于是这个 `source='pipeline'` 的 plan 继续流进 ⓓ，用 `action='created'` 调
 * `pipelineTransitionFor()` → `decideTransition({kind:'issue-opened'})`，把
 * `format/awaiting_info` / `classify/awaiting_info` / `blocked` 全部改写成 `format/pending`
 * （`blocked_reason` 被清空、`issue_version` 被写成回执桶）。
 * 必现症状：issue 永久卡在 `format/pending`，而门禁从此只会打 eyes。
 *
 * 这里逐字段比对「回执前后」的 `issue_pipeline` 行：除 `gate_notice_at`（限速要用）与
 * `updated_at` 外**一个字段都不许变**，且只产生 1 条 `pipeline:notice` 任务、0 条命令任务。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { handleWebhook } from '../src/http/index.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/index.ts';
import { loadPipeline } from '../src/workflows/pipeline.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-01T12:00:00.000Z');

/** 合法配置：`pipeline.managers` 非空 + 词表带 role（否则 `readRepoPolicy` 判 settings 非法）。 */
const VALID_SETTINGS = {
  version: 1,
  pipeline: { managers: ['alice'] },
  labels: { vocabulary: [{ name: '需求', role: 'requirement' }] },
  commands: { enabled: true, allowed: ['/review-pr'], author_associations: ['OWNER', 'MEMBER'] },
};

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(NOW);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table tasks, webhook_deliveries, repos, runtime_flags, issue_pipeline cascade');
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, JSON.stringify(VALID_SETTINGS)],
  );
});

function commentPayload(commentId: number): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: 7,
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
  };
}

type Harness = {
  readonly deps: WebhookDeps;
  readonly sends: Array<Record<string, unknown>>;
  readonly eyes: Array<Record<string, unknown>>;
};

function harness(): Harness {
  const sends: Array<Record<string, unknown>> = [];
  const eyes: Array<Record<string, unknown>> = [];
  const ack: WebhookAck = {
    addEyesReaction: async (input) => {
      eyes.push({ ...input });
    },
  };
  return {
    sends,
    eyes,
    deps: {
      verify: async () => true,
      db: db.pool,
      enqueue: async (data) => {
        sends.push({ ...data });
        return 'job-1';
      },
      ack,
      logger: createNullLogger(),
      now: () => NOW,
    },
  };
}

async function deliver(h: Harness, deliveryId: string) {
  return handleWebhook(h.deps, {
    deliveryId,
    event: 'issue_comment',
    rawBody: JSON.stringify(commentPayload(555)),
    signature: 'good-signature',
    source: 'live',
  });
}

/** 回执前后要比对的全部列（`gate_notice_at` 是限速用的，本来就会写；`updated_at` 同）。 */
const COMPARED_COLUMNS = [
  'stage',
  'state',
  'category',
  'format_attempts',
  'format_fail_count',
  'classify_attempts',
  'issue_version',
  'info_requested_at',
  'last_recheck_at',
  'mention_sent_at',
  'mention_category',
  'session_id',
  'session_cursor',
  'session_turns',
  'session_started_at',
  'stale_at',
  'blocked_reason',
  'ready_at',
  'closed_at',
] as const;

async function snapshotRow(): Promise<Record<string, unknown>> {
  const rows = await db.sql(
    `select ${COMPARED_COLUMNS.join(', ')} from issue_pipeline where repo = $1 and issue_number = 7`,
    [REPO],
  );
  expect(rows).toHaveLength(1);
  return rows[0] ?? {};
}

/** 三种「被拦」状态各自带一份脏数据：任何一个字段被状态机改写都会被抓到。 */
const CASES = [
  {
    name: 'format/awaiting_info',
    insert: `stage, state, issue_version, info_requested_at, format_attempts, format_fail_count, blocked_reason
      ) values ($1, 7, 'format', 'awaiting_info', 'v1', now(), 2, 2, null`,
  },
  {
    name: 'classify/awaiting_info',
    insert: `stage, state, issue_version, info_requested_at, classify_attempts, category, blocked_reason
      ) values ($1, 7, 'classify', 'awaiting_info', 'v2', null, 1, 'not-found', null`,
  },
  {
    name: 'blocked',
    insert: `stage, state, issue_version, info_requested_at, classify_attempts, blocked_reason
      ) values ($1, 7, 'classify', 'blocked', 'v3', null, 3, '阶段 1 运行失败（outcome=failed）（连续 2 次）'`,
  },
] as const;

describe('门禁回执不推状态（P0-1）', () => {
  for (const item of CASES) {
    it(`${item.name} 下收到 @命令：行逐字段不变、只产 1 条 pipeline:notice`, async () => {
      await db.sql(
        `insert into issue_pipeline (repo, issue_number, ${item.insert})`,
        [REPO],
      );
      const before = await snapshotRow();

      const h = harness();
      const result = await deliver(h, `d-gate-${item.name}`);

      // 任务：恰好 1 条 notice，0 条命令任务
      const tasks = await db.sql('select command, source from tasks');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ command: 'pipeline:notice', source: 'pipeline' });
      expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:notice']);
      expect(result.body).toMatchObject({ action: 'enqueued' });
      // 回执可以省，回应不能省
      expect(h.eyes).toHaveLength(1);

      // ★ 状态行逐字段不变
      const after = await snapshotRow();
      expect(after).toEqual(before);

      // 限速戳写上了（§8：每 issue 每小时 1 条）
      const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
      expect(row?.gateNoticeAt?.toISOString()).toBe(NOW.toISOString());
      // 回执桶不是 issue 版本（这一列只存裸 issueVersion，见 P2-2）
      expect(row?.issueVersion).not.toContain('notice:');
    });
  }

  it('回执之后的第二条 @ 仍然只打 eyes：状态没被回执推回 pending', async () => {
    await db.sql(
      `insert into issue_pipeline (repo, issue_number, stage, state, issue_version, blocked_reason)
       values ($1, 7, 'classify', 'blocked', 'v3', '连续 2 次失败')`,
      [REPO],
    );
    const h = harness();
    await deliver(h, 'd-gate-twice-1');
    // 第二条：限速生效 → 只 eyes，零任务；关键是行仍是 blocked（不是 format/pending）
    await deliver(h, 'd-gate-twice-2');

    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'classify', state: 'blocked', issueVersion: 'v3' });
    expect(row?.blockedReason).toBe('连续 2 次失败');
    expect(h.eyes).toHaveLength(2);
    expect(h.sends).toHaveLength(1);
  });
});
