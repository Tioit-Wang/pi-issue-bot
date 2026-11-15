/**
 * 当前模型的上下文窗口（FR-5.6「触发」第一条：阈值从当前模型的窗口**现算**，不做成配置项）。
 *
 * 为什么不是配置项：一个固定数字无法同时服务 32K 与 1M 窗口——配 32K 会让 1M 模型每两轮就压缩
 * 一次（压缩本身要花一次模型调用），配 1M 会让 32K 模型直接撞 provider 的 400。
 *
 * 窗口从哪来（按可靠性排序，当前只能用第 3 档）：
 *  1. **provider 的 `/models` 能力上报** —— 最准，但本仓库刻意不做 provider 客户端
 *     （见 `app/model-env.ts`：端点配置只换算成 pi-host 的环境变量，bot 自己不说模型协议）；
 *  2. **RACP 的能力/会话快照里报窗口** —— 宿主最清楚自己加载的模型，但目前协议里没有这个字段
 *     （`packages/racp-client/src/schema.ts` 的 `Session` / `InitializeResult` 都没有窗口信息）；
 *  3. **模型名 → 窗口表**（本文件）：模型名是我们唯一拿得到的模型身份事实，按它查表；
 *     表里没有的模型退回一个**保守下限**（宁可早压缩，不要撞 400）。
 *
 * TODO(FR-5.6): 第 1/2 档任一打通后，`resolveModelWindow()` 换成从那里取，本表退化成兜底。
 *
 * 纯函数、零 I/O：阈值算错会连锁影响整条压缩降级链，必须能被单测逐个窗口钉住。
 */

/**
 * 表里认不出来的模型一律按这个数算（保守：小于所有主流模型的真实窗口）。
 *
 * **它不是「安全预算」**：真实窗口未知时，`FALLBACK_WINDOW_TOKENS` 只用来「早一点提醒 / 早一点
 * 准备收尾」，不能当作自动压缩与硬边界去砍上下文。原因：32K 减去 16K 输出预留后只剩 16.7K，
 * 对 1M 窗口的模型等于把自动线压到真实能力的 1.5% —— 每轮都压缩、每轮都写一条
 * `agent_compactions`、提示词反复催模型收尾，而真实问题（窗口到底多大）一个都没解决。
 * 裁决与降级见 `resolveCompactionBudget()`。
 */
export const FALLBACK_WINDOW_TOKENS = 32_768;

/**
 * 未命中模型表时的窗口**下限**（用作压缩预算而不是提醒线）。
 *
 * 取 128K 的理由：它是当前主流模型的常见下限（GPT-4o / Gemini / Qwen / GLM / DeepSeek 都 ≥128K）。
 * 猜大了的代价是「压缩触发得晚一点，可能撞一次 provider 400」—— 那是一次可见的失败；
 * 猜小了的代价是上面那段：无声的过度压缩 + 无界增长的风险账。两害相权取后者。
 */
export const UNKNOWN_MODEL_WINDOW_TOKENS = 128_000;

/** 一张表的行：模型名正则 → 窗口（token）。顺序即匹配优先级（先精确后泛化）。 */
export type ModelWindowRule = {
  /** 匹配模型名（不区分大小写） */
  readonly pattern: RegExp;
  /** 上下文窗口（token） */
  readonly tokens: number;
  /** 单次输出上限（token）；未知就不写，压缩预检会只按 16k / 5% 两项预留 */
  readonly outputTokens?: number;
  /** 便于日志与测试断言的家族名 */
  readonly family: string;
};

/**
 * 模型名 → 窗口。**只写确定的事实**：不确定的家族宁可不进表（走保守下限），
 * 也不要写一个猜的数字——猜大了就是「压缩不触发 → provider 400」。
 */
export const MODEL_WINDOW_RULES: readonly ModelWindowRule[] = [
  // GPT-4.1 / GPT-5 系列：1M 上下文
  { pattern: /gpt-4\.1|gpt-5/i, tokens: 1_000_000, outputTokens: 32_768, family: 'gpt-4.1/5' },
  // Gemini 1.5 / 2：1M
  { pattern: /gemini-(?:1\.5|2)/i, tokens: 1_000_000, outputTokens: 8_192, family: 'gemini-1.5/2' },
  // GPT-4o / 4-turbo 系列：128K
  { pattern: /gpt-4o|gpt-4-turbo|gpt-4\.5/i, tokens: 128_000, outputTokens: 16_384, family: 'gpt-4o' },
  // o1 / o3 / o4 推理系列：200K
  { pattern: /\bo[1-4](?:-|$)/i, tokens: 200_000, outputTokens: 100_000, family: 'o-series' },
  // Claude 家族：200K
  { pattern: /claude/i, tokens: 200_000, outputTokens: 8_192, family: 'claude' },
  // 国内兼容端点里常见的 128K 家族（MiMo / Qwen / GLM / Kimi / Step）
  { pattern: /mimo|qwen|glm|kimi|moonshot|step-/i, tokens: 128_000, outputTokens: 8_192, family: 'cn-128k' },
  // DeepSeek：chat 系列窗口 64K（不写 128K：deepseek-chat 的 128K 是 coder 版本的参数，混写会低估）
  { pattern: /deepseek/i, tokens: 64_000, outputTokens: 8_192, family: 'deepseek' },
  // 老 GPT-3.5 / 4（无后缀）：32K 起
  { pattern: /gpt-3\.5|gpt-4$|gpt-4-0/i, tokens: 32_768, outputTokens: 4_096, family: 'gpt-3.5/4' },
];

/** 解析结果（`matched=false` 表示走了保守下限，调用方/日志要能说清「这个数字是猜的还是查的」）。 */
export type ResolvedWindow = {
  /** 上下文窗口（token），恒为正整数 */
  readonly tokens: number;
  /** 单次输出上限（token）；表里没写就是 `undefined` */
  readonly outputTokens?: number;
  /** 命中的家族名；`null` = 没命中，用了保守下限 */
  readonly family: string | null;
  /** 归一化后的模型名（`null` = 完全没配模型名） */
  readonly model: string | null;
  /** `true` = 命中表 */
  readonly matched: boolean;
  /** `true` = 这个 token 数是估的（未命中表），不是模型真实窗口 */
  readonly estimated?: boolean;
};

/**
 * 从模型名解析窗口。
 *
 * 三段式：配了名 → 查表；没配名 / 查不到 → 保守下限。**永不抛错、永不返回 0**
 * （0 会让 `planCompaction` 的下限保护生效，但日志里就看不出「是没配还是没命中」了）。
 */
export function resolveModelWindow(modelName: string | null | undefined): ResolvedWindow {
  const model = typeof modelName === 'string' && modelName.trim().length > 0 ? modelName.trim() : null;
  if (model === null) {
    return { tokens: FALLBACK_WINDOW_TOKENS, family: null, model: null, matched: false };
  }

  for (const rule of MODEL_WINDOW_RULES) {
    if (!rule.pattern.test(model)) {
      continue;
    }
    return {
      tokens: rule.tokens,
      ...(rule.outputTokens === undefined ? {} : { outputTokens: rule.outputTokens }),
      family: rule.family,
      model,
      matched: true,
    };
  }

  return { tokens: FALLBACK_WINDOW_TOKENS, family: null, model, matched: false };
}

/**
 * 压缩预算的裁决：把「解析到的窗口」分成**提醒线**与**压缩预算**两个口径。
 *
 * 命中的模型表 → 两者相同（数字是查出来的，可信）。
 * 未命中 → 提醒仍用保守下限（32K，早一点催模型收尾没有坏处），但压缩预算抬到
 * `UNKNOWN_MODEL_WINDOW_TOKENS`（128K）—— 见 `FALLBACK_WINDOW_TOKENS` 的注释：
 * 拿 32K 当真实安全预算会把 1M 模型压到 1.5%，每轮都压缩、每轮都写一条压缩记录，
 * 而真实问题（窗口到底多大）依旧没有答案。
 *
 * `estimated=true` 表示「这个数字是猜的」，调用方必须让它可观测（日志 / 记录），
 * 否则运维看到「压得很频繁」时无从知道是模型太大还是我们没认出来。
 */
export function resolveCompactionBudget(resolved: ResolvedWindow): ResolvedWindow {
  if (resolved.matched) {
    return resolved;
  }
  return {
    ...resolved,
    tokens: UNKNOWN_MODEL_WINDOW_TOKENS,
    estimated: true,
  };
}
