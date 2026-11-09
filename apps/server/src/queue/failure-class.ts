/**
 * `failure_class` 的**优先级表**（tech-plan §7.3 的第一张表，F6）。
 *
 * 为什么必须有这张表：一次 run 可能同时「像」崩溃又「像」超时——任务级超时的实现就是 kill 容器，
 * 从容器退出码看和崩溃没有任何区别。若按「最后一个观测到的信号」分类，
 * 一个超时任务会走进 `sandbox-crash` 的 `retryLimit: 1` 分支被自动重跑一次，
 * 直接违反 plan §9.1「超时不自动重试，只接受 /retry」。
 *
 * 所以：**分类必须在全部观测信号上按固定优先级取一个**，写进 `runs.failure_class`；
 * 其余信号落 `runs.failure_detail` 供审计；重试决策只读那个最高优先级的类。
 */
import { FAILURE_CLASS } from '../db/schema.ts';

export type FailureClass = (typeof FAILURE_CLASS)[keyof typeof FAILURE_CLASS];

/**
 * 优先级数值（1 = 最高）。数值化而不是用数组下标，是为了让「取最高优先级」不必依赖数组顺序，
 * 也让日志里能直接打印 `priority=1`。
 *
 * 取值严格照抄 §7.3：
 *  1 timeout / interrupt / degenerate-output —— 都表示「这轮不该继续，也不该自动重来」
 *  2 sandbox-oom —— 配置/体量问题，自动重试只会再 OOM 一次
 *  3 sandbox-crash —— 最多 1 次
 *  4 auth / rate_limit / model / parse / github_api（以及未知分类）
 */
export const FAILURE_CLASS_PRIORITY: Readonly<Record<FailureClass, 1 | 2 | 3 | 4>> = Object.freeze({
  [FAILURE_CLASS.timeout]: 1,
  [FAILURE_CLASS.interrupt]: 1,
  [FAILURE_CLASS.degenerateOutput]: 1,
  [FAILURE_CLASS.sandboxOom]: 2,
  [FAILURE_CLASS.sandboxCrash]: 3,
  [FAILURE_CLASS.auth]: 4,
  [FAILURE_CLASS.rateLimit]: 4,
  [FAILURE_CLASS.model]: 4,
  [FAILURE_CLASS.parse]: 4,
  [FAILURE_CLASS.githubApi]: 4,
  [FAILURE_CLASS.unknown]: 4,
});

/**
 * 同优先级内的稳定次序（用于确定性：同一批信号永远得到同一个分类）。
 * 顺序取 `FAILURE_CLASS` 的声明顺序，改动它等于改面板文案，但不影响重试决策。
 */
const DECLARATION_ORDER: readonly FailureClass[] = Object.freeze([
  FAILURE_CLASS.timeout,
  FAILURE_CLASS.interrupt,
  FAILURE_CLASS.degenerateOutput,
  FAILURE_CLASS.sandboxOom,
  FAILURE_CLASS.sandboxCrash,
  FAILURE_CLASS.auth,
  FAILURE_CLASS.rateLimit,
  FAILURE_CLASS.model,
  FAILURE_CLASS.parse,
  FAILURE_CLASS.githubApi,
  FAILURE_CLASS.unknown,
]);

/** 一个观测到的失败信号：分类 + 判定它需要的附加信息（HTTP 状态、retry-after）。 */
export type FailureSignal = {
  readonly failureClass: FailureClass;
  /** 来自 GitHub / 模型网关的 HTTP 状态（只有 `github_api` / `auth` / `rate_limit` 会带） */
  readonly httpStatus?: number | null;
  /** 429 的 `retry-after` 响应头（秒）；没有就按固定退避 */
  readonly retryAfterSeconds?: number | null;
  /** 人读的补充说明，落 `runs.failure_detail`，不参与决策 */
  readonly detail?: string;
};

export function priorityOf(failureClass: FailureClass): number {
  return FAILURE_CLASS_PRIORITY[failureClass] ?? 4;
}

function orderOf(failureClass: FailureClass): number {
  const index = DECLARATION_ORDER.indexOf(failureClass);
  return index === -1 ? DECLARATION_ORDER.length : index;
}

/**
 * 取最高优先级的信号（同优先级按声明顺序取第一个）。
 * 空数组返回 null——「没有信号」与「未知分类」是两件事：前者不该被判成 `unknown` 再重试。
 */
export function pickHighestPrioritySignal(
  signals: readonly FailureSignal[],
): FailureSignal | null {
  let best: FailureSignal | null = null;
  for (const signal of signals) {
    if (best === null) {
      best = signal;
      continue;
    }
    const candidatePriority = priorityOf(signal.failureClass);
    const bestPriority = priorityOf(best.failureClass);
    if (candidatePriority < bestPriority) {
      best = signal;
      continue;
    }
    if (candidatePriority === bestPriority && orderOf(signal.failureClass) < orderOf(best.failureClass)) {
      best = signal;
    }
  }
  return best;
}

/** 只取分类（`runs.failure_class` 落库用）。 */
export function pickFailureClass(signals: readonly FailureSignal[]): FailureClass | null {
  return pickHighestPrioritySignal(signals)?.failureClass ?? null;
}

/**
 * 把 HTTP 状态翻译成分类（GitHub / 模型网关共用）。
 * 429 优先于「其它 4xx」：它要的是退避重投，不是失败。
 */
export function classifyHttpStatus(status: number): FailureClass {
  if (status === 429) {
    return FAILURE_CLASS.rateLimit;
  }
  if (status === 401 || status === 403) {
    return FAILURE_CLASS.auth;
  }
  return FAILURE_CLASS.githubApi;
}

/** 从 HTTP 响应构造信号（`retry-after` 头由调用方解析成秒后传入）。 */
export function signalFromHttp(
  status: number,
  retryAfterSeconds?: number | null,
): FailureSignal {
  return {
    failureClass: classifyHttpStatus(status),
    httpStatus: status,
    retryAfterSeconds: retryAfterSeconds ?? null,
  };
}
