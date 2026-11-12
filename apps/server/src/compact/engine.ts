/**
 * 压缩引擎（FR-5.6 全篇 + `docs/v21-contract.md` §6）。
 *
 * 一句话职责：**在请求发出前**判断上下文是否过线，过线就生成一份追加式 checkpoint，
 * 并明确返回「这次喂给模型的视图是什么」。
 *
 * 三条不可动摇的约束：
 *  1. **追加不改写**：压缩产物是一条 checkpoint（`agent_compactions` 一行），原始对话一条不删；
 *     后台看的是完整历史，模型看的是 checkpoint + 真实最近窗口，两套视图不能混。
 *  2. **保留真实最近窗口**（我方对参考实现的刻意偏离）：窗口内含 assistant 与 toolResult，
 *     摘要只补窗口外的旧历史。代价是必须剔除孤儿 toolResult（见 `truncate.ts`）。
 *  3. **降级有界**：六阶，每阶都能被观测（`layers`），不允许无限重试。
 *
 * 依赖注入：本模块**不直接调模型、不直接查库**。这样六阶降级链能在一秒内被单测完整跑一遍
 * （真实模型无法复现「连续 4 次超时」「鉴权立刻失败」这些分支）。
 *
 * 六阶降级（对应需求文档「失败降级」1–6）：
 *   1 预检 → 2 摘要请求短重试（3 次，2/4/8s，鉴权/配额首次即返回）→ 3 一次有界削减
 *   → 4 分块链式摘要 → 5 兜底 checkpoint → 6 仍超硬边界则拒绝发送。
 */
import { estimateMessagesTokens, estimateMessageTokens, estimateTokens } from './tokens.ts';
import type { MessageLike } from './tokens.ts';
import { planCompaction } from './thresholds.ts';
import type { CompactionPlan } from './thresholds.ts';
import { buildSummaryPrompt, collectFileMentions, parseSummary } from './summary.ts';
import { TRUNCATE_LIMITS, stripOrphanToolResults, truncateToolResults } from './truncate.ts';
import type { TruncateOptions } from './truncate.ts';

/* ── 常量 ─────────────────────────────────────────────────────────────────── */

/**
 * 摘要请求的退避（毫秒）。**重试 3 次 → 最多 4 次请求**：第 1 次失败后等 2s、第 2 次后 4s、
 * 第 3 次后 8s，第 4 次再失败就进入下一阶（阶 3 有界削减）。
 * 为什么不是指数退避就一发到底：模型侧 429/5xx 的自愈窗口通常就在几秒级，
 * 4 次、总计 14s 足够，再长会把一轮 issue 处理的时限（默认 20min）耗在重试上。
 */
export const SUMMARY_RETRY_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

/** 重试次数（不含首次请求）。 */
export const SUMMARY_MAX_RETRIES = SUMMARY_RETRY_BACKOFF_MS.length;

/** 保留真实最近窗口的默认预算：20% hardLimit，且至少 8k。 */
export const KEEP_RECENT_DEFAULTS = {
  ratioOfHardLimit: 0.2,
  minimumTokens: 8_000,
} as const;

/** 分块摘要的上界（需求：≤16 块）。`baseTokens` 是单块起点，实际按总量放大。 */
export const CHUNK_LIMITS = {
  maxChunks: 16,
  baseTokens: 8_000,
} as const;

/* ── 类型 ─────────────────────────────────────────────────────────────────── */

/** 落 `agent_compactions` 的一行（字段与 `db/schema.ts` 的列一一对应）。 */
export type CompactionRecordInput = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly summaryChars: number;
  readonly fallback: boolean;
};

/** 摘要模型的返回（`usage` 目前只用于观测，不参与阈值判断）。 */
export type SummarizeResult = {
  readonly text: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
};

/** 引擎对存储的最小需求（`compact/store.ts` 的实现直接满足）。 */
export type CompactStore = {
  record(record: CompactionRecordInput): Promise<void>;
  latestGeneration(sessionId: string): Promise<number>;
};

/** 注入的副作用。除 `summarize` / `store` 外都可缺省。 */
export type CompactDeps = {
  readonly summarize: (prompt: string) => Promise<SummarizeResult>;
  readonly store: CompactStore;
  /** 取当前时刻（毫秒）。兜底 checkpoint 的时间戳用它，测试可注入固定值。 */
  readonly now?: () => number;
  /** 退避用。默认 `setTimeout`，测试注入收集器避免真等 14 秒。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 是否「致命」（鉴权 / 配额类：重试无意义）。默认 `isFatalSummarizeError`。 */
  readonly isFatal?: (error: unknown) => boolean;
};

/** 压缩输入。`messages` 是**完整历史**（不是视图），窗口切分由引擎做。 */
export type CompactInput = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly sessionId: string;
  /** 当前模型窗口（token），来自模型配置 */
  readonly windowTokens: number;
  /** 模型输出上限（token），未知则不参与预留 */
  readonly outputLimitTokens?: number;
  readonly messages: readonly MessageLike[];
  /** 上一版摘要（第二代及以后的增量输入） */
  readonly previousSummary?: string;
  /** 保留真实最近窗口的 token 预算；默认 20% hardLimit 且至少 8k */
  readonly keepRecentTokens?: number;
};

/** 压缩成功：调用方据此重建模型视图（`view` 已剔除孤儿 toolResult）。 */
export type CompactSuccess = {
  readonly compacted: true;
  readonly summary: string;
  readonly generation: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly fallback: boolean;
  /** 本次实际走过的降级链（可观测：哪一段历史已不在模型上下文里） */
  readonly layers: readonly string[];
  readonly plan: CompactionPlan;
  /**
   * 喂给模型的视图：checkpoint 摘要 + 真实最近窗口。
   *
   * 为什么由引擎返回而不是让调用方自己拼：窗口切分与孤儿剔除的规则必须与 `afterTokens`
   * 的估算口径**完全一致**，两处各拼一次迟早对不上（对不上就是 400 或超限）。
   */
  readonly view: { readonly summary: string; readonly messages: readonly MessageLike[] };
};

/** 压缩未发生/被拒：`below` 是正常路径（不压缩），`hard-limit` 是必须阻断发送的异常路径。 */
export type CompactRejected = {
  readonly compacted: false;
  readonly reason: 'below' | 'hard-limit';
  readonly beforeTokens: number;
  readonly plan: CompactionPlan;
  readonly layers: readonly string[];
  /** 仅在 `hard-limit` 时给出（已发往后台告警/日志） */
  readonly error?: string;
};

export type CompactResult = CompactSuccess | CompactRejected;

type SummarizeAttempt =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'failed'; readonly fatal: boolean; readonly error: unknown };

/* ── 默认实现 ─────────────────────────────────────────────────────────────── */

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 默认的「致命错误」判定：鉴权 / 配额 / 计费类。
 *
 * 为什么这类要首次即返回：重试 3 次、等 14 秒，最后还是同一个 401，
 * 只是把一轮 issue 处理的时限烧掉。这类错误应该立刻走兜底 checkpoint。
 */
export function isFatalSummarizeError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  const record =
    typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const status = record?.['status'] ?? record?.['statusCode'] ?? record?.['code'];
  if (typeof status === 'number' && (status === 401 || status === 403 || status === 429)) {
    return true;
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lower = message.toLowerCase();
  const hints = [
    'unauthorized',
    'unauthenticated',
    'forbidden',
    'quota',
    'rate limit',
    'ratelimit',
    'rate_limit',
    'insufficient',
    'api key',
    'api_key',
    'invalid api',
    'billing',
    'payment required',
    '429',
    '401',
    '403',
  ];
  return hints.some((hint) => lower.includes(hint));
}

/* ── 视图切分 ─────────────────────────────────────────────────────────────── */

export type RecentWindow = {
  /** 保留的真实最近消息（含 assistant / toolResult） */
  readonly recent: readonly MessageLike[];
  /** 被摘要覆盖的旧历史（切点之前） */
  readonly old: readonly MessageLike[];
};

/**
 * 从尾部按 token 预算切出「真实最近窗口」。
 *
 * 两条细节：
 *  1. **至少留最后一条**：预算再小也不能切出空窗口，否则视图里只剩摘要，等于回到
 *     「只留用户消息」的参考实现；
 *  2. **不从句首 tool 消息开始**：窗口第一条如果是工具结果，它的调用方被切到摘要侧了 ——
 *     这种孤儿结果会让 provider 400，所以把切点往前挪到非 tool 消息。
 */
export function selectRecentWindow(
  messages: readonly MessageLike[],
  keepRecentTokens: number,
): RecentWindow {
  const budget = Math.max(0, Math.trunc(keepRecentTokens));
  let start = messages.length;
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      break;
    }
    const cost = estimateMessageTokens(message);
    const pickedNothingYet = start === messages.length;
    if (!pickedNothingYet && used + cost > budget) {
      break;
    }
    used += cost;
    start = index;
    if (used >= budget) {
      break;
    }
  }

  // 切点前移到非 tool 消息（把发起调用的 assistant 一起带进窗口）
  while (start > 0 && messages[start]?.role === 'tool') {
    start -= 1;
  }

  return { recent: messages.slice(start), old: messages.slice(0, start) };
}

/**
 * 把旧历史按 token 分块（≤ `maxChunks` 块），供链式摘要用。
 *
 * 预算先按 `baseTokens` 起，再按 `总量 / maxChunks` 放大：块数只受上限约束，
 * 不做「固定 8k 一块」——1M 窗口下 200k 的旧历史不该切 25 块。
 */
export function planChunks(
  messages: readonly MessageLike[],
  baseTokens: number = CHUNK_LIMITS.baseTokens,
  maxChunks: number = CHUNK_LIMITS.maxChunks,
): MessageLike[][] {
  if (messages.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.trunc(maxChunks));
  const total = estimateMessagesTokens(messages);
  const budget = Math.max(Math.trunc(baseTokens), Math.ceil(total / limit));

  const chunks: MessageLike[][] = [];
  let current: MessageLike[] = [];
  let used = 0;

  for (const message of messages) {
    const cost = estimateMessageTokens(message);
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(message);
    used += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  // 单条超大消息也会让块数超过上限 → 把尾部并进最后一块，宁可块大也不能超块数
  if (chunks.length > limit) {
    const head = chunks.slice(0, limit - 1);
    const tail = chunks.slice(limit - 1).flat();
    return [...head, tail];
  }
  return chunks;
}

/* ── 兜底 checkpoint ──────────────────────────────────────────────────────── */

/**
 * 构造兜底 checkpoint 的正文（阶 5）。
 *
 * 需求原文：「沿用上版摘要 + 真实最近窗口 + 明确标记，说明这次是兜底而非正常压缩」。
 * 因此这里**不调用模型**，只做规则化拼装：
 *  - 有上一版摘要 → 原文沿用 + 一行兜底说明（不重写上一版，避免二次失真）；
 *  - 没有上一版 → 给一份六段骨架 + 首条用户消息摘录 + 系统抠出的文件清单，
 *    明确写「未生成模型摘要」，让人一眼看出这段上下文是残的。
 */
export function buildFallbackSummary(input: {
  readonly previousSummary?: string;
  readonly messages: readonly MessageLike[];
  readonly nowMs: number;
}): string {
  const stamp = new Date(input.nowMs).toISOString();
  const toolCount = input.messages.filter((message) => message.role === 'tool').length;
  const marker = `[兜底 checkpoint · ${stamp}] 本段历史未能生成模型摘要（降级链已用尽）；以下为规则化留存。`;
  const counts = `覆盖范围：${String(input.messages.length)} 条历史消息（其中工具结果 ${String(toolCount)} 条）已不在模型上下文中。`;

  const previous = input.previousSummary?.trim() ?? '';
  if (previous.length > 0) {
    return `${previous}\n\n---\n${marker}\n${counts}`;
  }

  const firstUser = input.messages.find((message) => message.role === 'user');
  const excerpt =
    firstUser === undefined ? '（无）' : firstUser.content.replace(/\s+/gu, ' ').slice(0, 400);
  const files = collectFileMentions(input.messages, 20);
  const fileBlock =
    files.length === 0 ? '- （无）' : files.map((file) => `- ${file}`).join('\n');

  return [
    marker,
    counts,
    '',
    '## 目标',
    excerpt,
    '',
    '## 约束与偏好',
    '（无 —— 兜底压缩未分析）',
    '',
    '## 进度',
    '受阻：模型摘要生成失败，进度未分析（已知已完成 / 进行中信息丢失）',
    '',
    '## 关键决策',
    '（无 —— 兜底压缩未分析）',
    '',
    '## 下一步',
    '重新确认当前进度后再继续；必要时重读下列文件。',
    '',
    '## 关键上下文',
    '系统追加·本段历史涉及的文件：',
    fileBlock,
  ].join('\n');
}

/* ── 内部工具 ─────────────────────────────────────────────────────────────── */

/** 单轮/多轮摘要调用（`maxRetries=0` 即「只试一次」）。 */
async function runSummarize(params: {
  readonly summarize: CompactDeps['summarize'];
  readonly prompt: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isFatal: (error: unknown) => boolean;
  readonly maxRetries: number;
}): Promise<SummarizeAttempt> {
  let lastError: unknown = new Error('摘要请求未执行');

  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    try {
      const result = await params.summarize(params.prompt);
      return { status: 'ok', text: result.text };
    } catch (error) {
      lastError = error;
      // 鉴权/配额：重试只是浪费时间，立刻交给调用方走兜底
      if (params.isFatal(error)) {
        return { status: 'failed', fatal: true, error };
      }
      const backoff = SUMMARY_RETRY_BACKOFF_MS[attempt];
      if (attempt >= params.maxRetries || backoff === undefined) {
        break;
      }
      await params.sleep(backoff);
    }
  }

  return { status: 'failed', fatal: false, error: lastError };
}

/** 施加一次截断层，并**只在真的动过东西时**记一笔 layer（可观测性要准，不能每次都写）。 */
function applyTruncation(
  messages: readonly MessageLike[],
  opts: TruncateOptions,
  layers: string[],
  layer: string,
): MessageLike[] {
  const next = truncateToolResults(messages, opts);
  const changed = next.some((message, index) => message !== messages[index]);
  if (changed) {
    layers.push(layer);
  }
  return next;
}

/** 把系统抠出的文件清单追加到 checkpoint 末尾（不依赖模型记忆，FR-5.6「压缩方式」末条）。 */
function withFileListNote(summary: string, fileList: readonly string[]): string {
  if (fileList.length === 0) {
    return summary;
  }
  return `${summary}\n\n> 系统追加·本段历史涉及的文件：${fileList.join('、')}`;
}

/** 解析 keepRecentTokens：默认 20% hardLimit 且至少 8k，再夹到 hardLimit 以内。 */
function resolveKeepRecentTokens(provided: number | undefined, hardLimit: number): number {
  const fallback = Math.max(
    KEEP_RECENT_DEFAULTS.minimumTokens,
    Math.floor(hardLimit * KEEP_RECENT_DEFAULTS.ratioOfHardLimit),
  );
  const wanted =
    typeof provided === 'number' && Number.isFinite(provided) && provided > 0
      ? Math.trunc(provided)
      : fallback;
  return Math.min(wanted, hardLimit);
}

/** 查上一代。查不到/查失败都按 0 处理（最坏结果是 generation 重新计一代，不影响正确性）。 */
async function readLatestGeneration(store: CompactStore, sessionId: string): Promise<number> {
  try {
    const value = await store.latestGeneration(sessionId);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  } catch {
    return 0;
  }
}

/* ── 主流程 ───────────────────────────────────────────────────────────────── */

/**
 * 压缩一个会话（六阶降级）。返回的 `view` 才是应该发给模型的内容。
 *
 * `below` 是**正常路径**（未过自动线，什么都不做、不碰库、不调模型）；其余情况要么成功
 * （`fallback` 标明是否走了兜底），要么以 `hard-limit` 拒绝发送。
 */
export async function compactSession(
  deps: CompactDeps,
  input: CompactInput,
): Promise<CompactResult> {
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const isFatal = deps.isFatal ?? isFatalSummarizeError;

  const layers: string[] = [];
  const beforeTokens = estimateMessagesTokens(input.messages);

  /* ── 阶 1：预检 ── */
  // 预检不需要代数（只有真要压缩了才去查上一代），所以 `generation: 0` 是占位；
  // 未过线时返回的 `plan.generation` 也是 0，调用方不要拿它当「本会话压缩代数」使用。
  const preflight = planCompaction({
    windowTokens: input.windowTokens,
    outputLimitTokens: input.outputLimitTokens,
    currentTokens: beforeTokens,
    generation: 0,
  });
  layers.push('precheck');

  if (!preflight.needed) {
    // 未过自动线：直接返回。**不发请求、不查库、不落记录**（压缩记录只记真实发生的压缩）
    return {
      compacted: false,
      reason: 'below',
      beforeTokens,
      plan: preflight,
      layers,
    };
  }

  const previousGeneration = await readLatestGeneration(deps.store, input.sessionId);
  const generation = previousGeneration + 1;
  const plan = planCompaction({
    windowTokens: input.windowTokens,
    outputLimitTokens: input.outputLimitTokens,
    currentTokens: beforeTokens,
    generation,
  });

  const keepRecentTokens = resolveKeepRecentTokens(input.keepRecentTokens, plan.hardLimit);
  const window = selectRecentWindow(input.messages, keepRecentTokens);
  const viewMessages = stripOrphanToolResults(window.recent);
  const old = window.old;
  layers.push(`window:${String(window.recent.length)}/${String(input.messages.length)}`);

  /** 视图 token = checkpoint + 真实最近窗口（孤儿已剔除）。 */
  const viewTokensOf = (summary: string): number =>
    estimateTokens(summary) + estimateMessagesTokens(viewMessages);

  const fileList = collectFileMentions(old);

  /** 成功收口：落记录 + 返回视图。记录失败直接抛（AC-25 要求压缩可查，不能静默丢）。 */
  const finish = async (summary: string, fallback: boolean): Promise<CompactSuccess> => {
    const afterTokens = viewTokensOf(summary);
    await deps.store.record({
      repo: input.repo,
      issueNumber: input.issueNumber,
      sessionId: input.sessionId,
      generation,
      beforeTokens,
      afterTokens,
      summaryChars: summary.length,
      fallback,
    });
    return {
      compacted: true,
      summary,
      generation,
      beforeTokens,
      afterTokens,
      fallback,
      layers: [...layers],
      plan,
      view: { summary, messages: viewMessages },
    };
  };

  if (old.length === 0) {
    // 整个历史都落在最近窗口里 → 没有可摘要的旧历史。此时压缩无从谈起，只能拒发。
    layers.push('hard-limit');
    return {
      compacted: false,
      reason: 'hard-limit',
      beforeTokens,
      plan,
      layers,
      error: `没有可压缩的旧历史（最近窗口已覆盖全部 ${String(input.messages.length)} 条消息），但有 ${String(beforeTokens)} token 超过自动线，拒绝发送`,
    };
  }

  /* ── 阶 2：摘要请求（3 次短重试，退避 2/4/8s） ── */
  // 拼摘要时单条工具结果先按 2000 字符截断（FR-5.6「工具输出」第二层）
  const promptOld = applyTruncation(
    old,
    { maxChars: TRUNCATE_LIMITS.first },
    layers,
    'truncate:2000',
  );
  const primaryAttempt = await runSummarize({
    summarize: deps.summarize,
    prompt: buildSummaryPrompt({
      previousSummary: input.previousSummary,
      messages: promptOld,
      generation,
      fileList,
    }),
    sleep,
    isFatal,
    maxRetries: SUMMARY_MAX_RETRIES,
  });
  layers.push(
    primaryAttempt.status === 'ok' ? 'summary:l1' : `summary:l1-${primaryAttempt.fatal ? 'fatal' : 'failed'}`,
  );

  let fatal = primaryAttempt.status === 'failed' && primaryAttempt.fatal;

  if (primaryAttempt.status === 'ok') {
    const parsed = parseSummary(primaryAttempt.text);
    if (!parsed.ok) {
      layers.push(`summary:${parsed.reason}`);
    } else {
      const candidate = withFileListNote(parsed.summary, fileList);
      if (viewTokensOf(candidate) <= plan.hardLimit) {
        return finish(candidate, false);
      }
      layers.push('summary:over-hard');
    }
  }

  if (!fatal) {
    /* ── 阶 3：一次有界削减（工具结果 500 字符 + 丢 thinking），再试一次 ── */
    const bounded = applyTruncation(
      old,
      { maxChars: TRUNCATE_LIMITS.second, dropThinking: true },
      layers,
      'truncate:500',
    );
    const boundedAttempt = await runSummarize({
      summarize: deps.summarize,
      prompt: buildSummaryPrompt({
        previousSummary: input.previousSummary,
        messages: bounded,
        generation,
        fileList,
      }),
      sleep,
      isFatal,
      maxRetries: 0,
    });
    layers.push(
      boundedAttempt.status === 'ok'
        ? 'summary:l2'
        : `summary:l2-${boundedAttempt.fatal ? 'fatal' : 'failed'}`,
    );

    if (boundedAttempt.status === 'ok') {
      const parsed = parseSummary(boundedAttempt.text);
      if (parsed.ok) {
        const candidate = withFileListNote(parsed.summary, fileList);
        if (viewTokensOf(candidate) <= plan.hardLimit) {
          return finish(candidate, false);
        }
        layers.push('bounded:over-hard');
      } else {
        layers.push(`bounded:${parsed.reason}`);
      }
    } else if (boundedAttempt.fatal) {
      fatal = true;
    }

    if (!fatal) {
      /* ── 阶 4：分块链式摘要（≤16 块，每块带上一块摘要） ── */
      const chunks = planChunks(bounded);
      layers.push(`chunked:${String(chunks.length)}`);

      let carried = input.previousSummary;
      let chained: string | null = null;

      for (const chunk of chunks) {
        // 已有上一块摘要 → 强制走增量语义（保留旧信息 / 补充新进展 / 迁移进度），
        // 即使当前是「本会话第一次压缩」也一样：链式摘要的本质就是逐块 UPDATE。
        const chunkGeneration =
          typeof carried === 'string' && carried.trim().length > 0
            ? Math.max(generation, 2)
            : generation;

        const attempt = await runSummarize({
          summarize: deps.summarize,
          prompt: buildSummaryPrompt({
            previousSummary: carried,
            messages: chunk,
            generation: chunkGeneration,
            fileList,
          }),
          sleep,
          isFatal,
          maxRetries: 0,
        });

        if (attempt.status !== 'ok') {
          chained = null;
          // 这里不再区分 fatal：无论哪种失败都只剩阶 5（兜底 checkpoint，不调模型），
          // 分块链一旦断掉，后面的块没有可续的上一版摘要，继续调模型只是白烧配额。
          layers.push(attempt.fatal ? 'chunked:aborted-fatal' : 'chunked:aborted');
          break;
        }

        const parsed = parseSummary(attempt.text);
        if (!parsed.ok) {
          chained = null;
          layers.push(`chunked:${parsed.reason}`);
          break;
        }

        carried = parsed.summary;
        chained = parsed.summary;
      }

      if (chained !== null) {
        const candidate = withFileListNote(chained, fileList);
        if (viewTokensOf(candidate) <= plan.hardLimit) {
          return finish(candidate, false);
        }
        layers.push('chunked:over-hard');
      }
    }
  } else {
    layers.push('skip-bounded');
  }

  /* ── 阶 5：兜底 checkpoint（规则化，不依赖模型） ── */
  layers.push('fallback');
  const fallbackSummary = buildFallbackSummary({
    previousSummary: input.previousSummary,
    messages: old,
    nowMs: now(),
  });
  if (viewTokensOf(fallbackSummary) <= plan.hardLimit) {
    return finish(fallbackSummary, true);
  }

  /* ── 阶 6：仍超硬边界 → 拒绝发送 ── */
  layers.push('hard-limit');
  return {
    compacted: false,
    reason: 'hard-limit',
    beforeTokens,
    plan,
    layers,
    error: `压缩后仍超硬边界（hardLimit=${String(plan.hardLimit)}，兜底视图=${String(viewTokensOf(fallbackSummary))} token），拒绝发送请求`,
  };
}

/**
 * 柯里化版本：WS6 装配时一次性绑定依赖，调用点只关心 `input`。
 *
 * 两种调用形式都保留（`compactSession(deps, input)` 与 `createCompactor(deps)(input)`）：
 * 单测喜欢前者（一个文件里换着 deps 跑），装配层喜欢后者。
 */
export function createCompactor(
  deps: CompactDeps,
): (input: CompactInput) => Promise<CompactResult> {
  return async (input: CompactInput): Promise<CompactResult> => compactSession(deps, input);
}
