/**
 * 压缩双阈值（FR-5.6「触发」+ `docs/v21-contract.md` §6）。
 *
 * 两个数字，都必须**从当前模型的窗口现算**，不做成配置项：
 *  - 硬边界 `hardLimit` = 窗口 − 预留。预留 = max(16k, min(25% 窗口, 模型输出上限), 5% 窗口)。
 *    过了这条线**不发送请求**：宁可失败并明确报错，也不发一个注定被 provider 拒掉的包。
 *  - 自动压缩线 `autoLimit` = 0.9 × hardLimit。过线就先压缩再发，用户/模型都无感。
 *
 * 为什么预留取「max」而不是「sum」：三项测算的是同一块空间的不同下限（最小安全余量 /
 * 输出长度 / 窗口比例），取 max 是「最保守的那一个说了算」；相加会把 1M 窗口的预留推到
 * 荒谬的量级，白白浪费上下文。
 *
 * 为什么要有 32k 下限保护：窗口参数可能来自没配全的模型配置（0 / undefined / 手写错）。
 * 直接代入公式会让 `hardLimit` 变成负数，后续所有「是否过线」的判断都成立，
 * 表现为「每条消息都触发压缩」——比报错更难查。所以先兜住窗口下限。
 *
 * 纯函数、零 I/O：阈值算错会连锁影响整条压缩降级链，必须能被单测逐个窗口钉住。
 */

/** 契约 §6 的 `CompactionPlan`（字段名与 `docs/v21-contract.md` 逐字一致）。 */
export type CompactionPlan = {
  /** `reason !== 'below'`，即「需要压缩」 */
  readonly needed: boolean;
  /** 硬边界：超过就不发送请求 */
  readonly hardLimit: number;
  /** 自动压缩线：0.9 × hardLimit */
  readonly autoLimit: number;
  /** 本次估算出的当前上下文 token 数 */
  readonly currentTokens: number;
  /** 本次压缩将写入的代数（调用方给；纯函数不查库） */
  readonly generation: number;
  /** `below` 未过线 / `auto` 过自动线 / `hard` 过硬边界 */
  readonly reason: 'below' | 'auto' | 'hard';
};

/**
 * 全部魔数（需求文档钉死的取值，测试直接引用这份，避免「改了一个忘了另一个」）。
 */
export const COMPACTION_DEFAULTS = {
  /** 预留下限：任何窗口都至少留 16k 给输出 + 协议开销 */
  reserveFloorTokens: 16_000,
  /** 预留跟着窗口走时的比例上限（相对模型输出上限） */
  reserveOutputRatio: 0.25,
  /** 预留跟着窗口走时的比例（保底，小窗口也留 5%） */
  reserveWindowRatio: 0.05,
  /** 自动压缩线 = autoRatio × hardLimit */
  autoRatio: 0.9,
  /** 窗口下限保护：小于这个数一律按这个数算（见文件头注释） */
  minimumWindowTokens: 32_000,
} as const;

/** `planCompaction` 的输入。 */
export type PlanCompactionInput = {
  /** 当前模型的上下文窗口（token），来自模型配置；非法值会被下限保护兜住 */
  readonly windowTokens: number;
  /** 模型单次输出上限（token）；未知就不参与预留（按 0 处理，即只靠 16k / 5% 两项） */
  readonly outputLimitTokens?: number;
  /** 本次要发送的内容估算出的 token 数（`tokens.ts` 的 `estimateMessagesTokens`） */
  readonly currentTokens: number;
  /** 本次压缩是第几代（0 = 从未压缩过，调用方 +1 后传入） */
  readonly generation: number;
};

/** 把任意输入收敛成非负整数（NaN / 负数 / 小数都归一）。 */
function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}

/**
 * 算一份压缩计划。
 *
 * 纯函数：同样的输入永远给同样的输出，便于在面板/日志里复盘「当时为什么压缩了」。
 */
export function planCompaction(input: PlanCompactionInput): CompactionPlan {
  // ① 窗口下限保护：0 / NaN / 8k 之类的配置错误一律按 32k 算，避免 hardLimit 变成非正数
  const windowTokens = Math.max(
    toNonNegativeInteger(input.windowTokens),
    COMPACTION_DEFAULTS.minimumWindowTokens,
  );

  // ② 三项预留，取最保守的那个（见文件头「为什么预留取 max」）
  const outputLimit = toNonNegativeInteger(input.outputLimitTokens ?? 0);
  const reserveByOutput = Math.min(
    COMPACTION_DEFAULTS.reserveOutputRatio * windowTokens,
    outputLimit,
  );
  const reserve = Math.max(
    COMPACTION_DEFAULTS.reserveFloorTokens,
    reserveByOutput,
    COMPACTION_DEFAULTS.reserveWindowRatio * windowTokens,
  );

  // ③ 双阈值。再夹一次 Math.max(…, 1)，保证「过硬边界」这件事永远有定义
  const hardLimit = Math.max(Math.trunc(windowTokens - reserve), 1);
  const autoLimit = Math.trunc(COMPACTION_DEFAULTS.autoRatio * hardLimit);

  const currentTokens = toNonNegativeInteger(input.currentTokens);
  const generation = Math.max(0, toNonNegativeInteger(input.generation));

  const reason: CompactionPlan['reason'] =
    currentTokens >= hardLimit ? 'hard' : currentTokens >= autoLimit ? 'auto' : 'below';

  return {
    needed: reason !== 'below',
    hardLimit,
    autoLimit,
    currentTokens,
    generation,
    reason,
  };
}

/**
 * 摘要侧的 token 预算（正常路径用）：`hardLimit` 扣掉要保留的真实最近窗口。
 *
 * 放在这里而不是 engine：这是「双阈值」的派生量，跟阈值口径绑在一起才不会各自漂移。
 * 至少给 2k，避免窗口极小时把摘要预算压成 0（那等于没摘要）。
 */
export function summaryBudgetFor(hardLimit: number, keepRecentTokens: number): number {
  return Math.max(2_000, Math.trunc(hardLimit) - Math.trunc(keepRecentTokens));
}
