import { describe, expect, it } from 'vitest';

import {
  ACTION_INTENTS,
  CONTRACT_VERSION,
  EXECUTOR_ACTION_INTENTS,
  FAILURE_CLASS_PRIORITY_GROUPS,
  OUTCOMES,
  TASK_STATUSES,
  addRepoRequestSchema,
  auditQuerySchema,
  auditResponseSchema,
  costsResponseSchema,
  errorBodySchema,
  failureClassPriority,
  issueSessionResponseSchema,
  issuesListResponseSchema,
  overviewQuerySchema,
  overviewResponseSchema,
  querySchemas,
  repoSettingsResponseSchema,
  reposResponseSchema,
  responseSchemas,
  revertsResponseSchema,
  saveRepoSettingsRequestSchema,
  systemQuerySchema,
  systemResponseSchema,
  taskDetailResponseSchema,
  tasksQuerySchema,
  tasksResponseSchema,
  webhookAcceptedResponseSchema,
} from '../src/index.ts';

/** 合法任务列表行（其余响应体复用它的字段，避免每个 fixture 各写一份）。 */
const taskItem = {
  id: 't_01',
  repo: 'acme/widgets',
  source: 'webhook',
  command: 'auto:triage',
  targetKind: 'issue',
  targetNumber: 12,
  headSha: null,
  status: 'queued',
  failureClass: null,
  outcome: null,
  actorLogin: null,
  queuedAt: '2026-06-01T00:00:00Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  costUsd: null,
  dryRun: true,
} as const;

describe('枚举与契约版本', () => {
  it('契约版本是可比较的字符串', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('信封 intent 只有 plan §5 的 4 类，close_issue 只在执行器侧', () => {
    expect([...ACTION_INTENTS]).toEqual(['comment', 'label', 'create_issue', 'push_branch']);
    expect(EXECUTOR_ACTION_INTENTS).toContain('close_issue');
    expect(ACTION_INTENTS as readonly string[]).not.toContain('close_issue');
    // `open_pr` 不是 intent：开 PR 是 push_branch.openPr，两处都不许出现它。
    expect(EXECUTOR_ACTION_INTENTS as readonly string[]).not.toContain('open_pr');
  });

  it('任务状态与结果分布是固定集合', () => {
    expect([...TASK_STATUSES]).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    expect([...OUTCOMES]).toContain('timed-out');
    expect([...OUTCOMES]).toContain('parse-failed');
  });

  it('失败分类优先级：超时/中断/退化 1 级，sandbox-oom 2 级，sandbox-crash 3 级，其余 4 级', () => {
    expect(failureClassPriority('timeout')).toBe(1);
    expect(failureClassPriority('interrupt')).toBe(1);
    expect(failureClassPriority('degenerate-output')).toBe(1);
    expect(failureClassPriority('sandbox-oom')).toBe(2);
    expect(failureClassPriority('sandbox-crash')).toBe(3);
    expect(failureClassPriority('rate-limit')).toBe(4);
    expect(FAILURE_CLASS_PRIORITY_GROUPS.flat()).toHaveLength(10);
  });
});

describe('全局约定', () => {
  it('错误体形状固定为 {error:{code,message,details?}}', () => {
    expect(errorBodySchema.safeParse({ error: { code: 'unauthorized', message: '未登录' } }).success).toBe(true);
    expect(errorBodySchema.safeParse({ error: { code: 'missing', message: 'x' } }).success).toBe(false);
    expect(errorBodySchema.safeParse({ error: { code: 'internal', message: 'x', extra: 1 } }).success).toBe(false);
  });

  it('比例必须在 0–1 之间（不乘 100）', () => {
    const bad = { ...baseOverview(), today: { ...baseOverview().today, successRate: 83 } };
    expect(overviewResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('空集时用 null 而不是 0（p95 与成功率）', () => {
    const body = baseOverview();
    expect(overviewResponseSchema.safeParse(body).success).toBe(true);
    expect(body.today.p95Ms).toBeNull();
    expect(body.today.successRate).toBeNull();
  });

  it('时间必须是带 Z 的 ISO8601 UTC', () => {
    const bad = { ...baseOverview(), generatedAt: '2026-06-01 00:00:00' };
    expect(overviewResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('token 与耗时必须是整数', () => {
    const bad = baseCosts();
    expect(costsResponseSchema.safeParse({ ...bad, total: { ...bad.total, inputTokens: 1.5 } }).success).toBe(false);
  });
});

describe('8 个 GET 的响应 schema', () => {
  it('/api/overview', () => {
    expect(overviewResponseSchema.safeParse(baseOverview()).success).toBe(true);
    const bad = { ...baseOverview(), outcomeDistribution: [{ outcome: 'weird', count: 1 }] };
    expect(overviewResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('/api/tasks（列表 + 游标）', () => {
    const body = { items: [taskItem], nextCursor: null, hasMore: false, totalEstimate: 1 };
    expect(tasksResponseSchema.safeParse(body).success).toBe(true);
    // 末页 nextCursor 必须是 null，不能省字段
    const missing = { items: [], hasMore: false, totalEstimate: 0 };
    expect(tasksResponseSchema.safeParse(missing).success).toBe(false);
    // 非法状态
    expect(tasksResponseSchema.safeParse({ ...body, items: [{ ...taskItem, status: 'done' }] }).success).toBe(false);
  });

  it('/api/tasks 的筛选参数（含 coerce 与默认 limit）', () => {
    const parsed = tasksQuerySchema.parse({ status: 'failed', failureClass: 'sandbox-oom', limit: '20' });
    expect(parsed.limit).toBe(20);
    expect(parsed.repo).toBeUndefined();
    expect(tasksQuerySchema.parse({}).limit).toBe(50);
    expect(tasksQuerySchema.safeParse({ limit: '9999' }).success).toBe(false);
    expect(tasksQuerySchema.safeParse({ unknownParam: '1' }).success).toBe(false);
  });

  it('/api/tasks/:id（详情）', () => {
    const body = baseTaskDetail();
    expect(taskDetailResponseSchema.safeParse(body).success).toBe(true);
    expect(taskDetailResponseSchema.safeParse({ ...body, diff: { available: false } }).success).toBe(false);
  });

  it('/api/costs', () => {
    expect(costsResponseSchema.safeParse(baseCosts()).success).toBe(true);
    expect(costsResponseSchema.safeParse({ ...baseCosts(), currency: 'EUR' }).success).toBe(false);
  });

  it('/api/quality/reverts', () => {
    const body = {
      generatedAt: '2026-06-02T00:00:00Z',
      window: baseOverview().window,
      overall: { applied: 0, reverted: 0, rate: null },
      byCommand: [{ key: '/review-pr', applied: 4, reverted: 1, rate: 0.25 }],
      byRepo: [],
      records: [],
      nextCursor: null,
      hasMore: false,
    };
    expect(revertsResponseSchema.safeParse(body).success).toBe(true);
    // applied = 0 时 rate 必须是 null（不能用 0 冒充）
    expect(
      revertsResponseSchema.safeParse({ ...body, byCommand: [{ key: '/review-pr', applied: 0, reverted: 0, rate: 0 }] })
        .success,
    ).toBe(false);
  });

  it('/api/audit', () => {
    const body = {
      items: [
        {
          id: 'a_1',
          at: '2026-06-02T00:00:00Z',
          repo: 'acme/widgets',
          taskId: 't_01',
          runId: 'r_01',
          actor: { login: 'alice', association: 'MEMBER' },
          command: '/review-pr',
          target: { kind: 'pr', number: 7, ref: null },
          intent: 'close_issue',
          status: 'applied',
          headSha: 'abcdef1',
          externalRef: null,
          approval: { tool: 'Bash', decision: 'allow', rule: 'read-only' },
          revertedAt: null,
          revertKind: null,
          dryRun: false,
        },
      ],
      nextCursor: null,
      hasMore: false,
      truncated: false,
      exportLimit: 50000,
    };
    expect(auditResponseSchema.safeParse(body).success).toBe(true);
    expect(auditQuerySchema.safeParse({ intent: 'close_issue' }).success).toBe(true);
    expect(auditQuerySchema.safeParse({ intent: 'merge' }).success).toBe(false);
  });

  it('/api/system', () => {
    expect(systemResponseSchema.safeParse(baseSystem()).success).toBe(true);
    const bad = baseSystem();
    expect(
      systemResponseSchema.safeParse({
        ...bad,
        skills: [{ ...bad.skills[0], enabled: false, disabledReason: null }],
      }).success,
    ).toBe(true);
    expect(systemResponseSchema.safeParse({ ...bad, protocol: { wsPath: '/v1/racp/ws' } }).success).toBe(false);
  });

  it('POST /webhook 的应答', () => {
    const body = {
      status: 'accepted',
      deliveryId: 'd-1',
      taskId: null,
      duplicate: true,
      action: 'duplicate',
      ackComment: null,
    };
    expect(webhookAcceptedResponseSchema.safeParse(body).success).toBe(true);
    expect(webhookAcceptedResponseSchema.safeParse({ ...body, status: 'ok' }).success).toBe(false);
  });
});

describe('多仓库改造后的契约（W3-H）', () => {
  it('只读接口的 `?repo=`：overview / system 都接受，未知参数仍被拒', () => {
    expect(overviewQuerySchema.safeParse({}).success).toBe(true);
    expect(overviewQuerySchema.parse({ repo: 'acme/widgets' }).repo).toBe('acme/widgets');
    expect(overviewQuerySchema.safeParse({ repo: 'not a repo' }).success).toBe(false);
    expect(systemQuerySchema.parse({})).toEqual({});
    expect(systemQuerySchema.parse({ repo: 'acme/widgets' }).repo).toBe('acme/widgets');
    expect(systemQuerySchema.safeParse({ repo: 'x' }).success).toBe(false);
  });

  it('/api/overview 的 `repo` 口径字段：null = 全部仓库', () => {
    const body = baseOverview();
    expect(overviewResponseSchema.safeParse(body).success).toBe(true);
    expect(overviewResponseSchema.safeParse({ ...body, repo: 'acme/widgets' }).success).toBe(true);
    // 缺字段不行（null 与「没给」必须可区分）
    const { repo: _repo, ...withoutRepo } = body;
    expect(overviewResponseSchema.safeParse(withoutRepo).success).toBe(false);
  });

  it('/api/system 的 repos[]：新字段齐 + `configValid` 同值别名', () => {
    const system = baseSystem();
    const [first] = system.repos;
    expect(first).toMatchObject({
      settingsValid: true,
      configValid: true,
      settingsError: null,
      configError: null,
      source: 'manual',
      archivedAt: null,
      lastActivityAt: '2026-06-02T00:00:00Z',
    });
    expect(systemResponseSchema.safeParse(system).success).toBe(true);
    // 老形状（只有 configValid/configError）不再合法：别名是与新字段**并存**，不是替代
    expect(
      systemResponseSchema.safeParse({
        ...system,
        repos: [{ repo: 'acme/widgets', enabled: true, dryRun: true, configValid: true, configError: null }],
      }).success,
    ).toBe(false);
  });

  it('/api/repos 的响应与两个写请求体', () => {
    const listItem = {
      repo: 'acme/widgets',
      enabled: true,
      dryRun: false,
      settingsValid: true,
      settingsError: null,
      settingsUpdatedAt: '2026-06-02T00:00:00Z',
      source: 'installation',
      installationId: '12345678',
      archivedAt: null,
      updatedAt: '2026-06-02T00:00:00Z',
    };
    expect(reposResponseSchema.safeParse({ items: [listItem] }).success).toBe(true);
    // `source` 只有两个取值
    expect(reposResponseSchema.safeParse({ items: [{ ...listItem, source: 'cron' }] }).success).toBe(false);

    expect(addRepoRequestSchema.parse({ repo: 'acme/widgets' })).toEqual({ repo: 'acme/widgets' });
    expect(addRepoRequestSchema.safeParse({ repo: 'acme/widgets', enabled: false }).success).toBe(false);

    // settings 视图：非法配置时 `settings` 必须是 null（不是空对象）
    const view = {
      repo: 'acme/widgets',
      enabled: false,
      dryRun: true,
      settings: null,
      settingsValid: false,
      settingsError: 'version: 缺字段',
      source: 'manual',
      installationId: null,
      archivedAt: '2026-06-01T00:00:00Z',
    };
    expect(repoSettingsResponseSchema.safeParse(view).success).toBe(true);
    // 请求体 = settings 本身（默认值会被补齐）
    expect(saveRepoSettingsRequestSchema.parse({}).version).toBe(1);
  });

  it('/api/issues 的新字段：reactionState / labelDecisions / feedback 与详情侧 pendingFeedback', () => {
    const feedbackEvent = {
      stage: 'succeeded',
      content: 'rocket',
      appliedAt: '2026-06-02T00:01:00Z',
      at: '2026-06-02T00:01:00Z',
      commentId: null,
    };
    const issue = {
      repo: 'acme/widgets',
      kind: 'issue',
      number: 17,
      title: 'EACCES',
      url: null,
      state: 'open',
      stateStale: false,
      lastActivityAt: '2026-06-02T00:01:00Z',
      humanTurns: 1,
      autoTurns: 0,
      botTurns: 1,
      lastReplyAt: '2026-06-02T00:01:00Z',
      lastActorLogin: 'alice',
      lastActorKind: 'human',
      awaitingReply: false,
      labels: ['bug'],
      outcomes: { succeeded: 1 },
      lastPreview: '结论',
      reactionState: feedbackEvent,
      labelDecisions: {
        lastAt: '2026-06-02T00:01:00Z',
        desired: ['bug', 'needs-info'],
        applied: ['bug'],
        reason: 'needs-info 被词表拦住',
        blocked: [{ reason: 'not-in-vocabulary', count: 1 }],
      },
      feedback: [{ ...feedbackEvent, stage: 'received', content: 'eyes' }, feedbackEvent],
    };
    const list = { generatedAt: '2026-06-02T00:02:00Z', issues: [issue], hasMore: false, nextCursor: null };
    expect(issuesListResponseSchema.safeParse(list).success).toBe(true);
    // 新字段是必填（缺了就解析失败：面板不用判空）
    const { reactionState: _r, ...withoutReaction } = issue;
    expect(
      issuesListResponseSchema.safeParse({ ...list, issues: [withoutReaction] }).success,
    ).toBe(false);
    // 契约外的 stage 不行
    expect(
      issuesListResponseSchema.safeParse({
        ...list,
        issues: [{ ...issue, reactionState: { ...feedbackEvent, stage: 'queued' } }],
      }).success,
    ).toBe(false);

    const session = {
      generatedAt: '2026-06-02T00:02:00Z',
      issue: {
        repo: 'acme/widgets',
        kind: 'issue',
        number: 17,
        title: 'EACCES',
        url: null,
        state: 'open',
        stateStale: false,
        labels: ['bug'],
        participants: ['alice'],
        reactionState: feedbackEvent,
        pendingFeedback: [{ ...feedbackEvent, appliedAt: null }],
      },
      turns: [],
    };
    expect(issueSessionResponseSchema.safeParse(session).success).toBe(true);
  });
});

describe('注册表', () => {
  it('每个响应 schema 都能生成 draft 2020-12 的 JSON Schema', () => {
    for (const [name, schema] of Object.entries(responseSchemas)) {
      // 带 `.meta({id})` 的顶层会生成 `{$ref:'#/$defs/…', $defs:{…}}`，没有 type 也合法。
      const jsonSchema = schema.toJSONSchema({ target: 'draft-2020-12', io: 'output' }) as {
        type?: string;
        $ref?: string;
        $defs?: Record<string, unknown>;
      };
      if (jsonSchema.type === undefined) {
        expect(jsonSchema.$ref, name).toBeTruthy();
        expect(jsonSchema.$defs, name).toBeTruthy();
      } else {
        expect(jsonSchema.type, name).toBe('object');
      }
    }
  });

  it('查询参数 schema 都是对象', () => {
    for (const [name, schema] of Object.entries(querySchemas)) {
      expect(schema.safeParse({}).success, name).toBe(true);
    }
  });
});

function baseOverview() {
  return {
    generatedAt: '2026-06-02T00:00:00Z',
    repo: null,
    window: { from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' },
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
    doctor: { status: 'not-run', checkedAt: null, failedChecks: [] },
    trend: [{ at: '2026-06-01T00:00:00Z', tasks: 0, succeeded: 0, failed: 0 }],
    outcomeDistribution: [{ outcome: 'success', count: 0 }],
    failureTop: [{ failureClass: 'timeout', count: 0 }],
  };
}

function baseTaskDetail() {
  return {
    task: { ...taskItem, status: 'succeeded', outcome: 'success' },
    runs: [
      {
        id: 'r_01',
        attempt: 0,
        sessionId: 's_1',
        turnId: 'tu_1',
        startedAt: '2026-06-01T00:00:01Z',
        endedAt: '2026-06-01T00:01:00Z',
        outcome: 'success',
        failureClass: null,
        failureDetail: null,
      },
    ],
    events: [
      {
        runId: 'r_01',
        cursor: 0,
        kind: 'envelope',
        at: '2026-06-01T00:00:30Z',
        payload: { valid: true },
      },
    ],
    envelopes: [
      {
        runId: 'r_01',
        valid: true,
        verdict: { kind: 'issue', labels: ['bug'], evidence: [{ rule: 'has-repro', quote: '步骤：…', passed: false }] },
        actionCount: 1,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0004 },
      },
    ],
    actions: [
      {
        id: 'a_1',
        runId: 'r_01',
        intent: 'push_branch',
        status: 'applied',
        target: { kind: 'branch', number: null, ref: 'bot/t_01-fix', url: null },
        externalRef: 'abcdef1',
        appliedAt: '2026-06-01T00:00:40Z',
        revertedAt: null,
        revertKind: null,
        audit: {
          declared: ['src/a.ts'],
          actual: ['src/a.ts', 'README.md'],
          intersect: ['src/a.ts'],
          dropped: ['README.md'],
          rejectedReason: null,
        },
        dryRun: false,
      },
    ],
    diff: { available: true, text: 'diff --git a/src/a.ts b/src/a.ts', truncated: false, baseSha: 'abcdef1', headSha: 'abcdef2' },
  };
}

function baseCosts() {
  return {
    generatedAt: '2026-06-02T00:00:00Z',
    window: baseOverview().window,
    currency: 'USD',
    total: { inputTokens: 0, outputTokens: 0, costUsd: 0, pricingCoverage: 1 },
    byRepo: [{ key: 'acme/widgets', inputTokens: 0, outputTokens: 0, costUsd: 0, tasks: 0, runs: 0 }],
    byCommand: [],
    byModel: [],
    series: [{ day: '2026-06-01', costUsd: 0, inputTokens: 0, outputTokens: 0 }],
    topTasks: [],
  };
}

function baseSystem() {
  return {
    generatedAt: '2026-06-02T00:00:00Z',
    version: { app: '0.0.0', contract: CONTRACT_VERSION, host: null, hostPinned: false },
    protocol: { wsPath: '/v1/racp/ws', wsSubprotocol: 'pi-racp.v1.jsonrpc' },
    host: { status: 'unknown', lastPingAt: null, sessions: 0 },
    doctor: { status: 'ok', checkedAt: null, checks: [{ id: 'docker-daemon', status: 'skip', detail: '本机没有 docker' }] },
    queue: [{ name: 'task', pending: 0, active: 0, retryLimit: 3, expireInMs: 1_200_000 }],
    retention: { webhookDays: 90, runEventDays: 90, transcriptDays: 90, metricsForever: true },
    flags: [{ key: 'rate_limit_pause', value: '1', until: null }],
    repos: [
      {
        repo: 'acme/widgets',
        enabled: true,
        dryRun: true,
        settingsValid: true,
        settingsError: null,
        source: 'manual',
        archivedAt: null,
        lastActivityAt: '2026-06-02T00:00:00Z',
        // 过渡期别名（与 settingsValid / settingsError 同值）
        configValid: true,
        configError: null,
      },
    ],
    skills: [
      {
        name: '/issue-triage',
        source: 'builtin',
        enabled: false,
        disabledReason: 'skill_invalid',
        outputs: ['comment', 'labels'],
        timeoutMs: 1_200_000,
      },
    ],
  };
}
