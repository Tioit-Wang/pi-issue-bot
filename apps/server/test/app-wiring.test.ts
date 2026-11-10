/**
 * **装配级**测试（`docs/impl-multi-repo.md` W4-J 的交付标准第 2 条）：
 * 验的不是纯函数，而是「生产装配之后这些东西到底有没有被接上」。
 *
 * 五个接线点各一条（都用真 PG + 假 RACP host + 假 GitHub 端口）：
 *
 *  1. 自动通道（`tasks.source='webhook'`）：**零评论** + 打标经 `normalizeDesired`
 *     （词表外的标签被拦 → `label_decisions.blocked_reason` 有值）+ 终态 `rocket`；
 *  2. 人工通道（`tasks.source='command'`）：写回**恰好一条**最终回答；
 *  3. 反馈注入后终态 reaction 真的被调用（成功 rocket / 失败 confused）；
 *  4. `settings.limits.concurrency_per_repo` 真的生效（同仓库串行、另一仓库并行）；
 *  5. `prompt_versions` 里的 P1 正文真的出现在最终 prompt 里（并且装配统计落了库）。
 *
 * 为什么必须走 `createApplication().executeTask()`：这些依赖（feedback / labelPolicy /
 * ledger / prompt enricher 的 db）全是在 **compose** 里拼的；只测 `runTask` 或只测
 * `normalizeDesired` 都无法发现「compose 忘了传」——那正是本次要修的黑洞。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRepoSettings } from '../../../packages/contract/src/index.ts';
import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import type { GithubReactionApi } from '../src/github/index.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import {
  FakeRacpHost,
  createCountingGithubApi,
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  stubMetricsServer,
  tick,
} from './helpers/e2e-harness.ts';
import type { CountingGithubApi, FakeQueue } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/** 有词表 + 仓库级并发 1 的仓库（自动通道、打标归一化、并发闸门都用它）。 */
const REPO_LABELLED = 'acme/wiring';
/** 默认 settings 的仓库（人工通道、失败路径、并发默认值用它）。 */
const REPO_PLAIN = 'acme/plain';
/** 有 P1 项目提示词的仓库。 */
const REPO_PROMPTED = 'acme/prompted';

const PROMPT_BODY = '- 一律用中文回答；贴代码时给出文件路径与行号。';

/** 记调用的假 reaction 写面（`feedback/` 与 `confused` 端口共用它）。 */
function createRecordingReactions(): {
  api: GithubReactionApi;
  calls: Array<{ readonly content: string; readonly issueNumber: number }>;
} {
  const calls: Array<{ readonly content: string; readonly issueNumber: number }> = [];
  let nextId = 900;
  return {
    calls,
    api: {
      async addReaction(input) {
        calls.push({ content: input.content, issueNumber: input.issueNumber });
        nextId += 1;
        return { id: nextId };
      },
      async listReactions() {
        return [];
      },
      async removeReaction() {
        // 终态删 eyes：本测试里没有别人的 reaction 可删
      },
    },
  };
}

/** 一段「合规信封」文本：`item.completed` 的 payload 就是它（worker 从里找最后一个 json 块）。 */
function envelopeText(input: {
  readonly labels?: readonly string[];
  readonly actions: readonly Record<string, unknown>[];
}): string {
  return [
    '看完了，先说结论。',
    '```json',
    JSON.stringify({
      verdict: {
        kind: 'issue',
        labels: [...(input.labels ?? [])],
        evidence: [{ rule: 'has-repro-steps', quote: '步骤：1. 打开页面', passed: true }],
      },
      actions: [...input.actions],
      usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.02 },
    }),
    '```',
  ].join('\n');
}

/** 轮询等一个条件成立（并发测试等 worktree 真的建出来）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`等条件超时（${String(timeoutMs)}ms）`);
    }
    await tick(5);
  }
}

describe('装配级接线（真 PG + 假 host / 假 GitHub）', () => {
  let db: TestDb;
  let app: Application;
  let host: FakeRacpHost;
  let queue: FakeQueue;
  let github: CountingGithubApi;
  let reactions: ReturnType<typeof createRecordingReactions>;
  let fakePorts: ReturnType<typeof createFakePorts>;

  /** 插一行 `repos`（settings 由调用方给全）。 */
  async function seedRepo(repo: string, settings: unknown, options: { dryRun?: boolean } = {}): Promise<void> {
    await db.sql(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
       values ($1, true, $2, $3::jsonb, true)`,
      [repo, options.dryRun === true, JSON.stringify(settings)],
    );
  }

  /** 插一行 `tasks`（webhook 落库那一步的等价物：F9 说 command / source 入队时写死）。 */
  async function seedTask(input: {
    readonly id: string;
    readonly repo: string;
    readonly source: 'webhook' | 'command' | 'cron';
    readonly command: string;
    readonly targetNumber: number;
    readonly actorLogin?: string | null;
    readonly idempotencyKey?: string | null;
  }): Promise<void> {
    await db.sql(
      `insert into tasks
         (id, source, repo, target_kind, target_number, head_sha, command, actor_login,
          queued_at, idempotency_key, status, attempt, created_at, updated_at)
       values ($1, $2, $3, 'issue', $4, null, $5, $6, now(), $7, 'queued', 0, now(), now())`,
      [
        input.id,
        input.source,
        input.repo,
        input.targetNumber,
        input.command,
        input.actorLogin ?? 'someone',
        input.idempotencyKey ?? `idem-${input.id}`,
      ],
    );
  }

  beforeAll(async () => {
    db = await openTestDb();
    await db.truncate();

    await seedRepo(
      REPO_LABELLED,
      parseRepoSettings({
        labels: {
          vocabulary: [{ name: '缺陷', meaning: '功能不符合预期', group: '类型' }],
          map: {},
          missing: 'warn',
        },
        limits: { concurrency_per_repo: 1 },
      }),
    );
    await seedRepo(REPO_PLAIN, parseRepoSettings({}));
    await seedRepo(REPO_PROMPTED, parseRepoSettings({ prompt: { enabled: true, current_version: 1 } }));
    await db.sql(
      `insert into prompt_versions (repo, version, body, note) values ($1, 1, $2, 'wiring test')`,
      [REPO_PROMPTED, PROMPT_BODY],
    );

    host = await FakeRacpHost.start({ script: { text: envelopeText({ actions: [] }) } });
    queue = createFakeQueue();
    github = createCountingGithubApi();
    reactions = createRecordingReactions();

    fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
    app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false', PI_BOT_FREE_MENTION: 'false' }), {
      pool: poolWithNoopEnd(db.pool),
      queue,
      ports: {
        ...fakePorts.ports,
        store: createPgRunStore({ pool: db.pool }),
      },
      metrics: quietMetrics(),
      metricsServer: stubMetricsServer(),
      // 入队 `+eyes` 不在这里验（webhook 的 ack 归 W1-B），给一个不响的假实现
      ack: { addEyesReaction: async () => undefined },
      // reaction 写面注入：终态反馈与 `confused` 端口都用它（断言「真的被调用」）
      reactions: reactions.api,
      // 仓库标签目录：`labels.missing` 需要它，否则一律不判 missing
      labelCatalog: { list: async () => ['缺陷'] },
      skipSchedules: true,
    });
    await app.start();
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    await host?.close();
    await db?.close();
  }, 60_000);

  it('① 自动通道：零评论 + 词表外的标签被拦（blocked_reason）+ 终态 rocket', async () => {
    await seedTask({
      id: 't-auto-wiring',
      repo: REPO_LABELLED,
      source: 'webhook',
      command: 'auto:triage',
      targetNumber: 41,
      actorLogin: 'alice',
      idempotencyKey: 'idem-auto-wiring',
    });
    host.setScript({
      text: envelopeText({
        labels: ['缺陷'],
        actions: [
          { intent: 'label', add: ['缺陷', '不存在的标签'] },
          // 自动通道即使模型想发评论，也必须被拦住
          { intent: 'comment', body: '这条评论不该出现在 issue 上' },
        ],
      }),
    });

    const report = await app.executeTask({ taskId: 't-auto-wiring' });
    expect(report.outcome).toBe('succeeded');

    // 1) 零评论：`createIssueComment` 一次都没被调用
    expect(github.calls.filter((call) => call.method.startsWith('createIssueComment'))).toHaveLength(0);
    const comments = await db.sql("select * from actions where intent = 'comment'");
    expect(comments).toHaveLength(0);

    // 2) 打标经归一化：只加词表里的那个
    const addLabelCalls = github.calls.filter((call) => call.method.startsWith('addLabels'));
    expect(addLabelCalls).toHaveLength(1);
    expect(addLabelCalls[0]?.method).toContain('缺陷');
    expect(addLabelCalls[0]?.method).not.toContain('不存在的标签');

    // 3) `label_decisions`：desired/applied 只有词表内的，词表外的进 blocked_reason
    const decisions = await db.sql('select * from label_decisions where repo = $1 and target_number = $2', [
      REPO_LABELLED,
      41,
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.['desired']).toEqual(['缺陷']);
    expect(decisions[0]?.['applied']).toEqual(['缺陷']);
    expect(String(decisions[0]?.['blocked_reason'])).toContain('not-in-vocabulary:不存在的标签');
    expect(decisions[0]?.['run_id']).toBe(report.runId);

    // 4) `bot_labels` 记账（只增删自己打过的标签 + 人工否决都靠它）
    const botLabels = await db.sql('select * from bot_labels where repo = $1 and issue_number = $2', [
      REPO_LABELLED,
      41,
    ]);
    expect(botLabels.map((row) => row['label'])).toEqual(['缺陷']);

    // 5) 终态反馈：`issue_feedback` 一行（applied_at 已回填）+ 真的打了 rocket
    const feedback = await db.sql(
      "select * from issue_feedback where repo = $1 and target_number = $2 and stage = 'succeeded'",
      [REPO_LABELLED, 41],
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.['content']).toBe('rocket');
    expect(feedback[0]?.['applied_at']).not.toBeNull();
    expect(reactions.calls.map((call) => call.content)).toContain('rocket');
  }, 60_000);

  it('② 人工通道：写回恰好一条最终回答', async () => {
    await seedTask({
      id: 't-manual-wiring',
      repo: REPO_PLAIN,
      source: 'command',
      command: '/issue-triage',
      targetNumber: 52,
      actorLogin: 'bob',
      idempotencyKey: 'idem-manual-wiring',
    });
    host.setScript({
      text: envelopeText({ actions: [{ intent: 'comment', body: '这是最终回答。' }] }),
    });

    const before = github.calls.filter((call) => call.method.startsWith('createIssueComment')).length;
    const report = await app.executeTask({ taskId: 't-manual-wiring' });
    expect(report.outcome).toBe('succeeded');

    const commentCalls = github.calls
      .filter((call) => call.method.startsWith('createIssueComment'))
      .slice(before);
    expect(commentCalls).toHaveLength(1);

    const rows = await db.sql("select * from actions where intent = 'comment' and target = $1", [
      `${REPO_PLAIN}#52`,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['applied_at']).not.toBeNull();
    expect(report.actions.find((action) => action.intent === 'comment')?.status).toBe('applied');
    expect(report.actions.find((action) => action.intent === 'comment')?.externalRef).not.toBeNull();
  }, 60_000);

  it('③ 失败路径：终态 reaction 是 confused（不是 rocket）', async () => {
    await seedTask({
      id: 't-fail-wiring',
      repo: REPO_PLAIN,
      source: 'webhook',
      command: 'auto:triage',
      targetNumber: 63,
      actorLogin: 'dave',
      idempotencyKey: 'idem-fail-wiring',
    });
    host.setScript({
      text: envelopeText({ actions: [] }),
      terminal: 'turn.failed',
    });

    const before = reactions.calls.length;
    const report = await app.executeTask({ taskId: 't-fail-wiring' });
    expect(report.outcome).not.toBe('succeeded');

    const added = reactions.calls.slice(before).map((call) => call.content);
    expect(added).toContain('confused');
    expect(added).not.toContain('rocket');

    const feedback = await db.sql(
      "select * from issue_feedback where repo = $1 and target_number = $2 and stage = 'failed'",
      [REPO_PLAIN, 63],
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.['content']).toBe('confused');
  }, 60_000);

  it('④ `settings.limits.concurrency_per_repo` 真的生效（同仓库串行、另一仓库并行）', async () => {
    // `registerTaskWorker` 注册的是 pg-boss 的**批量** handler：`(jobs) => …`（`queue/boss.ts`）。
    const handler = queue.record.handlers['run-task'] as
      | ((jobs: Array<{ id: string; data: { taskId: string; repo: string } }>) => Promise<void>)
      | undefined;
    expect(typeof handler).toBe('function');

    // ── 同一个「并发 1」的仓库：第二条 job 必须等第一条跑完才动 ──────────────────
    await seedTask({
      id: 't-conc-1',
      repo: REPO_LABELLED,
      source: 'webhook',
      command: 'auto:triage',
      targetNumber: 81,
      actorLogin: 'erin',
      idempotencyKey: 'idem-conc-1',
    });
    await seedTask({
      id: 't-conc-2',
      repo: REPO_LABELLED,
      source: 'webhook',
      command: 'auto:triage',
      targetNumber: 82,
      actorLogin: 'erin',
      idempotencyKey: 'idem-conc-2',
    });
    // 事件晚 80ms 到：让第一条 job 有足够长的占槽窗口
    host.setScript({ text: envelopeText({ actions: [] }), delayMs: 80 });

    const before = fakePorts.record.worktrees.length;
    const first = handler?.([{ id: 'job-conc-1', data: { taskId: 't-conc-1', repo: REPO_LABELLED } }]);
    await waitFor(() => fakePorts.record.worktrees.length === before + 1);
    const second = handler?.([{ id: 'job-conc-2', data: { taskId: 't-conc-2', repo: REPO_LABELLED } }]);
    await tick(60);
    // 槽位只有 1 个 → 第二条连 worktree 都还没建（这就是「仓库级并发」的直接证据）
    expect(fakePorts.record.worktrees.length).toBe(before + 1);
    await Promise.all([first, second]);
    expect(fakePorts.record.worktrees.length).toBe(before + 2);

    // ── 另一个「默认并发 2」的仓库：两条 job 同时起来 ────────────────────────────
    await seedTask({
      id: 't-conc-3',
      repo: REPO_PLAIN,
      source: 'webhook',
      command: 'auto:triage',
      targetNumber: 83,
      actorLogin: 'erin',
      idempotencyKey: 'idem-conc-3',
    });
    await seedTask({
      id: 't-conc-4',
      repo: REPO_PLAIN,
      source: 'webhook',
      command: 'auto:triage',
      targetNumber: 84,
      actorLogin: 'erin',
      idempotencyKey: 'idem-conc-4',
    });
    const beforePlain = fakePorts.record.worktrees.length;
    const third = handler?.([{ id: 'job-conc-3', data: { taskId: 't-conc-3', repo: REPO_PLAIN } }]);
    const fourth = handler?.([{ id: 'job-conc-4', data: { taskId: 't-conc-4', repo: REPO_PLAIN } }]);
    await waitFor(() => fakePorts.record.worktrees.length === beforePlain + 2);
    await Promise.all([third, fourth]);
    expect(fakePorts.record.worktrees.length).toBe(beforePlain + 2);
  }, 60_000);

  it('⑤ P1 项目提示词出现在最终 prompt 里，且装配统计落库', async () => {
    await seedTask({
      id: 't-prompt-wiring',
      repo: REPO_PROMPTED,
      source: 'webhook',
      command: 'auto:triage',
      targetNumber: 74,
      actorLogin: 'carol',
      idempotencyKey: 'idem-prompt-wiring',
    });
    const callsBefore = host.calls.length;
    host.setScript({ text: envelopeText({ actions: [] }) });

    await app.executeTask({ taskId: 't-prompt-wiring' });

    // `turn/start` 的 params.input.text 就是最终交给宿主的提示词
    const turnStart = host.calls
      .slice(callsBefore)
      .filter((call) => call.method === 'turn/start')
      .at(-1);
    expect(turnStart).toBeDefined();
    const text = String(
      ((turnStart?.params as { input?: { text?: unknown } } | undefined)?.input?.text ?? '') as string,
    );
    expect(text).toContain('项目约定');
    expect(text).toContain(PROMPT_BODY);

    // 装配统计：`runtime_flags{key='assemble:prompt:stats', repo=<repo>}`
    const stats = await db.sql(
      "select * from runtime_flags where key = 'assemble:prompt:stats' and repo = $1",
      [REPO_PROMPTED],
    );
    expect(stats).toHaveLength(1);
    expect(String(stats[0]?.['value'])).toContain('promptChars');
  }, 60_000);
});
