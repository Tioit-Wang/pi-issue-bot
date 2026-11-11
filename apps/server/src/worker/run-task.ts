/**
 * 一次任务的完整链路（B13；tech-plan §4.3 的九步 + §4.7 的三层时间闸）。
 *
 * ```
 * 1 project/register → 2 session/create → 3 events/subscribe → 4 turn/start
 *                                          ↓（事件循环，含审批/反问应答）
 * 5 workspace/diff → 6 校验信封 → 7 写执行器 → 8 session/archive → 9 落库
 * ```
 *
 * 九步的**顺序就是单测的断言对象**（`onStep` 回调 + `TaskRunReport.steps`）：
 * worktree → container → proxy → host → turn → diff → validate → execute → dispose。
 *
 * 四处关键取舍（都在对应位置有展开注释）：
 *  - **dry-run 不产生任何写副作用**：连 `actions` 行都不写（见 `writeback.ts`）。
 *  - **任务级时间闸分两段**：setup（worktree/容器/代理/host）与 turn 各自套同一个
 *    `runWithDeadline`。为什么不是一个大 `runWithDeadline` 包住全部：外层一旦 reject，
 *    `runWithDeadline` 不会等内层落地，容器销毁与 `runs` 落库就会和后台还在跑的
 *    turn 打架（同一 run 两处写库）。分段后每一段超时都能**确定性收尾**。
 *  - **超时不自动重试**：`decideRetry()` 只读最高优先级分类，`timeout` 恒为 `retry:false`。
 *  - **OOM 必须在销毁前采**（§6.3）：处置只调 `lifecycle.dispose()`，它内部先 inspect 再销毁。
 */
import os from 'node:os';

import { createDegeneracyMonitor } from '../degeneracy/index.ts';
import type { DegeneracyHit } from '../degeneracy/index.ts';
import { decideRetry, pickHighestPrioritySignal } from '../queue/index.ts';
import { estimateDeepSeekCostUsd } from '../cost/index.ts';
import type { FailureClass, FailureSignal } from '../queue/index.ts';
import { DEFAULT_TURN_TIMEOUT_MS, REVIEW_PR_TURN_TIMEOUT_MS, driveTurn } from '../runtime/turn-driver.ts';
import type { TurnDriveResult, TurnDriverOps } from '../runtime/turn-driver.ts';
import {
  buildContainerCreateOptions,
  classifyDestroyedState,
  containerNameFor,
} from '../sandbox/index.ts';
import type { ContainerStateSnapshot, TaskOutcome } from '../sandbox/index.ts';
import { createNullLogger, runWithDeadline, summarizeIssues } from './deps.ts';
import type { EventEnvelope } from './deps.ts';
import { envelopeRowOf, findEnvelopeText, prepareEnvelope } from './envelope.ts';
import type { CapturedEvent } from './envelope.ts';
import {
  buildFallbackCommentBody,
  findLastAgentText,
  postFallbackComment,
  supportsCommentFallback,
} from './fallback.ts';
import {
  isInterruptError,
  isTimeoutError,
  observeCommandTimeout,
  signalFromContainerState,
  signalFromDegeneracy,
  signalFromError,
  signalFromParse,
} from './failure.ts';
import type { CommandTimeoutObservation } from './failure.ts';
import type {
  ActionOutcome,
  EndpointRegistry,
  PreparedEnvelope,
  RunOutcome,
  TaskRunInput,
  TaskRunReport,
  TaskRunnerDeps,
  TaskStep,
  WorkerTaskStatus,
} from './types.ts';
import { WORKER_TASK_STATUS } from './types.ts';
import { actionTargetOf, executeActions, taskSourceOf } from './writeback.ts';
import { applyFeedback, feedbackStageForOutcome } from '../feedback/index.ts';
import type { FeedbackOutcome } from '../feedback/index.ts';

/** `/review-pr` 的命令名（决定 30min 而非 20min 的任务级时间闸，§4.7）。 */
export const REVIEW_PR_COMMAND = '/review-pr';

/** 命令 → 任务级时间闸（毫秒）。 */
export function timeoutMsForCommand(command: string): number {
  const normalized = command.trim().toLowerCase();
  return normalized === REVIEW_PR_COMMAND || normalized.startsWith(`${REVIEW_PR_COMMAND} `)
    ? REVIEW_PR_TURN_TIMEOUT_MS
    : DEFAULT_TURN_TIMEOUT_MS;
}

/** `runs.outcome` → 生命周期处置用的 `TaskOutcome`（§6.3 那张表）。 */
export function toTaskOutcome(outcome: RunOutcome): TaskOutcome {
  switch (outcome) {
    case 'succeeded':
      return 'success';
    case 'timed-out':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'degenerate-output':
      // 熔断与超时同一档：立即销毁（§6.3「超时 / 熔断 / 取消」）
      return 'circuit-open';
    case 'failed':
      return 'failure';
  }
}

/** `runs.outcome` → `tasks.status`。 */
export function toTaskStatus(outcome: RunOutcome): WorkerTaskStatus {
  switch (outcome) {
    case 'succeeded':
      return WORKER_TASK_STATUS.succeeded;
    case 'timed-out':
      return WORKER_TASK_STATUS.timedOut;
    case 'cancelled':
      return WORKER_TASK_STATUS.cancelled;
    case 'degenerate-output':
    case 'failed':
      // `tasks.status` 没有「熔断」这一档：它是失败的一个分类（原因在 runs.failure_class）
      return WORKER_TASK_STATUS.failed;
  }
}

/**
 * 由**全部信号**推出 run 的结局。
 *
 * 只看最高优先级的那一个（§7.3）：`timeout` / `interrupt` / `degenerate-output` 同在
 * 优先级 1，它们分别落 `timed-out` / `cancelled` / `degenerate-output`（面板文案不同），
 * 其余一律 `failed`。
 */
export function decideOutcome(
  signals: readonly FailureSignal[],
  terminal: string | null,
  hasDegeneracyHit: boolean,
): RunOutcome {
  if (hasDegeneracyHit) {
    return 'degenerate-output';
  }
  const highest = pickHighestPrioritySignal(signals);
  if (highest === null) {
    return terminal === 'turn.completed' ? 'succeeded' : 'failed';
  }
  switch (highest.failureClass) {
    case 'timeout':
      return 'timed-out';
    case 'interrupt':
      return 'cancelled';
    case 'degenerate-output':
      return 'degenerate-output';
    default:
      return 'failed';
  }
}

/**
 * 记下 `session/create` 与 `turn/start` 返回的 id。
 *
 * 为什么需要这一层：`driveTurn()` 只在**成功返回**时把 `sessionId` / `turnId` 交给上层；
 * 超时、取消、事件流异常这些路径它直接抛错，而 `runs.session_id` / `runs.turn_id`
 * 恰恰在失败场景才有排查价值（面板详情页靠它们回到 Host 侧会话）。
 * 所以这里在 operation 边界上各记一份，两条路径都能把 id 写进 `runs`。
 *
 * 刻意**逐个方法显式委托**而不是 `{ ...ops }`：`RacpOps` 是类实例，方法在原型上，
 * 展开运算符只会复制自有属性——那样就会静默丢掉所有方法。
 */
function recordingOps(
  ops: TurnDriverOps,
  sink: { sessionId?: string; turnId?: string },
): TurnDriverOps {
  // `session/attach` 是可选 operation（`RacpOps` 提供、老 Host 不提供）：这里判断的是
  // **有没有这个方法**，调用时仍然从 `ops` 上取（`RacpOps` 是类实例，方法在原型上，
  // 一旦把方法摘下来当裸函数调，`this` 就丢了 —— 会报 "Cannot read properties of undefined"）。
  const hasAttach = ops.sessionAttach !== undefined;
  return {
    projectRegister: (params, options) => ops.projectRegister(params, options),
    sessionCreate: async (params, options) => {
      const session = await ops.sessionCreate(params, options);
      sink.sessionId = session.id;
      return session;
    },
    eventsSubscribe: (params, options) => ops.eventsSubscribe(params, options),
    turnStart: async (params, options) => {
      const turn = await ops.turnStart(params, options);
      sink.turnId = turn.id;
      return turn;
    },
    turnInterrupt: (params, options) => ops.turnInterrupt(params, options),
    approvalRespond: (params, options) => ops.approvalRespond(params, options),
    inputRespond: (params, options) => ops.inputRespond(params, options),
    workspaceDiff: (params, options) => ops.workspaceDiff(params, options),
    sessionArchive: (params, options) => ops.sessionArchive(params, options),
    ...(hasAttach ? { sessionAttach: (params, options) => ops.sessionAttach!(params, options) } : {}),
  };
}

/** 跑一次任务。**不抛异常**：任何失败都体现在 `report.outcome` 与 `report.signals` 上。 */
export async function runTask(input: TaskRunInput, deps: TaskRunnerDeps): Promise<TaskRunReport> {
  const clock = deps.clock ?? ((): number => Date.now());
  const logger = (deps.logger ?? createNullLogger()).child({ taskId: input.taskId, runId: input.runId });
  const startedAtMs = clock();
  const timeoutMs = (deps.timeoutForCommand ?? timeoutMsForCommand)(input.command);
  const attempt = Math.max(1, input.attempt ?? 1);
  const dryRun = input.dryRun === true;

  /**
   * 人工通道 / 自动通道（plan §5）：只有 `command` 允许写回评论。
   *
   * 显式传了就听传的；没传则按命令名推（`auto:*` → 自动通道），
   * 于是「装配层还没接线」也不会让自动通道发出评论。
   */
  const taskSource = taskSourceOf({ source: input.source, command: input.command });

  const steps: TaskStep[] = [];
  const recordStep = (step: TaskStep, detail?: Readonly<Record<string, unknown>>): void => {
    steps.push(step);
    deps.onStep?.(step, detail);
  };

  const signals: FailureSignal[] = [];
  const commandTimeouts: CommandTimeoutObservation[] = [];
  const captured: CapturedEvent[] = [];
  const actionOutcomes: ActionOutcome[] = [];
  const endpoints: EndpointRegistry = new Map();
  const monitor = createDegeneracyMonitor(deps.degeneracy ?? {});

  let cursor = 0;
  let appendChain: Promise<void> = Promise.resolve();
  const appendEvent = (kind: string, payload: unknown): void => {
    cursor += 1;
    const assigned = cursor;
    appendChain = appendChain
      .then(() => deps.store.appendEvent({ runId: input.runId, cursor: assigned, kind, payload }))
      .catch((error: unknown) => {
        // 落 run_events 失败不能杀掉任务（同 turn-driver 对 onEvent 的处理）
        logger.warn({ kind, cursor: assigned, err: String(error) }, 'run_events 落库失败（已忽略）');
      });
  };

  let containerId: string | undefined;
  let jobDir: string | undefined;
  let sessionId: string | undefined;
  let turnId: string | undefined;
  /** 由 `recordingOps()` 填的 id：失败路径（超时/取消）也要能写进 `runs.session_id` / `turn_id`。 */
  const recordedIds: { sessionId?: string; turnId?: string } = {};
  /** 会话游标与「attach 失败改新建」的标记（上层写 `issue_pipeline.session_cursor` / `blocked_reason`）。 */
  let sessionCursor: number | null = null;
  let sessionReset = false;
  let sessionMode: 'ephemeral' | 'persistent' = 'ephemeral';
  let terminal: string | null = null;
  let turnResult: TurnDriveResult | undefined;
  let eventCount = 0;
  let degeneracyHit: DegeneracyHit | null = null;
  let degeneracyInterrupted = false;
  let containerState: ContainerStateSnapshot | null = null;
  let disposed = false;
  let prepared: PreparedEnvelope | null = null;
  /** 终态无感反馈的结果（`null` = 没注入 feedback 端口 / 没走到收尾）。 */
  let feedbackOutcome: FeedbackOutcome | null = null;

  await deps.store.beginRun({
    runId: input.runId,
    taskId: input.taskId,
    attempt,
    startedAt: new Date(startedAtMs),
  });
  await deps.store.markTask({ taskId: input.taskId, status: WORKER_TASK_STATUS.running, endedAt: new Date(startedAtMs) });

  /** 熔断命中后的退出路径：`turn/interrupt`（幂等）→ 停止产出事件。 */
  const interruptForDegeneracy = async (ref: {
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<void> => {
    try {
      await deps.ops.turnInterrupt({ sessionId: ref.sessionId, turnId: ref.turnId });
    } catch (error) {
      logger.warn({ code: isTimeoutError(error) ? 'timeout' : 'unknown' }, '熔断后 turn/interrupt 失败（幂等，继续）');
    }
  };

  /** 事件流包装：先喂熔断监视器，再交给 turn-driver（它负责落库与审批应答）。 */
  const observedEvents = async function* observe(
    context: { readonly sessionId: string; readonly turnId: string },
  ): AsyncGenerator<EventEnvelope> {
    for await (const event of deps.events(context)) {
      const hit = monitor.observe({ kind: event.kind, payload: event.payload });
      if (hit !== null && !degeneracyInterrupted) {
        degeneracyInterrupted = true;
        degeneracyHit = hit;
        logger.warn({ criterion: hit.criterion }, '重复输出熔断命中，中断本轮');
        await interruptForDegeneracy(context);
      }
      const timeout = observeCommandTimeout(event);
      if (timeout !== undefined) {
        commandTimeouts.push(timeout);
      }
      yield event;
      if (degeneracyInterrupted) {
        return;
      }
    }
  };

  // ── 运行时模式：light 只有 host；sandboxed 走 worktree → container → proxy → host（同一段预算）
  //
  // `light`（阶段 0 格式检查 / 门禁回执）只读正文判定：**没有 worktree、没有容器、没有 exec 代理**
  // （§5 / §10.5）。老任务不传 `runtimeMode`，走 `sandboxed` 分支，调用序列与接线前逐条相同。
  const runtimeMode = input.runtimeMode ?? 'sandboxed';
  const light = runtimeMode === 'light';
  /**
   * light 的 `project/register` 路径：没有 worktree，但 Host 仍要一个 path。
   * 缺省给操作系统临时目录 —— 绝不能退化成 bot 自己的 cwd（那等于把服务端仓库交给 agent 读）。
   */
  const lightRoot = deps.lightWorkdir ?? os.tmpdir();
  let hostReady = false;

  try {
    await runWithDeadline(
      {
        ms: timeoutMs,
        label: `setup:${input.taskId}`,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
      },
      async () => {
        if (!light) {
          recordStep('worktree');
          const handle = await deps.worktree.create({
            taskId: input.taskId,
            repo: input.repo,
            ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
          });
          jobDir = handle.jobDir;

          recordStep('container');
          const spec = buildContainerCreateOptions({
            jobId: input.taskId,
            jobDir: handle.jobDir,
            image: deps.image,
            ...(deps.memoryTier === undefined ? {} : { memoryTier: deps.memoryTier }),
            ...(deps.networkMode === undefined ? {} : { networkMode: deps.networkMode }),
          });
          containerId = await deps.docker.createContainer(spec);

          recordStep('proxy');
          const endpoint = await deps.proxy.listen({
            jobId: input.taskId,
            jobDir: handle.jobDir,
            containerId,
          });
          // tech-plan §4.5 的那张表：socket 路径 → 该进哪个容器
          endpoints.set(endpoint.socketPath ?? endpoint.address, { jobId: input.taskId, containerId });
        }

        recordStep('host');
        const host = await deps.host.ready();
        logger.debug({ hostId: host.hostId, port: host.port, version: host.version }, 'pi-host 就绪');
        hostReady = true;
      },
    );
  } catch (error) {
    signals.push(signalFromError(error));
    logger.error(
      { err: String(error), runtimeMode },
      light ? 'light 运行时就绪失败（host），跳过 turn' : '任务准备阶段失败，跳过 turn',
    );
  }

  // light 只需要 host；sandboxed 还必须有容器与 job 目录（缺一不可，否则没有写入目标）
  const setupFailed =
    signals.length > 0 ||
    !hostReady ||
    (!light && (containerId === undefined || jobDir === undefined));
  // 显式收窄：`setupFailed` 是布尔量，TS 不会据此收窄 `jobDir`，所以取一个局部量。
  const worktreeRoot = setupFailed ? undefined : light ? lightRoot : jobDir;

  // ── 5–8：turn → diff → 信封 → 写执行器 ──────────────────────────────────────
  if (worktreeRoot !== undefined) {
    // ── 提示词装配（M1）：worktree 已就绪、交给宿主之前再装配一次 ────────────────
    //
    // 上游 `input.prompt` 是在建 worktree **之前**拼好的，而 AGENTS.md 与仓库技能文件都
    // 在 worktree 里 —— 这就是「技能正文从未进提示词」的根因。时序上只能在建完 worktree
    // 之后补一次，所以这里回调注入的 enricher。
    //
    // 两条边界：(a) 没注入 = 行为完全不变（`prompt` 就是 `input.prompt`）；
    // (b) 装配失败不能让任务失败 —— 抛错/返回空串都回退到 `basePrompt` 并记 warn。
    let prompt = input.prompt;
    if (light) {
      // light 没有 worktree：阶段提示词 + AGENTS.md 已经在装配层（`buildStagePrompt`）拼好，
      // 这里**不再回调** enricher（§10.5「light 不调 P1/AGENTS 注入器」）。
      logger.debug({ promptChars: prompt.length }, 'light 运行时：提示词已由装配层拼好，跳过 enricher');
    }
    if (!light && deps.promptEnricher !== undefined) {
      try {
        const enriched = await deps.promptEnricher({
          worktreeDir: worktreeRoot,
          basePrompt: input.prompt,
          command: input.command,
        });
        if (typeof enriched === 'string' && enriched.length > 0) {
          prompt = enriched;
          logger.debug(
            { baseChars: input.prompt.length, promptChars: enriched.length },
            '提示词已装配（AGENTS.md + 技能）',
          );
        } else {
          logger.warn({}, 'promptEnricher 返回空提示词，回退到 basePrompt');
        }
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          '提示词装配失败，回退到 basePrompt（不影响任务结局）',
        );
      }
    }

    recordStep('turn');
    try {
      turnResult = await driveTurn({
        ops: recordingOps(deps.ops, recordedIds),
        worktreeRoot,
        prompt,
        messageId: `${input.runId}:${attempt}`,
        timeoutMs,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        events: observedEvents,
        onEvent: async (event) => {
          captured.push({ eventId: event.eventId, kind: event.kind, payload: event.payload });
          appendEvent(event.kind, event.payload);
        },
        onAudit: (audit) => {
          deps.onAuditEvent?.(audit);
          appendEvent('approval.audit', audit);
        },
        title: `${input.command} ${input.repo}#${String(input.targetNumber)}`,
        // 会话计划：缺省 `ephemeral`（= 现有行为）；阶段 2 传 `persistent` 复用（§7）
        ...(input.session === undefined ? {} : { session: input.session }),
        // light 没有容器/worktree：不采 diff（§10.5）
        ...(light ? { collectDiff: false } : {}),
        logger,
      });
      terminal = turnResult.terminal;
      eventCount = turnResult.events;
      sessionId = turnResult.sessionId;
      turnId = turnResult.turnId;
      sessionCursor = turnResult.cursor;
      sessionReset = turnResult.sessionReset;
      sessionMode = turnResult.sessionMode;
    } catch (error) {
      const signal = signalFromError(error);
      signals.push(signal);
      if (isTimeoutError(error)) {
        logger.warn({ timeoutMs }, '任务级超时：中断并销毁容器（不自动重试）');
      } else if (isInterruptError(error)) {
        logger.warn({}, '任务被取消');
      }
      // session/turn id 由 driveTurn 内部维护，异常路径上我们只能从错误里拿不到；
      // `runs.session_id` 允许为空（§7.2），面板按 run_events 也能定位。
    }
  }

  // light 不采 diff（§10.5）：步骤序列里也不该出现 `diff`
  if (!light) {
    recordStep('diff', { events: eventCount, terminal });
    if (turnResult !== undefined) {
      // `workspace/diff` 已由 turn-driver 在归档前取过（第 6 步），这里只把它记进报告。
      logger.debug({ diffBytes: turnResult.diff.diff.length }, 'workspace/diff 已采集');
    }
  }

  if (degeneracyHit !== null) {
    await deps.store.recordDegeneracyHit({ runId: input.runId, hit: degeneracyHit });
    signals.push(signalFromDegeneracy(degeneracyHit));
  }

  // 终态事件自己的语义：`turn.failed` / `turn.interrupted` 也是观测到的信号
  if (terminal === 'turn.failed') {
    signals.push({ failureClass: 'unknown', detail: 'turn.failed：Host 报本轮失败' });
  } else if ((terminal === 'turn.interrupted' || terminal === 'turn.canceled') && degeneracyHit === null) {
    signals.push({ failureClass: 'interrupt', detail: `turn 终态 ${terminal}` });
  } else if (terminal === 'stream-ended' && degeneracyHit === null) {
    signals.push({
      failureClass: 'unknown',
      detail: 'turn 没有终态事件（stream-ended）：无法确认本轮正常结束',
    });
  }

  // ── 信封（第 7 步）：只有在拿到 turn 结果时才校验 ────────────────────────────
  recordStep('validate');
  if (turnResult !== undefined) {
    const found = findEnvelopeText(captured);
    prepared = prepareEnvelope(found?.text ?? null, {
      ...(deps.allowedIntents === undefined ? {} : { allowedIntents: deps.allowedIntents }),
      ...(deps.allowPushBranch === undefined ? {} : { allowPushBranch: deps.allowPushBranch }),
      ...(deps.allowedLabels === undefined ? {} : { allowedLabels: deps.allowedLabels }),
    });
    const row = envelopeRowOf(prepared.text, prepared);
    await deps.store.recordEnvelope({
      runId: input.runId,
      verdict: row.verdict,
      actions: row.actions,
      usage: row.usage,
      valid: prepared.valid,
      errors: prepared.errors,
    });
    if (!prepared.valid) {
      signals.push(signalFromParse(summarizeIssues(prepared.errors)));
    } else if (prepared.dropped.length > 0) {
      appendEvent('writeback.dropped', { dropped: prepared.dropped });
    }
  }

  // ── 兜底回复：信封不可信时**唯一**允许的写回 ────────────────────────────────
  //
  // 真实故障：`@answer` 的 turn 正常跑完（`turn.completed`、工具也跑了），
  // 但事件流里没有能通过 Ajv 的信封 → 按「没有可信信封 → 不写回」的设计，用户看到「@ 了没反应」。
  // 信封校验是安全边界，一步都不能松；但「agent 已经写出面向人的答案」不该被一起丢掉。
  //
  // 五个条件同时成立才兜底（缺一条就只留痕、不写任何东西）：
  //   1. 有一封信封且**不合规**（`missing-envelope` 也算不合规）；
  //   2. 命令是评论类（`/issue-triage`、`/issue-repro`、`@answer`）——
  //      `/review-pr` 的结论若不可信就不该发出去，push 类任务更没有可发的东西；
  //   3. turn 正常收尾（`turn.completed`）：半路结束的 turn 没有「交付物」可言；
  //   4. 不是 dry-run（零副作用是 M0 的验收口径，`actions` 也必须 0 行）；
  //   5. 没有命中熔断（退化输出不值得发布）。
  //
  // 兜底**不改结局**：run 仍然是 `failure_class=parse`，打标与其它写回仍然只认合规信封。
  let fallback: ActionOutcome | null = null;
  if (prepared !== null && !prepared.valid) {
    const agentText =
      turnResult !== undefined && terminal === 'turn.completed' ? findLastAgentText(captured) : null;
    const body = agentText === null ? null : buildFallbackCommentBody(agentText);

    let blocked: string | null = null;
    if (dryRun) {
      blocked = 'dry-run：兜底评论同样不写（零副作用口径）';
    } else if (degeneracyHit !== null) {
      blocked = '熔断命中：不发布退化输出';
    } else if (!supportsCommentFallback(input.command)) {
      blocked = `命令 ${input.command} 不在兜底白名单（仅 /issue-triage、/issue-repro、@answer）`;
    } else if (terminal !== 'turn.completed') {
      blocked = `turn 未正常收尾（terminal=${String(terminal)}）`;
    } else if (body === null) {
      blocked = '事件流里没有面向人的 assistant 文本（只有信封或什么都没有）';
    }

    if (blocked !== null) {
      logger.info({ reason: blocked, command: input.command }, '信封不可信，但不发兜底评论');
      appendEvent('writeback.fallback-skipped', { reason: blocked, command: input.command });
    } else if (body !== null) {
      fallback = await postFallbackComment({
        runId: input.runId,
        repo: input.repo,
        targetNumber: input.targetNumber,
        command: input.command,
        body,
        api: deps.github,
        store: deps.store,
        clock,
      });
      appendEvent('writeback.fallback', {
        status: fallback.status,
        target: fallback.target,
        reason: fallback.reason,
        command: input.command,
      });
      logger.warn({ status: fallback.status, target: fallback.target }, '信封不可信，已按 last assistant 文本兜底发评论');
    }
  }

  // ── 写执行器（第 8 步） ────────────────────────────────────────────────────
  recordStep('execute');
  // 熔断命中时**只校验入库、不执行写动作**：plan §9.3 的处置是「已产出的结构化结果照样校验入库」，
  // 没说「照样发布」。一份在退化状态下产出的评论/标签，发布出去比丢掉代价大得多。
  // ★ `command` **有意不传**（`executeActions()` 的 `command` 缺省 = `undefined`）：
  // `isWriteBackAllowed({intent:'comment', source:'pipeline', command:undefined})` 恒为 false，
  // 于是**流水线的阶段评论一条都不会由 worker 发出** —— 阶段评论（含门禁回执）统一由控制面发
  // （`app/compose.ts` 的 `executeFormatPlan()` / `executeClassifyPlan()` / `postGateNotice()`）。
  // 别为了「让回执能发出去」把 `command` 补上：那会让同一条评论有两条发送路径，
  // 而 worker 侧没有长度 / 限速 / `@` 那三道控制面才有的闸。
  if (prepared !== null && prepared.valid && prepared.accepted.length > 0 && degeneracyHit === null) {
    const target =
      deps.targets === undefined
        ? {}
        : await deps.targets
            .load({ repo: input.repo, targetNumber: input.targetNumber })
            .catch(() => ({}));
    const executed = await executeActions({
      runId: input.runId,
      repo: input.repo,
      targetNumber: input.targetNumber,
      actions: prepared.accepted,
      dryRun,
      source: taskSource,
      api: deps.github,
      ...(deps.feedback === undefined ? {} : { reactions: deps.feedback.reactions }),
      ledger: deps.ledger,
      // 打标策略（W2-E）：装配层注入 → 写之前归一化 desired + 落 label_decisions。
      // 不注入时 `executeActions` 照信封的增量集合直接写（接线前的行为）。
      ...(deps.labelPolicy === undefined ? {} : { labelPolicy: deps.labelPolicy }),
      target,
      mention: input.actorLogin ?? null,
      store: deps.store,
      clock,
    });
    actionOutcomes.push(...executed.outcomes);
    signals.push(...executed.signals);
    if (dryRun) {
      // dry-run 的「计划」留在这里：不写 actions 行，但面板与审计能看到本来要做什么
      appendEvent('writeback.dry-run', {
        status: 'dry-run',
        actions: executed.outcomes.map((item) => ({
          intent: item.intent,
          target: item.target,
          reason: item.reason,
        })),
      });
    }
  }

  // ── 结局判定 → 生命周期处置（第 9 步之前） ─────────────────────────────────
  const preOutcome = decideOutcome(signals, terminal, degeneracyHit !== null);
  const endedAtMs = clock();

  // light 没有容器与端点：步骤序列里不记 `dispose`、也不碰 exec 代理 ——
  // 这样「零容器 / 零 worktree / 零代理」在调用序列上也是可断言的（V1）。
  if (!light) {
    recordStep('dispose', { outcome: preOutcome });
    if (containerId !== undefined && jobDir !== undefined) {
      try {
        const disposeResult = await deps.lifecycle.dispose({
          jobId: input.taskId,
          containerId,
          jobDir,
          outcome: toTaskOutcome(preOutcome),
        });
        disposed = true;
        containerState = disposeResult.state;
        // 采到 OOM 却与 lifecycle 的判定不一致时以采到的状态为准（§7.3 的判定源是 OOMKilled）
        const patched = classifyDestroyedState(disposeResult.state);
        if (patched !== undefined && preOutcome !== 'succeeded') {
          logger.debug({ patched }, '销毁前采集出的容器状态');
        }
      } catch (error) {
        signals.push(signalFromError(error, `容器处置失败：${String(error)}`));
      }
    } else {
      // 没起容器也要清端点（worktree 失败时不会有端点，destroy 是幂等的）
      await deps.proxy.destroy({ jobId: input.taskId }).catch(() => undefined);
    }
  }
  endpoints.clear();

  // 容器状态的结论只在「本轮本来就不算成功」时升级为信号（见 failure.ts 文件头第 2 条）
  if (preOutcome !== 'succeeded') {
    const containerSignal = signalFromContainerState(containerState);
    if (containerSignal !== undefined) {
      signals.push(containerSignal);
    }
  }

  const outcome = decideOutcome(signals, terminal, degeneracyHit !== null);
  const highest = pickHighestPrioritySignal(signals);
  const failureClass: FailureClass | null = outcome === 'succeeded' ? null : (highest?.failureClass ?? 'unknown');
  const retry = decideRetry(signals, { attempt });
  const endedAt = new Date(endedAtMs);

  // ── 用量与费用：pi-host 只给 token，金额按 DeepSeek 官方价目自己算 ─────────────
  //
  // 为什么不信信封里的 `usage`：那是 agent 自己填的，实测恒为 0（它看不到计费数据）。
  // pi-host 的 `turns` 表里有 provider 返回的真数（含 cacheReadTokens），所以从那里读。
  // 读不到 / 算不出**都不影响任务结局**：这条链路是记账，不是判定。
  const usageTurnId = turnId ?? recordedIds.turnId;
  if (deps.usage !== undefined && usageTurnId !== undefined) {
    try {
      const usage = await deps.usage(usageTurnId);
      if (usage !== null) {
        const cost = estimateDeepSeekCostUsd({ model: usage.modelId, tokens: usage, at: endedAt });
        await deps.store.recordUsage({
          runId: input.runId,
          model: usage.modelId ?? 'unknown',
          // 库里存 provider 口径的「总输入」＝未命中 + 命中缓存；单价差异已经体现在 costUsd 里
          inputTokens: usage.inputTokens + usage.cacheReadTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost.costUsd,
        });
        logger.info(
          {
            model: usage.modelId,
            inTokens: usage.inputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            outTokens: usage.outputTokens,
            costUsd: cost.costUsd,
            tier: cost.tier,
            peak: cost.peak,
            priceVersion: cost.priceVersion,
          },
          '已记录本轮用量与费用',
        );
      } else {
        logger.debug({ turnId: usageTurnId }, 'pi-host 里没有这一轮的用量记录，跳过记账');
      }
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, '记录用量失败（不影响任务结局）');
    }
  }

  // ── 无感反馈（W2-D）：终态一条 reaction ──────────────────────────────────────
  //
  // 成功 / 失败 / 超时 / 取消四条路径在 `decideOutcome()` 之后汇成一束，所以收尾只有这一处：
  //   succeeded → -eyes +rocket；failed / degenerate-output → -eyes +confused；
  //   timed-out / cancelled → -eyes +confused（闸门路径没有 worker，由闸门自己收尾）。
  //
  // 三条纪律：
  //  1. dry-run 一个 reaction 都不打，`issue_feedback` 也不写，只落 `feedback.planned`；
  //  2. 台账写入失败只 warn——**不能改变 run 结论**（反馈是装饰，不是证据）；
  //  3. 403 / 无权限 → `applyFeedback()` 内部置 `reactions_disabled` 并降级，
  //     这里补一条 `actions(applied_at=null)`，面板才能解释「为什么没有火箭」。
  if (deps.feedback !== undefined) {
    try {
      feedbackOutcome = await applyFeedback(
        {
          ...deps.feedback,
          logger,
          clock,
          onEvent: (kind: string, payload: unknown) => {
            appendEvent(kind, payload);
          },
        },
        {
          repo: input.repo,
          targetKind: input.targetKind,
          targetNumber: input.targetNumber,
          stage: feedbackStageForOutcome(outcome),
          // 锚点取 `tasks.idempotency_key`（**不是** taskId）：重投/重跑不该重复打 reaction
          anchor: input.idempotencyKey ?? input.runId,
          ...(dryRun ? { dryRun: true } : {}),
        },
      );

      if (feedbackOutcome.status === 'failed' || feedbackOutcome.status === 'disabled') {
        await deps.store
          .recordAction({
            runId: input.runId,
            intent: 'reaction.add',
            target: actionTargetOf(input.repo, input.targetNumber),
            externalRef: null,
            appliedAt: null,
            audit: {
              stage: feedbackOutcome.stage,
              content: feedbackOutcome.content,
              status: feedbackOutcome.status,
              reason: feedbackOutcome.reason,
              httpStatus: feedbackOutcome.httpStatus,
              permissionDenied: feedbackOutcome.permissionDenied,
            },
          })
          .catch((error: unknown) => {
            logger.warn({ err: String(error) }, '反馈留痕（actions 行）写入失败（已忽略）');
          });
      }

      if (feedbackOutcome.status === 'applied' || feedbackOutcome.status === 'failed') {
        appendEvent('feedback.result', {
          stage: feedbackOutcome.stage,
          content: feedbackOutcome.content,
          status: feedbackOutcome.status,
          reactionId: feedbackOutcome.reactionId,
          removed: feedbackOutcome.removed,
          reason: feedbackOutcome.reason,
        });
      }
    } catch (error) {
      // 兜底：反馈层内部已经把所有已知失败都收成 status，走到这里说明是未预料异常
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        '无感反馈失败（不影响 run 结论）',
      );
    }
  }

  const failureDetail = {
    signals: signals.map((signal) => ({
      failureClass: signal.failureClass,
      httpStatus: signal.httpStatus ?? null,
      retryAfterSeconds: signal.retryAfterSeconds ?? null,
      detail: signal.detail ?? null,
    })),
    // 命令级超时不参与分类，只留痕（§7.3：交给 agent 换策略）
    commandTimeouts,
    containerState,
    terminal,
    dryRun,
    envelope: prepared === null ? null : { valid: prepared.valid, accepted: prepared.accepted.length, dropped: prepared.dropped.length },
    actions: actionOutcomes.map((item) => ({ intent: item.intent, status: item.status, target: item.target })),
    // 兜底回复的留痕（`null` = 本轮没走兜底；原因看 `run_events` 的 `writeback.fallback*`）
    fallback:
      fallback === null
        ? null
        : { intent: fallback.intent, status: fallback.status, target: fallback.target, reason: fallback.reason },
    retry,
    // 无感反馈的留痕（`null` = 没注入 feedback 端口；状态见 `FeedbackOutcome`）
    feedback:
      feedbackOutcome === null
        ? null
        : {
            stage: feedbackOutcome.stage,
            content: feedbackOutcome.content,
            status: feedbackOutcome.status,
            reactionId: feedbackOutcome.reactionId,
            httpStatus: feedbackOutcome.httpStatus,
          },
  };
  await appendChain.catch(() => undefined);
  // 成功路径用 turn-driver 给的 id；失败路径（超时/取消）用它从 operation 边界记下的那一份。
  sessionId = sessionId ?? recordedIds.sessionId;
  turnId = turnId ?? recordedIds.turnId;
  await deps.store.finishRun({
    runId: input.runId,
    outcome,
    failureClass,
    failureDetail,
    endedAt,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(turnId === undefined ? {} : { turnId }),
  });
  await deps.store.markTask({
    taskId: input.taskId,
    status: toTaskStatus(outcome),
    endedAt,
    ...(containerId === undefined ? {} : { containerName: containerNameFor(input.taskId) }),
  });

  return {
    runId: input.runId,
    taskId: input.taskId,
    outcome,
    failureClass,
    signals,
    retry,
    steps,
    feedback: feedbackOutcome,
    terminal,
    envelope: prepared,
    sessionId: sessionId ?? null,
    turnId: turnId ?? null,
    actions: actionOutcomes,
    fallback,
    dryRun,
    containerState,
    containerId: containerId ?? null,
    jobDir: jobDir ?? null,
    events: eventCount,
    degeneracy: monitor.stats,
    durationMs: endedAtMs - startedAtMs,
    disposed,
    retryable: retry.retry,
    runtimeMode,
    sessionMode,
    sessionCursor,
    sessionReset,
  };
}
