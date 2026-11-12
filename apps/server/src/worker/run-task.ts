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
  EnvelopeRecord,
  PreparedEnvelope,
  RunOutcome,
  TaskRunInput,
  TaskRunReport,
  TaskRunnerDeps,
  TaskStep,
  WorkerTaskStatus,
  WriteTargetContext,
} from './types.ts';
import { WORKER_TASK_STATUS } from './types.ts';
import { actionTargetOf, executeActions, taskSourceOf } from './writeback.ts';
import { applyFeedback, feedbackStageForOutcome } from '../feedback/index.ts';
import type { FeedbackOutcome } from '../feedback/index.ts';
// ── v2.1 接线（WS6-B）：产出契约 v2 + 七类动作执行器 + 压缩观测 ────────────────
// 为什么在 worker 里直接 import 而不是包一层 adapter：`run-task.ts` 是**唯一**同时拿到
// 「事件流 / GitHub 写面 / settings / ledger / clock」的地方；再抽一层只会多一个空壳模块。
import { parseOutputV21Json, summarizeOutputV21Issues } from '../../../../packages/envelope/src/index.ts';
import type { OutputV21, OutputV21Issue } from '../../../../packages/envelope/src/index.ts';
import { createV21PortFromGithub, executeV21 } from '../writeback/v21/execute.ts';
import type {
  ExecuteV21Result,
  V21ActionSwitches,
  V21PortSources,
} from '../writeback/v21/execute.ts';
import type { CatalogEntry } from '../writeback/v21/labels.ts';
import { readV21Settings, resolveAgentExecution, resolveManagedCatalog } from '../config/v21-settings.ts';
import type { CompactionRecordInput, CompactStore } from '../compact/engine.ts';

/* ── v2.1 运行时的可选注入（WS6-B）────────────────────────────────────────── */

/**
 * 装配层给 worker 的 v2.1 配置。
 *
 * 为什么是**可选**且独立成一块：`TaskRunnerDeps` 的必填字段被上百个单测钉住，
 * 加一个必填项会让所有旧假实现一起崩。旧任务不注入 `v21` 时，
 * `runTask()` 的九步、旧 4-intent 信封与写回逐字节不变。
 */
/** 装配层注入的执行器结论（与 `http/webhook-v21.ts::createV21Executor()` 同形）。 */
export type V21RunExecution = {
  readonly handled: boolean;
  readonly valid: boolean;
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  readonly verdict: unknown;
  readonly actions: unknown;
  readonly executed: readonly {
    readonly index: number;
    readonly type: string;
    readonly outcome: string;
  }[];
  readonly stoppedAt: number | null;
};

export interface V21RuntimeConfig {
  /** `repos.settings` 原始值（unknown）；`readV21Settings()` 自己兜底，坏配置不抛。 */
  readonly settings?: unknown;
  /**
   * 装配层的 v2 执行器（可选）。注入时 runTask 走它（它内部就是 `executeV21()`）；
   * 不注入时 runTask 用下面的 `reactions`/`openPullRequest` 自己装配一份端口直连。
   * 两种形态并存是为了让「控制面装配」与「worker 自测直连」都能跑同一条分流逻辑。
   */
  readonly execute?:
    | ((text: string, ctx: {
        readonly repo: string;
        readonly issueNumber: number;
        readonly dryRun: boolean;
      }) => Promise<V21RunExecution>)
    | undefined;
  /** reaction 写面（已由装配层把 `GithubReactionApi` 收窄成端口形状）。 */
  readonly reactions?: V21PortSources['reactions'];
  /** 开 PR 的能力（v2.1 之前没有任何路径会开 PR，单独注入）。 */
  readonly openPullRequest?: V21PortSources['openPullRequest'];
  /** 「这个 login 是不是我」的判定（App slug 优先，否则按 `[bot]` 后缀）。 */
  readonly isOwn?: V21PortSources['isOwn'];
  /** `agent_compactions` 的只追加存储（不注入 = 只观测不落库）。 */
  readonly compactionStore?: CompactStore;
  /**
   * 事件钩子（与 `http/webhook-v21.ts::V21EventHook` 同形）：host 报出
   * `itemType==='compaction'` 时只追加一条压缩记录。与 `compactionStore` 可同时注入，
   * 两者各自负责一条留痕路径（装配层的钩子 / worker 自己的识别），互不覆盖。
   */
  readonly onEvent?:
    | ((event: {
        readonly kind: string;
        readonly payload: unknown;
        readonly repo: string;
        readonly issueNumber: number;
        readonly sessionId: string;
      }) => Promise<void>)
    | undefined;
  /**
   * 压缩引擎句柄（`createCompactor()` 的柯里化形态）。
   *
   * 本轮**只暴露、不自动调用**：RACP 客户端没有 session/history 与 compact 操作，
   * host 侧拿不到完整历史，「请求发出前自动压缩」仍是遗留项（见最终报告）。
   */
  readonly compactor?: unknown | undefined;
}

/** `runTask()` 的依赖：旧端口 + 可选 v2.1 注入。 */
export type V21RunnerDeps = TaskRunnerDeps & { readonly v21?: V21RuntimeConfig | undefined };

/** 兼容别名（装配层与早期接线稿都用过这两个名字）。 */
export type V21RunDeps = V21RunnerDeps;
export type V21RunnerHooks = V21RuntimeConfig;

/* ── v2 产出的「试探」：从事件流里找一份 v2 契约的原文 ─────────────────────── */

/** 与旧 `findEnvelopeText()` 同口径的载体路径（v2 与 v1 共用同一批事件形状）。 */
const V21_TEXT_PATHS: readonly (readonly string[])[] = [
  ['event', 'message', 'content'],
  ['message', 'content'],
  ['event', 'message', 'text'],
  ['text'],
  ['message', 'text'],
  ['item', 'text'],
  ['content'],
  ['output'],
  ['result'],
  ['envelope'],
];

/** 只在这些 kind 上找产出，避免把日志/工具输出当成信封。 */
const V21_EVENT_KINDS: readonly string[] = ['item.completed', 'turn.completed', 'turn.failed'];

const FENCED_V21_JSON = /```(?:json|jsonc)?\s*([\s\S]*?)```/gu;

export type V21Probe =
  | { readonly kind: 'valid'; readonly text: string; readonly output: OutputV21 }
  | { readonly kind: 'rejected'; readonly text: string; readonly errors: readonly OutputV21Issue[] }
  /** 不是 v2 产出（旧 4-intent 信封、纯人话、或压根没有产出）→ 回落旧路径。 */
  | { readonly kind: 'not-v21' };

function v21StringAt(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.includes('{') ? current : undefined;
}

/** 一个事件载荷里的全部候选文本：每个 ```json 代码块优先，其次整串。 */
function v21CandidateTexts(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (text: string): void => {
    if (text.includes('{') && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  if (typeof payload === 'string') {
    add(payload);
  }
  for (const path of V21_TEXT_PATHS) {
    const raw = v21StringAt(payload, path);
    if (raw === undefined) {
      continue;
    }
    for (const block of raw.matchAll(FENCED_V21_JSON)) {
      const inner = block[1];
      if (inner !== undefined) {
        add(inner.trim());
      }
    }
    add(raw);
  }
  return out;
}

/**
 * 「像不像 v2 产出」的判定（不是校验）。
 *
 * 为什么必须区分「v2 形状但校验失败」与「旧信封」：一份含未知 `type` 的 v2 产出必须
 * **整份拒绝**并把 `/actions/0/type` 写进 `envelopes.errors`；若一律回落到旧 Ajv，
 * 面板只会看到一串和 v2 无关的旧字段错误。旧 4-intent 信封必带 `usage` 且
 * `verdict` 是对象，所以这两个条件足以把两份契约分开。
 */
function looksLikeV21Output(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record['actions']) || 'usage' in record) {
      return false;
    }
    const verdict = record['verdict'];
    return verdict === undefined || typeof verdict === 'string';
  } catch {
    return false;
  }
}

/** 不合规产出也要把模型交出来的 `verdict` / `actions` 留在 envelopes 行里（面板要能看到原文）。 */
function v21RawEnvelopeColumns(text: string): { readonly verdict: unknown; readonly actions: unknown } {
  try {
    const value: unknown = JSON.parse(text);
    const record =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return { verdict: record['verdict'] ?? null, actions: record['actions'] ?? null };
  } catch {
    return { verdict: null, actions: null };
  }
}

/**
 * 从后往前试探事件流：最后一条合规 v2 产出胜出；没有合规的但见过 v2 形状 → 整份拒绝。
 *
 * 用 `parseOutputV21Json()` 当探针而不是 `findEnvelopeText()`：后者以旧 Ajv 为探针，
 * v2 产出没有 `usage` 且 `verdict` 是字符串，永远过不了旧 schema（也过不了
 * `looksLikeEnvelope()` 的三键判定），会被误判成「没有交信封」。
 */
export function probeV21Output(events: readonly CapturedEvent[]): V21Probe {
  let rejection: { readonly text: string; readonly errors: readonly OutputV21Issue[] } | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !V21_EVENT_KINDS.includes(event.kind)) {
      continue;
    }
    for (const text of v21CandidateTexts(event.payload)) {
      const parsed = parseOutputV21Json(text);
      if (parsed.ok) {
        return { kind: 'valid', text, output: parsed.output };
      }
      if (rejection === null && looksLikeV21Output(text)) {
        rejection = { text, errors: parsed.errors };
      }
    }
  }
  return rejection === null
    ? { kind: 'not-v21' }
    : { kind: 'rejected', text: rejection.text, errors: rejection.errors };
}

/* ── v2 执行端口：把既有写面接到 `createV21PortFromGithub()` ───────────────── */

/**
 * 为什么逐个方法显式委托而不 `{ ...github }`：写面可能来自类实例（方法在原型上），
 * 展开会静默丢方法。顺带把 `label` 的增删同步进 `bot_labels`（`deps.ledger`），
 * 否则 v2 路径打过的标签下一轮「谁打的」就查不到了。
 */
export function v21WritePort(
  github: TaskRunnerDeps['github'],
  ledger: TaskRunnerDeps['ledger'],
): V21PortSources['write'] {
  return {
    listIssueComments: (input) => github.listIssueComments(input),
    createIssueComment: (input) => github.createIssueComment(input),
    updateIssueComment: (input) => github.updateIssueComment(input),
    addLabels: async (input) => {
      await github.addLabels(input);
      await ledger?.recordApplied({
        repo: input.repo,
        issueNumber: input.issueNumber,
        labels: input.labels,
      });
    },
    removeLabel: async (input) => {
      await github.removeLabel(input);
      await ledger?.recordRemoved({
        repo: input.repo,
        issueNumber: input.issueNumber,
        labels: [input.label],
      });
    },
    createIssue: (input) => github.createIssue(input),
    closeIssue: (input) => github.closeIssue(input),
  };
}

/**
 * `ExecuteV21Input.catalog` 的装配：**全量**返回，不提前筛。
 *
 * `planLabelTargetState()` 自己会按 `managed` / `status` / `meaning` 判可管理集合；
 * 在这里先筛掉 retired / unmanaged / 没填含义的条目，会把「目录外」和「不可管理」
 * 压成同一种错误，面板就分不清该让人改产出还是改配置，而且 `skipped` 留痕也会丢。
 */
export function v21CatalogOf(settings: unknown): readonly CatalogEntry[] {
  return resolveManagedCatalog(settings).map((entry) => ({
    name: entry.name,
    meaning: entry.meaning,
    managed: entry.managed,
    status: entry.status,
  }));
}

/* ── 压缩事件的观测（FR-5.6：本轮只做「识别 + 落记录」）───────────────────── */

function v21Record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function v21Int(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * 从一条 RACP 事件里认出 `itemType === 'compaction'` 并还原 `agent_compactions` 的一行。
 *
 * 为什么只做识别、`compactSession()` 不在这里调：`packages/racp-client` 目前**没有**
 * session/history 与 compact 操作，只在 `ITEM_TYPES` 里留了 `'compaction'` 字面量。
 * host 侧不暴露历史，就无从在「请求发出前」判断上下文是否过线；本轮只能把 host 报出来的
 * 压缩 checkpoint 如实落库（观测），不能假装已经自动压缩。
 */
export function compactionRecordOfEvent(
  payload: unknown,
  ctx: { readonly repo: string; readonly issueNumber: number; readonly sessionId: string },
): CompactionRecordInput | null {
  // `agent_compactions.session_id` 非空：拿不到会话 id 时宁可不写，也不写一条无法归因的行
  if (ctx.sessionId === '') {
    return null;
  }
  const outer = v21Record(payload);
  const inner = v21Record(outer?.['item']) ?? outer;
  const isCompaction =
    outer?.['itemType'] === 'compaction' ||
    inner?.['itemType'] === 'compaction' ||
    outer?.['type'] === 'compaction' ||
    inner?.['type'] === 'compaction';
  if (!isCompaction) {
    return null;
  }
  const detail = v21Record(inner?.['checkpoint']) ?? inner;
  if (detail === null) {
    return null;
  }
  const summary = detail['summary'];
  return {
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    sessionId: ctx.sessionId,
    generation: v21Int(detail['generation'], 0),
    beforeTokens: v21Int(detail['beforeTokens'], 0),
    afterTokens: v21Int(detail['afterTokens'], 0),
    summaryChars: typeof summary === 'string' ? summary.length : v21Int(detail['summaryChars'], 0),
    fallback: detail['fallback'] === true,
  };
}

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
export async function runTask(input: TaskRunInput, deps: V21RunnerDeps): Promise<TaskRunReport> {
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
  /** 本轮是否走了 v2 分支（走了就跳过旧兜底评论：v2 的 `comment` 是槽位写回）。 */
  let v21Handled = false;
  /** 合规的 v2 产出，留到 execute 步执行（envelopes 每 run 只有一行，错误要等执行结果）。 */
  let v21Plan: { readonly text: string; readonly output: OutputV21 } | null = null;
  /** v2 分支是否已经写过 envelopes 行（唯一索引在 run_id 上，绝不能写第二行）。 */
  let v21EnvelopeWritten = false;

  /** 写一行 envelopes；失败只 warn（审计行写不进去不该杀掉整个 run）。 */
  const writeV21Envelope = async (record: EnvelopeRecord): Promise<void> => {
    if (v21EnvelopeWritten) {
      return;
    }
    v21EnvelopeWritten = true;
    await deps.store.recordEnvelope(record).catch((error: unknown) => {
      logger.warn({ err: String(error) }, 'envelopes 行写入失败（已忽略）');
    });
  };

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
          // 点名的技能：任务行上的结构化字段（正文里的 `/name` 已在组装期被摘掉）。
          ...(input.skillIds === undefined ? {} : { skillIds: input.skillIds }),
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
          // FR-5.6 压缩观测：host 在事件流里报出 `itemType==='compaction'` 时只追加一条
          // `agent_compactions` 行。这里**不发起压缩** —— RACP 客户端目前没有 session/history
          // 与 compact 操作，请求前自动压缩还接不上（见最终报告的遗留说明）。
          // 两条留痕路径二选一，避免同一事件写两行：优先 worker 自己的 `compactionStore`
          // （由 `createCompactionStore()` 装配），没注入时才走装配层的 `onEvent` 钩子。
          if (deps.v21 !== undefined) {
            const context = {
              kind: event.kind,
              payload: event.payload,
              repo: input.repo,
              issueNumber: input.targetNumber,
              sessionId: recordedIds.sessionId ?? sessionId ?? '',
            };
            const store = deps.v21.compactionStore;
            if (store !== undefined) {
              const record = compactionRecordOfEvent(event.payload, context);
              if (record !== null) {
                try {
                  await store.record(record);
                  appendEvent('compact.recorded', {
                    sessionId: record.sessionId,
                    generation: record.generation,
                    beforeTokens: record.beforeTokens,
                    afterTokens: record.afterTokens,
                    summaryChars: record.summaryChars,
                    fallback: record.fallback,
                  });
                } catch (error) {
                  logger.warn({ err: String(error) }, '压缩记录落库失败（不影响本轮）');
                }
              }
            } else if (deps.v21.onEvent !== undefined) {
              try {
                await deps.v21.onEvent(context);
              } catch (error) {
                logger.warn({ err: String(error) }, 'v2.1 压缩留痕失败（不影响本轮）');
              }
            }
          }
          // `item.delta` 是正文的**流式增量**（一次 turn 上百条，实机 125 条 / 27 秒）：
          // 退化检测需要它（走 `captured`，不进库），审计与面板不需要 —— 落库只会让
          // `run_events` 每轮多出上百行、把真正的事件挤出详情页（上限 500 条）。
          if (event.kind !== 'item.delta') {
            appendEvent(event.kind, event.payload);
          }
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
    // v2 产出分流（FR-5.3）：**仅 `tasks.source==='agent'`** 试探事件流里的 v2 信封。
    //
    // 三态而不能只看「parse ok / parse 失败」：
    //  - `valid`    → 走 `executeV21()`（第 8 步），旧路径一次都不碰；
    //  - `rejected` → v2 形状但校验不过（未知 type / 字段越界）→ **整份拒绝**，
    //                 一条动作都不执行，错误落 envelopes.errors 与 run_events，**不回落**；
    //  - `not-v21`  → 旧 4-intent 信封 / 纯人话 / 没有产出 → 原样回落 `prepareEnvelope()`。
    // 于是 `command` / `pipeline` 与全部旧单测逐字节零回归，`actions: []` 也是合法 v2 产出
    // （会进 `valid` 分支，只是第 8 步一条都不执行，不视为失败）。
    const probe: V21Probe = taskSource === 'agent' ? probeV21Output(captured) : { kind: 'not-v21' };
    if (probe.kind === 'valid') {
      v21Handled = true;
      v21Plan = { text: probe.text, output: probe.output };
      appendEvent('envelope.v21', { contract: 'v2', actions: probe.output.actions.length });
    } else if (probe.kind === 'rejected') {
      v21Handled = true;
      const errors = probe.errors.map((issue) => ({ path: issue.path, message: issue.message }));
      const raw = v21RawEnvelopeColumns(probe.text);
      await writeV21Envelope({
        runId: input.runId,
        verdict: raw.verdict,
        actions: raw.actions,
        usage: null,
        valid: false,
        errors,
      });
      appendEvent('envelope.v21.rejected', {
        contract: 'v2',
        errors,
        text: probe.text.slice(0, 2_000),
      });
      signals.push(signalFromParse(`v2 产出整份拒绝：${summarizeOutputV21Issues(probe.errors)}`));
    } else {
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
  }

  // ── 兜底回复：信封不可信、或信封没给 comment 动作时**唯一**允许的写回 ─────────
  //
  // 两个真实故障（都在实机出现过）：
  //   a. `@answer` 的 turn 正常跑完（`turn.completed`、工具也跑了），事件流里没有能通过 Ajv
  //      的信封 → 按「没有可信信封 → 不写回」的设计，用户看到「@ 了没反应」；
  //   b. v0.3 agent：信封**合规**但 `actions` 是空数组（模型把结论写在第一段里），
  //      run 记为 succeeded，issue 上同样一个字都没有。
  // 信封校验是安全边界，一步都不能松；但「agent 已经写出面向人的答案」不该被一起丢掉。
  //
  // 五个条件同时成立才兜底（缺一条就只留痕、不写任何东西）：
  //   1. 信封不合规（`missing-envelope` 也算）、或合规但没有 `comment` 动作；
  //   2. 命令是评论类（`agent:mention`、`agent:event`、`/issue-triage`、`/issue-repro`、`@answer`）——
  //      `/review-pr` 的结论若不可信就不该发出去，push 类任务更没有可发的东西；
  //   3. turn 正常收尾（`turn.completed`）：半路结束的 turn 没有「交付物」可言；
  //   4. 不是 dry-run（零副作用是 M0 的验收口径，`actions` 也必须 0 行）；
  //   5. 没有命中熔断（退化输出不值得发布）。
  //
  // 兜底**不改结局**：信封不合规时 run 仍是 `failure_class=parse`；合规但缺 comment 时 run 照旧
  //成功，只是把第一段补发成评论。打标与其它写回仍然只认合规信封。
  let fallback: ActionOutcome | null = null;
  // v0.3：**信封合法但没有 comment 动作**也要补发（需求 §1「默认产出一条评论」）。
  // 实机 2026-11-11：模型把结论写在第一段、`actions` 给 `[]`，run 记为 succeeded，
  // issue 上却一个字都没有 —— 用户视角就是「@ 了没反应」。
  const envelopeValid = prepared !== null && prepared.valid;
  const hasCommentAction =
    prepared !== null && prepared.valid && prepared.accepted.some((item) => item.intent === 'comment');
  // v2 分支**不发兜底评论**：它的 `comment` 是槽位写回（覆盖语义），再补一段人话会
  // 在同一个 issue 上多出一条不可控的评论；v2 的 `actions: []` 也是「只判定不动作」的合法产出。
  if (!v21Handled && prepared !== null && (!prepared.valid || !hasCommentAction)) {
    const agentText =
      turnResult !== undefined && terminal === 'turn.completed' ? findLastAgentText(captured) : null;
    const body = agentText === null ? null : buildFallbackCommentBody(agentText);

    let blocked: string | null = null;
    if (dryRun) {
      blocked = 'dry-run：兜底评论同样不写（零副作用口径）';
    } else if (degeneracyHit !== null) {
      blocked = '熔断命中：不发布退化输出';
    } else if (!supportsCommentFallback(input.command)) {
      blocked = `命令 ${input.command} 不在兜底白名单（仅 /issue-triage、/issue-repro、@answer、agent:mention、agent:event）`;
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
        // 兜底评论也要 @ 到提问人（与信封里的 comment 一致）
        mention: input.actorLogin ?? null,
        api: deps.github,
        store: deps.store,
        clock,
      });
      const cause = envelopeValid ? 'no-comment-action' : 'invalid-envelope';
      appendEvent('writeback.fallback', {
        status: fallback.status,
        target: fallback.target,
        reason: fallback.reason,
        command: input.command,
        cause,
      });
      logger.warn(
        { status: fallback.status, target: fallback.target, cause },
        cause === 'no-comment-action'
          ? '信封没有 comment 动作，已按 last assistant 文本补发评论'
          : '信封不可信，已按 last assistant 文本兜底发评论',
      );
    }
  }

  // ── 写执行器（第 8 步） ────────────────────────────────────────────────────
  recordStep('execute');

  // v2 七类动作（FR-5.4 / FR-5.5）：`executeV21()` 负责「顺序执行、遇失败即停、
  // 后三类动作开关在**执行前**整份拒绝」。这里只做装配与留痕，不重写任何一条写回规则。
  if (v21Handled && v21Plan !== null) {
    // 目标现状：当前标签 / 我们打过的标签。`deps.targets.load()` 由装配层接
    // （读 `bot_labels`，与 `deps.ledger` 是同一张表）；没注入时给空集合，是安全侧。
    const target: WriteTargetContext =
      deps.targets === undefined
        ? {}
        : await deps.targets
            .load({ repo: input.repo, targetNumber: input.targetNumber })
            .catch((): WriteTargetContext => ({}));
    const currentLabels: readonly string[] = target.currentLabels ?? [];
    const botLabels: readonly string[] = target.botLabels ?? [];

    // settings 是仓库级配置，由装配层从 `repos.settings` 读出来注入（不注入 = 全默认，
    // 于是后三类开关默认全关，是最保守的一侧）。
    const rawSettings: unknown = deps.v21?.settings ?? null;
    const settingsRead = readV21Settings(rawSettings);
    const settings = settingsRead.settings;
    const resolved = resolveAgentExecution(rawSettings);
    if (!settingsRead.ok || !resolved.ok) {
      // `ok:false` 只用来记告警，**不据此停工**：两个 resolve* 已回退到形状默认值
      // （后三类动作开关默认全关，是最保守的一侧）；配置写坏了不该把整条处理链带崩。
      logger.warn(
        { repo: input.repo, error: settingsRead.error ?? resolved.error },
        'v2.1 settings 解析失败：按形状默认值继续执行（受限动作开关默认全关）',
      );
    }
    // 直接喂 `resolveAgentExecution(settings).actions`：它内部已按
    // `agent.actions.X || agent.limits.actions.X` 裁决（任一处开启即开启，默认全 false）。
    // 这里再抄一遍字段只会多一处「以后改了裁决规则却忘了同步」的漂移点。
    const actionsEnabled: V21ActionSwitches = resolved.actions;
    const catalog: readonly CatalogEntry[] = v21CatalogOf(rawSettings);

    const v21Config = deps.v21;
    const api = createV21PortFromGithub({
      write: v21WritePort(deps.github, deps.ledger),
      ...(v21Config?.reactions === undefined ? {} : { reactions: v21Config.reactions }),
      ...(v21Config?.openPullRequest === undefined ? {} : { openPullRequest: v21Config.openPullRequest }),
      ...(v21Config?.isOwn === undefined ? {} : { isOwn: v21Config.isOwn }),
    });

    let result: ExecuteV21Result;
    try {
      if (degeneracyHit !== null) {
        // 熔断命中：plan §9.3 只说「照样校验入库」，没说照样发布 → 一条写动作都不做。
        result = { ok: true, executed: [], stoppedAt: null, errors: [], finishedAtMs: clock() };
        appendEvent('writeback.v21.skipped', { reason: 'degeneracy-hit' });
      } else if (v21Config?.execute !== undefined) {
        // 装配层注入的执行器（compose.ts → createV21Executor() → executeV21()）。
        // 结论形状收成 `ExecuteV21Result`，下面「写 envelopes / actions / run_events」只有一份。
        const execution = await v21Config.execute(v21Plan.text, {
          repo: input.repo,
          issueNumber: input.targetNumber,
          dryRun,
        });
        result = {
          ok: execution.valid,
          executed: execution.executed.map((item) => ({
            index: item.index,
            type: item.type,
            outcome: item.outcome === 'failed' ? ('failed' as const) : ('ok' as const),
          })),
          stoppedAt: execution.stoppedAt,
          errors: execution.errors.map((issue) => ({
            index: 0,
            type: 'output',
            message: `${issue.path} ${issue.message}`,
          })),
          finishedAtMs: clock(),
        };
      } else {
        // 直连路径：worker 自己用 `createV21PortFromGithub(deps.github)` 装配端口，
        // 开关 / 标签目录 / 上限全部来自注入的 settings，dryRun 原样透传。
        result = await executeV21({
          output: v21Plan.output,
          repo: input.repo,
          issueNumber: input.targetNumber,
          dryRun,
          actionsEnabled,
          currentLabels,
          botLabels,
          catalog,
          maxPerIssue: settings.labels.max_per_issue,
          api,
          now: clock,
        });
      }
    } catch (error) {
      // `executeV21()` 契约上不抛（装配层钩子可能抛）；真抛了也要收成一条可查错误，
      // 不能让 run 崩掉，更不能回落旧信封重复写回。
      const detail = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        executed: [],
        stoppedAt: null,
        errors: [{ index: 0, type: 'output', message: `v2 执行器异常：${detail}` }],
        finishedAtMs: clock(),
      };
    }

    const errors = result.errors.map((item) => ({
      path: `/actions/${String(item.index)}/${item.type}`,
      message: item.message,
    }));
    // envelopes 每 run 只有一行（唯一索引在 run_id）：**等执行结果出来才写**，
    // 这样「执行前整份拒绝」（开关未开）的错误也能落在 envelopes.errors 上。
    await writeV21Envelope({
      runId: input.runId,
      verdict: v21Plan.output.verdict ?? null,
      actions: v21Plan.output.actions,
      usage: null,
      valid: result.ok,
      errors: result.ok ? [] : errors,
    });

    // 结果写 actions 行与 run_events。dry-run 沿用旧口径：不写 actions 行（零库副作用），
    // 只把计划留在 run_events 与 report.actions 里。
    const actionTarget = actionTargetOf(input.repo, input.targetNumber);
    for (const item of result.executed) {
      const status: ActionOutcome['status'] =
        item.outcome === 'failed' ? 'failed' : dryRun ? 'dry-run' : 'applied';
      if (!dryRun) {
        await deps.store
          .recordAction({
            runId: input.runId,
            intent: `v21:${item.type}`,
            target: actionTarget,
            externalRef: null,
            appliedAt: item.outcome === 'failed' ? null : new Date(clock()),
            audit: {
              source: 'v21',
              contract: 'v2',
              index: item.index,
              type: item.type,
              outcome: item.outcome,
              detail: item.detail ?? null,
              dryRun,
            },
          })
          .catch((error: unknown) => {
            logger.warn({ err: String(error) }, 'v2 actions 行写入失败（已忽略）');
          });
      }
      actionOutcomes.push({
        intent: `v21:${item.type}`,
        status,
        target: actionTarget,
        externalRef: null,
        reason: item.detail ?? '',
      });
    }
    appendEvent('writeback.v21.result', {
      contract: 'v2',
      valid: result.ok,
      dryRun,
      stoppedAt: result.stoppedAt,
      executed: result.executed.map((item) => ({
        index: item.index,
        type: item.type,
        outcome: item.outcome,
        detail: item.detail ?? null,
      })),
      errors,
    });
    if (!result.ok) {
      // 整份拒绝 / 中途失败：一条动作都不该被当成「已发布」。错误同时进 run_events 与 signals。
      signals.push(
        signalFromParse(
          `v2 执行未完成：${errors.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
        ),
      );
    }
  }

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
        // 销毁前快照落一条事件 —— **也是「这个容器已经处理过」的凭据**：
        // `lifecycle-cleanup` 的容器清单来自 `tasks` 的终态行（`container_name` 永不清空），
        // 没有这条凭据它就会每分钟对早已消失的容器重放一次 dispose，并往 `run_events`
        // 追加一条重复的 `sandbox.inspected`（实机：一条 run 结束后 36 分钟涨了 36 行）。
        // 见 `jobs/lifecycle-sweep.ts` 的 `TRACKED_CONTAINERS_SQL`。
        appendEvent('sandbox.inspected', {
          containerId,
          outcome: toTaskOutcome(preOutcome),
          reason: '任务结束：容器已由 worker 销毁',
          oomKilled: disposeResult.state?.oomKilled ?? null,
          exitCode: disposeResult.state?.exitCode ?? null,
          status: disposeResult.state?.status ?? null,
          failureClass: classifyDestroyedState(disposeResult.state) ?? null,
        });
        // 采到 OOM 却与 lifecycle 的判定不一致时以采到的状态为准（§7.3 的判定源是 OomKilled）
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
