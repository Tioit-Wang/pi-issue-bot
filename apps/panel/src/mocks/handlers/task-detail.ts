import { http, HttpResponse, type HttpHandler } from 'msw';
import type { TaskDetailResponse, TaskListItem } from '../../lib/contract.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 任务详情（S3）的拦截器 —— W3-K 只改这一个文件。
 *
 * 契约：`GET /api/tasks/:id`（`TaskDetailResponse`，docs/spec/contract-api.md §3）。
 *
 * 为什么不用 `fixtures.ts` 的 `taskDetailFixture()`：那份是 P0 的「能跑通」样本，
 * 覆盖不到详情页真正要表达的东西。这里按契约造一份**有故事的**数据：
 *
 *  - 两次 run，第一次 `timeout` 失败、第二次成功 → 头部 `failure_class` 与「执行尝试」有对照；
 *  - 事件里既有 `allow` 也有 `deny` 的审批判定（带 rule + reason）→ 时间线要能读出「为什么被拒」；
 *  - 两封信封：一封校验通过、一封 `valid: false`（`verdict: null`）→ 信封 Tab 的失败分支有内容；
 *  - 一个 `push_branch` 动作的闸门摘要里 `dropped` 非空（`config/secrets.env` 越界）→
 *    「diff 越界 / dropped 动作」必须被标出来，这是 F2 写回闸门在面板上的可见面；
 *  - diff 里有超长行与 `@@` 段 → 折行 / 横向滚动两种读法都能验证。
 *
 * 时间锚在请求时刻（往前推），相对时间展示才不是「5 个月前」。
 * `id === 'missing'` 按契约返回 404 `not-found`（页面据此显示「任务不存在」而不是空白）。
 */

const MINUTE_MS = 60_000;

const TASK_ID = 't-mock-1';
const HEAD_SHA = 'abcdef1234567';
const BASE_SHA = 'abcdef0000000';

const LONG_LINE = `const veryLongExpression = await runtime.execute({ command: '/review-pr', repo: 'acme/widgets', sha: '${HEAD_SHA}', timeoutMs: 1_800_000, sandbox: { image: 'pi-bot/sandbox:24.04', memoryMb: 2048, network: 'none' } }); // 这一行故意很长，用来验证 diff 的折行 / 横向滚动`;

function buildTask(id: string, now: number): TaskListItem {
  const queuedAt = now - 42 * MINUTE_MS;
  return {
    id,
    repo: 'acme/widgets',
    source: 'command',
    command: '/review-pr',
    targetKind: 'pr',
    targetNumber: 12,
    headSha: HEAD_SHA,
    status: 'succeeded',
    failureClass: null,
    outcome: 'success',
    actorLogin: 'dana',
    queuedAt: new Date(queuedAt).toISOString(),
    startedAt: new Date(queuedAt + 3_000).toISOString(),
    endedAt: new Date(queuedAt + 9 * MINUTE_MS).toISOString(),
    durationMs: 9 * MINUTE_MS - 3_000,
    costUsd: 0.0412,
    dryRun: false,
  };
}

/**
 * 分类任务（`command = pipeline:classify`）的样本：issue 详情页的**证据两栏**从这里取。
 *
 * 响应形状与通用样本一致，只把 command/source/target 与信封里的 `verdict.evidence` 换成
 * 分类真实的形态（§6）：`rule=code:<path>:<line>` 是「命中的代码位置」，
 * `rule=checked:<范围>` 是「已查范围」。没有这两类，一句「查不到」在面板上无法复核。
 */
export function buildClassifyTaskFixture(id: string, now: number = Date.now()): TaskDetailResponse {
  const queuedAt = now - 18 * MINUTE_MS;
  const at = (offsetMinutes: number): string => new Date(queuedAt + offsetMinutes * MINUTE_MS).toISOString();
  const runId = 'r-classify-1';

  return {
    task: {
      id,
      repo: 'acme/widgets',
      source: 'agent',
      command: 'agent:opened',
      targetKind: 'issue',
      targetNumber: 88,
      headSha: HEAD_SHA,
      status: 'succeeded',
      failureClass: null,
      outcome: 'success',
      actorLogin: null,
      queuedAt: at(0),
      startedAt: at(1),
      endedAt: at(16),
      durationMs: 15 * MINUTE_MS,
      costUsd: 0.0128,
      dryRun: false,
    },
    runs: [
      {
        id: runId,
        attempt: 0,
        sessionId: 'sess-classify-88',
        turnId: 'turn-classify-88',
        startedAt: at(1),
        endedAt: at(16),
        outcome: 'success',
        failureClass: null,
        failureDetail: null,
      },
    ],
    events: [
      { runId, cursor: 1, kind: 'session', at: at(1), payload: { phase: 'create', sessionId: 'sess-classify-88' } },
      { runId, cursor: 2, kind: 'command', at: at(2), payload: { command: 'pipeline:classify', target: 'issue#88' } },
      { runId, cursor: 3, kind: 'envelope', at: at(15), payload: { valid: true, actions: 2 } },
      { runId, cursor: 4, kind: 'action', at: at(16), payload: { intent: 'comment', status: 'applied' } },
    ],
    envelopes: [
      {
        runId,
        valid: true,
        verdict: {
          kind: 'issue',
          labels: [],
          evidence: [
            {
              rule: 'code:apps/server/src/search/ranking.ts:118',
              quote: 'export function scoreOf(doc: SearchDoc): number { return doc.boost * DEFAULT_BOOST; }',
              passed: null,
            },
            {
              rule: 'code:apps/server/src/search/ranking.ts:42',
              quote: '// 权重只有 boost 一个可调项，没有任何「降权 / 惩罚」分支',
              passed: true,
            },
            {
              rule: 'checked:apps/server/src/search/**',
              quote: '翻了 ranking / index / query 三个文件，没有按作者或关键词做惩罚的逻辑',
              passed: null,
            },
            { rule: 'checked:apps/panel/src/**', quote: '面板只渲染结果，不参与排序', passed: null },
          ],
        },
        actionCount: 2,
        usage: { inputTokens: 21_400, outputTokens: 1_320, costUsd: 0.0128 },
      },
    ],
    actions: [
      {
        id: '1',
        runId,
        intent: 'comment',
        status: 'applied',
        target: {
          kind: 'comment',
          number: 88,
          ref: null,
          url: 'https://github.com/acme/widgets/issues/88#issuecomment-880002',
        },
        externalRef: '880002',
        appliedAt: at(16),
        revertedAt: null,
        revertKind: null,
        audit: null,
        dryRun: false,
      },
      {
        id: '2',
        runId,
        intent: 'label',
        status: 'skipped',
        target: { kind: 'issue', number: 88, ref: null, url: null },
        externalRef: null,
        appliedAt: null,
        revertedAt: null,
        revertKind: null,
        // not-found 不打缺陷标签（§6）：被跳过的动作也要能看见原因
        audit: null,
        dryRun: false,
      },
    ],
    diff: { available: false, text: '', truncated: false, baseSha: null, headSha: HEAD_SHA },
  };
}

/** 详情页的完整样本（单一事实源，handler 与测试都从这里取）。 */
export function buildTaskDetailFixture(id: string = TASK_ID, now: number = Date.now()): TaskDetailResponse {
  const task = buildTask(id, now);
  const start = Date.parse(task.queuedAt);

  const at = (offsetMinutes: number): string => new Date(start + offsetMinutes * MINUTE_MS).toISOString();
  const runOne = 'r-mock-1';
  const runTwo = 'r-mock-2';

  const diffLines = [
    `diff --git a/src/summary.ts b/src/summary.ts`,
    `index ${BASE_SHA.slice(0, 7)}..${HEAD_SHA.slice(0, 7)} 100644`,
    '--- a/src/summary.ts',
    '+++ b/src/summary.ts',
    '@@ -1,6 +1,12 @@',
    " import { z } from 'zod';",
    " import type { PullRequest } from './types.ts';",
    '+import { renderSummary } from "./render.ts";',
    ' ',
    ' export function summarize(pull: PullRequest): string {',
    '-  return pull.title;',
    '+  const verdict = pull.labels.includes("needs-info") ? "needs-info" : "ok";',
    `+  ${LONG_LINE}`,
    '+  return renderSummary({ verdict, title: pull.title });',
    ' }',
    '@@ -20,3 +26,7 @@ export function labelNames(pull: PullRequest): string[] {',
    '   return pull.labels.map((label) => label.name);',
    ' }',
    '+',
    '+export const summarySchema = z.object({ verdict: z.string() });',
    '+export type Summary = z.infer<typeof summarySchema>;',
    '',
  ];

  return {
    task,
    runs: [
      {
        id: runOne,
        attempt: 0,
        sessionId: 'sess-mock-1',
        turnId: 'turn-mock-1',
        startedAt: at(1),
        endedAt: at(31),
        outcome: 'timed-out',
        failureClass: 'timeout',
        failureDetail: { phase: 'turn', turnMs: 30 * MINUTE_MS, budgetMs: 30 * MINUTE_MS },
      },
      {
        id: runTwo,
        attempt: 1,
        sessionId: 'sess-mock-2',
        turnId: 'turn-mock-2',
        startedAt: at(32),
        endedAt: at(41),
        outcome: 'success',
        failureClass: null,
        failureDetail: null,
      },
    ],
    events: [
      { runId: runOne, cursor: 1, kind: 'session', at: at(1), payload: { phase: 'create', sessionId: 'sess-mock-1' } },
      { runId: runOne, cursor: 2, kind: 'turn', at: at(2), payload: { phase: 'start', turnId: 'turn-mock-1' } },
      {
        runId: runOne,
        cursor: 3,
        kind: 'tool-call',
        at: at(4),
        payload: { tool: 'Bash', input: 'pnpm -r test' },
      },
      {
        runId: runOne,
        cursor: 4,
        kind: 'approval',
        at: at(5),
        payload: { tool: 'Bash', decision: 'allow', rule: 'allow-tests', reason: '命令命中 allow-tests（只读测试）' },
      },
      {
        runId: runOne,
        cursor: 5,
        kind: 'approval',
        at: at(6),
        payload: {
          tool: 'WebFetch',
          decision: 'deny',
          rule: 'deny-network',
          reason: '金丝雀网络未放行，任务内不允许出网',
        },
      },
      { runId: runOne, cursor: 6, kind: 'notice', at: at(30), payload: { level: 'warn', message: 'turn 超过 30 分钟预算，触发三层时间闸' } },
      { runId: runTwo, cursor: 7, kind: 'session', at: at(32), payload: { phase: 'create', sessionId: 'sess-mock-2' } },
      { runId: runTwo, cursor: 8, kind: 'command', at: at(33), payload: { command: '/review-pr', target: 'pr#12' } },
      { runId: runTwo, cursor: 9, kind: 'envelope', at: at(39), payload: { valid: true, actions: 3 } },
      { runId: runTwo, cursor: 10, kind: 'action', at: at(40), payload: { intent: 'comment', status: 'applied' } },
      { runId: runTwo, cursor: 11, kind: 'writeback', at: at(40), payload: { gate: 'outputs', declared: 2, actual: 3, dropped: 1 } },
    ],
    envelopes: [
      {
        runId: runTwo,
        valid: true,
        verdict: {
          kind: 'pr',
          labels: ['needs-info'],
          evidence: [
            { rule: 'missing-test', quote: '没有新增测试覆盖 summary 渲染分支', passed: false },
            { rule: 'readme-updated', quote: 'README 的用法段已同步', passed: true },
            { rule: 'scope', quote: '改动只落在 src/ 与 README', passed: null },
          ],
        },
        actionCount: 3,
        usage: { inputTokens: 12_430, outputTokens: 2_180, costUsd: 0.0412 },
      },
      {
        runId: runOne,
        valid: false,
        verdict: null,
        actionCount: 0,
        usage: { inputTokens: 1_800, outputTokens: 40, costUsd: 0.0004 },
      },
    ],
    actions: [
      {
        id: '1',
        runId: runTwo,
        intent: 'comment',
        status: 'applied',
        target: { kind: 'comment', number: 12, ref: null, url: 'https://github.com/acme/widgets/pull/12#issuecomment-9001' },
        externalRef: '9001',
        appliedAt: at(40),
        revertedAt: null,
        revertKind: null,
        audit: null,
        dryRun: false,
      },
      {
        id: '2',
        runId: runTwo,
        intent: 'push_branch',
        status: 'applied',
        target: { kind: 'branch', number: null, ref: 'pi-bot/task-t-mock-1', url: null },
        externalRef: null,
        appliedAt: at(40),
        revertedAt: null,
        revertKind: null,
        // 闸门摘要：声明 2 个文件，实际写了 3 个，`config/secrets.env` 越界被丢弃
        audit: {
          declared: ['src/summary.ts', 'src/render.ts'],
          actual: ['src/summary.ts', 'src/render.ts', 'config/secrets.env'],
          intersect: ['src/summary.ts', 'src/render.ts'],
          dropped: ['config/secrets.env'],
          rejectedReason: 'out-of-scope-paths',
        },
        dryRun: false,
      },
      {
        id: '3',
        runId: runTwo,
        intent: 'label',
        status: 'skipped',
        target: { kind: 'pr', number: 12, ref: null, url: null },
        externalRef: null,
        appliedAt: null,
        revertedAt: null,
        revertKind: null,
        audit: null,
        dryRun: true,
      },
    ],
    diff: {
      available: true,
      text: diffLines.join('\n'),
      truncated: false,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    },
  };
}

export const taskDetailHandlers: HttpHandler[] = [
  http.get('/api/tasks/:id', ({ params }) => {
    const id = String(params['id']);
    // 契约 §3：不存在 → 404 `not-found`（页面据此显示「任务不存在」，不是空白）
    if (id === 'missing') {
      return HttpResponse.json({ error: { code: 'not-found', message: '任务不存在' } }, { status: 404 });
    }
    // 分类任务用专门样本（带 `verdict.evidence`）；其余 id 走通用样本
    const data = id.startsWith('t-classify') ? buildClassifyTaskFixture(id) : buildTaskDetailFixture(id);
    return scenarioResponse({ data, slowMs: 600 });
  }),
];
