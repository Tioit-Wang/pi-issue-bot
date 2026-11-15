/**
 * WP6 · 记录完整性（FR-6.1 / FR-6.2 / FR-6.3 / NFR-6）的读路径断言。
 *
 * 需求原文（`docs/requirements.html`）：
 *  - `:1193` FR-6.1「会话内每一轮的用户输入、助手输出、工具调用与结果，全部按顺序落库」
 *    + 来源要求「必须由执行侧生成，不能依赖 agent 在回答里自述」
 *  - `:1199` FR-6.2「每次工具调用记录：工具名、入参、返回摘要、耗时、成功与否。命令类还要
 *    记录 argv、退出码」
 *  - `:1204` FR-6.3「按轮次记录 prompt token 与 completion token，并折算成本。可汇总到
 *    issue、仓库、时间维度」
 *  - `:1837` 可追溯「任一 issue 的处理过程可回放」/「对话 + 工具 + 用量三线齐全」（NFR-6）
 *
 * 本文件钉三件事，都断言**具体值**而不是「不抛异常」：
 *  1. 一个 issue 能**一次**查到整条链（投递 → 判定 → 执行 → 写回）；
 *  2. 失败 / 超时 / 取消都有可查记录，且 `outcome` 取值域两个拼写都认
 *     （写入侧 `succeeded`/`cancelled` 与契约 `success`/`interrupted`）；
 *  3. `toolCalls` 的耗时 / 入参 / argv / 退出码与 `usage` 的按轮次 token 全部到位。
 *
 * 用真 PostgreSQL（`helpers/queries-db.ts` 建库 + advisory lock）。种子**在本文件内自建**：
 * 共享的 `seedStandard` 写的是 `outcome='success'` 且没有 run_events 工具事件，
 * 改它会影响其它三个文件的断言。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueTraceResponseSchema } from '../../../packages/contract/src/index.ts';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { buildServer, createAllowAllAuth } from '../src/http/index.ts';
import type { ZodFastify } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/** 测试时钟（`generatedAt` 相对它）。 */
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const REPO = 'acme/widgets';
const ISSUE = 42;

let db: TestDb;
let app: ZodFastify;

/**
 * 种子：`acme/widgets#42` 的一条完整链。
 *
 * - 投递：`w-1` 触发（`decision=triggered`）、`w-2` 被闸门拦下（`ignored` + `not-mentioned`）、
 *   `w-3` 验签失败（`ignored` + `signature-invalid`）。三条都指 #42。
 * - 任务：`t-1`（`/review-pr`，command 通道），2 次 attempt（第一次超时、第二次成功）。
 * - run：`r-1` outcome=`timed-out`、`r-2` outcome=`succeeded`（**写入侧拼写**，验证映射）
 *   且带工具事件（Bash 报 argv + 退出码、Read 都没报）。
 * - 用量：两次 run 各一行，金额可手算。
 * - 写回：`r-2` 一行 comment（`applied`）+ 一行契约外 intent（必须被挡住）。
 */
async function seedTrace(): Promise<void> {
  await db.pool.query(`
    insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid, source)
    values ('${REPO}', true, false, '{"version":1}'::jsonb, true, 'manual')
  `);

  await db.pool.query(`
    insert into webhook_deliveries
      (delivery_id, event, action, repo, payload, signature_valid, decision, decision_reason, received_at)
    values
      ('w-1', 'issues', 'opened', '${REPO}',
       '{"repository":{"full_name":"${REPO}"},"issue":{"number":${ISSUE}}}'::jsonb,
       true, 'triggered', 'enabled', '2026-06-01T01:00:00Z'),
      ('w-2', 'issue_comment', 'created', '${REPO}',
       '{"repository":{"full_name":"${REPO}"},"issue":{"number":${ISSUE}}}'::jsonb,
       true, 'ignored', 'not-mentioned', '2026-06-01T01:05:00Z'),
      ('w-3', 'issues', 'edited', '${REPO}',
       '{"repository":{"full_name":"${REPO}"},"issue":{"number":${ISSUE}}}'::jsonb,
       false, 'ignored', 'signature-invalid', '2026-06-01T01:10:00Z'),
      ('w-other-issue', 'issues', 'opened', '${REPO}',
       '{"repository":{"full_name":"${REPO}"},"issue":{"number":7}}'::jsonb,
       true, 'ignored', 'switch-off', '2026-06-01T01:20:00Z'),
      ('w-other-repo', 'issues', 'opened', 'other/lib',
       '{"repository":{"full_name":"other/lib"},"issue":{"number":${ISSUE}}}'::jsonb,
       true, 'ignored', 'repo-disabled', '2026-06-01T01:30:00Z')
  `);

  await db.pool.query(`
    insert into tasks
      (id, source, repo, target_kind, target_number, command, actor_login, queued_at,
       idempotency_key, status, attempt, delivery_id, created_at, updated_at, ended_at)
    values
      ('t-1', 'command', '${REPO}', 'issue', ${ISSUE}, '/review-pr', 'alice',
       '2026-06-01T01:00:00Z', 'k-t1', 'succeeded', 2, 'w-1',
       '2026-06-01T01:00:00Z', '2026-06-01T01:10:00Z', '2026-06-01T01:10:00Z')
  `);

  await db.pool.query(`
    insert into runs
      (id, task_id, attempt, session_id, turn_id, started_at, ended_at, outcome, failure_class, created_at)
    values
      ('r-1', 't-1', 1, 's-1', 'u-1', '2026-06-01T01:00:10Z', '2026-06-01T01:05:10Z', 'timed-out', 'timeout', '2026-06-01T01:00:10Z'),
      ('r-2', 't-1', 2, 's-1', 'u-2', '2026-06-01T01:06:00Z', '2026-06-01T01:09:00Z', 'succeeded',  null,     '2026-06-01T01:06:00Z')
  `);

  await db.pool.query(`
    insert into usage_costs (run_id, model, input_tokens, output_tokens, cost_usd, created_at)
    values
      ('r-1', 'anthropic/claude-x', 1000, 200, 0.010000, '2026-06-01T01:05:10Z'),
      ('r-2', 'anthropic/claude-x', 3000, 800, 0.030000, '2026-06-01T01:09:00Z')
  `);

  await db.pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    values
      ('r-2', 1, 'item.started',
       '{"event":{"type":"tool_start","toolName":"Bash","toolCallId":"call_bash","args":{"command":"npm test","argv":["npm","test","--","--runInBand"]}},"itemId":"call_bash","itemType":"tool"}'::jsonb,
       '2026-06-01T01:06:30Z'),
      ('r-2', 2, 'tool.progress',
       '{"event":{"type":"tool_update","toolCallId":"call_bash","partialResult":{"content":[{"type":"text","text":"Tests: 12 passed"}]}},"itemId":"call_bash","itemType":"tool"}'::jsonb,
       '2026-06-01T01:07:00Z'),
      ('r-2', 3, 'item.completed',
       '{"event":{"type":"tool_end","toolCallId":"call_bash","exitCode":0},"itemId":"call_bash","itemType":"tool"}'::jsonb,
       '2026-06-01T01:07:30Z'),
      ('r-2', 4, 'item.started',
       '{"event":{"type":"tool_start","toolName":"Read","toolCallId":"call_read","args":{"path":"src/a.ts"}},"itemId":"call_read","itemType":"tool"}'::jsonb,
       '2026-06-01T01:07:40Z'),
      ('r-2', 5, 'item.completed',
       '{"event":{"type":"tool_end","toolCallId":"call_read"},"itemId":"call_read","itemType":"tool"}'::jsonb,
       '2026-06-01T01:08:00Z'),
      ('r-2', 6, 'item.completed',
       '{"event":{"type":"message_end","message":{"role":"assistant","content":"结论：容器只读挂载导致的。"}},"itemId":"msg-1","itemType":"message"}'::jsonb,
       '2026-06-01T01:08:50Z'),
      ('r-2', 7, 'item.delta',
       '{"event":{"type":"text_delta","text":"流式增量"},"itemId":"text-1","itemType":"text"}'::jsonb,
       '2026-06-01T01:08:55Z')
  `);

  await db.pool.query(`
    insert into actions (id, run_id, intent, target, external_ref, applied_at, audit, created_at)
    values
      (1, 'r-2', 'comment', '${REPO}#${ISSUE}', '9001', '2026-06-01T01:09:00Z',
       '{"status":"applied"}'::jsonb, '2026-06-01T01:09:00Z'),
      (2, 'r-2', 'open_pr', '${REPO}#${ISSUE}', null, '2026-06-01T01:09:10Z', null, '2026-06-01T01:09:10Z')
  `);
}

beforeAll(async () => {
  db = await openTestDb(FIXED_NOW);
  app = buildServer({
    logger: createNullLogger(),
    pool: db.pool,
    queries: db.queries,
    requireAuth: createAllowAllAuth('tester'),
    webhook: {
      verify: async () => true,
      db: db.pool,
      enqueue: async () => null,
      ack: { addEyesReaction: async () => undefined },
      logger: createNullLogger(),
      now: () => FIXED_NOW,
    },
    appVersion: 'test',
    now: () => FIXED_NOW,
  });
});

afterAll(async () => {
  await app.close();
  await db.truncate();
  await db.close();
});

beforeEach(async () => {
  await db.truncate();
  await seedTrace();
});

const PARAMS = { owner: 'acme', name: 'widgets', kind: 'issue', number: ISSUE } as const;

describe('queries/issueTrace（真库）· 一条链一次查全', () => {
  it('★ 投递 → 判定 → 执行 → 写回：一次请求拿全，且响应过契约 parse', async () => {
    const trace = await db.queries.issueTrace(PARAMS);
    expect(() => issueTraceResponseSchema.parse(trace)).not.toThrow();

    expect(trace.issue).toEqual({ repo: REPO, kind: 'issue', number: ISSUE });
    expect(trace.generatedAt).toBe(FIXED_NOW.toISOString());

    // ① 投递 + 判定：三条（含未触发与验签失败），`receivedAt` 倒序
    expect(trace.deliveries.map((row) => row.deliveryId)).toEqual(['w-3', 'w-2', 'w-1']);
    // 别的 issue / 别的仓库的投递不许串进来（查不到 ≠ 查不了）
    expect(trace.deliveries.some((row) => row.deliveryId === 'w-other-issue')).toBe(false);
    expect(trace.deliveries.some((row) => row.deliveryId === 'w-other-repo')).toBe(false);

    // 被拦下的那条也能看到原因（FR-6.4③「被忽略的事件也能看到原因」）
    const ignored = trace.deliveries.find((row) => row.deliveryId === 'w-2');
    expect(ignored).toMatchObject({ decision: 'ignored', decisionReason: 'not-mentioned' });
    // 验签失败也留痕（连同原因）
    const badSignature = trace.deliveries.find((row) => row.deliveryId === 'w-3');
    expect(badSignature).toMatchObject({
      decision: 'ignored',
      decisionReason: 'signature-invalid',
      signatureValid: false,
    });

    // ② 执行：两次 attempt，按时间正序
    expect(trace.runs.map((run) => run.runId)).toEqual(['r-1', 'r-2']);
    expect(trace.runs.map((run) => run.attempt)).toEqual([1, 2]);
    expect(trace.runs.every((run) => run.command === '/review-pr')).toBe(true);

    // ③ 写回：挂在该 run 上（契约外 intent `open_pr` 被挡在外面，否则整页 parse 失败）
    expect(trace.runs[1]?.actions.map((action) => action.intent)).toEqual(['comment']);
    expect(trace.runs[1]?.actions[0]).toMatchObject({
      intent: 'comment',
      status: 'applied',
      externalRef: '9001',
      appliedAt: '2026-06-01T01:09:00.000Z',
    });
    expect(trace.runs[1]?.actions[0]?.target).toMatchObject({ kind: 'comment', number: ISSUE });
    // 第一次 attempt 什么都没写回
    expect(trace.runs[0]?.actions).toEqual([]);
  });

  it('★ 失败与超时都有可查记录：outcome 两个拼写都认（写入侧 succeeded/cancelled ↔ 契约 success/interrupted）', async () => {
    const [timedOut, succeeded] = (await db.queries.issueTrace(PARAMS)).runs;
    expect(timedOut?.outcome).toBe('timed-out');
    expect(timedOut?.failureClass).toBe('timeout');
    expect(timedOut?.durationMs).toBe(300_000);
    // 库里写的是 worker 的 `RUN_OUTCOMES` 拼写（`succeeded`），契约枚举是 `success`
    expect(succeeded?.outcome).toBe('success');
    expect(succeeded?.failureClass).toBeNull();

    // 取消：worker 写 'cancelled'，契约里对应的是 'interrupted'
    await db.pool.query(`update runs set outcome = 'cancelled', failure_class = 'interrupt' where id = 'r-2'`);
    const cancelled = (await db.queries.issueTrace(PARAMS)).runs[1];
    expect(cancelled?.outcome).toBe('interrupted');
    expect(cancelled?.failureClass).toBe('interrupt');

    // 收尾没跑完（进程被杀）：行已插入、outcome 仍为空 → 可查且是 null（不是「没这行」）
    await db.pool.query(
      `update runs set outcome = null, ended_at = null, started_at = '2026-06-01T01:06:00Z' where id = 'r-2'`,
    );
    const unfinished = (await db.queries.issueTrace(PARAMS)).runs[1];
    expect(unfinished?.outcome).toBeNull();
    expect(unfinished?.endedAt).toBeNull();
    expect(unfinished?.durationMs).toBeNull();
  });

  it('★ FR-6.2 工具调用：名 / 入参 / 返回摘要 / 耗时 / 成功与否 / argv / 退出码', async () => {
    const run = (await db.queries.issueTrace(PARAMS)).runs[1];
    expect(run?.toolCallsTruncated).toBe(false);
    expect(run?.toolCalls.map((call) => call.toolCallId)).toEqual(['call_bash', 'call_read']);

    expect(run?.toolCalls[0]).toEqual({
      toolCallId: 'call_bash',
      name: 'Bash',
      // 入参是原样 jsonb（不是 160 字单行摘要）
      args: { command: 'npm test', argv: ['npm', 'test', '--', '--runInBand'] },
      outputSummary: 'Tests: 12 passed',
      startedAt: '2026-06-01T01:06:30.000Z',
      endedAt: '2026-06-01T01:07:30.000Z',
      // 耗时 = 同一 toolCallId 的 max - min（60s）
      durationMs: 60_000,
      ok: true,
      exitCode: 0,
      argv: ['npm', 'test', '--', '--runInBand'],
    });

    // 没报 argv / 退出码 / 输出的工具：字段是 null，不猜
    expect(run?.toolCalls[1]).toMatchObject({
      name: 'Read',
      args: { path: 'src/a.ts' },
      outputSummary: null,
      durationMs: 20_000,
      ok: true,
      exitCode: null,
      argv: null,
    });

    // 失败的工具：item.completed 带 error → ok=false（不是「没有错误字段」就算成功）
    await db.pool.query(
      `update run_events
          set payload = '{"event":{"type":"tool_end","toolCallId":"call_read","error":{"message":"EACCES"}},"itemId":"call_read","itemType":"tool"}'::jsonb
        where run_id = 'r-2' and kind = 'item.completed' and payload ->> 'itemId' = 'call_read'`,
    );
    const failed = (await db.queries.issueTrace(PARAMS)).runs[1];
    expect(failed?.toolCalls[1]?.ok).toBe(false);
  });

  it('★ FR-6.3 用量：按轮次（run）+ issue 维度合计', async () => {
    const trace = await db.queries.issueTrace(PARAMS);
    // 第一次超时也有用量（不能只记成功那轮）
    expect(trace.runs[0]?.usage).toEqual({
      model: 'anthropic/claude-x',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.01,
    });
    expect(trace.runs[1]?.usage).toEqual({
      model: 'anthropic/claude-x',
      inputTokens: 3000,
      outputTokens: 800,
      costUsd: 0.03,
    });
    // issue 维度合计（FR-6.3「可汇总到 issue」）
    expect(trace.totals).toEqual({ runs: 2, inputTokens: 4000, outputTokens: 1000, costUsd: 0.04 });

    // 没有记账行的 run：usage 为 null（「没记账」≠「记账为 0」）
    await db.pool.query(`delete from usage_costs where run_id = 'r-1'`);
    const withoutUsage = await db.queries.issueTrace(PARAMS);
    expect(withoutUsage.runs[0]?.usage).toBeNull();
    expect(withoutUsage.totals).toEqual({ runs: 2, inputTokens: 3000, outputTokens: 800, costUsd: 0.03 });
  });

  it('★ FR-6.1 助手输出取自执行侧事件流（不是信封里 agent 的自述）', async () => {
    const run = (await db.queries.issueTrace(PARAMS)).runs[1];
    expect(run?.assistantText).toBe('结论：容器只读挂载导致的。');
    // 第一次 attempt 没有 message 条目 → null（不是空串）
    expect((await db.queries.issueTrace(PARAMS)).runs[0]?.assistantText).toBeNull();

    // 对照：即使信封里写了别的正文，事件流优先
    await db.pool.query(`
      insert into envelopes (run_id, verdict, actions, usage, valid, errors, created_at)
      values ('r-2', null, '[{"intent":"comment","body":"信封自述的正文"}]'::jsonb, null, true, null, '2026-06-01T01:09:00Z')
    `);
    expect((await db.queries.issueTrace(PARAMS)).runs[1]?.assistantText).toBe('结论：容器只读挂载导致的。');
  });

  it('这个 issue 从没被处理过：空数组 + totals 全 0（不返回 null、也不是 404）', async () => {
    const trace = await db.queries.issueTrace({ owner: 'acme', name: 'widgets', kind: 'issue', number: 999 });
    expect(() => issueTraceResponseSchema.parse(trace)).not.toThrow();
    expect(trace.deliveries).toEqual([]);
    expect(trace.runs).toEqual([]);
    expect(trace.totals).toEqual({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('只有投递、还没入队：投递查得到，runs 为空（「查不到 ≠ 查不了」）', async () => {
    await db.pool.query(`delete from tasks where repo = '${REPO}' and target_number = ${ISSUE}`);
    const trace = await db.queries.issueTrace(PARAMS);
    expect(trace.deliveries.map((row) => row.deliveryId)).toEqual(['w-3', 'w-2', 'w-1']);
    expect(trace.runs).toEqual([]);
  });
});

describe('GET /api/issues/:owner/:name/:kind/:number/trace', () => {
  it('★ 200 + 契约 parse + no-store，响应体就是整条链', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/issues/acme/widgets/issue/${String(ISSUE)}/trace`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = issueTraceResponseSchema.parse(response.json());
    expect(body.deliveries).toHaveLength(3);
    expect(body.runs.map((run) => run.runId)).toEqual(['r-1', 'r-2']);
    expect(body.runs[0]?.outcome).toBe('timed-out');
    expect(body.runs[1]?.outcome).toBe('success');
    expect(body.totals).toEqual({ runs: 2, inputTokens: 4000, outputTokens: 1000, costUsd: 0.04 });
  });

  it('未知 issue：200 空链（不 404——投递可能仍在）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/issues/acme/widgets/issue/999/trace',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deliveries: [], runs: [] });
  });

  it('路径参数非法：kind 枚举外 / number 非正整数 → 400 bad-request', async () => {
    const badKind = await app.inject({
      method: 'GET',
      url: '/api/issues/acme/widgets/bogus/42/trace',
    });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json()).toMatchObject({ error: { code: 'bad-request' } });

    const badNumber = await app.inject({
      method: 'GET',
      url: '/api/issues/acme/widgets/issue/0/trace',
    });
    expect(badNumber.statusCode).toBe(400);
  });
});

/**
 * `sqlOutcome()` 的取值域：写入侧（worker 的 `RUN_OUTCOMES`）与契约（`OUTCOMES`）**两个拼写都要认**。
 *
 * 这条单独钉在三个既有只读接口上（overview / tasks / taskDetail），因为那个映射是
 * `queries/sql.ts` 里唯一的实现，被三个接口共用——只在新加的 trace 端点上测不够：
 * 真实库写 `succeeded`，若映射只认 `success`，`/api/overview` 的结果分布会静默少掉成功那一档。
 */
describe('sqlOutcome 取值域（写入侧 succeeded/cancelled ↔ 契约 success/interrupted）', () => {
  it('★ /api/overview：库里的 succeeded / cancelled 分别计入 success / interrupted 两档', async () => {
    await db.pool.query(
      `update runs set outcome = 'cancelled', failure_class = 'interrupt' where id = 'r-1'`,
    );
    // r-2 保持 'succeeded'，r-1 变成 'cancelled'：两档都必须出现在结果分布里
    const response = await db.queries.overview({});
    expect(response.outcomeDistribution).toEqual([
      { outcome: 'interrupted', count: 1 },
      { outcome: 'success', count: 1 },
    ]);
  });

  it('★ /api/tasks 与 /api/tasks/:id：outcome 映射到契约取值（不是 null）', async () => {
    const list = await db.queries.tasks({ limit: 50 });
    expect(list.items.map((item) => `${item.id}:${String(item.outcome)}`)).toEqual(['t-1:success']);

    const detail = await db.queries.taskDetail('t-1');
    expect(detail?.runs.map((run) => run.outcome)).toEqual(['timed-out', 'success']);
  });
});
