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
  COMPACTION_LIMIT_CODE,
  messagesFromSnapshotItems,
} from '../compact/turn-compaction.ts';
import type {
  TurnCompactionOutcome,
  TurnCompactionPort,
  TurnCompactionRebuild,
} from '../compact/turn-compaction.ts';
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
  /**
   * 快照里的会话条目（`SessionSnapshot.items`）。
   *
   * **为什么这里要它**：FR-5.6 的压缩需要「宿主侧真实历史」，而 `attach` 快照是 RACP 目前
   * 唯一给出历史的 operation（没有 `session/history`）。类型留成 `unknown[]` 是因为条目内容
   * 形状（`ItemSummary.content`）属于宿主私有结构，抽取的容错逻辑放在
   * `compact/turn-compaction.ts::messagesFromSnapshotItems()`，driver 不猜它。
   */
  readonly items?: readonly unknown[];
  /** `true` = 快照只给了第一页，更老的历史读不到（压缩侧的 token 估算因此是下界）。 */
  readonly hasMoreHistory?: boolean;
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
  /**
   * `true` = 本轮**上下文被重置过**，上层据此把 `agent_sessions.turns` 归零
   * （新会话没有旧正文历史，下一轮必须重新下发全文）。两种来源，都是「新会话、空历史」：
   *  1. 本该复用会话但 `session/attach` 失败 → 新建会话继续（不阻塞）；
   *  2. 压缩后**换会话重建**（FR-5.6「喂给模型的内容 = 从最新 checkpoint 重建」）——
   *     旧会话归档，新会话只拿到重建视图（摘要 + 保留的真实最近消息）。
   */
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
  /**
   * 请求前的压缩检查点（FR-5.6）。**不注入 = 与接线前逐字节一致**（老部署、老任务、单测）。
   *
   * 位置是需求明写的「请求发出前」：`session/attach` 之后（此刻拿得到宿主侧历史）、
   * `turn/start` 之前（此刻还来得及拒发）。返回 `send:false` 时本文件**不发送请求**，
   * 直接以 `COMPACTION_HARD_LIMIT` 抛出 —— 宁可失败并留痕，也不发一个注定被 provider 拒掉的包。
   */
  readonly compaction?: TurnCompactionPort;
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
  /** `true` = 压缩后换过会话（旧会话归档，新会话从重建视图开始）—— 也要把 `sessionReset` 交给上层。 */
  let sessionRebuilt = false;
  let cursor: number | null = null;
  /**
   * `session/attach` 的快照（`null` = 没 attach / attach 失败）。
   *
   * 压缩检查点要的历史只能从这里拿（RACP 没有 `session/history`），所以快照必须活到
   * 第 3.5 步，不能像以前那样用完即弃。
   */
  let attachSnapshot: SessionAttachResult | null = null;

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
          attachSnapshot = attached;
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
        // 3.5 压缩检查点（FR-5.6「检查点固定在请求发出前」）
        //
        // 为什么必须夹在这里：历史只能从第 2 步的 `session/attach` 快照里拿，而 `turn/start`
        // 是唯一真正的「请求发出」。再早拿不到历史，再晚就来不及拒发。
        //
        // `compaction` 未注入 / 快照里没历史（`ephemeral` 会话、本轮新建会话）→ 原样返回提示词，
        // 提示词与本层接线前**逐字节一致**。
        const decision = await runCompactionCheckpoint({
          compaction: params.compaction,
          sessionId,
          turnText: params.prompt,
          snapshot: attachSnapshot,
          logger,
        });

        // 3.6 换会话重建（FR-5.6「喂给模型的内容 = 从最新 checkpoint 重建」）
        //
        // 为什么是「换会话」而不是「拼前缀」：RACP 没有「替换会话上下文」的 operation
        // （`packages/racp-client/src/ops.ts` 全表核对过），`turn/start` 只带 `{ messageId, text }`。
        // 换一个会话 = 宿主侧上下文真的变空，重建视图因此真的比原来小；原始对话一条不删，
        // 它们仍在 `agent_messages` / `agent_compactions` 里（后台视图）。
        //
        // 换会话失败**不判死任务**：退回前缀路径（不减小请求，但至少能跑完这一轮），并留 warn。
        let turnText = decision.text;
        if (decision.rebuild !== null) {
          const rebuiltSessionId = await rebuildSession({
            ops: params.ops,
            projectId,
            sessionId,
            ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
            ...(params.title === undefined ? {} : { title: params.title }),
            logger,
            requestOptions,
          });
          if (rebuiltSessionId === null) {
            logger.warn(
              { sessionId },
              '压缩检查点：换会话重建失败，退回前缀路径（本轮请求没有变小，原始历史未丢）',
            );
          } else {
            logger.info(
              {
                from: sessionId,
                to: rebuiltSessionId,
                rebuiltTokens: decision.rebuild.tokens,
                recentMessages: decision.rebuild.recentMessages,
              },
              '压缩检查点：换会话重建上下文（旧会话已归档，新会话只拿到摘要 + 最近真实消息）',
            );
            sessionId = rebuiltSessionId;
            // 新会话没有任何历史事件：订阅从 0 开始，游标也从头计
            after = 0;
            turnText = decision.rebuild.text;
            sessionRebuilt = true;
          }
        }

        // 4. turn/start（`turnText` = 重建视图 / checkpoint 前缀 / 临边提醒，见第 3.5–3.6 步）
        const turn = await params.ops.turnStart(
          { sessionId, input: { messageId: params.messageId, text: turnText } },
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
          // 换过会话同样是「上下文被重置」（见 `TurnDriveResult.sessionReset`）
          sessionReset: sessionReset || sessionRebuilt,
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

/** 压缩检查点的结论（两种「本轮怎么发」的入口，见第 3.5–3.6 步）。 */
type CompactionDecision = {
  /** 不换会话时本轮要发的文本（checkpoint 前缀 / 临边提醒 / 原文） */
  readonly text: string;
  /** 有值 = 端口要求换会话重建（`null` = 走 `text`） */
  readonly rebuild: TurnCompactionRebuild | null;
};

/**
 * 请求前的压缩检查点（FR-5.6）。
 *
 * 三件事，按责任划清：
 *  1. 把「宿主侧真实历史」从快照里还原出来（形状容错在 `compact/turn-compaction.ts`）；
 *  2. 调端口。**端口约定不抛**，这里再兜一次：压缩器自己炸了不能把一轮已经跑到这里、
 *     捧着一条完整提示词的任务判死（代价 = 按原文发送，见端口注释）；
 *  3. `send:false` → **不发送请求**，抛 `COMPACTION_HARD_LIMIT`。需求原文是「过了硬边界
 *     不发送请求，宁可失败也不发一个注定被拒的包」，所以失败要带足够的原因去留痕
 *     （`details` 里有 beforeTokens / hardLimit / layers）。
 *
 * 本函数**不换会话、不发送**：换会话是 ops 的事（`rebuildSession()`），发送点只有
 * 第 4 步的 `turn/start` 一处。这里只决定「这一步要不要换、换了发什么」。
 *
 * 为什么读 `snapshot.items` 而不是自己查库：`run_events` 是我们**看到的事件**，不是宿主
 * 真正喂给模型的消息（`item.delta` 都不落库）；拿事件流冒充历史会让压缩算错量级。
 */
async function runCompactionCheckpoint(input: {
  readonly compaction: TurnCompactionPort | undefined;
  readonly sessionId: string;
  readonly turnText: string;
  readonly snapshot: SessionAttachResult | null;
  readonly logger: Logger;
}): Promise<CompactionDecision> {
  if (input.compaction === undefined) {
    return { text: input.turnText, rebuild: null };
  }

  const items = input.snapshot?.items;
  const history = items === undefined ? [] : messagesFromSnapshotItems(items);
  const historyComplete = input.snapshot?.hasMoreHistory !== true;

  let outcome: TurnCompactionOutcome;
  try {
    outcome = await input.compaction({
      sessionId: input.sessionId,
      turnText: input.turnText,
      history,
      historyComplete,
    });
  } catch (error) {
    // 端口承诺不抛；真抛了按原文发送（同端口注释里的取舍），但必须能被发现
    input.logger.warn(
      { code: isAppError(error) ? error.code : 'UNKNOWN' },
      '压缩检查点异常（按原文发送本轮请求）',
    );
    return { text: input.turnText, rebuild: null };
  }

  if (!outcome.send) {
    throw new AppError(outcome.message, {
      code: outcome.code === '' ? COMPACTION_LIMIT_CODE : outcome.code,
      failureClass: 'model',
      // 不重试：同一份历史重投一次还是同一个 token 数，重试只会把 20min 的任务时限烧在这里
      retriable: false,
      details: { ...outcome.details },
    });
  }

  if (outcome.note !== null) {
    input.logger.info(
      {
        generation: outcome.note.generation,
        beforeTokens: outcome.note.beforeTokens,
        afterTokens: outcome.note.afterTokens,
        summaryChars: outcome.note.summaryChars,
        fallback: outcome.note.fallback,
        layers: outcome.note.layers,
        historyComplete: outcome.note.historyComplete,
        rebuild: outcome.rebuild !== undefined,
      },
      '压缩检查点：已追加一条 checkpoint（压缩记录已落 agent_compactions，原始对话未改写）',
    );
  } else if (outcome.reminder !== null) {
    input.logger.debug({ tier: outcome.reminder }, '本轮请求已带上临边提醒（该档只响一次）');
  }

  return { text: outcome.text, rebuild: outcome.rebuild ?? null };
}

/**
 * 压缩后的「换会话重建」（FR-5.6「喂给模型的内容 = 从最新 checkpoint 重建」）。
 *
 * 为什么必须换会话：`packages/racp-client/src/ops.ts` 的全部 operation 里没有「替换会话上下文」，
 * `turn/start` 只接受 `{ messageId, text }`。所以「重建」只能落成「新会话 + 一段自包含正文」：
 * 新会话的宿主上下文是空的，重建视图因此真的比原来小；原始对话一条不删，仍在
 * `agent_messages` / `agent_compactions`（后台视图）。
 *
 * 顺序与失败取舍（`null` = 换会话失败，调用方退回前缀路径）：
 *  1. 先 `session/create`：失败就返回 `null`，旧会话还能用 —— 任务不该因为「压缩器想换会话
 *     但宿主建不出来」而失败；
 *  2. 再在新会话上 `events/subscribe`：订阅是按 sessionId 的，旧会话那条订阅读不到新事件；
 *     这一步失败也返回 `null`（宁可退回前缀，也不要在一个没订阅的会话上发 turn，那样事件全丢）；
 *  3. 最后才 `session/archive` 旧会话 —— 它是清理动作，失败只 warn：新会话已可用，
 *     不该因为「旧的没归档成功」把这一轮判死。反过来（先归档再建）会把任务卡在没有会话的状态上。
 */
async function rebuildSession(input: {
  readonly ops: TurnDriverOps;
  readonly projectId: string;
  readonly sessionId: string;
  readonly systemPrompt?: string;
  readonly title?: string;
  readonly logger: Logger;
  readonly requestOptions: RequestOptions;
}): Promise<string | null> {
  let createdId: string;
  try {
    const created = await input.ops.sessionCreate(
      {
        projectId: input.projectId,
        permissionMode: 'ask',
        mode: 'agent',
        // 身份走 system 通道：新会话是全新上下文，system 提示词必须跟着一起给
        ...(input.systemPrompt === undefined || input.systemPrompt === ''
          ? {}
          : { systemPrompt: input.systemPrompt }),
        ...(input.title === undefined ? {} : { title: input.title }),
      },
      input.requestOptions,
    );
    createdId = created.id;
    await input.ops.eventsSubscribe({ sessionId: createdId, after: 0 }, input.requestOptions);
  } catch (error) {
    input.logger.warn(
      { sessionId: input.sessionId, code: isAppError(error) ? error.code : 'UNKNOWN' },
      '换会话重建失败：新会话不可用，退回 checkpoint 前缀路径（这一轮照常跑，但请求没有变小）',
    );
    return null;
  }

  try {
    await input.ops.sessionArchive({ sessionId: input.sessionId }, input.requestOptions);
  } catch (error) {
    input.logger.warn(
      { sessionId: input.sessionId, code: isAppError(error) ? error.code : 'UNKNOWN' },
      '换会话重建：旧会话归档失败（Host 可能不提供该 operation；不影响本轮）',
    );
  }
  return createdId;
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
