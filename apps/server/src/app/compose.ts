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
import { createSupervisorHostPort, runTask } from '../worker/index.ts';
import type { HostPort, TaskRunReport, WorktreePort } from '../worker/index.ts';
import type { AppConfig } from './config.ts';
import { describeAppConfig } from './config.ts';
import { hostModelEnv } from './model-env.ts';
import { createRacpChannelFactory } from './racp.ts';
import type { RacpChannelFactory } from './racp.ts';
import {
  buildTaskPrompt,
  buildAnswerPrompt,
  createBotLabelLedger,
  createGithubLabelCatalog,
  createLabelWritebackPolicy,
  createPromptEnricher,
  createUnavailableHostPort,
  createWorkerFeedbackDeps,
  createWorkerPorts,
  createWorkflowReactionPort,
  readTaskRow,
} from './worker-deps.ts';
import type { WorkerPorts } from './worker-deps.ts';
import { createSkillStore } from '../skills/store.ts';
import { concurrencyPerRepoOf } from '../queue/repo-concurrency.ts';

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
  /** 不注册四个定时作业（测试里不需要 pg-boss 的 cron）。 */
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

  const verify = overrides.verify ?? createOctokitVerifier(config.webhook.secret);
  const ack: WebhookAck =
    overrides.ack ??
    (baseGithubClient === null
      ? createUnavailableWebhookAck('未配置 PI_BOT_GITHUB_TOKEN')
      : createGithubWebhookAck(baseGithubClient));

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
      enqueue: createQueueEnqueuer(queue),
      // 触发别名：部署默认（`@issuebot` / `@ibot`）+ App slug；仓库配置里的 `triggers` 与之合并
      aliases: resolveTriggerAliases({ deployment: [...DEFAULT_TRIGGER_ALIASES, config.github.mention] }),
      ack,
      freeMention: config.freeMention,
      logger,
      // 面板上传且启用的技能名：让 `/demo` 这类命令不必先进仓库配置就能被调用
      // （spec D0「上传即生效」；关掉开关后下一份投递就不再放行）。
      listSkills: (repo) => skillStore.activeSkillNames(repo),
      now,
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
    // `judgement_hash` 这一层拿不到（webhook 的 issue 版本 hash 没落到 `tasks` 列），
    // 于是写 NULL —— 面板按 `created_at` 排序仍然能看「这一轮想打什么、被谁拦了」。
    const labelPolicy = createLabelWritebackPolicy({
      pool,
      settings: policy.settings,
      ...(labelCatalog === undefined ? {} : { catalog: labelCatalog }),
      ...(workflowReactions === undefined ? {} : { reactions: workflowReactions }),
    });

    // 自由问答任务：问题正文优先读 `tasks.prompt_text`（新格式），
    // 兼容历史行 `command=@answer:<base64url>` 的解码
    const answerQuestion = row.promptText ?? decodeFreeQuestion(row.command);
    // 面板上传技能的当前快照（仓库作用域优先，见 `SkillStore.activeSkillFiles`）。
    const uploadedSkills = await skillStore.activeSkillFiles(row.repo);

    const endpoint = await ports.host.ready();
    const channel = await racp(endpoint);
    try {
      return await runTask(
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
          prompt:
            answerQuestion === null
              ? buildTaskPrompt({
                  command: row.command,
                  repo: row.repo,
                  targetKind: row.targetKind,
                  targetNumber: row.targetNumber,
                  dryRun,
                  // 项目标签词表（W2-E）：提示词里的「项目标签」段全靠它，缺了就退成
                  // 「只能用该 issue 上已有的标签」。settings 读不出来时给 null（同上）。
                  settings: policy.settings,
                })
              : // 自由问答：问题正文在 `command` 里（`@answer:<base64url>`），不打标、只发评论
                buildAnswerPrompt({
                  repo: row.repo,
                  targetKind: row.targetKind,
                  targetNumber: row.targetNumber,
                  question: answerQuestion,
                }),
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
          // 装配失败不影响任务（worker 侧回退到 basePrompt），所以这里不需要 try/catch。
          promptEnricher: createPromptEnricher({
            logger,
            config: policy.config,
            // P1「项目人格层」+ 装配统计：每轮读一次当前版本（面板改了下一轮就生效）。
            db: pool,
            context: {
              repo: row.repo,
              targetKind: row.targetKind,
              targetNumber: row.targetNumber,
              ...(row.headSha === null ? {} : { headSha: row.headSha }),
            },
            // 面板上传的技能（spec R5「上传即生效、不重启」）：每轮任务开始前读一次启用集合。
            // 放在这里而不是进程启动时：开关关掉后下一轮任务就不再带它，不需要重启。
            extraSkillFiles: uploadedSkills,
          }),
          image: config.worker.image,
          networkMode: config.worker.network,
          allowPushBranch: config.worker.allowPushBranch,
          logger,
          onStep: (step, detail) => {
            logger.debug({ taskId: row.id, step, detail }, 'worker 步骤');
          },
        },
      );
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
