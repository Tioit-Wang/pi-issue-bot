/**
 * 工具输出的分层截断（FR-5.6「工具输出」）。
 *
 * 需求给了三层，**任何一层都不允许直接丢消息**：
 *  1. 执行时抓取就有上限，超出部分落文件（在 sandbox 侧做，不在本模块）；
 *  2. 拼摘要/拼请求时单条工具结果截到 **2000 字符**，带「已截断 N 字符」标记；
 *  3. 仍超预算时降到 **500 字符**并丢弃思考块；正文与工具入参不动，消息一条不删。
 *
 * 为什么截断而不是删除：删掉一条工具结果会让后续 assistant 的引用悬空（模型会以为自己
 * 记得那个 diff），而截断保留了「这里曾有一段 12KB 输出、前 500 字长这样」的事实。
 *
 * 三条硬约束（测试钉住）：
 *  - 只动 `role==='tool'` 的正文；
 *  - 不删消息、不改非工具消息的正文、不动工具入参（本模块压根看不见入参）；
 *  - 保留 `toolCallId`，否则下游拼请求时会出现孤儿 toolResult → provider 400。
 */
import { estimateMessagesTokens } from './tokens.ts';
import type { MessageLike } from './tokens.ts';

/** 三层截断的档位名（`none` = 消息本来就装得下，一处都没动）。 */
export const TRUNCATION_LAYERS = ['none', '2000', '500'] as const;

export type TruncationLayer = (typeof TRUNCATION_LAYERS)[number];

/** 两层的字符上限（需求写死的数字）。 */
export const TRUNCATE_LIMITS = {
  /** 第二层：拼摘要时的单条上限 */
  first: 2_000,
  /** 第三层：仍超预算时的上限 */
  second: 500,
} as const;

/** 截断标记的前缀（面板/日志按它认「这段不是原文」）。 */
export const TRUNCATION_MARKER_PREFIX = '已截断';

export type TruncateOptions = {
  /** 单条工具结果保留的最大字符数 */
  readonly maxChars: number;
  /** 是否丢弃思考块（第二层降级时 true） */
  readonly dropThinking?: boolean;
};

/**
 * 给被截断的工具结果补标记。
 *
 * 标记里写明「截掉了多少字符」而不是原文长度：排查时想知道的是损失了多少，不是原来多长
 * （原长 = 保留长度 + 截掉长度，信息不丢）。
 */
function truncationMarker(droppedChars: number): string {
  return `\n\n[${TRUNCATION_MARKER_PREFIX} ${String(droppedChars)} 字符]`;
}

/**
 * 只截 `role==='tool'` 消息的正文，其余字段与消息全部原样保留。
 *
 * 未超过上限的消息**返回同一个对象引用**：调用方据此判断「这一层有没有真的动过东西」，
 * 也避免给几百条消息都造新对象。
 */
export function truncateToolResults(
  messages: readonly MessageLike[],
  opts: TruncateOptions,
): MessageLike[] {
  const maxChars = Math.max(0, Math.trunc(opts.maxChars));
  const dropThinking = opts.dropThinking === true;

  return messages.map((message) => {
    let next = message;

    if (next.role === 'tool' && next.content.length > maxChars) {
      const kept = next.content.slice(0, maxChars);
      const dropped = next.content.length - kept.length;
      next = { ...next, content: `${kept}${truncationMarker(dropped)}` };
    }

    if (dropThinking && typeof next.thinking === 'string' && next.thinking.length > 0) {
      // 置空而不是删字段：形状稳定，调用方（WS6 的适配层）不用为「有没有 thinking」写分支
      next = { ...next, thinking: '' };
    }

    return next;
  });
}

export type LayeredTruncateResult = {
  readonly messages: MessageLike[];
  readonly layer: TruncationLayer;
};

/**
 * 按预算分层截断：装得下就一处不动 → 2000 → 500（并丢思考块）。
 *
 * 每次降级都**重新估算**整数组：截断后总量与预算的关系才算数，拍脑袋按单条长度判断会算错。
 * 注意最后一档返回 `'500'` 时**不保证**已在预算内 —— 它是「已经压到最狠了」的事实陈述，
 * 是否继续降级（分块 / 兜底 / 拒发）由 `engine.ts` 决定。
 */
export function layeredTruncate(
  messages: readonly MessageLike[],
  budgetTokens: number,
): LayeredTruncateResult {
  const budget = Math.max(0, Math.trunc(budgetTokens));

  if (estimateMessagesTokens(messages) <= budget) {
    return { messages: [...messages], layer: 'none' };
  }

  const first = truncateToolResults(messages, { maxChars: TRUNCATE_LIMITS.first });
  if (estimateMessagesTokens(first) <= budget) {
    return { messages: first, layer: '2000' };
  }

  const second = truncateToolResults(messages, {
    maxChars: TRUNCATE_LIMITS.second,
    dropThinking: true,
  });
  return { messages: second, layer: '500' };
}

/**
 * 剔除孤儿 toolResult（FR-5.6「保留策略·代价」）。
 *
 * 场景：压缩后喂模型的视图 = checkpoint + **真实最近窗口**。窗口从中间切下去时，
 * 可能出现「工具结果还在窗口里、发起这次调用的 assistant 消息被切到摘要侧」的情况。
 * provider 遇到这种孤儿结果会直接 400，所以拼视图前必须按窗口内 assistant 的 `toolCalls`
 * 反查一遍。
 *
 * 判定口径：**只有能查到调用方的工具结果才留下** —— `toolCallId` 缺失也算孤儿。
 * 理由：无法证明它有主，就当它有主发出去，代价是一整轮请求 400；剔掉只是少一段输出，
 * 摘要侧仍覆盖了它（工具消息不删，只是不进这次请求）。
 */
export function stripOrphanToolResults(messages: readonly MessageLike[]): MessageLike[] {
  const knownCallIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      knownCallIds.add(call.id);
    }
  }

  const kept = messages.filter((message) => {
    if (message.role !== 'tool') {
      return true;
    }
    return message.toolCallId !== undefined && knownCallIds.has(message.toolCallId);
  });

  // 没剔任何东西就返回同一批引用（便于上层判断视图是否变化）
  return kept.length === messages.length ? [...messages] : kept;
}
