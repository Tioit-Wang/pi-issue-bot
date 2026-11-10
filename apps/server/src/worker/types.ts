/**
 * worker 的注入面与产出形状（B13；tech-plan §4.3 的九步）。
 *
 * **全部外部件都是注入的**，一条都不在本进程里 new 出来：
 *   - `WorktreePort`    git 检出（真实实现在 W4-N 的 `git/`；本切片只有窄接口 + 默认可抛实现）
 *   - `SandboxDocker`   容器（`sandbox/` 的窄接口，worker 只 build 规格 + create + dispose）
 *   - `ExecProxyPort`   exec 代理（`sandbox/exec-proxy.ts` 的适配层）
 *   - `HostPort`        pi-host 就绪信息（`runtime/host-supervisor.ts` 的适配层）
 *   - `TurnDriverOps`   RACP operation（`runtime/turn-driver.ts` 驱动事件循环）
 *   - `RunStore`        落库（`worker/run-store.ts` 是 PG 实现；单测注入内存假实现）
 *   - `GithubWriteApi`  写执行器的真实动作（`github/` 的注入点）
 *
 * 为什么这么设计：本机**没有** `vendor/pi-host` bundle，也不能真连 GitHub。
 * 单测必须能在「不起进程、不碰 docker、不打网络」的前提下断言**调用序列**与**落库内容**。
 */
import type { DegeneracyHit, DegeneracyMonitorOptions, DegeneracyStats } from '../degeneracy/index.ts';
import type { BotLabelLedger, GithubWriteApi } from '../github/index.ts';
import type { FailureClass, FailureSignal, RetryDecision } from '../queue/index.ts';
import type { TurnDriverOps } from '../runtime/turn-driver.ts';
import type {
  ContainerStateSnapshot,
  DisposeResult,
  SandboxDocker,
  SandboxMemoryTier,
  TaskOutcome,
} from '../sandbox/index.ts';
import type { EnvelopeAction, EventEnvelope, Logger, TaskEnvelope } from './deps.ts';

/* ── 备注：`EventEnvelope` 只用于 `events` 注入点，worker 不建 WS 连接 ─────────── */

/** 九步链路里的步骤名（`onStep` 与测试断言的调用序列都用它）。 */
export const TASK_STEPS = [
  'worktree',
  'container',
  'proxy',
  'host',
  'turn',
  'diff',
  'validate',
  'execute',
  'dispose',
] as const;

export type TaskStep = (typeof TASK_STEPS)[number];

/* ── 端口：worktree ─────────────────────────────────────────────────────────── */

/** 一棵已经检出的独立工作树（`git worktree add` 的产物）。 */
export interface WorktreeHandle {
  readonly taskId: string;
  readonly repo: string;
  /** 宿主的 job 目录；身份挂载下容器内路径与之相同（tech-plan §4.5）。 */
  readonly jobDir: string;
  readonly branch?: string;
  readonly headSha?: string;
}

/**
 * 窄接口：worker 只要「给我一棵树」与「这棵树可以回收了」。
 *
 * 真实实现（clone 缓存 + `git worktree add` + `GIT_ASKPASS`）归 `git/` owner（W4-N）。
 * 默认实现 `createUnavailableWorktreePort()` 直接抛
 * `AppError{failureClass:'sandbox', code:'WORKTREE_UNAVAILABLE'}`——
 * **绝不悄悄退化成「用当前仓库跑」**：那会让任务在错误的树上写回。
 */
export interface WorktreePort {
  create(input: { readonly taskId: string; readonly repo: string; readonly headSha?: string }): Promise<WorktreeHandle>;
  /** 立刻回收（保留期策略由调用方决定；没有回收能力就不实现）。 */
  release?(handle: WorktreeHandle): Promise<void>;
}

/* ── 端口：exec 代理 ────────────────────────────────────────────────────────── */

/** 一个 job 的 exec 端点。 */
export interface ExecEndpoint {
  /** 规范化监听地址（`unix:/abs/exec.sock` 或 `pipe:\\.\pipe\pi-bot-<jobId>`）。 */
  readonly address: string;
  /** unix 端点的 socket 路径（pipe 端点没有）。 */
  readonly socketPath?: string;
}

export interface ExecProxyPort {
  listen(input: {
    readonly jobId: string;
    readonly jobDir: string;
    readonly containerId: string;
  }): Promise<ExecEndpoint>;
  /** 销毁端点（`unlink` socket + 从映射表删条目，tech-plan §6.3 的 (b)）。 */
  destroy(target: { readonly jobId: string }): Promise<void>;
}

/**
 * worker 侧的「socket 路径 → 该进哪个容器」映射表（tech-plan §4.5 的那张表）。
 *
 * 为什么 worker 也要有一份：代理内部那张表只对**代理自己**可见；
 * 而「这个 run 现在有哪个端点在监听」是 run 的诊诊断信息（销毁时也要按它兜底清理）。
 */
export type EndpointRegistry = Map<string, { readonly jobId: string; readonly containerId: string }>;

/* ── 端口：pi-host ─────────────────────────────────────────────────────────── */

/** 任务需要的 Host 连接信息（`HostSupervisor.info` 的子集 + 端口基址）。 */
export interface HostEndpoint {
  readonly hostId: string;
  readonly port: number;
  readonly version: string;
  /** `--pair` 时的一次性配对令牌；正常启动为 undefined。**不进日志**。 */
  readonly token?: string;
}

/**
 * 窄接口：worker 只要「Host 就绪了，端口/令牌是多少」。
 *
 * 真实实现是 `HostSupervisor` 的适配层（`createSupervisorHostPort`）：
 * 监督器负责退避重启与崩溃循环放弃，worker 不重复实现。
 */
export interface HostPort {
  ready(): Promise<HostEndpoint>;
  stop(): Promise<void>;
}

/* ── 端口：生命周期 ─────────────────────────────────────────────────────────── */

/**
 * 容器处置。真实实现是 `sandbox/lifecycle.ts` 的 `LifecycleExecutor.dispose`：
 * **销毁前先 inspect** 采 `OOMKilled` / `ExitCode`（§6.3），OOM 判定全靠这一次采集。
 */
export interface LifecycleDisposer {
  dispose(input: {
    readonly jobId: string;
    readonly containerId: string;
    readonly jobDir: string;
    readonly outcome: TaskOutcome;
  }): Promise<DisposeResult>;
}

/* ── 端口：落库 ────────────────────────────────────────────────────────────── */

/** 一条 `actions` 行的写入参数（`appliedAt` 为 null 表示「未落地」）。 */
export interface ActionRecord {
  readonly runId: string;
  /** `comment` / `label` / `create_issue` / `push_branch` / `open_pr` */
  readonly intent: string;
  /** 写操作指向的对象：`owner/name#123`（分支类动作是 `owner/name#bot/xxx`）。 */
  readonly target: string;
  readonly externalRef: string | null;
  readonly appliedAt: Date | null;
  readonly audit: Readonly<Record<string, unknown>>;
}

/** 信封行（`envelopes` 每 run 一行，唯一索引在 `run_id` 上）。 */
export interface EnvelopeRecord {
  readonly runId: string;
  readonly verdict: unknown;
  readonly actions: unknown;
  readonly usage: unknown;
  readonly valid: boolean;
  readonly errors: unknown;
}

/** 落库端口。PG 实现见 `worker/run-store.ts`；单测注入内存假实现以断言内容。 */
export interface RunStore {
  beginRun(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly attempt: number;
    readonly startedAt: Date;
  }): Promise<void>;
  appendEvent(input: {
    readonly runId: string;
    readonly cursor: number;
    readonly kind: string;
    readonly payload: unknown;
  }): Promise<void>;
  recordEnvelope(record: EnvelopeRecord): Promise<void>;
  recordAction(record: ActionRecord): Promise<void>;
  recordDegeneracyHit(input: {
    readonly runId: string;
    readonly hit: DegeneracyHit;
  }): Promise<void>;
  finishRun(input: {
    readonly runId: string;
    readonly outcome: RunOutcome;
    readonly failureClass: FailureClass | null;
    readonly failureDetail: unknown;
    readonly endedAt: Date;
    readonly sessionId?: string;
    readonly turnId?: string;
  }): Promise<void>;
  markTask(input: {
    readonly taskId: string;
    readonly status: WorkerTaskStatus;
    readonly endedAt: Date;
    readonly containerName?: string;
  }): Promise<void>;
}

/** `runs.outcome` 的取值（比 `failure_class` 粗一档，面板按它分组）。 */
export const RUN_OUTCOMES = ['succeeded', 'failed', 'timed-out', 'cancelled', 'degenerate-output'] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** `tasks.status` 的取值（复用 db 常量的字面量，避免各写一份）。 */
export const WORKER_TASK_STATUS = {
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  timedOut: 'timed-out',
  cancelled: 'cancelled',
} as const;

export type WorkerTaskStatus = (typeof WORKER_TASK_STATUS)[keyof typeof WORKER_TASK_STATUS];

/* ── 端口：写回所需的目标现状 ───────────────────────────────────────────────── */

/**
 * 执行写动作前需要知道的「目标现状」（标签集、去重键是否命中、今日配额）。
 *
 * 为什么用端口而不是在 worker 里查库：这些查询的 owner 是 `queries/` 与
 * `issue_states` 的写入方（M1/M3 切片），worker 只消费它们给的事实，
 * 免得「谁算真相」出现两份（同 `github/executor.ts` 对 `close_issue` 的处理）。
 */
export interface WriteTargetContext {
  /** `label` 动作要用：当前标签集。 */
  readonly currentLabels?: readonly string[];
  /** `label` 动作要用：我们打过哪些（`bot_labels`）。 */
  readonly botLabels?: readonly string[];
  /** `create_issue` 要用：`(repo, fingerprint)` 是否已命中。 */
  readonly fingerprintKnown?: boolean;
  /** `create_issue` 要用：今日已创建几个。 */
  readonly createdToday?: number;
  /** `create_issue` 要用：命中时在哪个 issue 上追加评论。 */
  readonly existingIssueNumber?: number;
  /** `create_issue` 要用：日配额（默认 10，plan §6.3）。 */
  readonly dailyQuota?: number;
}

export interface TargetContextPort {
  load(input: { readonly repo: string; readonly targetNumber: number }): Promise<WriteTargetContext>;
}

/* ── 输入 ──────────────────────────────────────────────────────────────────── */

/** 一次 run 的输入（`run-task` 载荷 + 任务行里 worker 需要的列）。 */
export interface TaskRunInput {
  readonly taskId: string;
  /** `runs.id`（由入队方生成，与 taskId 一对一即可）。 */
  readonly runId: string;
  /** 命令名：决定任务级时间闸（20min / `/review-pr` 30min）。 */
  readonly command: string;
  readonly repo: string;
  /** 触发者 login（`tasks.actor_login`）；给了就让最终回复以 `@login` 开头。 */
  readonly actorLogin?: string | null | undefined;
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly headSha?: string;
  /** 拼好的提示词（技能模板 + 仓库配置 + 任务上下文）。 */
  readonly prompt: string;
  /** 第几次尝试（从 1 起）。 */
  readonly attempt?: number;
  /** 仓库开关：首周强制 dry-run（plan §11 M1）。 */
  readonly dryRun?: boolean;
  /** 上层取消（SIGTERM / 人工取消）。 */
  readonly parent?: AbortSignal;
}

/* ── 依赖 ──────────────────────────────────────────────────────────────────── */

export interface TaskRunnerDeps {
  readonly worktree: WorktreePort;
  readonly docker: SandboxDocker;
  readonly proxy: ExecProxyPort;
  readonly host: HostPort;
  readonly lifecycle: LifecycleDisposer;
  readonly store: RunStore;
  /** RACP operation（`RacpOps` 天然满足）。 */
  readonly ops: TurnDriverOps;
  /** 事件流（`client.onEvent()` 装配；单测注入假事件流）。 */
  readonly events: (context: { readonly sessionId: string; readonly turnId: string }) => AsyncIterable<EventEnvelope>;
  /** 写执行器依赖的 GitHub 写入面。 */
  readonly github: GithubWriteApi;
  readonly ledger?: BotLabelLedger;
  readonly targets?: TargetContextPort;
  /** worker 镜像（`pi-worker:node22` 等）。 */
  readonly image: string;
  readonly memoryTier?: SandboxMemoryTier;
  /** 网络模式（`pi-jobs`；高风险任务可传 `none`）。 */
  readonly networkMode?: string;
  /** 覆盖任务级时间闸（单测用；正常走 `timeoutMsForCommand`）。 */
  readonly timeoutForCommand?: (command: string) => number;
  /** 允许的动作 intent（技能 `outputs`）。 */
  readonly allowedIntents?: readonly ('comment' | 'label' | 'create_issue' | 'push_branch')[];
  /** 写回闸门是否开启（M4 之前传 false → `push_branch` 被丢弃）。 */
  readonly allowPushBranch?: boolean;
  /** 仓库配置映射出的标签集合（给 `filterActions` 用）。 */
  readonly allowedLabels?: readonly string[];
  /** 熔断器参数覆盖（单测把窗口缩小）。 */
  readonly degeneracy?: DegeneracyMonitorOptions;
  readonly clock?: () => number;
  readonly logger?: Logger;
  /** 九步链路的观测点（测试断言调用序列；生产接 tracing）。 */
  readonly onStep?: (step: TaskStep, detail?: Readonly<Record<string, unknown>>) => void;
  /** 单步事件的观测点（审批审计等），默认落 `run_events`。 */
  readonly onAuditEvent?: (audit: unknown) => void;
}

/* ── 产出 ──────────────────────────────────────────────────────────────────── */

/** 一条动作在执行器里的归宿。 */
export const ACTION_STATUSES = ['applied', 'skipped', 'delegated', 'dry-run', 'failed'] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionOutcome {
  readonly intent: string;
  readonly status: ActionStatus;
  readonly target: string;
  readonly externalRef: string | null;
  /** 人读说明（落 `actions.audit.reason`）。 */
  readonly reason: string;
}

/** 信封装配结果（校验 + 动作过滤）。 */
export interface PreparedEnvelope {
  /** agent 交出来的 JSON 原文（找不到时为 null）。 */
  readonly text: string | null;
  /** 是否通过 Ajv 校验（不合规也落库，`valid=false`）。 */
  readonly valid: boolean;
  readonly errors: readonly { readonly path: string; readonly keyword: string; readonly message: string }[];
  readonly envelope: TaskEnvelope | null;
  readonly accepted: readonly EnvelopeAction[];
  readonly dropped: readonly { readonly index: number; readonly intent: string; readonly reason: string; readonly detail: string }[];
}

/** 一次 run 的结果（落库之外还给调用方：重试决策、调用序列、诊断）。 */
export interface TaskRunReport {
  readonly runId: string;
  readonly taskId: string;
  readonly outcome: RunOutcome;
  /** 最高优先级的失败分类（§7.3；成功为 null）。 */
  readonly failureClass: FailureClass | null;
  /** 本轮观测到的**全部**信号（其余进 `runs.failure_detail`，不参与重试决策）。 */
  readonly signals: readonly FailureSignal[];
  /** 只调 `decideRetry()` 得到的决策（worker 自己不重投，交给队列 owner）。 */
  readonly retry: RetryDecision;
  readonly steps: readonly TaskStep[];
  /** turn 的终态事件（`turn.completed` / `stream-ended` / …）。 */
  readonly terminal: string | null;
  /**
   * Host 侧会话 / 轮次 id（面板详情页按它回查 Host）。
   *
   * 失败路径（超时、取消、事件流异常）也要有：`driveTurn()` 抛错时不会把 id 交给上层，
   * 所以 worker 在 operation 边界上另记了一份（见 `run-task.ts::recordingOps()`）。
   */
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly envelope: PreparedEnvelope | null;
  readonly actions: readonly ActionOutcome[];

  /**
   * 兜底评论（信封不可信、但有可读文本时才可能有值；`null` = 没走兜底）。
   *
   * 刻意**不并入** `actions`：那里是「信封里被接受的写动作」，
   * 兜底评论不属于任何一封信封（信封本身就是不可信的）。它单独一栏，
   * 面板/统计才能把「模型交了合法信封」与「我们替它兜了一句」分开数。
   */
  readonly fallback: ActionOutcome | null;
  readonly dryRun: boolean;
  /** 容器销毁前采到的状态（OOM/ExitCode 的唯一来源）。 */
  readonly containerState: ContainerStateSnapshot | null;
  readonly containerId: string | null;
  readonly jobDir: string | null;
  readonly events: number;
  readonly degeneracy: DegeneracyStats | null;
  readonly durationMs: number;
  readonly disposed: boolean;
  readonly retryable: boolean;
}

/** 运行器：一个进程一个，可并发跑多个 run（各自独立的 job 目录与容器）。 */
export interface TaskRunner {
  runTask(input: TaskRunInput): Promise<TaskRunReport>;
}
