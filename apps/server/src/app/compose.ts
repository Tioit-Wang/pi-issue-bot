/**
 * **进程装配**（W4-P 的核心）：把 db / 队列 / http / worker / runtime / sandbox / github 拧成
 * 一个能 `start()` / `stop()` 的应用对象。
 *
 * ```
 * config ─┬─ pool(pg) ── assertSchemaReady ─┐
 *         ├─ queue(pg-boss) ─ start + bootstrapQueue(ensureQueues + registerSchedules)
 *         ├─ registerTaskWorker(queue, job => runTask(...))   ← worker 唯一入口
 *         ├─ registerJobs(queue, ...)                        ← 四个定时作业
 *         ├─ createQueries(pool) → buildServer(webhook/http) → metrics 独立实例
 *         └─ worker 端口：worktree(git) / docker / exec代理 / lifecycle / host / github
 * ```
 *
 * 三条设计取舍（都是踩过坑才会这么写）：
 *  1. **`serve` 不自动迁移**：只 `assertSchemaReady()` 检查。迁移是显式动作（`pi-bot migrate`），
 *     否则「两个实例同时起来」时会并发跑同一个迁移（tech-plan §7.2 的账本表能挡，但没必要让它挡）。
 *  2. **RACP 通道每 run 一条**（见 `app/racp.ts` 文件头）：`ops` 必须绑定到具体连接，
 *     而 `TaskRunnerDeps.ops` 是静态注入点 —— 所以「拼 deps」这一步放在 job handler 里，
 *     而不是进程启动时。`worker/` 因此一行都不用改。
 *  3. **所有外部件都能被注入替换**：docker / host / github / racp / queue / pool / 端口集合。
 *     默认值才真起（`createSandboxDocker()`、`HostSupervisor`、真 pg-boss）。
 *     端到端测试因此不需要 docker daemon、不需要 `vendor/pi-host`、不打真实 GitHub。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';

import { AppError, createLogger } from '../../../../packages/shared/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { DEFAULT_TRIGGER_ALIASES, resolveTriggerAliases } from '../../../../packages/contract/src/index.ts';
import type { SqlExecutor } from '../db/index.ts';
import { closePool, createPool } from '../db/index.ts';
import { readRepoPolicy } from '../config/index.ts';
import { resolveGithubAuth } from './github-auth.ts';
import { createGithubWriteApi } from '../github/index.ts';
import type { GithubClient, GithubReactionApi, GithubWriteApi } from '../github/index.ts';
import type { LabelCatalogPort } from '../workflows/ports.ts';
import { RepoCache, createExecFileRunGit, createRepoWorktreePort } from '../git/index.ts';
import {
  APP_VERSION,
  buildServer,
  createGithubWebhookAck,
  createMetrics,
  createMetricsServer,
  createOctokitVerifier,
  createQueueEnqueuer,
  createAllowAllAuth,
  decodeFreeQuestion,
  createSessionAuth,
} from '../http/index.ts';
import type {
  BuildServerDeps,
  HealthCheck,
  Metrics,
  MetricsServer,
  RequireAuth,
  SessionStore,
  ReactionContent,
  WebhookAck,
  WebhookVerify,
} from '../http/index.ts';
import { JOB_SCHEDULES, registerJobs } from '../jobs/index.ts';
import type { JobDeps } from '../jobs/index.ts';
import {
  QUEUE,
  bootstrapQueue,
  cancelTaskJob,
  createBoss,
  enqueueRetry,
  expireInSecondsForCommand,
  registerScheduleWorker,
  registerTaskWorker,
} from '../queue/index.ts';
import type {
  QueueAdminBoss,
  QueueBoss,
  ScheduleAdminBoss,
  TaskJobHandler,
  WorkBoss,
} from '../queue/index.ts';
import { createQueries } from '../queries/index.ts';
import { createHostUsageReader } from '../cost/index.ts';
import type { Queries } from '../queries/index.ts';
import { HostSupervisor, createNodeHostSpawn, resolveBundleCommand } from '../runtime/index.ts';
import type { SandboxDocker } from '../sandbox/index.ts';
import { createSupervisorHostPort, timeoutMsForCommand } from '../worker/index.ts';
// 直接引 run-task.ts：`worker/index.ts` 的便利包装把 deps 钉成了旧 `TaskRunnerDeps`，
// 而 v2 钩子是它的可选超集。走实现文件才能让类型检查看到 `v21`。
import { runTask } from '../worker/run-task.ts';
import type { HostPort, SessionPlan, TaskRunnerDeps, TaskRunReport, WorktreePort } from '../worker/index.ts';
import type { AppConfig } from './config.ts';
import { describeAppConfig } from './config.ts';
import { hostModelEnv } from './model-env.ts';
import { createRacpChannelFactory } from './racp.ts';
import type { RacpChannelFactory } from './racp.ts';
import {
  buildAnswerPrompt,
  buildTaskPrompt,
  createBotLabelLedger,
  createGithubLabelCatalog,
  createLabelWritebackPolicy,
  createPromptEnricher,
  createUnavailableHostPort,
  createWorkerFeedbackDeps,
  createWorkerPorts,
  createWorkflowReactionPort,
  createV21Compactor,
  createV21CompactionStore,
  readTaskRow,
} from './worker-deps.ts';
import type { TaskJobRow, WorkerPorts } from './worker-deps.ts';
import { createSkillStore } from '../skills/store.ts';
import { concurrencyPerRepoOf } from '../queue/repo-concurrency.ts';
import {
  dispatchNextForIssue,
  finishMessageAndContinue,
  loadSession as loadAgentSessionRow,
  parseAgentTaskIdempotencyKey,
  saveSession as saveAgentSessionRow,
} from '../agent/index.ts';
import type { AgentDispatchDeps } from '../agent/index.ts';
import {
  createRepoIssuesLister,
  createV21CompactionHook,
  createV21Executor,
  createV21OpenPullRequest,
  v21ReactionsOf,
} from '../http/webhook-v21.ts';
import { planSessionOnEvent } from '../agent/session-state.ts';
import type {
  AgentSessionRow as V21AgentSessionRow,
  PlanSessionOnEventInput,
  SessionEventKey,
  SessionTransition,
} from '../agent/session-state.ts';
import { createV21TargetContextPort } from './worker-deps.ts';
import { createRepoIssuesProvider } from '../prompt/repo-issues.ts';

/* ── 队列的最小接口（结构可替换）────────────────────────────────────────────── */

/** `getQueueStats` 里我们用到的两列（`/healthz` 的队列探针）。 */
export type QueueStatsLike = {
  readonly queuedCount: number;
  readonly activeCount: number;
};
/**
 * 装配层用的队列接口：**恰好**覆盖本文件用到的成员。
 *
 * 为什么不直接写 `PgBoss`：`PgBoss` 是个几十个方法的大类，测试没法给一个「只实现用到的
 * 那 8 个方法」的假对象。这里用结构类型，`createDefaultQueue()` 里有一行
 * `const boss: PgBoss = …; return boss;` —— 真实 `PgBoss` 不满足 AppQueue 时**编译期**就炸，
 * 所以「窄接口」不会悄悄漂离真实类型。
 */
export interface AppQueue extends QueueBoss, WorkBoss, QueueAdminBoss, ScheduleAdminBoss {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  getQueueStats(name: string): Promise<readonly QueueStatsLike[]>;
}

/* ── 停机步骤（顺序即 tech-plan §3.4 的那句话）────────────────────────────── */

/**
 * 优雅停机的步骤，**顺序即语义**：
 *
 *  1. `http.close`        停止接收新 webhook（连接被拒 → GitHub 视为失败并重投，§3.4）
 *  2. `worker.drain`      等手上 job 收尾（pg-boss `graceful:true`，上限 30s）
 *  3. `containers.release` 兜底销毁仍在跑的容器（正常路径由 worker 的 dispose 步做完）
 *  4. `host.stop`         关 pi-host（`SIGTERM` → 宽限 → `SIGKILL`，见 `HostSupervisor.stop`）
 *  5. `pool.close`        关业务连接池（队列池由 `queue.stop` 自己关）
 *  6. `metrics.close`     最后关 metrics 实例（让停机过程里也能被抓到指标）
 *
 * systemd 的 `TimeoutStopSec=90` 是**总**预算；本文件的每一步都在 30s 以内，
 * 加起来留了余量（队列 30s 是唯一的大头）。
 */
export const SHUTDOWN_STEPS = [
  'http.close',
  'worker.drain',
  'containers.release',
  'host.stop',
  'pool.close',
  'metrics.close',
] as const;

export type ShutdownStep = (typeof SHUTDOWN_STEPS)[number];

/** pg-boss 优雅停止的上限（与 `queue/boss.ts::stopBoss` 同一个数字）。 */
export const QUEUE_STOP_TIMEOUT_MS = 30_000;

/** 装配层错误码。 */
export const APP_ERROR_CODES = {
  migrationsPending: 'MIGRATIONS_PENDING',
  repoUnusable: 'REPO_UNUSABLE',
  alreadyStarted: 'APP_ALREADY_STARTED',
} as const;

/* ── issue agent 会话：复用 / 轮换（`docs/req-issue-agent.md` §1.2）────────────────── */

/**
 * 会话轮换的阈值（系统级常量：30 轮 / 7 天）。
 *
 * 这两个数字原来在 `config/pipeline-constants.ts`（已随流水线删除），现在就近定义在这里 ——
 * 它们是「上下文预算法」的一部分，v0.3 的 `docs/agent-context.md`（D-2）定稿后若调整，
 * 只改这一处。
 */
export const AGENT_SESSION_POLICY = Object.freeze({
  maxTurns: 30,
  maxAgeDays: 7,
});

/** 轮换原因（面板要能解释「为什么这一轮换了会话」）。 */
export type AgentSessionRotationReason = 'turns' | 'age';

/** `agent_sessions` 的一行（会话状态的**唯一**来源；原来住在 `issue_pipeline`）。 */
export type AgentSessionRow = {
  readonly sessionId: string | null;
  /** `events/subscribe` 的 `after` 游标 */
  readonly cursor: number;
  /** 该会话已用轮数 */
  readonly turns: number;
  readonly startedAt: Date | null;
};

/** 一次 agent run 的会话计划（`executeTask()` 用它决定 attach / archive / 新建）。 */
export interface AgentSessionPlan {
  /** 交给 `runTask()` 的会话计划；`undefined` = 缺省 `ephemeral`（非 agent 任务）。 */
  readonly session: SessionPlan | undefined;
  readonly rotate: boolean;
  readonly rotateReason: AgentSessionRotationReason | null;
  /** 需要**先 archive** 的旧会话（`rotate:false` 时恒 `null`）。 */
  readonly archiveSessionId: string | null;
}

/**
 * agent 任务的会话决策（**纯函数**：时钟由参数给，便于单测把「第 30 轮」「第 8 天」直接摆出来）。
 *
 * 四条规则：
 *  1. **不是 agent 任务** → `undefined`（ephemeral，跑完归档；`/review-pr`、`@answer` 都是这样）；
 *  2. **第一次**：没有 `session_id` → `{mode:'persistent'}`（新建会话，本轮结束后落 id）；
 *  3. **复用**：有 id → `{mode:'persistent', sessionId, after: cursor}`（`after` 防重放旧事件）；
 *  4. **轮换**：`turns >= maxTurns` 或存活超过 `maxAgeDays` → 先 archive 旧会话再新建。
 */
/**
 * `tasks.command` → v2.1 会话状态机的事件键。
 *
 * v0.3 的 agent 任务只带命令名（事件类型不在 `tasks` 行上），所以这里是**保守推断**：
 * 认不出的命令按 `issues.edited`（普通复用）处理，绝不猜成 `issues.closed` ——
 * 后者会回收活跃沙箱。权威判定仍在 webhook 侧（那里有真实的 `X-GitHub-Event`）。
 */
export function v21EventOfCommand(command: string): SessionEventKey {
  switch (command.trim().toLowerCase()) {
    case 'agent:opened':
      return 'issues.opened';
    case 'agent:edited':
      return 'issues.edited';
    case 'agent:closed':
      return 'issues.closed';
    case 'agent:mention':
      return 'issue_comment.created';
    default:
      return 'issues.edited';
  }
}

/** v2.1 会话状态机的纯函数出口（FR-3.4：只有 active/idle，永不删会话行）。 */
export function planV21SessionOnTask(input: PlanSessionOnEventInput): SessionTransition {
  return planSessionOnEvent(input);
}

/**
 * v2.1 会话状态迁移的**落库语句**（FR-3.4 / AC-23）。
 *
 * 只有 INSERT / UPDATE，**没有 DELETE**：issue 随时可能重开，删掉会话行就等于把
 * 重开后的上下文一起丢了。同理这里也不发 `session/archive`（RACP 归档）——
 * 关闭只回收沙箱资源，数据动作一律不做。
 */
export const V21_SESSION_TRANSITION_SQL = {
  read: `SELECT "state", "sandbox_id", "session_id", "turns", "cursor"
FROM "agent_sessions" WHERE "repo" = $1 AND "issue_number" = $2`,
  create: `INSERT INTO "agent_sessions"
  ("repo", "issue_number", "state", "sandbox_id", "closed_at", "cursor", "turns", "updated_at")
VALUES ($1, $2, $3, $4, NULL, 0, 0, now())
ON CONFLICT ("repo", "issue_number") DO NOTHING`,
  recycle: `UPDATE "agent_sessions"
SET "state" = 'idle', "sandbox_id" = NULL, "closed_at" = now(), "updated_at" = now()
WHERE "repo" = $1 AND "issue_number" = $2`,
  reuse: `UPDATE "agent_sessions"
SET "state" = 'active', "sandbox_id" = COALESCE("sandbox_id", $3), "closed_at" = NULL, "updated_at" = now()
WHERE "repo" = $1 AND "issue_number" = $2`,
} as const;

/** 一次事件后的会话迁移计划（纯函数：单测可以按输入矩阵逐格断言）。 */
export interface V21SessionTransitionPlan {
  readonly transition: SessionTransition;
  readonly sql: string;
  readonly params: readonly unknown[];
  /** 恒为 `false`：会话行永不删除。 */
  readonly deleteSession: false;
  /** 恒为 `null`：v2.1 路径永不 archive。 */
  readonly archiveSessionId: null;
  /**
   * `planSessionOnEvent()` 只给结论、不碰沙箱；`true` 时**由装配层**决定要不要（重新）
   * 拉起沙箱，并把新 id 通过 `sandboxId` 回填到 `reuse` / `create` 的 SQL 参数里。
   */
  readonly rebuildSandbox: boolean;
}

/**
 * 把 `planSessionOnEvent()` 的结论翻译成「只改状态、不动数据」的一条 SQL。
 *
 * 三条映射（顺序即 FR-3.4 / AC-23）：
 *  - `issues.closed` 且 issue 实时状态确为 closed → `recycle-sandbox`：
 *    `state='idle'`、`sandbox_id=NULL`、`closed_at=now()`，会话行原样保留；
 *  - 重开 / 已关闭 issue 上的其它触发 → `reuse`：
 *    `state='active'`、`closed_at=NULL`，沙箱按需重建；
 *  - 首次 → `create`：只 INSERT 一行，不删任何东西、不 archive。
 */
export function planV21SessionOnEvent(input: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly session: V21AgentSessionRow | null;
  readonly event: SessionEventKey;
  readonly issueState: 'open' | 'closed';
  readonly sandboxId?: string | null | undefined;
}): V21SessionTransitionPlan {
  const transition = planSessionOnEvent({
    session: input.session,
    issueState: input.issueState,
    event: input.event,
  });
  const sandboxId = input.sandboxId ?? null;
  let sql: string;
  let params: readonly unknown[];
  if (transition.action === 'create') {
    sql = V21_SESSION_TRANSITION_SQL.create;
    params = [input.repo, input.issueNumber, transition.state, sandboxId];
  } else if (transition.action === 'recycle-sandbox') {
    sql = V21_SESSION_TRANSITION_SQL.recycle;
    params = [input.repo, input.issueNumber];
  } else {
    sql = V21_SESSION_TRANSITION_SQL.reuse;
    params = [input.repo, input.issueNumber, sandboxId];
  }
  return {
    transition,
    sql,
    params,
    deleteSession: false,
    archiveSessionId: null,
    rebuildSandbox: transition.rebuildSandbox,
  };
}

/** 从 `agent_sessions` 的行还原 `planSessionOnEvent()` 要的运行时快照。 */
export function v21SessionRowOf(
  row: Record<string, unknown> | undefined,
  key: { readonly repo: string; readonly issueNumber: number },
): V21AgentSessionRow | null {
  if (row === undefined) {
    return null;
  }
  const text = (name: string): string | null =>
    typeof row[name] === 'string' ? (row[name] as string) : null;
  const int = (name: string): number =>
    typeof row[name] === 'number' && Number.isFinite(row[name]) ? Math.trunc(row[name] as number) : 0;
  return {
    repo: key.repo,
    issueNumber: key.issueNumber,
    sessionId: text('session_id'),
    state: text('state') === 'active' ? 'active' : 'idle',
    sandboxId: text('sandbox_id'),
    turns: int('turns'),
    cursor: int('cursor'),
  };
}

/**
 * 读现状 → 算迁移 → 只写一条 UPDATE/INSERT。**不删行、不 archive。**
 *
 * `planSessionOnEvent()` 是纯函数，`rebuildSandbox=true` 只表示「该拉沙箱了」，真正的
 * 资源动作由装配层通过 `hooks.createSandbox()` 注入；拿到新 id 后重算一次**纯函数**计划，
 * 让 `reuse`/`create` 的 SQL 把 `sandbox_id` 一并写进去（不重写规则、不碰 DB 之外的东西）。
 * 没注入 `createSandbox` 时只更新状态列 —— 本仓库的容器是 **runTask 每轮创建、结束即销毁**
 * 的临时沙箱（`sandbox/lifecycle.ts`），并没有常驻的 per-session 沙箱可拉起，因此
 * `rebuildSandbox` 会如实留在返回的计划里供调用方留痕，不假装已经创建。
 */
export async function applyV21SessionTransition(
  db: SqlExecutor,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly event: SessionEventKey;
    readonly issueState: 'open' | 'closed';
    readonly sandboxId?: string | null | undefined;
  },
  hooks: { readonly createSandbox?: (() => Promise<string | null>) | undefined } = {},
): Promise<V21SessionTransitionPlan> {
  const result = await db.query(V21_SESSION_TRANSITION_SQL.read, [input.repo, input.issueNumber]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const base = {
    repo: input.repo,
    issueNumber: input.issueNumber,
    session: v21SessionRowOf(row, { repo: input.repo, issueNumber: input.issueNumber }),
    event: input.event,
    issueState: input.issueState,
  };
  const planOf = (sandboxId: string | null): V21SessionTransitionPlan =>
    planV21SessionOnEvent({ ...base, sandboxId });

  let plan = planOf(input.sandboxId ?? null);
  if (plan.transition.rebuildSandbox && hooks.createSandbox !== undefined) {
    // 资源动作失败就不该把状态标成 active：直接抛，由调用方记 warn（不改变已存在的会话行）。
    const createdId = await hooks.createSandbox();
    plan = planOf(createdId ?? input.sandboxId ?? null);
  }
  await db.query(plan.sql, [...plan.params]);
  return plan;
}

export function planAgentSession(input: {
  readonly session: AgentSessionRow | null;
  /** 这一轮是不是 agent 任务（`tasks.source === 'agent'`）。 */
  readonly isAgentTask: boolean;
  readonly at: Date;
  readonly maxTurns?: number;
  readonly maxAgeDays?: number;
}): AgentSessionPlan {
  const idle: AgentSessionPlan = {
    session: undefined,
    rotate: false,
    rotateReason: null,
    archiveSessionId: null,
  };
  if (!input.isAgentTask) {
    return idle;
  }
  const maxTurns = input.maxTurns ?? AGENT_SESSION_POLICY.maxTurns;
  const maxAgeDays = input.maxAgeDays ?? AGENT_SESSION_POLICY.maxAgeDays;
  const sessionId = input.session?.sessionId ?? null;
  if (sessionId === null || sessionId === '') {
    // 第一轮：新建（`persistent` 不 archive，下一轮才能 attach）
    return { session: { mode: 'persistent' }, rotate: false, rotateReason: null, archiveSessionId: null };
  }

  const startedAt = input.session?.startedAt ?? null;
  const ageMs = startedAt === null ? 0 : input.at.getTime() - startedAt.getTime();
  const reason: AgentSessionRotationReason | null =
    (input.session?.turns ?? 0) >= maxTurns
      ? 'turns'
      : ageMs >= maxAgeDays * 86_400_000
        ? 'age'
        : null;
  if (reason !== null) {
    return {
      // 不带 `sessionId`：`driveTurn` 会新建会话；旧会话由 `executeTask()` 先 archive
      session: { mode: 'persistent' },
      rotate: true,
      rotateReason: reason,
      archiveSessionId: sessionId,
    };
  }
  const cursor = input.session?.cursor ?? 0;
  return {
    session: {
      mode: 'persistent',
      sessionId,
      // **只在本轮真的有过游标时才传 `after`**：恒传 `after: cursor`（缺省 0）会让
      // `turn-driver` 的「没给 `after` 时用 attach 快照游标兜底」分支永不生效 ——
      // `session_id` 有值但 `cursor` 还没回填（0）时，会 `subscribe{after:0}`
      // 把整段旧事件重放一遍，旧信封有机会污染本轮。
      ...(cursor > 0 ? { after: cursor } : {}),
    },
    rotate: false,
    rotateReason: null,
    archiveSessionId: null,
  };
}


/* ── 注入面 ───────────────────────────────────────────────────────────────── */

export interface ApplicationOverrides {
  readonly logger?: Logger;
  readonly pool?: Pool;
  readonly queue?: AppQueue;
  /** 整组 worker 端口（测试一次性替换；优先于下面几个单项注入） */
  readonly ports?: WorkerPorts;
  readonly docker?: SandboxDocker;
  readonly worktree?: WorktreePort;
  readonly host?: HostPort;
  readonly github?: GithubWriteApi;
  readonly racp?: RacpChannelFactory;
  readonly verify?: WebhookVerify;
  readonly ack?: WebhookAck;
  readonly queries?: Queries;
  /**
   * reaction 写面（测试注入假实现）：给了就跳过「按 App 客户端造 reaction 端口」这一步，
   * 于是装配级测试能断言「终态真的打了 rocket / confused」而不打网络。
   */
  readonly reactions?: GithubReactionApi;
  /** 标签目录端口（测试注入）：`labels.missing` 的三策略需要它。 */
  readonly labelCatalog?: LabelCatalogPort;
  readonly metrics?: Metrics;
  readonly metricsServer?: MetricsServer;
  readonly requireAuth?: BuildServerDeps['requireAuth'];
  readonly now?: () => Date;
  /** 不注册定时作业（测试里不需要 pg-boss 的 cron）。 */
  readonly skipSchedules?: boolean;
}

/** `start()` 之后的实际监听地址（端口 0 时这里给的是内核分配的端口）。 */
export interface ApplicationAddresses {
  readonly http: { readonly host: string; readonly port: number };
  readonly metrics: { readonly host: string; readonly port: number };
}

export interface TaskExecutionInput {
  readonly taskId: string;
  /** 第几次尝试（从 1 起）；不给就用 `tasks.attempt + 1`。 */
  readonly attempt?: number;
  /** 强制 dry-run（`replay` / 测试用）；不给则「配置 || 仓库开关」。 */
  readonly dryRun?: boolean;
  /**
   * 触发本轮的真实 webhook 事件（v2.1 会话状态机用）。
   *
   * 不给 = 不在这里改会话状态（webhook 侧才是权威写入点，见 `http/webhook.ts` 的
   * `applyV21SessionOnEvent`）。`tasks` 行上没有事件列，所以这一项由调用方
   * （`app.executeTask()` 的直连调用 / 未来的 job 载荷）显式给，避免按命令名瞎猜。
   */
  readonly sessionEvent?: {
    readonly event: SessionEventKey;
    readonly issueState: 'open' | 'closed';
    readonly sandboxId?: string | null | undefined;
  };
}

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly queue: AppQueue;
  readonly ports: WorkerPorts;
  /** 主 Fastify 实例（**已装配未监听**；`start()` 才 listen）。 */
  readonly server: FastifyInstance;
  readonly metricsServer: MetricsServer;
  readonly addresses: ApplicationAddresses | null;
  readonly started: boolean;
  /** 已执行的停机步骤（按执行顺序；测试断言 §3.4 的顺序用）。 */
  readonly shutdownSteps: readonly ShutdownStep[];
  start(): Promise<ApplicationAddresses>;
  stop(): Promise<void>;
  /**
   * 跑一次任务（不经队列）。`serve` 的 job handler 与端到端测试**共用**这条路径 ——
   * 这样「线上跑的」与「测试验的」是同一段装配，而不是两份相似代码。
   */
  executeTask(input: TaskExecutionInput): Promise<TaskRunReport>;
}

/* ── 默认件 ───────────────────────────────────────────────────────────────── */

function createDefaultQueue(config: AppConfig): AppQueue {
  // 这一行是「窄接口不漂移」的编译期保证：PgBoss 不满足 AppQueue 时这里 TS2322。
  const boss: PgBoss = createBoss({
    connectionString: config.pgDsn,
    applicationName: 'pi-bot-queue',
  });
  return boss;
}

/** 有 bundle 就真起 pi-host；没有就换成「明确失败」的端口（并说明缺什么）。 */
function createDefaultHostPort(config: AppConfig, logger: Logger): HostPort {
  const bundleDir = config.host.bundleDir;
  if (bundleDir === null) {
    logger.warn(
      {},
      '未配置 PI_BOT_HOST_BUNDLE_DIR：本机没有 vendor/pi-host bundle，任务会在 host 步骤以 HOST_UNAVAILABLE 失败',
    );
    return createUnavailableHostPort('未配置 PI_BOT_HOST_BUNDLE_DIR（本机没有 vendor/pi-host bundle）');
  }
  // bundle 可以自带 `runner.json` 声明启动命令（Windows 开发机：`node pi-host.js`）；
  // 没声明就是 §2.2 的 `bin/pi-host`。见 `runtime/pin.ts::resolveBundleCommand`。
  const command = resolveBundleCommand(bundleDir);
  if (command.prependArgs.length > 0) {
    logger.info(
      { command: command.command, prependArgs: command.prependArgs },
      'bundle 自带 runner.json：按它启动 pi-host（Linux 生产不会走这条）',
    );
  }
  const supervisor = new HostSupervisor({
    spawn: createNodeHostSpawn(),
    binaryPath: command.command,
    prependArgs: command.prependArgs,
    dataDir: config.host.dataDir,
    port: config.host.port,
    logger,
    // 模型端点从这里进 pi-host：base URL / key / model 三个，别名同时写（见 model-env.ts）。
    // key 只在可信侧（bot + pi-host），永不进任务容器（plan §8.4）。
    extraEnv: hostModelEnv(config),
  });
  // 设备令牌来自环境（`PI_BOT_HOST_TOKEN`）：常驻 Host 没有 `--pair` 行，必须显式传。
  return createSupervisorHostPort(supervisor, { token: config.host.token ?? undefined });
}

/**
 * 真实检出：`RepoCache`（clone 缓存 + `git worktree add --detach`）接成 `WorktreePort`。
 *
 * 为什么放在装配层：`git/` 只认识 `RepoCache` 与 `RunGit`，`config` 与日志面都是装配层的知识。
 * 私有仓库的认证走 remote URL 里的 token（`x-access-token:` 形式），token 只活在这个闭包里，
 * 不会进容器、也不会写进 `tasks`/`runs`——写回推送另有 `push.ts` 的 askpass 通道。
 */
function createDefaultWorktreePort(config: AppConfig, logger: Logger): WorktreePort {
  const token = config.github.token;
  const runGit = createExecFileRunGit({ env: { GIT_TERMINAL_PROMPT: '0' } });
  const cache = new RepoCache({
    cacheRoot: config.worker.cacheRoot,
    runGit,
    logger,
  });
  return createRepoWorktreePort({
    cache,
    jobRoot: config.worker.jobRoot,
    logger,
    ...(token === null
      ? {}
      : { remoteUrl: (repo: string) => `https://x-access-token:${token}@github.com/${repo}.git` }),
  });
}

/** 没有令牌时的 ack：明确报错，让 webhook handler 记 warn 并继续回 200（§5.3 第 8 步）。 */
export function createUnavailableWebhookAck(reason: string): WebhookAck {
  const fail = async (): Promise<void> => {
    throw new Error(`webhook ack 不可用：${reason}`);
  };
  return { addEyesReaction: fail };
}

/**
 * 面板鉴权：`off` 直接放行（`PI_BOT_PANEL_AUTH=off`，缺省只在 loopback 上），
 * `session` 走 `panel_sessions` 的 cookie 会话。
 *
 * 为什么允许 `off`：本地面板（127.0.0.1）没有外部可达面，而 OAuth 流程尚未接入；
 * 关掉只影响 `/api/*` 的读接口，`/webhook` 的验签与 worker 的写面完全不受影响。
 */
function createPanelAuth(config: AppConfig, store: SessionStore, logger: Logger): RequireAuth {
  if (config.panelAuth === 'off') {
    logger.warn({}, '面板鉴权已关闭（PI_BOT_PANEL_AUTH=off）：/api/* 不做会话校验，仅适用于 loopback');
    return createAllowAllAuth();
  }
  return createSessionAuth({ store, logger });
}

/**
 * GitHub 客户端装配：**App 认证优先**（installation token），token 兜底，都没有就 `null`。
 * 解析逻辑与「缺什么」的措辞在 `github-auth.ts`；这里只负责按模式记一条启动日志。
 */
function createDefaultGithubClient(config: AppConfig, logger: Logger): GithubClient | null {
  const resolution = resolveGithubAuth(config);
  if (resolution.mode === 'degraded') {
    logger.warn({ githubAuthMode: resolution.mode }, resolution.detail);
  } else {
    logger.info({ githubAuthMode: resolution.mode }, resolution.detail);
  }
  return resolution.client;
}
/**
 * 容器记账装饰器：包住 `createContainer` / `destroyContainer`，维护「当前还活着的容器 id」。
 *
 * 为什么需要：停机时若某个 run 卡在 dispose 之前，容器会漏下来（§3.4 的「释放容器」）。
 * 装饰器只加两个 `Set` 操作，不改任何行为 —— 正常路径下容器照样由 `sandbox/lifecycle.ts`
 * 的 `dispose()` 销毁，这里只是给停机流程一个**确定的**兜底清单。
 */
function trackContainers(docker: SandboxDocker, live: Set<string>): SandboxDocker {
  return {
    ping: () => docker.ping(),
    async createContainer(spec) {
      const id = await docker.createContainer(spec);
      live.add(id);
      return id;
    },
    inspectState: (containerId) => docker.inspectState(containerId),
    execStream: (request) => docker.execStream(request),
    async destroyContainer(containerId) {
      live.delete(containerId);
      await docker.destroyContainer(containerId);
    },
  };
}

/* ── schema 检查（serve 不迁移，只检查）───────────────────────────────────── */

/** 业务表清单（`migrations/` 建的那些；pg-boss 的表由 `queue.start()` 自己建）。 */
export const REQUIRED_TABLES = [
  'tasks',
  'runs',
  'run_events',
  'envelopes',
  'actions',
  'webhook_deliveries',
  'repos',
  'runtime_flags',
  // 0002：技能管理（面板可写面）。缺表 → 技能接口与上传全废，所以纳入启动自检。
  'skills',
  'skill_versions',
  'skills_audit',
  // 0006：issue agent（缺表 → 会话连续性 / 消息队列 / 拒绝记账全废，同样纳入启动自检）
  'agent_sessions',
  'agent_messages',
  'agent_denials',
] as const;

/**
 * 检查业务表是否齐（**不迁移**）。缺表 → `MIGRATIONS_PENDING`，信息里直接给修复命令。
 *
 * 为什么在监听端口**之前**检查：一个缺表的进程能收 webhook、能入队、然后在 worker 里
 * 一条条 500；还不如启动就失败（systemd 会重试，人也会看到日志）。
 */
export async function assertSchemaReady(db: SqlExecutor): Promise<void> {
  const result = await db.query(
    `select "table_name" from "information_schema"."tables" where "table_schema" = 'public'`,
  );
  const present = new Set(
    (result.rows as Array<Record<string, unknown>>).map((row) => String(row['table_name'])),
  );
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new AppError(
      `数据库缺表：${missing.join(', ')}。先跑 \`pi-bot migrate\`（serve 不自动迁移）`,
      {
        code: APP_ERROR_CODES.migrationsPending,
        failureClass: 'unknown',
        retriable: false,
        details: { missing, required: [...REQUIRED_TABLES] },
      },
    );
  }
}

/* ── 装配 ─────────────────────────────────────────────────────────────────── */

export function createApplication(config: AppConfig, overrides: ApplicationOverrides = {}): Application {
  const logger = overrides.logger ?? createLogger({ service: 'pi-bot', level: config.logLevel });
  const now = overrides.now ?? ((): Date => new Date());

  const pool =
    overrides.pool ??
    createPool({ connectionString: config.pgDsn, applicationName: 'pi-bot' });
  const queue = overrides.queue ?? createDefaultQueue(config);

  // ── worker 端口（docker / exec 代理 / lifecycle / host / github / worktree）──
  const baseGithubClient = createDefaultGithubClient(config, logger);
  const matchableGithub =
    overrides.github !== undefined
      ? { github: overrides.github }
      : baseGithubClient === null
        ? {}
        : // 写面优先用 App 认证的客户端：评论/打标会显示成 `<app-slug>[bot]`，
          // 与 webhook ack 用的是同一个客户端。只有 App 不可用才回落到静态 token 分支。
          { github: createGithubWriteApi(baseGithubClient) };
  const declaredPorts =
    overrides.ports ??
    createWorkerPorts({
      config,
      pool,
      logger,
      ...(overrides.docker === undefined ? {} : { docker: overrides.docker }),
      worktree: overrides.worktree ?? createDefaultWorktreePort(config, logger),
      // 有 bundle 就真起 pi-host（`HostSupervisor`）；没有就换成「明确失败」的端口并告警
      host: overrides.host ?? createDefaultHostPort(config, logger),
      ...matchableGithub,
    });
  const liveContainers = new Set<string>();
  const ports: WorkerPorts = {
    ...declaredPorts,
    docker: trackContainers(declaredPorts.docker, liveContainers),
  };

  // ── W2-D 无感反馈 + W2-E 打标策略的装配点 ───────────────────────────────────
  //
  // 这两组依赖的注入位置就在进程装配这一层：台账在 `feedback/`（要池）、reaction 在
  // `github/`（要 App 客户端）、降级开关在 `runtime_flags`（要池）—— 只有这里同时认识它们。
  //
  // `feedback === null` 表示「本部署没有可用的 reaction 写面」（没装 App）：worker 缺端口
  // 就是不打 reaction，而不是每轮记一条失败。dry-run 另有一层拦阻（一个 reaction 都不打）。
  const feedback =
    createWorkerFeedbackDeps({
      pool,
      // 测试注入假 reaction 时不需要客户端；反之才按 App 认证的客户端造。
      ...(overrides.reactions === undefined ? { client: baseGithubClient } : { reactions: overrides.reactions }),
      // App 身份在 GitHub 上显示成 `<slug>[bot]`，删自己的 reaction 时靠它判别归属。
      appSlug: config.github.mention,
    });
  // `bot_labels` 记账（W2-E）：进程级建一次（它只依赖池）。
  const botLabelLedger = createBotLabelLedger(pool);
  // 标签目录（`labels.missing` 的判据）：只有真客户端才有。
  const labelCatalog: LabelCatalogPort | undefined =
    overrides.labelCatalog ??
    (baseGithubClient === null ? undefined : createGithubLabelCatalog(baseGithubClient));
  // `workflows/` 的 reaction 端口（缺信息时打 `confused`）：与终态反馈共用同一个写面。
  const workflowReactions = feedback === null ? undefined : createWorkflowReactionPort(feedback.reactions);

  const racp: RacpChannelFactory =
    overrides.racp ?? createRacpChannelFactory({ logger });

  // ── http / metrics ───────────────────────────────────────────────────────
  const queries = overrides.queries ?? createQueries({ pool, now });
  // 技能存储（面板可写面）：库里存清单与版本，正文落 `<PI_BOT_DATA_DIR>/skills/<id>/<version>/`。
  const skillStore = createSkillStore({ pool, dataDir: config.dataDir });
  const metrics = overrides.metrics ?? createMetrics({ defaultMetrics: true });
  const metricsServer =
    overrides.metricsServer ??
    createMetricsServer({ metrics, host: config.metrics.host, port: config.metrics.port, logger });

  /* ── v2.1 运行时（FR-2.3 / FR-5.3 / FR-5.6）─────────────────────────────
   * 全部做成「注入到 webhook / runTask 的对象」，两个旧链路本身只多一个 `v21` 可选字段。
   * 这样旧路径（source='pipeline'|'command'）与既有单测不会被新逻辑改到。
   */
  const v21RepoIssues =
    baseGithubClient === null
      ? undefined
      : // 只建一份：{{repo.issues}} 的项目级 5 分钟缓存必须跨投递复用
        createRepoIssuesProvider({ listIssues: createRepoIssuesLister(baseGithubClient.request) });
  const v21Executor = createV21Executor({
    write: ports.github,
    settings: async (repo) => (await readRepoPolicy(pool, repo)).settings ?? null,
    ...(feedback === null ? {} : { reactions: v21ReactionsOf(feedback.reactions) }),
    ...(baseGithubClient === null
      ? {}
      : { openPullRequest: createV21OpenPullRequest(baseGithubClient.request) }),
  });
  const v21CompactionHook = createV21CompactionHook(pool);
  /** `runTask` 的 v2 钩子：v2 产出分流 + 压缩事件留痕 + 暴露压缩引擎入口。 */
  const v21RunnerHooks = {
    execute: async (
      text: string,
      ctx: { readonly repo: string; readonly issueNumber: number; readonly dryRun: boolean },
    ) => {
      // `label` 目标态需要「当前标签」与「我们打过的标签」；两者都从 bot_labels 台账读，
      // 读失败退化为空集（执行器会按「只加不删」处理，比用过期数据删标签安全）。
      const currentLabels = await readAppliedLabels(pool, ctx.repo, ctx.issueNumber).catch(() => []);
      const outcome = await v21Executor(text, { ...ctx, currentLabels, botLabels: currentLabels });
      return {
        handled: outcome.handled,
        valid: outcome.valid,
        errors: outcome.errors,
        verdict: outcome.output?.verdict ?? null,
        actions: outcome.output?.actions ?? [],
        executed: (outcome.result?.executed ?? []).map((item) => ({
          index: item.index,
          type: item.type,
          outcome: item.outcome,
        })),
        stoppedAt: outcome.result?.stoppedAt ?? null,
      };
    },
    onEvent: v21CompactionHook,
    // 只暴露不调用：RACP 没有 history/compact 操作，请求前自动压缩尚属遗留（见最终报告）
    compactor: createV21Compactor,
  };

  const verify = overrides.verify ?? createOctokitVerifier(config.webhook.secret);
  const ack: WebhookAck =
    overrides.ack ??
    (baseGithubClient === null
      ? createUnavailableWebhookAck('未配置 PI_BOT_GITHUB_TOKEN')
      : createGithubWebhookAck(baseGithubClient));

  /**
   * 入队通道：webhook 与「阶段交接」（compose 自己把 pass 推进到 `pipeline:classify`）共用同一个。
   *
   * 共用的意义不只是省一个对象：`singletonKey = taskId` 与 `expireInSeconds` 按命令取值这两条
   * 语义只能有一处实现，否则阶段交接入队的任务会拿到不同的执行闸。
   */
  const enqueuer = createQueueEnqueuer(queue);

  /**
   * agent 串行调度（v0.3 S1）：`agent_messages` 本身就是队列，这里只负责「领一条 + 投 run-task」。
   *
   * `singletonKey` 按**消息**唯一（`agent:<repo>#<n>:<fingerprint>`）：同一条消息被重复投递会
   * 被队列去重，而不同消息各自独立 —— 这正是「排队」的语义（用 `taskId` 或 issue 粒度的 key
   * 会让第二条消息被丢掉，见 `queue/boss.ts` 的注释）。
   */
  const agentDispatch: AgentDispatchDeps = {
    db: pool,
    logger: {
      info: (detail, message) => {
        logger.info(detail, message);
      },
      warn: (detail, message) => {
        logger.warn(detail, message);
      },
    },
    enqueue: async ({ taskId, repo, command, message }) =>
      queue.send(
        QUEUE.runTask,
        { taskId, command, repo },
        {
          singletonKey: `agent:${repo}#${String(message.issueNumber)}:${message.fingerprint}`,
          expireInSeconds: expireInSecondsForCommand(command),
          retryLimit: 0,
        },
      ),
  };

  /**
   * 无 worktree 时的 AGENTS.md（Q9：任意阶段生效）。
   *
   * 阶段 1（sandboxed）从 worktree 读（enricher 负责）；**阶段 0 是 light**，没有检出，
   * 所以走 GitHub `contents` 端点读仓库根那一份 —— 带 5 分钟缓存，读不到就 `null` + 一次 warn。
   * 没有 GitHub 读面（本机没装 App）时 `reader: null` = 永远 `null`，一条日志都不刷。
   */
  const queueHealth = async (): Promise<HealthCheck[]> => {
    const stats = await queue.getQueueStats(QUEUE.runTask);
    const latest = stats.at(-1);
    const detail =
      latest === undefined
        ? '无队列统计'
        : `queued ${String(latest.queuedCount)} active ${String(latest.activeCount)}`;
    return [{ id: 'queue.runTask', status: 'ok', detail }];
  };

  const server = buildServer({
    logger,
    pool,
    queries,
    skills: { store: skillStore, writeMode: config.panelWrite },
    // TODO(owner: 面板鉴权切片)：OAuth + `isOrgMember` 接进来之前只有会话校验（401 完整、403 待接）
    requireAuth: overrides.requireAuth ?? createPanelAuth(config, pool, logger),
    webhook: {
      verify,
      db: pool,
      enqueue: enqueuer,
      // 触发别名：部署默认（`@issuebot` / `@ibot`）+ App slug；仓库配置里的 `triggers` 与之合并
      aliases: resolveTriggerAliases({ deployment: [...DEFAULT_TRIGGER_ALIASES, config.github.mention] }),
      ack,
      freeMention: config.freeMention,
      logger,
      // 面板上传且启用的技能名：让 `/demo` 这类命令不必先进仓库配置就能被调用
      // （spec D0「上传即生效」；关掉开关后下一份投递就不再放行）。
      listSkills: (repo) => skillStore.activeSkillNames(repo),
      // reaction 写面（`agent/ack.ts`）：与终态反馈共用同一个 App 客户端；没有写面时静默。
      ...(feedback === null ? {} : { reactions: feedback.reactions }),
      appSlug: config.github.mention,
      // 非管理员的「无权限」回复（同 issue 同 actor 只回一次；dry-run 时由 webhook 侧跳过）
      replyDenied: async (input) => {
        await ports.github.createIssueComment({
          repo: input.repo,
          issueNumber: input.issueNumber,
          body: input.text,
        });
      },
      // agent 消息落库后**立刻**为这个 issue 领一条（cron 那条只是兜底）
      dispatchAgent: (key) => dispatchNextForIssue(agentDispatch, key),
      now,
      // v2.1：判定留痕 + 模板渲染。注入即启用，不注入时旧 webhook 行为完全不变。
      v21: {
        db: pool,
        ...(v21RepoIssues === undefined ? {} : { repoIssues: v21RepoIssues }),
      },
    },
    metrics,
    bodyLimitBytes: config.http.bodyLimitBytes,
    openapi: config.http.openapi,
    queueHealth,
    appVersion: APP_VERSION,
    now,
  });

  // ── 任务执行（job handler 与测试共用的唯一路径）───────────────────────────
  let shutdownSteps: ShutdownStep[] = [];
  let started = false;
  let stopping = false;
  let addresses: ApplicationAddresses | null = null;

  /**
   * 这个 issue 的持久会话（`agent_sessions` 一行）。
   *
   * 会话状态原来是 `issue_pipeline` 的四列；流水线退役后它搬到 `agent_sessions`
   * （`docs/dev-plan-issue-agent.md` §4）。读失败 → `null`（按「还没有会话」处理，
   * 本轮新建；不影响任务结论）。
   */
  const loadAgentSession = async (key: {
    readonly repo: string;
    readonly issueNumber: number;
  }): Promise<AgentSessionRow | null> => {
    try {
      return await loadAgentSessionRow(pool, key);
    } catch (error) {
      logger.warn(
        { repo: key.repo, issue: key.issueNumber, err: String(error) },
        '读 agent_sessions 失败：本轮按「还没有会话」处理',
      );
      return null;
    }
  };

  /** 写回会话字段（`agent_sessions` 的 UPSERT：一个 issue 一行）。 */
  const persistAgentSessionAfterRun = async (params: {
    readonly row: TaskJobRow;
    readonly session: AgentSessionRow | null;
    readonly report: TaskRunReport;
    readonly agentSession: AgentSessionPlan;
  }): Promise<void> => {
    // 非 agent 任务不落会话字段：它们各自 ephemeral（跑完归档）。
    if (params.agentSession.session === undefined) {
      return;
    }
    const rotate = params.agentSession.rotate;
    // 轮换那一轮的 `turns` 从 **1** 起（本轮已经跑在新会话上）；按「归零」字面实现会让
    // 新会话的第一轮永远不被计数，实际变成每 31 轮才轮换一次。
    const turns = rotate ? 1 : (params.session?.turns ?? 0) + 1;
    // 轮换时旧会话已归档：新 id 可能是 `null`（本轮没建起会话），那就把列清空，
    // 免得下一轮去 attach 一个已经归档的会话。
    const sessionId =
      params.report.sessionId !== null ? params.report.sessionId : rotate ? null : (params.session?.sessionId ?? null);
    const cursor = params.report.sessionCursor ?? params.session?.cursor ?? 0;
    const startedAt = rotate || params.session?.startedAt == null ? now() : params.session.startedAt;
    if (rotate || params.report.sessionReset) {
      logger.info(
        { repo: params.row.repo, issue: params.row.targetNumber, reason: params.agentSession.rotateReason },
        'agent 会话重置：上下文断了一次（不阻塞下一轮）',
      );
    }
    await saveAgentSessionRow(
      pool,
      { repo: params.row.repo, issueNumber: params.row.targetNumber },
      { sessionId, cursor, turns, startedAt },
    );
  };

  /**
   * agent 消息的终态收尾（`done` / `failed`）+ **立刻**领这个 issue 的下一条。
   *
   * 任务与消息的连接键是 `tasks.idempotency_key`（`agent:message:<repo>#<n>:<fingerprint>`，
   * 见 `agent/store.ts::agentTaskIdempotencyKey`）：`tasks` 没有指向 `agent_messages` 的外键，
   * 而这条键是唯一索引 + 我们自己拼的字符串，天然一对一。
   *
   * 失败**不影响**任务结论：run 已经跑完并落库，消息状态下一轮 dispatch 还能再修。
   */
  const finishAgentMessage = async (params: {
    readonly row: TaskJobRow;
    readonly report: TaskRunReport;
  }): Promise<void> => {
    if (params.row.source !== 'agent') {
      return;
    }
    const key = parseAgentTaskIdempotencyKey({
      repo: params.row.repo,
      issueNumber: params.row.targetNumber,
      idempotencyKey: params.row.idempotencyKey,
    });
    if (key === null) {
      return;
    }
    try {
      const outcome = await finishMessageAndContinue(agentDispatch, {
        repo: key.repo,
        issueNumber: key.issueNumber,
        fingerprint: key.fingerprint,
        status: params.report.outcome === 'succeeded' ? 'done' : 'failed',
      });
      logger.info(
        {
          repo: key.repo,
          issue: key.issueNumber,
          fingerprint: key.fingerprint,
          outcome: params.report.outcome,
          nextClaimed: outcome.message !== null,
        },
        'agent 消息已收尾，并尝试取下一条',
      );
    } catch (error) {
      logger.warn(
        { repo: key.repo, issue: key.issueNumber, err: error instanceof Error ? error.message : String(error) },
        'agent 消息状态写回失败（不影响本轮任务结论）',
      );
    }
  };

  /**
   * 一条任务的**完整执行**（job handler 与端到端测试共用的唯一路径）。
   *
   * 运行时固定 `sandboxed`（v0.3 没有 light 阶段）；会话按 `agent_sessions` 决定
   * 复用 / 新建 / 轮换，其余任务保持 ephemeral。
   */
  const executeTask = async (input: TaskExecutionInput): Promise<TaskRunReport> => {
    const row = await readTaskRow(pool, input.taskId);
    const policy = await readRepoPolicy(pool, row.repo);
    if (!policy.known) {
      throw new AppError(`仓库 ${row.repo} 尚未同步配置（repos 无此行）`, {
        code: APP_ERROR_CODES.repoUnusable,
        failureClass: 'unknown',
        retriable: false,
        details: { repo: row.repo, taskId: row.id },
      });
    }
    // dry-run 的三条来源取并集：进程级开关（首周强制）、仓库开关、调用方强制（replay/测试）
    const dryRun = input.dryRun === true || config.dryRun || policy.dryRun;
    const attempt = input.attempt ?? row.attempt + 1;
    // `runs.id` 在装配层生成（与 taskId 一对一）：打标策略要用它写 `label_decisions.run_id`，
    // 所以先取出来，不能让 `runTask(...)` 的入参里现 new 一个。
    const runId = randomUUID();

    // 打标策略（W2-E）：**每轮**建一次（settings 是仓库级的，人工否决是目标级的）。
    const labelPolicy = createLabelWritebackPolicy({
      pool,
      settings: policy.settings,
      ...(labelCatalog === undefined ? {} : { catalog: labelCatalog }),
      ...(workflowReactions === undefined ? {} : { reactions: workflowReactions }),
    });

    // agent 任务（v0.3）：`tasks.prompt_text` 里是**组装好的那一条消息**（模板渲染 / 原话改写），
    // 所以不能当「自由问答」处理 —— 那条路径会用 `buildAnswerPrompt` 把系统段整段丢掉，
    // 而需求 §1.5 要求两种输入的系统提示**完全相同**（只差一句「先加载谁」）。
    const isAgentTask = row.source === 'agent';
    const agentMessageBody = isAgentTask ? (row.promptText ?? '').trim() : null;
    // 自由问答任务：问题正文优先读 `tasks.prompt_text`（新格式），
    // 兼容历史行 `command=@answer:<base64url>` 的解码
    const answerQuestion = isAgentTask ? null : (row.promptText ?? decodeFreeQuestion(row.command));
    // 面板上传技能的当前快照（仓库作用域优先，见 `SkillStore.activeSkillFiles`）。
    const uploadedSkills = await skillStore.activeSkillFiles(row.repo);
    // 目标上当前生效的标签：技能正文要求「与『当前标签』比对」，没有它模型会重复打标。
    // 取自 `bot_labels`（我们自己的记账表，已 `applied` 未 `removed` 的那些）。
    const currentLabels = await readAppliedLabels(pool, row.repo, row.targetNumber);

    // ── 运行时 / 会话（v0.3：一个 issue 一个持久会话）──────────────────────────
    const runtimeMode = 'sandboxed' as const;
    /**
     * 会话行（`agent_sessions`）。v1.5 里它住在 `issue_pipeline`，那张表已随流水线退役删除 ——
     * 会话连续性是 agent 唯一有状态的资产，必须从新表读（`docs/dev-plan-issue-agent.md` §4）。
     */
    const agentSessionRow =
      row.targetKind === 'issue'
        ? await loadAgentSession({ repo: row.repo, issueNumber: row.targetNumber })
        : null;

    // v2.1 会话状态（FR-3.4 / AC-23）：`active`/`idle` 两种状态、关闭只回收沙箱、永不删会话行。
    // **权威写入在 webhook 侧**（那里有真实事件名与 issue 实时状态，见 http/webhook.ts 的
    // `applyV21SessionOnEvent`）；这里只跑一遍同一个纯函数做交叉校验并留一条 debug，
    // 不额外发 GitHub 请求、也不在这里改库，避免任务执行期把刚回收的沙箱标回 active。
    const v21SessionPlan = planV21SessionOnTask({
      session:
        agentSessionRow === null
          ? null
          : {
              repo: row.repo,
              issueNumber: row.targetNumber,
              sessionId: agentSessionRow.sessionId,
              state: 'active',
              sandboxId: null,
              turns: agentSessionRow.turns,
              cursor: agentSessionRow.cursor,
            },
      issueState: 'open',
      event: v21EventOfCommand(row.command),
    });
    logger.debug(
      { action: v21SessionPlan.action, state: v21SessionPlan.state, reason: v21SessionPlan.reason },
      'v2.1 会话状态机交叉校验（权威写入在 webhook 侧）',
    );

    // 会话状态的**执行侧落点**：调用方给了真实事件（含 issue 实时状态）就按状态机写一次。
    // 只 UPDATE state / sandbox_id / closed_at，永不 DELETE 会话行、永不 archive（AC-23）。
    //
    // **互斥约定**：webhook 侧（`http/webhook.ts` 的 `applyV21SessionOnEvent`）才是权威写入点，
    // 那里有真实 `X-GitHub-Event` + `issue.state`。这里只在 `app.executeTask()` 被直连调用且
    // 显式传了 `sessionEvent` 时才写；队列 job 路径不传 → 不写，因此两处不会打架。
    // 若将来改由 compose 侧统一写，必须先摘掉 webhook 侧那次调用。
    // 失败只 warn：会话状态是资源编排，不该让一轮已经跑完的任务判死。
    let v21SessionEventActive = false;
    if (input.sessionEvent !== undefined) {
      try {
        const applied = await applyV21SessionTransition(pool, {
          repo: row.repo,
          issueNumber: row.targetNumber,
          event: input.sessionEvent.event,
          issueState: input.sessionEvent.issueState,
          ...(input.sessionEvent.sandboxId === undefined
            ? {}
            : { sandboxId: input.sessionEvent.sandboxId }),
        });
        v21SessionEventActive = true;
        logger.info(
          {
            repo: row.repo,
            issue: row.targetNumber,
            action: applied.transition.action,
            state: applied.transition.state,
            reason: applied.transition.reason,
            rebuildSandbox: applied.rebuildSandbox,
          },
          'v2.1 会话状态已落库（只回收沙箱 / 复用，不删会话行、不归档）',
        );
      } catch (error) {
        logger.warn(
          { repo: row.repo, issue: row.targetNumber, err: String(error) },
          'v2.1 会话状态写回失败（不影响本轮任务结论）',
        );
      }
    }

    // 会话计划（E2 / §7）：agent 任务复用 / 新建 / 轮换；其余任务仍是 ephemeral。
    const agentSession = planAgentSession({
      session: agentSessionRow,
      isAgentTask: row.source === 'agent',
      at: now(),
    });
    const session: SessionPlan | undefined = agentSession.session;

    let prompt: string;
    if (isAgentTask) {
      // 系统段沿用 `buildTaskPrompt`（需求 §1.5：两种输入的系统提示完全相同），
      // 后面接「这一条消息」—— 就是 `agent_messages.comment_body` 里那条。
      prompt = [
        buildTaskPrompt({
          command: row.command,
          repo: row.repo,
          targetKind: row.targetKind,
          targetNumber: row.targetNumber,
          dryRun,
          settings: policy.settings,
        }),
        '',
        '## 这一条消息',
        '',
        agentMessageBody === null || agentMessageBody === '' ? '（消息为空）' : agentMessageBody,
      ].join('\n');
    } else if (answerQuestion === null) {
      prompt = buildTaskPrompt({
        command: row.command,
        repo: row.repo,
        targetKind: row.targetKind,
        targetNumber: row.targetNumber,
        dryRun,
        // 项目标签词表（W2-E）：提示词里的「项目标签」段全靠它，缺了就退成
        // 「只能用该 issue 上已有的标签」。settings 读不出来时给 null（同上）。
        settings: policy.settings,
      });
    } else {
      // 自由问答：问题正文在 `command` 里（`@answer:<base64url>`），不打标、只发评论
      prompt = buildAnswerPrompt({
        repo: row.repo,
        targetKind: row.targetKind,
        targetNumber: row.targetNumber,
        question: answerQuestion,
      });
    }

    /**
     * 提示词装配钩子（worktree 就绪后回调一次）。
     *
     * 三档（§16.3）：
     *  - 非流水线（缺省）= 现状：P1 + AGENTS.md + 技能层，逐字节一致；
     *  - `pipeline:classify`：`stage:'classify'` → 无 P1、无技能层，AGENTS.md 照常（Q9）；
     *  - `pipeline:format` / `pipeline:notice`（light）：没 worktree，提示词已在上面装配好，**不回调**。
     */
    /**
     * 提示词装配钩子（worktree 就绪后回调一次）。
     *
     * v0.3 只有一层：`basePrompt`（head）+ AGENTS.md + 命中的技能正文。
     * 阶段系统提示词（`buildStagePrompt`）与 P1（`prompt_versions`）已随退役删除；
     * 项目级补充提示词由 `settings.agent.project_prompt` 在 S2/S4 接入。
     */
    const promptEnricher: TaskRunnerDeps['promptEnricher'] = createPromptEnricher({
      logger,
      config: policy.config,
      context: {
        repo: row.repo,
        targetKind: row.targetKind,
        targetNumber: row.targetNumber,
        ...(row.headSha === null ? {} : { headSha: row.headSha }),
        // 事实层三件套：标题 / issue 正文 / 当前标签。
        // 以前只给了 `body`（且混用成「触发评论」），于是技能里写的「读 `## 任务上下文` 的
        // issue 正文」「与『当前标签』比对」在真实运行里全是空的。
        ...(row.targetTitle === null ? {} : { title: row.targetTitle }),
        ...(row.targetBody === null ? {} : { body: row.targetBody }),
        ...(currentLabels.length === 0 ? {} : { labels: currentLabels }),
        // 触发这一轮的原话：agent 任务 = 那条评论，其余 = issue 正文本身（渲染时会去重）。
        ...(agentMessageBody === null || agentMessageBody === '' ? {} : { triggerText: agentMessageBody }),
      },
      extraSkillFiles: uploadedSkills,
    });

    const endpoint = await ports.host.ready();
    const channel = await racp(endpoint);
    // 轮换（§7）：**先 archive 旧会话、再新建**。archive 失败只告警（旧会话会被每日清理带走），
    // 不能因为清理动作失败就把这一轮任务判死。
    // v2.1 会话状态机生效时**不 archive**：FR-3.4 明令会话没有「结束」这个状态，
    // 归档会让重开的 issue 失去上下文。旧 v0.3 的轮次轮换只在没走 v2.1 路径时保留。
    if (!v21SessionEventActive && agentSession.archiveSessionId !== null) {
      try {
        await channel.ops.sessionArchive({ sessionId: agentSession.archiveSessionId });
        logger.info(
          {
            repo: row.repo,
            issue: row.targetNumber,
            sessionId: agentSession.archiveSessionId,
            reason: agentSession.rotateReason,
          },
          '阶段 2 会话轮换：旧会话已归档，本轮新建会话',
        );
      } catch (error) {
        logger.warn(
          {
            repo: row.repo,
            issue: row.targetNumber,
            sessionId: agentSession.archiveSessionId,
            err: String(error),
          },
          '阶段 2 会话轮换：归档旧会话失败（已忽略，继续新建）',
        );
      }
    }
    try {
      const report = await runTask(
        {
          taskId: row.id,
          runId,
          command: row.command,
          repo: row.repo,
          targetKind: row.targetKind,
          targetNumber: row.targetNumber,
          ...(row.headSha === null ? {} : { headSha: row.headSha }),
          actorLogin: row.actorLogin,
          // 无感反馈的幂等锚（`tasks.idempotency_key`）：不给就退回 runId，
          // 于是重投 / `/retry` 会重复打终态 reaction —— 这正是它必须被读上来的原因。
          ...(row.idempotencyKey === null ? {} : { idempotencyKey: row.idempotencyKey }),
          // `tasks.source` 决定「这一轮能不能写回评论」：自动通道零评论（plan §5）。
          // 认不出的值（老行 / NULL）不传，由 `taskSourceOf()` 按命令名兜底推断。
          ...(row.source === null ? {} : { source: row.source }),
          prompt,
          runtimeMode,
          // 点名的技能：装配层靠它决定注入哪份正文（正文里的 `/name` 已在消息组装期被摘掉）。
          ...(row.skillIds.length === 0 ? {} : { skillIds: row.skillIds }),
          ...(session === undefined ? {} : { session }),
          attempt,
          dryRun,
        },
        {
          worktree: ports.worktree,
          docker: ports.docker,
          proxy: ports.proxy,
          host: ports.host,
          lifecycle: ports.lifecycle,
          store: ports.store,
          github: ports.github,
          ops: channel.ops,
          // 用量与费用：从 pi-host 的 sqlite 读真实 token，金额按 DeepSeek 官方价目算
          usage: createHostUsageReader({ dataDir: config.host.dataDir }),
          events: channel.events,
          // 无感反馈（W2-D）：终态 `-eyes +rocket/confused` + `issue_feedback` 台账。
          // 没有可用 reaction 写面时不传（= 一个 reaction 都不打，而不是每轮记失败）。
          ...(feedback === null ? {} : { feedback }),
          // 打标策略（W2-E）：写 `label` 动作之前归一化 desired 并落 `label_decisions`。
          labelPolicy,
          // `bot_labels` 记账（W2-E）：只增删自己打过的标签 + 人工否决都靠这张表。
          ledger: botLabelLedger,
          // 提示词装配（M1）：AGENTS.md 与仓库技能文件都在 **worktree** 里，而上面的 `prompt`
          // 是在建 worktree 之前拼好的 —— 所以装配只能由 worker 在建完 worktree 之后回调补一次。
          // light 运行时没有 worktree，worker 自己会跳过这个钩子（§10.5）。
          ...(promptEnricher === undefined ? {} : { promptEnricher }),
          image: config.worker.image,
          // 任务级时间闸：`/review-pr` 30min、其余 20min（`worker/index.ts::timeoutMsForCommand`）。
          timeoutForCommand: (command) => timeoutMsForCommand(command),
          networkMode: config.worker.network,
          allowPushBranch: config.worker.allowPushBranch,
          logger,
          // v2.1：只有 `source==='agent'` 的产出会试探 v2 契约；解析失败仍回落旧 4-intent 信封。
          //
          // 两种执行形态都给全：
          //  - `execute` 钩子（控制面装配）→ runTask 优先走它，内部即 `createV21Executor`；
          //  - 直连 `V21RuntimeConfig`（未注入钩子的部署 / 单测）→ runTask 自己用
          //    `createV21PortFromGithub(deps.github)` + 下面这份 settings/能力装配 `executeV21()`。
          // `settings` 用**本轮** `policy.settings`，与应用启动时构造的 `v21Executor` 不是同一份
          // 闭包，避免「仓库配置改了但 worker 还读旧值」；`createV21Compactor` 只暴露不调用。
          v21: {
            ...v21RunnerHooks,
            settings: policy.settings,
            ...(feedback === null ? {} : { reactions: v21ReactionsOf(feedback.reactions) }),
            ...(baseGithubClient === null
              ? {}
              : { openPullRequest: createV21OpenPullRequest(baseGithubClient.request) }),
            compactionStore: createV21CompactionStore(pool),
          },
          // v2.1 目标现状：`label` 目标态要「当前标签 + 我们打过的标签」。
          // 与上面的 `v21Executor` 读同一张 `bot_labels` 台账，避免两份事实源。
          targets: createV21TargetContextPort({ pool, currentLabels }),
          onStep: (step, detail) => {
            logger.debug({ taskId: row.id, step, detail }, 'worker 步骤');
          },
        },
      );

      // 结论写回状态机（阶段 0 三条路径 / 阶段 2 会话字段）。
      // 失败**不影响**任务结论：run 已经跑完并落库，状态机下一轮还能再修
      // （写库失败比「丢掉一次跑完的结论」更容易被发现，因为面板上的阶段会停住）。
      // 会话字段写回（`agent_sessions`；复用 / 轮换见 `planAgentSession()`）。
      // 失败**不影响**任务结论：run 已经跑完并落库，会话字段下一轮还能再修。
      try {
        await persistAgentSessionAfterRun({
          row,
          session: agentSessionRow,
          report,
          agentSession,
        });
      } catch (error) {
        logger.warn(
          { taskId: row.id, repo: row.repo, err: error instanceof Error ? error.message : String(error) },
          'agent 会话字段写回失败（不影响本轮任务结论）',
        );
      }
      // agent 消息终态（done/failed）+ 立刻取下一条：串行的「立刻」在这里兑现
      await finishAgentMessage({ row, report });
      return report;
    } finally {
      await channel.close();
    }
  };

  const onTaskJob: TaskJobHandler = async (job) => {
    const report = await executeTask({
      taskId: job.data.taskId,
      attempt: (job.data.attempt ?? 0) + 1,
    });
    // 重试决策只读 `report.retry`（worker 自己不重投，§7.3 F6）
    if (report.retryable) {
      const jobId = await enqueueRetry(queue, job.data, report.retry);
      logger.info({ taskId: job.data.taskId, jobId, failureClass: report.failureClass }, '按重试矩阵重投');
    }
  };

  const markStep = (step: ShutdownStep): void => {
    shutdownSteps = [...shutdownSteps, step];
    logger.info({ step }, '停机步骤完成');
  };

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const start = async (): Promise<ApplicationAddresses> => {
    if (started) {
      throw new AppError('应用已经启动过了', {
        code: APP_ERROR_CODES.alreadyStarted,
        failureClass: 'unknown',
        retriable: false,
      });
    }
    logger.info(describeAppConfig(config), '装配完成，开始启动');

    // 1) 只检查不迁移（见文件头第 1 条）
    await assertSchemaReady(pool);

    // 2) 队列：start 建 pgboss schema → 建我们自己的队列 → 注册 cron
    await queue.start();
    const bootstrap = await bootstrapQueue(queue, {
      info: (message) => {
        logger.info(message);
      },
    });
    logger.info(
      { created: bootstrap.created, existing: [...bootstrap.existing], scheduled: [...bootstrap.scheduled] },
      '队列就绪',
    );

    // 3) worker（同进程，§8.4「刻意不拆」）
    //
    // `gate` 是**仓库级并发**闸门（`settings.limits.concurrency_per_repo`，默认 2）：
    // 全局并发仍是 `QUEUES.run-task` 的 3，但一个仓库最多占它声明的槽位，
    // 免得「吵的那个仓库」把三个槽全占满、其余仓库只能排队（W1-B 第 3 条）。
    // `limitFor` 走 `readRepoPolicy()`：settings 读不出来就回落默认 2（闸门不抛错）。
    await registerTaskWorker(queue, onTaskJob, {
      gate: {
        limitFor: async (repo) => {
          const policy = await readRepoPolicy(pool, repo);
          return concurrencyPerRepoOf(policy.settings);
        },
      },
    });
    logger.info({ queue: QUEUE.runTask }, 'run-task worker 已注册');

    // 4) 四个定时作业（缺 github/docker 注入时 `registerJobs` 自己跳过并告警）
    if (overrides.skipSchedules !== true) {
      const jobDeps: JobDeps = {
        pool,
        logger,
        docker: ports.docker,
        proxy: ports.proxy,
        ...(baseGithubClient === null ? {} : { github: baseGithubClient }),
        diskPath: config.dataDir,
        // 排队闸门（§4.7）：排队超时 → 取消 job + `confused` reaction（不是发一条评论）。
        // `ack` 与 webhook 的入队 `+eyes` 是同一个对象（同一个 App 客户端），
        // `cancelTaskJob` 直接把 pg-boss 里排队中的 job 撤掉，否则任务还会被 worker 领走。
        gateAck: {
          addReaction: async (input) => {
            // `WebhookAck.addReaction` 的 content 是 reaction 枚举，闸门侧只声明是字符串：
            // 闸门实际只发 `confused`（见 `QUEUE_GATE_REACTION`），这里收窄是安全的。
            await ack.addReaction?.({ ...input, content: input.content as ReactionContent });
          },
        },
        cancelTaskJob: (taskId: string) => cancelTaskJob(queue, taskId),
        // agent 调度（v0.3）：**必须**注入 enqueue —— 没有它，`agent-dispatch` 每分钟只会打一条
        // 「未注入 enqueue」的 warning；webhook 那条即时路径能派发，但「上一条卡住/进程重启后」
        // 的补偿派发就永远不发生（消息会停在 queued）。
        agentEnqueue: agentDispatch.enqueue,
      };
      const registered = await registerJobs(queue, jobDeps, registerScheduleWorker);
      logger.info({ queues: registered, declared: JOB_SCHEDULES.length }, '定时作业已注册');
    }

    // 5) 指标（独立实例，只监听 loopback）→ 6) 主实例
    const metricsAddress = await metricsServer.listen();
    const httpAddress = await server.listen({ host: config.http.host, port: config.http.port });
    addresses = {
      http: { host: config.http.host, port: portOf(httpAddress, server) },
      metrics: metricsAddress,
    };
    started = true;
    logger.info({ http: addresses.http, metrics: addresses.metrics }, 'pi-bot serve 已启动');
    return addresses;
  };

  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    shutdownSteps = [];
    logger.info({}, '开始优雅停机（顺序见 SHUTDOWN_STEPS，总预算 90s = systemd TimeoutStopSec）');

    // 1) 不再接收新 webhook。`http/` 是只读模块（没有 draining 钩子），`close()` 的效果是
    //    新连接被拒 —— 对 GitHub 来说与 503 等价（投递失败 → 稍后重投），符合 §3.4。
    await server.close().catch((error: unknown) => {
      logger.warn({ err: describeError(error) }, '关闭 http 实例时出错（继续停机）');
    });
    markStep('http.close');

    // 2) 等手上的 job 收尾（pg-boss graceful stop 会等 worker 返回）
    await queue.stop({ graceful: true, timeout: QUEUE_STOP_TIMEOUT_MS }).catch((error: unknown) => {
      logger.warn({ err: describeError(error) }, '停止队列时出错（继续停机）');
    });
    markStep('worker.drain');

    // 3) 兜底释放容器（正常路径 worker 的 dispose 步已经销毁过，这里只处理漏网）
    for (const containerId of [...liveContainers]) {
      try {
        await ports.docker.destroyContainer(containerId);
        logger.warn({ containerId }, '停机时兜底销毁容器');
      } catch (error) {
        logger.warn({ containerId, err: describeError(error) }, '兜底销毁容器失败（保留，交给 lifecycle 清扫任务）');
      }
    }
    liveContainers.clear();
    markStep('containers.release');

    // 4) 关 pi-host（SIGTERM → 宽限 → SIGKILL）
    await ports.host.stop().catch((error: unknown) => {
      logger.warn({ err: describeError(error) }, '停止 pi-host 时出错（继续停机）');
    });
    markStep('host.stop');

    // 5) 关池（队列池已由 queue.stop 自己关）
    await closePool(pool).catch((error: unknown) => {
      logger.warn({ err: describeError(error) }, '关闭 PG 池时出错（继续停机）');
    });
    markStep('pool.close');

    // 6) 最后关 metrics：停机过程中的指标还抓得到
    await metricsServer.close().catch((error: unknown) => {
      logger.warn({ err: describeError(error) }, '关闭 metrics 实例时出错');
    });
    markStep('metrics.close');

    started = false;
    logger.info({ steps: shutdownSteps }, '停机完成');
  };

  return {
    config,
    logger,
    pool,
    queue,
    ports,
    server,
    metricsServer,
    get addresses() {
      return addresses;
    },
    get started() {
      return started;
    },
    get shutdownSteps() {
      return shutdownSteps;
    },
    start,
    stop,
    executeTask,
  };
}

/** Fastify `listen()` 的返回值 → 实际端口（端口 0 时它给的是内核分配的端口）。 */
function portOf(listenAddress: string, server: FastifyInstance): number {
  const fromServer = server.server.address();
  if (fromServer !== null && typeof fromServer === 'object') {
    return fromServer.port;
  }
  // 兜底：`fastify.listen()` 的字符串形态是 `http://host:port`
  const matched = /:(\d+)$/u.exec(listenAddress);
  return matched === null ? 0 : Number(matched[1]);
}

/**
 * 目标上当前生效的标签（`bot_labels` 里未 `removed` 的那些）。
 *
 * 为什么读自己的记账表而不是打一次 GitHub API：这是每次装配都要做的事，多一次远程调用
 * 会让「发一条评论」变成「两次外部请求」；`bot_labels` 就是我们写回后的权威副本。
 * 读失败不阻塞装配（标签只是提示词里的一个事实，不是判定依据）。
 */
async function readAppliedLabels(
  db: SqlExecutor,
  repo: string,
  issueNumber: number,
): Promise<string[]> {
  try {
    const result = await db.query(
      `select distinct "label" from "bot_labels"
       where "repo" = $1 and "issue_number" = $2 and "applied_at" is not null and "removed_at" is null
       order by "label" asc`,
      [repo, issueNumber],
    );
    const out: string[] = [];
    for (const row of result.rows as { label?: unknown }[]) {
      if (typeof row.label === 'string' && row.label !== '') out.push(row.label);
    }
    return out;
  } catch {
    return [];
  }
}