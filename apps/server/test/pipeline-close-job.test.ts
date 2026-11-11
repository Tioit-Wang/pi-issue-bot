/**
 * `pipeline-close` 定时作业（§9 / D5 / V12）。
 *
 * 真库 + 假 `closeIssue`：断言**扫到谁、关了谁、谁是反例**。
 * 两个反例是这一组的主角（写错了不会有任何报错，只会悄悄关错 issue）：
 *  - `classify/awaiting_info`（等管理员，`info_requested_at IS NULL`）**绝不能被扫到**；
 *  - 阈值必须来自注入（`closeAfterHours: 0.01` = 36 秒），不是写死的 48 小时。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPipelineLimits } from '../src/config/pipeline-constants.ts';
import { pipelineClose, PIPELINE_CLOSE_SCAN_SQL } from '../src/jobs/index.ts';
import type { PipelineCloseApi } from '../src/jobs/index.ts';
import { loadPipeline } from '../src/workflows/pipeline.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'test/pipeline-close';

let db: TestDb;

type CloseCall = { readonly issueNumber: number; readonly reason?: string };

function createFakeClose(options: { readonly failOn?: number } = {}): {
  readonly closeIssue: PipelineCloseApi;
  readonly calls: CloseCall[];
} {
  const calls: CloseCall[] = [];
  return {
    calls,
    closeIssue: async (input) => {
      if (options.failOn === input.issueNumber) {
        throw new Error('403 Resource not accessible by integration');
      }
      calls.push({ issueNumber: input.issueNumber, ...(input.reason === undefined ? {} : { reason: input.reason }) });
    },
  };
}

/** 插一行 `issue_pipeline`（`infoRequestedAt` 用 SQL 表达式，便于写「2 分钟前」）。 */
async function seedRow(input: {
  readonly issueNumber: number;
  readonly stage: 'format' | 'classify' | 'agent' | 'closed';
  readonly state: 'pending' | 'awaiting_info' | 'ready' | 'blocked' | 'closed';
  /** SQL 表达式，例如 `now() - interval '2 minutes'`；`null` = 不写（等管理员那条）。 */
  readonly infoRequestedAt: string | null;
}): Promise<void> {
  await db.sql(
    `insert into issue_pipeline (repo, issue_number, stage, state, info_requested_at)
     values ($1, $2, $3, $4, ${input.infoRequestedAt === null ? 'null' : input.infoRequestedAt})`,
    [REPO, input.issueNumber, input.stage, input.state],
  );
}

const rowOf = async (issueNumber: number) =>
  loadPipeline(db.pool, { repo: REPO, issueNumber });

beforeAll(async () => {
  db = await openTestDb();
});

afterAll(async () => {
  await db.sql('delete from issue_pipeline where repo = $1', [REPO]);
  await db.close();
});

beforeEach(async () => {
  await db.sql('delete from issue_pipeline where repo = $1', [REPO]);
  // 扫描 SQL 是**全局**的（作业不按仓库分组），所以别的夹具行下来的「已超时 awaiting_info」
  // 也会被扫到。这里先清掉这些行（它们本来就是要被关的），让 stats 的数字只反映本文件的种子。
  await db.sql(
    "delete from issue_pipeline where state = 'awaiting_info' and info_requested_at is not null",
  );
});

describe('扫描口径（V12 反例）', () => {
  it('扫描 SQL 自己就写死了「只扫等用户的 awaiting_info」', () => {
    expect(PIPELINE_CLOSE_SCAN_SQL).toContain(`"state" = 'awaiting_info'`);
    expect(PIPELINE_CLOSE_SCAN_SQL).toContain(`"info_requested_at" IS NOT NULL`);
    expect(PIPELINE_CLOSE_SCAN_SQL).toContain(`"info_requested_at" < now()`);
  });
});

describe('到点关 issue（注入 closeAfterHours=0.01h）', () => {
  it('format/awaiting_info 超时：关一次 + 状态落 closed + closed_at 有值', async () => {
    await seedRow({
      issueNumber: 101,
      stage: 'format',
      state: 'awaiting_info',
      infoRequestedAt: `now() - interval '2 minutes'`,
    });
    const api = createFakeClose();

    const result = await pipelineClose({
      pool: db.pool,
      closeIssue: api.closeIssue,
      limits: createPipelineLimits({ closeAfterHours: 0.01 }),
    });

    expect(result.stats).toMatchObject({ scanned: 1, closed: 1, failed: 0 });
    expect(api.calls).toEqual([{ issueNumber: 101, reason: 'not_planned' }]);
    const row = await rowOf(101);
    expect(row).toMatchObject({ stage: 'closed', state: 'closed' });
    expect(row?.closedAt).not.toBeNull();
  });

  it('反例一：classify/awaiting_info（等管理员，info_requested_at 为 NULL）不动', async () => {
    await seedRow({ issueNumber: 102, stage: 'classify', state: 'awaiting_info', infoRequestedAt: null });
    const api = createFakeClose();

    const result = await pipelineClose({
      pool: db.pool,
      closeIssue: api.closeIssue,
      limits: createPipelineLimits({ closeAfterHours: 0.01 }),
    });

    expect(result.stats.scanned).toBe(0);
    expect(api.calls).toEqual([]);
    expect(await rowOf(102)).toMatchObject({ stage: 'classify', state: 'awaiting_info' });
  });

  it('反例二：没到阈值（36 秒 vs 10 秒前）不动', async () => {
    await seedRow({
      issueNumber: 103,
      stage: 'format',
      state: 'awaiting_info',
      infoRequestedAt: `now() - interval '10 seconds'`,
    });
    const api = createFakeClose();

    const result = await pipelineClose({
      pool: db.pool,
      closeIssue: api.closeIssue,
      limits: createPipelineLimits({ closeAfterHours: 0.01 }),
    });

    expect(result.stats.scanned).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it('第二轮不重复关（同一条只关一次）', async () => {
    await seedRow({
      issueNumber: 104,
      stage: 'format',
      state: 'awaiting_info',
      infoRequestedAt: `now() - interval '2 minutes'`,
    });
    const api = createFakeClose();
    const limits = createPipelineLimits({ closeAfterHours: 0.01 });

    const first = await pipelineClose({ pool: db.pool, closeIssue: api.closeIssue, limits });
    const second = await pipelineClose({ pool: db.pool, closeIssue: api.closeIssue, limits });

    expect(first.stats.closed).toBe(1);
    // 第二轮：状态已是 closed，SQL 根本扫不到
    expect(second.stats.scanned).toBe(0);
    expect(api.calls).toHaveLength(1);
  });

  it('单条失败不中断整批：其余照关，失败进 warning', async () => {
    await seedRow({
      issueNumber: 105,
      stage: 'format',
      state: 'awaiting_info',
      infoRequestedAt: `now() - interval '2 minutes'`,
    });
    await seedRow({
      issueNumber: 106,
      stage: 'format',
      state: 'awaiting_info',
      infoRequestedAt: `now() - interval '3 minutes'`,
    });
    const api = createFakeClose({ failOn: 105 });

    const result = await pipelineClose({
      pool: db.pool,
      closeIssue: api.closeIssue,
      limits: createPipelineLimits({ closeAfterHours: 0.01 }),
    });

    expect(result.stats).toMatchObject({ scanned: 2, closed: 1, failed: 1 });
    expect(result.ok).toBe(false);
    expect(result.warnings.join('|')).toContain('105');
    expect(api.calls).toEqual([{ issueNumber: 106, reason: 'not_planned' }]);
    // 失败的那条留在原地（下一轮重试）
    expect(await rowOf(105)).toMatchObject({ stage: 'format', state: 'awaiting_info' });
  });

  it('缺 closeIssue 注入：不抛，返回 happened 的 warning', async () => {
    const result = await pipelineClose({ pool: db.pool });
    expect(result.stats.closed).toBe(0);
    expect(result.warnings.join('|')).toContain('closeIssue');
  });
});
