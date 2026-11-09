/**
 * 重复输出熔断（plan §9.3 / tech-plan §7.4 的 S2）的类型与判据清单。
 *
 * 三条判据是**并列**的：任一条命中即中止本轮。之所以要三条而不是一条，
 * 因为三种退化在 token 层面长得很不一样：
 *   - `paragraph-repeat`：把同一段整段重发（长文本，字符级可查）；
 *   - `low-novelty`：不是整段重复，而是「越写越像」——新增 n-gram 占比掉到 5% 以下，
 *     哪怕每次都在换词序也能被抓住；
 *   - `tool-loop`：文本层面看着还在推进（每轮都说话），但**动作**在原地打转：
 *     同一个工具、同一组参数、磁盘/测试结果毫无变化。
 *
 * 三条判据的实现被刻意拆成三个独立文件、三个独立的检测器实例：
 * 它们的状态机完全不同（窗口计数 / n-gram 集合 / 连续调用签名），
 * 合成一个类只会让「哪条判据误报了」变得不可定位。
 */

/** 命中判据的名字（落 `degeneracy_hits.criterion`，改动即契约变更）。 */
export const DEGENERACY_CRITERIA = ['paragraph-repeat', 'low-novelty', 'tool-loop'] as const;

export type DegeneracyCriterion = (typeof DEGENERACY_CRITERIA)[number];

/** 一次命中：判据 + 可落 jsonb 的细节（窗口、次数、占比、工具名与参数摘要）。 */
export interface DegeneracyHit {
  readonly criterion: DegeneracyCriterion;
  /** 人读 + 可机读的命中细节，直接进 `degeneracy_hits.detail`。 */
  readonly detail: Readonly<Record<string, unknown>>;
  /** 命中时刻（毫秒 epoch，取自注入的时钟）。 */
  readonly at: number;
}

/** 所有检测器的公共面：能算「已处理多少」并能复位（一个 run 一个实例，复位留给重试复用）。 */
export interface DegeneracyDetector {
  /** 已消费的文本字符数（`paragraph-repeat` / `low-novelty`）或工具调用次数（`tool-loop`）。 */
  readonly consumed: number;
  reset(): void;
}

/** 文本类判据（段落重复 / 低增量）的输入口：**流式**喂增量，不是一次性整篇文章。 */
export interface TextDegeneracyDetector extends DegeneracyDetector {
  /**
   * 喂一段新增文本。命中返回 hit（**粘住**：之后每次调用都返回同一个 hit，
   * 调用方不必自己记住「已经命中了」）。
   */
  push(chunk: string): DegeneracyHit | null;
}

/** 一次工具调用的观测：工具名 + 参数 + 「世界有没有变」的摘要。 */
export interface ToolCallObservation {
  /** 工具名，例如 `Bash` / `Edit` / `Grep`。 */
  readonly tool: string;
  /** 参数原文（对象会被稳定序列化后比较，不要求调用方自己排序键）。 */
  readonly params: unknown;
  /**
   * 状态指纹：调用**之后**的文件集 / 测试结果的摘要。
   * 缺省（`undefined`）按「没有观测到变化」处理——宁可漏报一次也不乱报：
   * 真正的工具循环必然伴随状态不变。
   */
  readonly stateDigest?: string;
}

/** 工具循环判据。 */
export interface ToolLoopDetector extends DegeneracyDetector {
  push(call: ToolCallObservation): DegeneracyHit | null;
}

/** 三条判据的合并监视器（worker 只跟它打交道）。 */
export interface DegeneracyMonitor {
  /** 喂文本增量；返回本次（或之前已命中而粘住的）hit。 */
  pushText(chunk: string): DegeneracyHit | null;
  /** 喂一次工具调用；返回 hit。 */
  pushToolCall(call: ToolCallObservation): DegeneracyHit | null;
  /** 已经粘住的那次命中（未命中为 null）。 */
  readonly hit: DegeneracyHit | null;
  /** 全部命中（按发生顺序；理论上有 1 条，保留数组是为了诊断）。 */
  readonly hits: readonly DegeneracyHit[];
  /** 从 run_events 的一条事件里抽文本 / 抽工具调用（默认实现见 `events.ts`）。 */
  observe(event: { readonly kind: string; readonly payload: unknown }): DegeneracyHit | null;
  /** 诊断快照（落 `run_events` 的一条 `degeneracy.status`，便于事后复盘）。 */
  readonly stats: DegeneracyStats;
  reset(): void;
}

/** 监视器的诊断快照（只读数字，不含任何模型原文）。 */
export interface DegeneracyStats {
  /** 喂进来的原始文本字符数。 */
  readonly textChars: number;
  /** 喂进来的 token 数（低增量判据的口径）。 */
  readonly tokens: number;
  /** 观测到的工具调用次数。 */
  readonly toolCalls: number;
  /** 段落重复判据当前的最大窗口计数（命中阈值 3）。 */
  readonly paragraphMaxCount: number;
  /** 低增量判据最近一次的占比（窗口未填满为 null，阈值 0.05）。 */
  readonly noveltyRatio: number | null;
  /** 工具循环判据当前的连续相同调用次数（命中阈值 3）。 */
  readonly toolLoopStreak: number;
}

/** 默认时钟（可注入，便于断言 `hit.at`）。 */
export type DegeneracyClock = () => number;
