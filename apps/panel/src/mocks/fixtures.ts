/**
 * MSW 的假数据（**每个响应都 `satisfies` 契约类型**：契约一改，这里先红）。
 *
 * 数据是「未来某一刻」（`MOCK_NOW`），时间相关的展示（相对时间）在任何真实时刻下都表现为过去，
 * 这样截图与测试断言都稳定。
 */
import type {
  AuditResponse,
  CostsResponse,
  OverviewResponse,
  RevertsResponse,
  SystemResponse,
  TaskDetailResponse,
  TasksResponse,
} from '../lib/contract.ts';

export const MOCK_NOW = '2026-06-01T12:00:00.000Z';
const HOUR_MS = 3_600_000;

function trend(): OverviewResponse['trend'] {
  const end = Date.parse(MOCK_NOW);
  return Array.from({ length: 24 }, (_, index) => {
    const at = new Date(end - (23 - index) * HOUR_MS).toISOString();
    const tasks = index % 4;
    const succeeded = tasks === 0 ? 0 : tasks - 1;
    return { at, tasks, succeeded, failed: tasks - succeeded };
  });
}

export function overviewFixture(): OverviewResponse {
  return {
    generatedAt: MOCK_NOW,
    repo: null,
    window: { from: '2026-05-31T12:00:00.000Z', to: MOCK_NOW },
    today: {
      deliveries: 12,
      tasks: 9,
      succeeded: 7,
      failed: 2,
      successRate: 0.777778,
      p50Ms: 600_000,
      p95Ms: 1_140_000,
      costUsd: 0.1842,
    },
    queue: { depth: 2, active: 1, oldestQueuedMs: 600_000, pausedUntil: null },
    doctor: { status: 'not-run', checkedAt: null, failedChecks: [] },
    trend: trend(),
    outcomeDistribution: [
      { outcome: 'success', count: 7 },
      { outcome: 'failed', count: 2 },
    ],
    failureTop: [
      { failureClass: 'timeout', count: 3 },
      { failureClass: 'rate-limit', count: 2 },
      { failureClass: 'sandbox-crash', count: 1 },
    ],
  };
}

export function overviewEmptyFixture(): OverviewResponse {
  return {
    ...overviewFixture(),
    today: {
      deliveries: 0,
      tasks: 0,
      succeeded: 0,
      failed: 0,
      successRate: null,
      p50Ms: null,
      p95Ms: null,
      costUsd: 0,
    },
    queue: { depth: 0, active: 0, oldestQueuedMs: null, pausedUntil: null },
    trend: trend().map((point) => ({ ...point, tasks: 0, succeeded: 0, failed: 0 })),
    outcomeDistribution: [],
    failureTop: [],
  };
}

const TASK_ITEM: TasksResponse['items'][number] = {
  id: 't-mock-1',
  repo: 'acme/widgets',
  source: 'command',
  command: '/review-pr',
  targetKind: 'pr',
  targetNumber: 12,
  headSha: 'abcdef1234567',
  status: 'succeeded',
  failureClass: null,
  outcome: 'success',
  actorLogin: 'alice',
  queuedAt: '2026-06-01T01:00:00.000Z',
  startedAt: '2026-06-01T01:00:00.000Z',
  endedAt: '2026-06-01T01:10:00.000Z',
  durationMs: 600_000,
  costUsd: 0.05,
  dryRun: false,
};

export function tasksFixture(): TasksResponse {
  return {
    items: [
      TASK_ITEM,
      {
        ...TASK_ITEM,
        id: 't-mock-2',
        repo: 'other/lib',
        command: 'auto:triage',
        targetKind: 'issue',
        targetNumber: 7,
        headSha: null,
        status: 'queued',
        outcome: null,
        actorLogin: 'bob',
        startedAt: null,
        endedAt: null,
        durationMs: null,
        costUsd: null,
        dryRun: true,
      },
    ],
    nextCursor: null,
    hasMore: false,
    totalEstimate: 2,
  };
}

export function tasksEmptyFixture(): TasksResponse {
  return { items: [], nextCursor: null, hasMore: false, totalEstimate: 0 };
}

export function taskDetailFixture(): TaskDetailResponse {
  return {
    task: TASK_ITEM,
    runs: [
      {
        id: 'r-mock-1',
        attempt: 1,
        sessionId: 'sess-mock',
        turnId: 'turn-mock',
        startedAt: '2026-06-01T01:00:00.000Z',
        endedAt: '2026-06-01T01:10:00.000Z',
        outcome: 'success',
        failureClass: null,
        failureDetail: null,
      },
    ],
    events: [
      {
        runId: 'r-mock-1',
        cursor: 1,
        kind: 'session',
        at: '2026-06-01T01:00:01.000Z',
        payload: { phase: 'create' },
      },
      {
        runId: 'r-mock-1',
        cursor: 2,
        kind: 'approval',
        at: '2026-06-01T01:05:00.000Z',
        payload: { tool: 'Bash', decision: 'deny', rule: 'deny-network' },
      },
    ],
    envelopes: [
      {
        runId: 'r-mock-1',
        valid: true,
        verdict: {
          kind: 'pr',
          labels: ['needs-info'],
          evidence: [{ rule: 'missing-test', quote: '没有新增测试', passed: false }],
        },
        actionCount: 2,
        usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 },
      },
    ],
    actions: [
      {
        id: '1',
        runId: 'r-mock-1',
        intent: 'comment',
        status: 'applied',
        target: {
          kind: 'comment',
          number: 12,
          ref: null,
          url: 'https://github.com/acme/widgets/issues/12#issuecomment-9001',
        },
        externalRef: '9001',
        appliedAt: '2026-06-01T01:11:00.000Z',
        revertedAt: null,
        revertKind: null,
        audit: null,
        dryRun: false,
      },
    ],
    diff: {
      available: true,
      text: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      truncated: false,
      baseSha: 'abcdef1234567',
      headSha: 'abcdef1234567',
    },
  };
}

export function costsFixture(): CostsResponse {
  return {
    generatedAt: MOCK_NOW,
    window: { from: '2026-05-31T12:00:00.000Z', to: MOCK_NOW },
    currency: 'USD',
    total: { inputTokens: 4600, outputTokens: 1850, costUsd: 0.22, pricingCoverage: 1 },
    byRepo: [
      { key: 'acme/widgets', inputTokens: 3800, outputTokens: 1700, costUsd: 0.19, tasks: 3, runs: 3 },
      { key: 'other/lib', inputTokens: 800, outputTokens: 150, costUsd: 0.03, tasks: 1, runs: 2 },
    ],
    byCommand: [
      { key: '/review-pr', inputTokens: 2600, outputTokens: 850, costUsd: 0.12, tasks: 3, runs: 4 },
      { key: 'auto:triage', inputTokens: 2000, outputTokens: 1000, costUsd: 0.1, tasks: 1, runs: 1 },
    ],
    byModel: [
      { key: 'anthropic/claude-x', inputTokens: 3800, outputTokens: 1700, costUsd: 0.19, tasks: 3, runs: 3 },
      { key: 'openai/gpt-y', inputTokens: 800, outputTokens: 150, costUsd: 0.03, tasks: 1, runs: 2 },
    ],
    series: [
      { day: '2026-05-31', costUsd: 0.04, inputTokens: 800, outputTokens: 200 },
      { day: '2026-06-01', costUsd: 0.18, inputTokens: 3800, outputTokens: 1650 },
    ],
    topTasks: [
      {
        taskId: 't-mock-1',
        repo: 'acme/widgets',
        command: '/review-pr',
        costUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 500,
        endedAt: '2026-06-01T01:10:00.000Z',
      },
    ],
  };
}

export function costsEmptyFixture(): CostsResponse {
  return {
    ...costsFixture(),
    total: { inputTokens: 0, outputTokens: 0, costUsd: 0, pricingCoverage: 0 },
    byRepo: [],
    byCommand: [],
    byModel: [],
    series: [],
    topTasks: [],
  };
}

export function revertsFixture(): RevertsResponse {
  return {
    generatedAt: MOCK_NOW,
    window: { from: '2026-05-31T12:00:00.000Z', to: MOCK_NOW },
    overall: { applied: 5, reverted: 2, rate: 0.4 },
    byCommand: [
      { key: '/review-pr', applied: 4, reverted: 2, rate: 0.5 },
      { key: 'auto:triage', applied: 1, reverted: 0, rate: 0 },
    ],
    byRepo: [
      { key: 'acme/widgets', applied: 3, reverted: 1, rate: 0.333333 },
      { key: 'other/lib', applied: 2, reverted: 1, rate: 0.5 },
    ],
    records: [
      {
        actionId: '5',
        taskId: 't-mock-1',
        repo: 'other/lib',
        command: '/review-pr',
        intent: 'comment',
        revertKind: 'changes-requested',
        appliedAt: '2026-06-01T03:06:00.000Z',
        revertedAt: '2026-06-01T05:00:00.000Z',
        url: 'https://github.com/other/lib/issues/3#issuecomment-9002',
      },
    ],
    nextCursor: null,
    hasMore: false,
  };
}

export function revertsEmptyFixture(): RevertsResponse {
  return {
    ...revertsFixture(),
    overall: { applied: 0, reverted: 0, rate: null },
    byCommand: [],
    byRepo: [],
    records: [],
  };
}

export function auditFixture(): AuditResponse {
  return {
    items: [
      {
        id: '6',
        at: '2026-06-01T03:07:00.000Z',
        repo: 'other/lib',
        taskId: 't-mock-2',
        runId: 'r-mock-1',
        actor: { login: 'carol', association: null },
        command: '/review-pr',
        target: { kind: 'pr', number: 3, ref: null },
        intent: 'label',
        status: 'applied',
        headSha: 'deadbeef1234',
        externalRef: null,
        approval: null,
        revertedAt: null,
        revertKind: null,
        dryRun: false,
      },
      {
        id: '1',
        at: '2026-06-01T01:11:00.000Z',
        repo: 'acme/widgets',
        taskId: 't-mock-1',
        runId: 'r-mock-1',
        actor: { login: 'alice', association: null },
        command: '/review-pr',
        target: { kind: 'comment', number: 12, ref: null },
        intent: 'comment',
        status: 'applied',
        headSha: 'abcdef1234567',
        externalRef: '9001',
        approval: { tool: 'Bash', decision: 'deny', rule: 'deny-network' },
        revertedAt: '2026-06-01T04:00:00.000Z',
        revertKind: 'comment-deleted',
        dryRun: false,
      },
    ],
    nextCursor: null,
    hasMore: false,
    truncated: false,
    exportLimit: 50_000,
  };
}

export function auditEmptyFixture(): AuditResponse {
  return { items: [], nextCursor: null, hasMore: false, truncated: false, exportLimit: 50_000 };
}

export function systemFixture(): SystemResponse {
  return {
    generatedAt: MOCK_NOW,
    version: { app: '0.0.0', contract: '1.0.0', host: null, hostPinned: false },
    protocol: { wsPath: '/v1/racp/ws', wsSubprotocol: 'pi-racp.v1.jsonrpc' },
    host: { status: 'unknown', lastPingAt: null, sessions: 0 },
    doctor: {
      status: 'fail',
      checkedAt: '2026-06-01T11:00:00.000Z',
      checks: [
        { id: 'docker-daemon', status: 'ok', detail: null },
        { id: 'disk-space', status: 'warn', detail: '剩余 12%' },
        { id: 'canary-network', status: 'fail', detail: '金丝雀不可达' },
      ],
    },
    queue: [
      { name: 'run-task', pending: 2, active: 1, retryLimit: 0, expireInMs: 1_200_000 },
      { name: 'queue-gate', pending: 0, active: 0, retryLimit: 1, expireInMs: 120_000 },
    ],
    retention: { webhookDays: 90, runEventDays: 90, transcriptDays: 90, metricsForever: true },
    flags: [{ key: 'rate_limit_pause', value: '1', until: '2026-06-01T12:15:00.000Z' }],
    repos: [
      {
        repo: 'acme/widgets',
        enabled: true,
        dryRun: false,
        settingsValid: true,
        settingsError: null,
        source: 'installation',
        archivedAt: null,
        lastActivityAt: '2026-06-01T11:40:00.000Z',
        configValid: true,
        configError: null,
      },
      {
        repo: 'other/lib',
        enabled: false,
        dryRun: true,
        settingsValid: false,
        settingsError: 'outputs 越界：pr 但没有 paths',
        source: 'manual',
        archivedAt: '2026-05-20T08:00:00.000Z',
        lastActivityAt: null,
        configValid: false,
        configError: 'outputs 越界：pr 但没有 paths',
      },
    ],
  };
}

export function systemEmptyFixture(): SystemResponse {
  return {
    ...systemFixture(),
    doctor: { status: 'not-run', checkedAt: null, checks: [] },
    queue: [],
    flags: [],
    repos: [],
  };
}
