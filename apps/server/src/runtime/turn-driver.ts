/**
 * 每任务时序（tech-plan §4.3 的九步，跑一个 turn）。
 *
 * ```
 * 1 project/register { path: <worktree> }            → projectId（已注册直接复用）
 * 2 session/create { projectId, permissionMode:'ask', mode:'agent' }  → sessionId
 * 3 events/subscribe { sessionId, after: 0 }         → 游标从 0 开始
 * 4 turn/start { sessionId, input:{ messageId, text: <prompt> } }     → turnId
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
}

export interface TurnDriverParams {
  readonly ops: TurnDriverOps;
  /** 本任务的 worktree 根（`project/register` 的 path，也是审批策略的判定基准）。 */
  readonly worktreeRoot: string;
  /** 拼好的提示词（技能模板 + 仓库配置 + 任务上下文，由上层负责拼）。 */
  readonly prompt: string;
  /** `turn/start` 的 `input.messageId`（与 run 绑定的稳定 id）。 */
  readonly messageId: string;
  /** 任务级 deadline；默认 20min，`/review-pr` 传 30min。 */
  readonly timeoutMs?: number;
  /** 上层取消（SIGTERM / 人工取消）。 */
  readonly parent?: AbortSignal;
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

  let sessionId: string | undefined;
  let turnId: string | undefined;

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

        // 2. session/create（`ask` + 自动应答：每次 allow/deny 都是审计条目，§4.6）
        const session = await params.ops.sessionCreate(
          {
            projectId,
            permissionMode: 'ask',
            mode: 'agent',
            ...(params.title === undefined ? {} : { title: params.title }),
          },
          requestOptions,
        );
        sessionId = session.id;

        // 3. events/subscribe（游标从 0 开始）
        await params.ops.eventsSubscribe({ sessionId, after: 0 }, requestOptions);

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

        // 6. workspace/diff（与信封一起入库供面板展示）
        const diff = await params.ops.workspaceDiff({ sessionId }, requestOptions);

        // 7. session/archive（任务结束立即归档；删除交给每日清理）
        //
        // **归档失败不算任务失败**：v0.22.0 的 Host 把 `session/archive` 注册成
        // 「不可用」（`unavailable("session archival")`），能力表里没有它就是没有。
        // 归档只是清理动作，把它变成 run 的终态会把「agent 干得对不对」和
        // 「宿主版本有没有这个能力」混为一谈——所以这里只记 warn。
        try {
          await params.ops.sessionArchive({ sessionId }, requestOptions);
        } catch (error) {
          logger.warn(
            { code: isAppError(error) ? error.code : 'UNKNOWN' },
            'session/archive 失败（Host 可能不提供该 operation；不影响本次结果）',
          );
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
          archived: true,
        } satisfies TurnDriveResult;
      },
    );
  } catch (error) {
    const appError = toAppError(error, { code: 'TURN_DRIVER_FAILED', failureClass: 'unknown' });
    // 超时与取消都要「先 interrupt 再抛」：否则 agent 会在容器里继续写同一个 worktree（§4.7）。
    const needsInterrupt = appError.failureClass === 'timeout' || appError.failureClass === 'interrupt';
    if (needsInterrupt && sessionId !== undefined && turnId !== undefined) {
      await interruptAndArchive(params.ops, { sessionId, turnId }, logger);
    }
    throw appError;
  }
}

/** 超时/取消的退出路径：`turn/interrupt`（幂等）→ `session/archive`。两者失败都只告警。 */
async function interruptAndArchive(
  ops: TurnDriverOps,
  ref: { readonly sessionId: string; readonly turnId: string },
  logger: Logger,
): Promise<void> {
  try {
    await ops.turnInterrupt({ sessionId: ref.sessionId, turnId: ref.turnId });
  } catch (error) {
    logger.warn(
      { code: isAppError(error) ? error.code : 'UNKNOWN' },
      '超时后 turn/interrupt 失败（幂等，继续归档）',
    );
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
}

/** 事件循环：审批/反问应答 + 终态退出。 */
async function runEventLoop(params: EventLoopParams): Promise<EventLoopResult> {
  let events = 0;
  let approvals = 0;
  let denies = 0;
  let inputs = 0;
  let eventSinkErrors = 0;

  for await (const event of params.events) {
    events += 1;

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
      return { terminal: event.kind, events, approvals, denies, inputs, eventSinkErrors };
    }
  }

  return { terminal: 'stream-ended', events, approvals, denies, inputs, eventSinkErrors };
}

/** 上层最常问的一句：这个错误是不是「任务超时」（决定任务标 `timed-out` 且不自动重试）。 */
export function isTurnTimeout(error: unknown): boolean {
  return error instanceof AppError && error.failureClass === 'timeout';
}

/** 固定应答的字面量再导出一遍：面板与审计要靠它 grep。 */
export { INPUT_UNAVAILABLE_ANSWER };
