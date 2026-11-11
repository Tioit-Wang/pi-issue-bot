/**
 * P1（项目人格层）的**预算口径**——`docs/plan-multi-repo.md` §7 那张表的落地。
 *
 * ```
 * | 层 | 内容                                   | 软上限        |
 * | P0 | 产品不变量（代码常量）                    | ~1200        |
 * | P1 | 项目人格层（`prompt_versions`）           | 4000         |
 * | P2 | 仓库约定（AGENTS.md，worktree）           | 根 4000 / 就近 6000 |
 * | P3 | 任务技能（registry）                     | 4000         |
 * | P4 | 任务上下文（issue 标题/正文/标签）         | ~4400        |
 * ````
 *
 * 两层预算机制**故意不同**，别把两件事混成一件：
 *  1. **保存期预演（本文件）**：面板点「保存」时先算「这条 P1 还能占多少」，超了直接拒绝，
 *     连版本都不建。理由：让人当场就知道存不下，而不是等下一轮任务被静默截断。
 *  2. **运行期兜底（`skills/assemble.ts`）**：真的超了总预算，就整段丢弃并记进 `stats.truncated`。
 *     它只对「别的层后来长大了 / 上一条 P1 是旧的」这类保存期看不到的变化生效。
 *
 * ## 预算数字怎么算
 *
 * 总预算是 12k（`DEFAULT_ASSEMBLE_BUDGET_CHARS`），它约束的是**整条 prompt**。
 * 所以留给 P1 的不是 12k，而是 `12k − 其它各层`，再与 P1 自己的软上限（4000）取小：
 *
 * ```
 * available = min(P1_CAP, max(0, 12000 − (P0 + P2 + P3 + P4)))
 * ok        = renderProjectLayer(body).length <= available
 * ```
 *
 * `requested` 与运行期用的是**同一个渲染函数**（`renderProjectLayer`），
 * 否则「保存时说放得下、运行期却被丢」这种偏差根本查不出来。
 *
 * ## 「其它各层」的两种来源
 *
 *  - `last-assembly`：最近一次真实装配的统计（`prompt/store.ts` 的 `readLastAssembleStats`，
 *    由 worker 每轮调 `recordAssembleStats()` 写入）。这是准的：它就是这个仓库此刻的实际情况。
 *  - `conservative-estimate`：还没跑过任何任务时（新仓库 / 刚清库）的保守估算。
 *    取 `P0 + P2 根 + P4` 三条软上限之和 = 9600，于是 P1 拿 2400。
 *
 *    为什么估算里**不**把 P2 就近（6000）与 P3（4000）按满额算：这两层只在「命中」时才存在，
 *    按满额记会得到 19600 > 12000，于是任何 P1 都存不进去 —— 那不是保守，是把功能关掉了。
 *    它们的真实影响由运行期兜底（整段丢弃 + 事件）承担，且第一次任务跑完就换成实测值。
 */

/**
 * 提示词层的**预算口径**（`docs/plan-multi-repo.md` §7 那张表 + `docs/plan-fixed-pipeline.md` §16.3.1）。
 *
 * ```
 * | 层 | 内容                                         | 软上限        |
 * | P0 | 阶段系统提示词（`kind=agent` 的项目版/内置默认）  | 4000          |
 * | P1 | 项目人格层（`prompt_versions` kind=project）     | 4000          |
 * | P2 | 仓库约定（AGENTS.md，worktree）                 | 根 4000 / 就近 6000 |
 * | P3 | 任务技能（registry）                           | 4000          |
 * | P4 | 任务上下文（issue 标题/正文/标签）               | ~4400         |
 * ````
 *
 * 两层预算机制**故意不同**，别把两件事混成一件：
 *  1. **保存期预演（本文件）**：面板点「保存」时先算「这条 P1 还能占多少」，超了直接拒绝，
 *     连版本都不建。理由：让人当场就知道存不下，而不是等下一轮任务被静默截断。
 *  2. **运行期兜底（`skills/assemble.ts`）**：真的超了总预算，就整段丢弃并记进 `stats.truncated`。
 *     它只对「别的层后来长大了 / 上一条 P1 是旧的」这类保存期看不到的变化生效。
 *
 * ## 预算数字怎么算
 *
 * 总预算是 12k（`DEFAULT_ASSEMBLE_BUDGET_CHARS`），它约束的是**整条 prompt**。
 * 所以留给 P1 的不是 12k，而是 `12k − 其它各层`，再与 P1 自己的软上限（4000）取小：
 *
 * ```
 * available = min(P1_CAP, max(0, 12000 − (stageBaseChars + baseChars + agentsChars + skillChars)))
 * ok        = renderProjectLayer(body).length <= available
 * ```
 *
 * `stageBaseChars` 是**阶段系统提示词**（`kind=agent`）的长度：它落在 `basePrompt` 里，
 * 写多长就直接扣掉 P1 多少额度（R6 / §16.3.1 / V18）。缺省 0 = 没有阶段维度（老调用点不变）。
 *
 * `requested` 与运行期用的是**同一个渲染函数**（`renderProjectLayer`），
 * 否则「保存时说放得下、运行期却被丢」这种偏差根本查不出来。
 *
 * ## 「其它各层」的两种来源
 *
 *  - `last-assembly`：最近一次真实装配的统计（`prompt/store.ts` 的 `readLastAssembleStats`，
 *    由 worker 每轮调 `recordAssembleStats()` 写入）。这是准的：它就是这个仓库此刻的实际情况。
 *  - `conservative-estimate`：还没跑过任何任务时（新仓库 / 刚清库）的保守估算。
 *    取 `P0 + P2 根 + P4` 三条软上限之和 = 9600，于是 P1 拿 2400。
 *
 *    为什么估算里**不**把 P2 就近（6000）与 P3（4000）按满额算：这两层只在「命中」时才存在，
 *    按满额记会得到 19600 > 12000，于是任何 P1 都存不进去 —— 那不是保守，是把功能关掉了。
 *    它们的真实影响由运行期兜底（整段丢弃 + 事件）承担，且第一次任务跑完就换成实测值。
 */
import { DEFAULT_ASSEMBLE_BUDGET_CHARS, renderProjectLayer } from '../skills/assemble.ts';

/** 总预算（= 装配期的 `DEFAULT_ASSEMBLE_BUDGET_CHARS`）。改这里等于同时改运行期的总量。 */
export const PROMPT_BUDGET_CHARS = DEFAULT_ASSEMBLE_BUDGET_CHARS;
/**
 * 各层**软上限**（字符）。软 = 超过不等于报错，只是「这一层不再保证进上下文」；
 * 唯一的硬约束是总预算 12000。
 */
export const PROMPT_LAYER_LIMITS = {
  p0: 1_200,
  p1: 4_000,
  p2Root: 4_000,
  p2Nearby: 6_000,
  p3: 4_000,
  p4: 4_400,
} as const;

/**
 * 没见过真实装配统计时的「其它各层」估算值（P0 + P2 根 + P4 = 9600）。见文件头的说明。
 */
export const CONSERVATIVE_OTHER_LAYERS_CHARS =
  PROMPT_LAYER_LIMITS.p0 + PROMPT_LAYER_LIMITS.p2Root + PROMPT_LAYER_LIMITS.p4;

/** 预算预演需要的那几个统计字段（`AssemblePromptStats` 的子集，便于单测直接构造）。 */
export interface AssembleStatsSubset {
  readonly baseChars: number;
  readonly agentsChars: number;
  readonly skillChars: number;
}

export interface PromptBudget {
  /** 总预算（12000）。 */
  readonly budgetChars: number;
  /** P1 自身的软上限（4000）。 */
  readonly p1Cap: number;
  /**
   * 「其它各层」占掉多少（实测或估算）**加上阶段系统提示词** `stageBaseChars`。
   * 拆开算的原因见 `stageBaseChars` 字段：`agent` 的长度是这次保存时才知道的。
   */
  readonly otherLayersChars: number;
  /** 阶段系统提示词占掉多少（缺省 0 = 没有阶段维度）。 */
  readonly stageBaseChars: number;
  /** 这条 P1 最多能占多少 = `min(p1Cap, budgetChars - otherLayersChars)`，不会小于 0。 */
  readonly available: number;
  /** 这条 P1 实际占多少（含 `## 项目约定` 标题）。 */
  readonly requested: number;
  readonly ok: boolean;
  readonly source: 'last-assembly' | 'conservative-estimate';
  /** 各层软上限（面板直接展示，避免前后端各写一份数字）。 */
  readonly layers: typeof PROMPT_LAYER_LIMITS;
}

export interface PlanPromptBudgetInput {
  /** 待保存的 P1 正文（原始文本，未渲染）。 */
  readonly body: string;
  /** 最近一次装配统计；`null`/缺省 = 用保守估算。 */
  readonly lastStats?: AssembleStatsSubset | null;
  /** 覆盖总预算（单测用）。 */
  readonly budgetChars?: number;
  /**
   * 阶段系统提示词（`kind=agent` 的项目版或内置默认）的字符数。
   *
   * 它落在 `basePrompt` 里，所以**如实扣掉 P1 的额度**（R6 / §16.3.1 / V18）：
   * `available = min(4000, 12000 − (stageBaseChars + baseChars + agentsChars + skillChars))`。
   * 缺省 0 = 没有阶段维度，老调用点的结果一个字节都不变。
   */
  readonly stageBaseChars?: number;
}

/** 保存期预演：这条 P1 能不能装进 12k。纯函数，不读库、不读时钟。 */
export function planPromptBudget(input: PlanPromptBudgetInput): PromptBudget {
  const budgetChars = input.budgetChars ?? PROMPT_BUDGET_CHARS;
  const lastStats = input.lastStats ?? null;
  const stageBaseChars = Math.max(0, Math.trunc(input.stageBaseChars ?? 0));
  const otherLayersChars =
    (lastStats === null
      ? CONSERVATIVE_OTHER_LAYERS_CHARS
      : lastStats.baseChars + lastStats.agentsChars + lastStats.skillChars) + stageBaseChars;
  const remaining = Math.max(0, budgetChars - otherLayersChars);
  const available = Math.min(PROMPT_LAYER_LIMITS.p1, remaining);
  const requested = renderProjectLayer(input.body).length;
  return {
    budgetChars,
    p1Cap: PROMPT_LAYER_LIMITS.p1,
    otherLayersChars,
    stageBaseChars,
    available,
    requested,
    // 空正文 = 「清空这一层」，永远允许（否则删不掉一条超长的 P1）。
    ok: requested === 0 || requested <= available,
    source: lastStats === null ? 'conservative-estimate' : 'last-assembly',
    layers: PROMPT_LAYER_LIMITS,
  };
}
