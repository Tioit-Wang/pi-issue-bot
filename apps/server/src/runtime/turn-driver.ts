/**
 * 每任务时序（tech-plan §4.3 的九步，跑一个 turn）。
 *
 * ```
 * 1 project/register { path: <worktree> }            → projectId（已注册直接复用）
 * 2 session/create { projectId, permissionMode:'ask', mode:'agent', systemPrompt? } → sessionId
 * 3 events/subscribe { sessionId, after: 0 }         → 游标从 0 开始
 * 4 turn/start { sessionId, input:{ messageId, text: <任务提示词> } }   → turnId
 * 5 事件循环：approval/request → §4.6 策略；input/request → 固定应答；turn 终态 → 退出
 * 6 workspace/diff                                    → 与信封一起入库
 * 7 session/archive                                   → 任务结束立即归档
 * ```
 * （第 7–8 步的「校验信封 / 写执行器」在 worker 里，不在本文件：本文件只负责把一个 turn
 * 从建会话跑到归档，`onEvent` 把事件流交给上层落 `run_events`。）
 *
 * 两个必须写对的地方：
 *  1. **任务级 deadline 用 `runWithDeadline`**（§4.7 第二层，20min；`/review-pr` 30min 由参数传）。
 *     超时后**先 `turn/interrupt`（幂等）再抛** `AppError{failureClass:'timeout'}`，
 *     否则 agent 会在容器里继续跑到自然结束 —— 那正是 §4.7 要避免的「超时了但还在写同一个 worktree」。
 *  2. **事件循环的退出条件是 `turn/*` 终态**，不是「事件流读完」。WS 会断、订阅会重放，
 *     「流结束」不等于「任务结束」，所以循环结束只有在拿到终态事件时才算正常收尾。
 */

import {
  INPUT_UNAVAILABLE_ANSWER,
  answerInputRequest,
  decideApproval,
  racpDecisionFor,
} from './approval-policy.ts';
import type { ApprovalAudit } from './approval-policy.ts';
import { AppError, createNullLogger, isAppError, runWithDeadline, toAppError } from './deps.ts';
import type { EventEnvelope, Logger, PermissionMode, RequestOptions, SessionMode } from './deps.ts';

/** 单任务时间闸默认值（§4.7）：20 分钟。 */
export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1_000;
/** `/review-pr` 的时间闸（§4.7）：30 分钟。 */
export const REVIEW_PR_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
/**
 * 会话复用计划（`docs/plan-fixed-pipeline.md` §7 / §10.5）。
 *
 *  - `ephemeral`（**缺省**）：一个任务一个会话，跑完 `session/archive` —— 阶段 0/1 与所有老任务；
 *  - `persistent`：阶段 2 的 `@` 轮次复用同一个会话。给了 `sessionId` 就 `session/attach` 接管，
 *    `after` 是上一轮结束时的 `session_cursor`（订阅从它之后开始，**防重放旧事件污染本轮信封**）；
 *    跑完**不 archive**（归档了下一轮就没得 attach）。
 *
 * 「阶段间独立、阶段内粘性」（D1 + E2）：阶段 0/1 各自 create → run → archive，
 * `session_id` 两两不同；只有 `ready` 之后同一 issue 的多轮 `@` 才复用。
 */
export type SessionPlan =
  | { readonly mode: 'ephemeral' }
  | { readonly mode: 'persistent'; readonly sessionId?: string; readonly after?: number };

/**
 * `session/attach` 返回值里我们只关心游标。
 *
 * `RacpOps.sessionAttach()` 交的是 `SessionSnapshot`（`cursor: { epoch, sequence }`），
 * 而 `issue_pipeline.session_cursor` 是一列整数 —— 所以这里两种形态都容忍，
 * 由 `sessionCursorOf()` 统一取数字（取不到就 `null`，由调用方的 `after` 兜底）。
 */
export type SessionAttachResult = {
  readonly cursor?: number | { readonly sequence?: number | null } | null;
};

/** 从 `session/attach` 的返回值里取数字游标（取不到给 `null`）。 */
export function sessionCursorOf(result: SessionAttachResult | null | undefined): number | null {
  const cursor = result?.cursor;
  if (typeof cursor === 'number' && Number.isFinite(cursor)) {
    return Math.max(0, Math.trunc(cursor));
  }
  if (typeof cursor === 'object' && cursor !== null) {
    const sequence = cursor.sequence;
    if (typeof sequence === 'number' && Number.isFinite(sequence)) {
      return Math.max(0, Math.trunc(sequence));
    }
  }
  return null;
}

/** turn 的四个终态事件（§5.3 的事件种类里的 `turn.*`）。 */
export const TERMINAL_TURN_EVENT_KINDS = [
  'turn.completed',
  'turn.interrupted',
  'turn.failed',
  'turn.canceled',
] as const;

export type TerminalTurnEventKind = (typeof TERMINAL_TURN_EVENT_KINDS)[number];

function isTerminalTurnEvent(kind: string): kind is TerminalTurnEventKind {
  return (TERMINAL_TURN_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * driver 用到的 RACP operation（`RacpOps` 的方法签名可直接满足这个结构类型）。
 * 只列 §4.4 白名单里用得到的那些，`terminal/*` 之类不在其中。
 */
export interface TurnDriverOps {
  projectRegister(
    params: { readonly path: string },
    options?: RequestOptions,
  ): Promise<{ readonly projectId: string }>;
  sessionCreate(
    params: {
      readonly projectId?: string;
      readonly title?: string;
      readonly mode?: SessionMode;
      readonly permissionMode?: PermissionMode;
      /**
       * 会话级 system 提示词（身份 + 工作方式）。
       *
       * 由 `driveTurn` **只在新建会话时**传（见 `TurnDriverParams.systemPrompt`）。
       * 老 Host 不认识这个字段时应忽略它：丢掉只是回到「身份写在任务提示词里」的旧行为，
       * 不应该让整条 `session/create` 判成参数非法。
       */
      readonly systemPrompt?: string;
    },
    options?: RequestOptions,
  ): Promise<{ readonly id: string }>;
  eventsSubscribe(
    params: { readonly sessionId: string; readonly after?: number },
    options?: RequestOptions,
  ): Promise<unknown>;
  turnStart(
    params: {
      readonly sessionId: string;
      readonly input: { readonly messageId: string; readonly text: string };
    },
    options?: RequestOptions,
  ): Promise<{ readonly id: string }>;
  /** 幂等：重复 interrupt 不报错（§4.3 的退出路径）。 */
  turnInterrupt(params: { readonly sessionId: string; readonly turnId: string }, options?: RequestOptions): Promise<unknown>;
  approvalRespond(
    params: {
      readonly approvalId: string;
      readonly decision: 'allow-once' | 'deny';
      readonly permissionMode?: PermissionMode;
    },
    options?: RequestOptions,
  ): Promise<unknown>;
  inputRespond(
    params: { readonly inputId: string; readonly answers: readonly (readonly string[] | null)[] },
    options?: RequestOptions,
  ): Promise<unknown>;
  workspaceDiff(
    params: { readonly sessionId: string },
    options?: RequestOptions,
  ): Promise<{ readonly diff: string; readonly truncated?: boolean }>;
  sessionArchive(params: { readonly sessionId: string }, options?: RequestOptions): Promise<unknown>;
  /**
   * `session/attach`：接管一个已有会话（阶段 2 的 `@` 复用，§7）。
   *
   * **可选**：`RacpOps` 提供它；不提供（或抛错）一律按「attach 失败」处理 ——
   * 新建会话 + warn + `session-reset`，**不阻塞**本轮（§7「attach 失败不阻塞」）。
   */
  sessionAttach?(
    params: { readonly sessionId: string },
    options?: RequestOptions,
  ): Promise<SessionAttachResult>;
}

/** 事件里 `approval.requested` 的载荷（只取我们判断需要的字段，缺就用不到的那几条兜）。 */
export interface ApprovalRequestPayload {
  readonly id: string;
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly kind?: string;
  readonly summary?: string;
}

/** 事件里 `input.requested` 的载荷。 */
export interface InputRequestPayload {
  readonly id: string;
  readonly questions: readonly { readonly id?: string; readonly question?: string }[];
}

export interface TurnDriveResult {
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** 触发退出的终态事件种类；`stream-ended` 表示事件流先结束了（异常但已归档）。 */
  readonly terminal: TerminalTurnEventKind | 'stream-ended';
  readonly diff: { readonly diff: string; readonly truncated?: boolean };
  readonly events: number;
  /** 审批判定次数（allow + deny）。 */
  readonly approvals: number;
  readonly denies: number;
  /** `input/request` 应答次数。 */
  readonly inputs: number;
  /** 落库失败被吞掉的事件条数（不阻断任务，但要能被发现）。 */
  readonly eventSinkErrors: number;
  readonly archived: boolean;
  /** 会话模式（`ephemeral` 归档 / `persistent` 留着给下一轮 attach）。 */
  readonly sessionMode: 'ephemeral' | 'persistent';
  /**
   * 本轮结束时的最新游标（事件流最后一条的 `sequence`，没有事件时退回订阅起点）。
   * 上层据此写 `issue_pipeline.session_cursor`；`ephemeral` 也会给（无害，便于观测）。
   */
  readonly cursor: number | null;
  /** `true` = 这一轮本该复用会话但 `session/attach` 失败，已新建会话（不阻塞）。 */
  readonly sessionReset: boolean;
}

export interface TurnDriverParams {
  readonly ops: TurnDriverOps;
  /** 本任务的 worktree 根（`project/register` 的 path，也是审批策略的判定基准）。 */
  readonly worktreeRoot: string;
  /**
   * **任务提示词**（这次要做什么 + 约束 + 输出契约，由上层负责拼）。
   *
   * 身份/工作方式**不在这里**：它走 `systemPrompt`（system 通道）。两者分开是因为
   * 前者每轮都变、后者跨轮次恒定，而 `session/create` 正好只有一次。
   */
  readonly prompt: string;
  /**
   * 会话级 system 提示词（`skills/prompt.ts::AGENT_IDENTITY_PROMPT` 或仓库配置里那份）。
   *
   * **只在新建会话时生效**：`session/attach` 分支不传（会话已存在，身份由创建那一刻决定，
   * 再传一次等于给同一条会话两个身份来源）。所以 `persistent` 复用的轮次里这个参数是**无用的**，
   * 传了也不会报错 —— 让调用方每轮统一传，比让调用方判断「这一轮会不会新建」更不容易错。
   */
  readonly systemPrompt?: string;
  /**
   * 会话计划（缺省 `ephemeral` = 现有行为：create → run → archive）。
   *
   * 阶段 2 传 `{ mode:'persistent', sessionId, after }` 复用同一个会话（§7）；
   * 阶段 0/1 与所有老任务不传，行为与接线前**逐字节一致**。
   */
  readonly session?: SessionPlan;
  /** `turn/start` 的 `input.messageId`（与 run 绑定的稳定 id）。 */
  readonly messageId: string;
  /** 任务级 deadline；默认 20min，`/review-pr` 传 30min。 */
  readonly timeoutMs?: number;
  /** 上层取消（SIGTERM / 人工取消）。 */
  readonly parent?: AbortSignal;
  /**
   * 是否采 `workspace/diff`（缺省 `true` = 现有行为）。
   *
   * `light` 运行时没有容器也没有 worktree，diff 必然是空的 —— 采集它只是多一次无用的
   * operation 调用（§10.5「light 跳过 diff 采集」）。缺省 `true` 保证老任务行为不变。
   */
  readonly collectDiff?: boolean;
  /** 事件源：上层用 `client.onEvent()` 装配；测试注入假事件流。 */
  readonly events: (context: { readonly sessionId: string; readonly turnId: string }) => AsyncIterable<EventEnvelope>;
  /** 每条事件都过一遍（落 `run_events`）；抛错会被记下但不中断任务。 */
  readonly onEvent?: (event: EventEnvelope) => void | Promise<void>;
  /** 每条审批审计（落 `actions.audit` / 面板审计页）。 */
  readonly onAudit?: (audit: ApprovalAudit) => void;
  readonly title?: string;
  readonly logger?: Logger;
}

/** driver 自己的错误码（`timeout` 沿用 `runWithDeadline` 的 `DEADLINE_EXCEEDED`）。 */
export const TURN_DRIVER_ERROR_CODES = {
  noTerminal: 'TURN_NO_TERMINAL_EVENT',
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * 从 `approval.requested` 的 payload 里取审批信息。
 *
 * 为什么两种嵌套都认：`racp.schema.json` 尚未 vendored（§2.2），
 * `payload` 到底是「ApprovalRequest 本体」还是 `{ approval: ApprovalRequest, tool: { name, input } }`
 * 现在无法确定。两种都试，都对不上就返回 `undefined`（记 warn，不猜测、不静默放行）。
 */
export function extractApprovalRequest(payload: unknown): ApprovalRequestPayload | undefined {
  const raw = asRecord(payload);
  if (raw === undefined) {
    return undefined;
  }
  const nested = asRecord(raw['approval']) ?? raw;
  const id = nested['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  const tool = asRecord(raw['tool']);
  const toolName = nested['toolName'] ?? tool?.['name'];
  const toolInput = asRecord(nested['input']) ?? asRecord(tool?.['input']) ?? asRecord(raw['input']);
  const summary = nested['summary'];
  const kind = nested['kind'];
  return {
    id,
    ...(typeof toolName === 'string' ? { toolName } : {}),
    ...(toolInput === undefined ? {} : { toolInput }),
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof summary === 'string' ? { summary } : {}),
  };
}

/** 从 `input.requested` 的 payload 里取反问列表（同样容忍一层嵌套）。 */
export function extractInputRequest(payload: unknown): InputRequestPayload | undefined {
  const raw = asRecord(payload);
  if (raw === undefined) {
    return undefined;
  }
  const nested = asRecord(raw['input']) ?? raw;
  const id = nested['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  const questions = nested['questions'];
  const list = Array.isArray(questions) ? questions : [];
  return {
    id,
    questions: list.map((question) => {
      const record = asRecord(question);
      return {
        ...(typeof record?.['id'] === 'string' ? { id: record['id'] } : {}),
        ...(typeof record?.['question'] === 'string' ? { question: record['question'] } : {}),
      };
    }),
  };
}

/**
 * 跑一个任务（一个 turn）。顺序严格按 §4.3：
 * register → create → subscribe → start → 事件循环 → diff → archive。
 *
 * 超时/取消：`turn/interrupt` → `session/archive` → 抛原分类的错误（`timeout` / `interrupt`）。
 */
export async function driveTurn(params: TurnDriverParams): Promise<TurnDriveResult> {
  const logger = params.logger ?? createNullLogger();
  const timeoutMs = params.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const plan: SessionPlan = params.session ?? { mode: 'ephemeral' };
  const persistent = plan.mode === 'persistent';
  /** `persistent` 用上一轮的游标当订阅起点（防重放旧事件污染本轮信封）；`ephemeral` 恒为 0。 */
  const requestedAfter = persistent ? Math.max(0, Math.trunc(plan.after ?? 0)) : 0;

  let sessionId: string | undefined;
  let turnId: string | undefined;
  let after = requestedAfter;
  let sessionReset = false;
  let cursor: number | null = null;

  try {
    return await runWithDeadline(
      {
        ms: timeoutMs,
        label: `turn:${params.messageId}`,
        ...(params.parent === undefined ? {} : { parent: params.parent }),
      },
      async (signal) => {
        const requestOptions: RequestOptions = { signal };

        // 1. project/register
        const project = await params.ops.projectRegister({ path: params.worktreeRoot }, requestOptions);
        const projectId = project.projectId;

        // 2. 会话：`persistent` 且有 `session_id` → `session/attach` 复用；否则（或 attach 失败）新建。
        //
        // 「attach 失败不阻塞」（§7）：老 Host 可能没有这条 operation，会话也可能已被每日清理删掉。
        // 这时新建一个会话继续跑，并把 `sessionReset` 交给上层落 `blocked_reason='session-reset'`
        // —— 面板要能解释「为什么这一轮的上下文断了一次」。
        if (persistent && plan.sessionId !== undefined && plan.sessionId !== '') {
          const attached = await attachSession(params.ops, plan.sessionId, logger);
          if (attached !== null) {
            sessionId = plan.sessionId;
            // 没显式给 `after` 时用快照游标兜底：至少不会从 0 重放整段历史
            if (plan.after === undefined) {
              const attachedCursor = sessionCursorOf(attached);
              if (attachedCursor !== null) {
                after = attachedCursor;
              }
            }
          } else {
            sessionReset = true;
            logger.warn({ sessionId: plan.sessionId }, 'session/attach 失败：新建会话继续（不阻塞本轮）');
          }
        }
        if (sessionId === undefined) {
          // session/create（`ask` + 自动应答：每次 allow/deny 都是审计条目，§4.6）
          const session = await params.ops.sessionCreate(
            {
              projectId,
              permissionMode: 'ask',
              mode: 'agent',
              // 身份说明走 system 通道，**只在这一分支**（新建会话）带；
              // `session/attach` 上面那条路径不带，原因见 `TurnDriverParams.systemPrompt`。
              ...(params.systemPrompt === undefined || params.systemPrompt === ''
                ? {}
                : { systemPrompt: params.systemPrompt }),
              ...(params.title === undefined ? {} : { title: params.title }),
            },
            requestOptions,
          );
          sessionId = session.id;
        }

        // 3. events/subscribe（`after` = 上一轮游标；`ephemeral` 恒从 0 开始）
        await params.ops.eventsSubscribe({ sessionId, after }, requestOptions);

        // 4. turn/start
        const turn = await params.ops.turnStart(
          { sessionId, input: { messageId: params.messageId, text: params.prompt } },
          requestOptions,
        );
        turnId = turn.id;

        // 5. 事件循环
        const loop = await runEventLoop({
          ops: params.ops,
          events: params.events({ sessionId, turnId }),
          worktreeRoot: params.worktreeRoot,
          requestOptions,
          logger,
          ...(params.onEvent === undefined ? {} : { onEvent: params.onEvent }),
          ...(params.onAudit === undefined ? {} : { onAudit: params.onAudit }),
        });
        // 最新游标：上层写 `issue_pipeline.session_cursor`（`persistent` 的下一轮靠它防重放）
        cursor = loop.lastSequence ?? after;

        // 6. workspace/diff（与信封一起入库供面板展示）
        //    light 运行时没有容器也没有 worktree：`collectDiff:false` 直接跳过（§10.5）
        const diff =
          params.collectDiff === false
            ? { diff: '', truncated: false }
            : await params.ops.workspaceDiff({ sessionId }, requestOptions);

        // 7. session/archive（任务结束立即归档；删除交给每日清理）
        //
        // **只有 `ephemeral` 归档**：`persistent` 归档了下一轮就没得 attach（§7）。
        //
        // **归档失败不算任务失败**：v0.22.0 的 Host 把 `session/archive` 注册成
        // 「不可用」（`unavailable("session archival")`），能力表里没有它就是没有。
        // 归档只是清理动作，把它变成 run 的终态会把「agent 干得对不对」和
        // 「宿主版本有没有这个能力」混为一谈——所以这里只记 warn。
        let archived = false;
        if (!persistent) {
          try {
            await params.ops.sessionArchive({ sessionId }, requestOptions);
          } catch (error) {
            logger.warn(
              { code: isAppError(error) ? error.code : 'UNKNOWN' },
              'session/archive 失败（Host 可能不提供该 operation；不影响本次结果）',
            );
          }
          archived = true;
        }

        return {
          projectId,
          sessionId,
          turnId,
          terminal: loop.terminal,
          diff: { diff: diff.diff, ...(diff.truncated === undefined ? {} : { truncated: diff.truncated }) },
          events: loop.events,
          approvals: loop.approvals,
          denies: loop.denies,
          inputs: loop.inputs,
          eventSinkErrors: loop.eventSinkErrors,
          archived,
          sessionMode: plan.mode,
          cursor,
          sessionReset,
        } satisfies TurnDriveResult;
      },
    );
  } catch (error) {
    const appError = toAppError(error, { code: 'TURN_DRIVER_FAILED', failureClass: 'unknown' });
    // 超时与取消都要「先 interrupt 再抛」：否则 agent 会在容器里继续写同一个 worktree（§4.7）。
    const needsInterrupt = appError.failureClass === 'timeout' || appError.failureClass === 'interrupt';
    if (needsInterrupt && sessionId !== undefined && turnId !== undefined) {
      // `persistent` 失败时也**不归档**：会话留给下一轮 attach（归档是清理，不是语义）
      await interruptAndArchive(params.ops, { sessionId, turnId }, logger, { archive: !persistent });
    }
    throw appError;
  }
}

/**
 * `session/attach` 的一次尝试：**不抛错**，失败一律 `null`（由调用方新建会话）。
 * 三种失败等价：Host 没这条 operation、会话不存在、断线。
 */
async function attachSession(
  ops: TurnDriverOps,
  sessionId: string,
  logger: Logger,
): Promise<SessionAttachResult | null> {
  if (ops.sessionAttach === undefined) {
    logger.warn({ sessionId }, 'Host 不提供 session/attach：改为新建会话（不阻塞）');
    return null;
  }
  try {
    return await ops.sessionAttach({ sessionId });
  } catch (error) {
    logger.warn(
      { sessionId, code: isAppError(error) ? error.code : 'UNKNOWN' },
      'session/attach 失败：改为新建会话（不阻塞）',
    );
    return null;
  }
}

/** 超时/取消的退出路径：`turn/interrupt`（幂等）→ `session/archive`。两者失败都只告警。 */
async function interruptAndArchive(
  ops: TurnDriverOps,
  ref: { readonly sessionId: string; readonly turnId: string },
  logger: Logger,
  options: { readonly archive: boolean },
): Promise<void> {
  try {
    await ops.turnInterrupt({ sessionId: ref.sessionId, turnId: ref.turnId });
  } catch (error) {
    logger.warn(
      { code: isAppError(error) ? error.code : 'UNKNOWN' },
      '超时后 turn/interrupt 失败（幂等，继续归档）',
    );
  }
  if (!options.archive) {
    // `persistent` 会话留给下一轮 attach（§7）；清理交给每日清理任务
    return;
  }
  try {
    await ops.sessionArchive({ sessionId: ref.sessionId });
  } catch (error) {
    logger.warn(
      { code: isAppError(error) ? error.code : 'UNKNOWN' },
      '超时后 session/archive 失败（交给每日清理）',
    );
  }
}

interface EventLoopParams {
  readonly ops: TurnDriverOps;
  readonly events: AsyncIterable<EventEnvelope>;
  readonly worktreeRoot: string;
  readonly requestOptions: RequestOptions;
  readonly logger: Logger;
  readonly onEvent?: (event: EventEnvelope) => void | Promise<void>;
  readonly onAudit?: (audit: ApprovalAudit) => void;
}

interface EventLoopResult {
  readonly terminal: TerminalTurnEventKind | 'stream-ended';
  readonly events: number;
  readonly approvals: number;
  readonly denies: number;
  readonly inputs: number;
  readonly eventSinkErrors: number;
  /** 最后一条事件的 `sequence`（会话游标）；一条都没有时 `null`（由订阅起点兜底）。 */
  readonly lastSequence: number | null;
}

/** 事件循环：审批/反问应答 + 终态退出。 */
async function runEventLoop(params: EventLoopParams): Promise<EventLoopResult> {
  let events = 0;
  let approvals = 0;
  let denies = 0;
  let inputs = 0;
  let eventSinkErrors = 0;
  let lastSequence: number | null = null;

  for await (const event of params.events) {
    events += 1;
    // 会话游标跟着事件走：`persistent` 的下一轮用它当 `events/subscribe` 的 `after`（§7）
    if (typeof event.sequence === 'number' && Number.isFinite(event.sequence)) {
      lastSequence = lastSequence === null ? event.sequence : Math.max(lastSequence, event.sequence);
    }

    if (params.onEvent !== undefined) {
      try {
        await params.onEvent(event);
      } catch (error) {
        // 落 run_events 失败不能杀掉一个已经跑了十几分钟的任务：记数 + 告警，继续跑。
        eventSinkErrors += 1;
        params.logger.warn(
          { kind: event.kind, eventId: event.eventId, code: isAppError(error) ? error.code : 'UNKNOWN' },
          'run_events 落库失败（已忽略，继续任务）',
        );
      }
    }

    if (event.kind === 'approval.requested') {
      const request = extractApprovalRequest(event.payload);
      if (request === undefined) {
        params.logger.warn({ eventId: event.eventId }, 'approval.requested 载荷无法解析，跳过应答');
        continue;
      }
      const decision = decideApproval({
        tool: request.toolName ?? '',
        input: request.toolInput ?? {},
        worktreeRoot: params.worktreeRoot,
      });
      params.onAudit?.(decision.audit);
      if (decision.decision === 'deny') {
        denies += 1;
      }
      approvals += 1;
      await params.ops.approvalRespond(
        { approvalId: request.id, decision: racpDecisionFor(decision.decision) },
        params.requestOptions,
      );
      continue;
    }

    if (event.kind === 'input.requested') {
      const request = extractInputRequest(event.payload);
      if (request === undefined) {
        params.logger.warn({ eventId: event.eventId }, 'input.requested 载荷无法解析，跳过应答');
        continue;
      }
      const answer = answerInputRequest({ questions: request.questions, worktreeRoot: params.worktreeRoot });
      params.onAudit?.(answer.audit);
      inputs += 1;
      await params.ops.inputRespond({ inputId: request.id, answers: answer.answers }, params.requestOptions);
      continue;
    }

    if (isTerminalTurnEvent(event.kind)) {
      return { terminal: event.kind, events, approvals, denies, inputs, eventSinkErrors, lastSequence };
    }
  }

  return { terminal: 'stream-ended', events, approvals, denies, inputs, eventSinkErrors, lastSequence };
}

/** 上层最常问的一句：这个错误是不是「任务超时」（决定任务标 `timed-out` 且不自动重试）。 */
export function isTurnTimeout(error: unknown): boolean {
  return error instanceof AppError && error.failureClass === 'timeout';
}

/** 固定应答的字面量再导出一遍：面板与审计要靠它 grep。 */
export { INPUT_UNAVAILABLE_ANSWER };
