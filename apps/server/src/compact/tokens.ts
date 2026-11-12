/**
 * token 估算（FR-5.6「触发」：阈值从当前模型的上下文窗口**现算**，所以压缩前必须先知道「现在多长」）。
 *
 * 为什么不引真 tokenizer：
 *  1. 压缩检查点固定在「请求发出前」，走的是控制面进程，拉一个几十 MB 的 BPE 词表只为估个数不划算；
 *  2. 我们要的是**保守的量级判断**（是否过 90% 自动线 / 硬边界），不是计费口径 ——
 *     计费走 provider 返回的 usage（`cost/` 那套），这里高估几个百分点无害，低估才会出事；
 *  3. 纯函数才能被单测钉住（不同窗口 32k / 128k / 1M 的双阈值都依赖它稳定）。
 *
 * 口径（刻意简单、保守）：
 *  - CJK 字符（汉字 / 假名 / 谚文 / 全角标点）**1 字符 ≈ 1 token**；
 *  - 其余字符（ASCII 等）**4 字符 ≈ 1 token**，向上取整；
 *  - 每条消息额外算一点结构开销（角色名、分隔符），带 `toolCalls` 的再按调用条目加一点。
 *
 * `MessageLike` 与现有 `runtime/turn-driver.ts` 的消息形状**解耦**：那边是 RACP 事件流，
 * 这边只关心「压缩器要读的字段」。适配层（事件 → MessageLike）由 WS6 做，本模块不 import 运行时。
 */

/** 消息角色（只保留压缩需要的四种）。 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 助手消息里的一次工具调用（**只用来判孤儿 toolResult**，不参与正文估算的语义判断）。
 *
 * 为什么需要它：压缩后喂模型的视图 = checkpoint + **真实最近窗口**，窗口从中间切下去时，
 * 可能出现「toolResult 还在窗口里、发起这次调用的 assistant 消息被切到摘要侧」的情况，
 * provider 遇到这种孤儿结果会直接 400。所以窗口内必须能反查到 call id。
 */
export type ToolCallLike = {
  readonly id: string;
  readonly name?: string;
};

/**
 * 压缩器视角的一条消息。
 *
 * 契约（`docs/v21-contract.md` §6 / FR-5.6）只要求 `role` + `content` + `toolCallId` + `toolName`；
 * 这里的 `thinking` / `toolCalls` 是**可选扩展**，分别服务「分层截断第二层丢思考块」与
 * 「剔除孤儿 toolResult」。缺了这两个字段也能跑，只是那两条降级能力退化为 no-op。
 */
export type MessageLike = {
  readonly role: MessageRole;
  readonly content: string;
  /** 工具结果 → 对应调用的 id（保留它才能判孤儿，也才能让 provider 认账）。 */
  readonly toolCallId?: string;
  /** 工具名（`Read` / `Bash` / …）：摘要提示词里带上它，模型才知道这段输出是什么。 */
  readonly toolName?: string;
  /** 思考块正文：第二层截断时置空（FR-5.6「仍超预算时降到 500 字符并丢弃思考块」）。 */
  readonly thinking?: string;
  /** 助手消息发起的工具调用列表（可缺省，见 `ToolCallLike`）。 */
  readonly toolCalls?: readonly ToolCallLike[];
};

/** 估算口径的全部魔数集中在这里，测试与文档引用同一份。 */
export const TOKEN_ESTIMATE = {
  /** ASCII 类字符多少个算 1 token（向上取整） */
  asciiCharsPerToken: 4,
  /** 每条消息的结构开销（角色名 + 分隔符），经验值 */
  messageOverheadTokens: 4,
  /** 每次工具调用的结构开销（id + name + 括号） */
  toolCallOverheadTokens: 6,
  /** 思考块的额外结构开销 */
  thinkingOverheadTokens: 2,
} as const;

/**
 * 判断一个码点是否按「1 字符 1 token」算（CJK 及全角区）。
 *
 * 覆盖范围刻意比「只有汉字」宽：日文假名、韩文谚文、全角标点在中英混排的提示词里 token 密度
 * 与汉字同一量级（一个字符一个 token 上下），漏掉它们会让含日文/全角标点的对话被低估。
 */
function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x2eff) || // CJK 部首补充
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK 标点（含全角空格）
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 平假名 / 片假名
    (codePoint >= 0x3100 && codePoint <= 0x312f) || // 注音符号
    (codePoint >= 0x3130 && codePoint <= 0x318f) || // 谚文字母
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) || // 片假名语音扩展
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // 汉字扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // 汉字基本区
    (codePoint >= 0xa960 && codePoint <= 0xa97f) || // 谚文字母扩展 A
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // 谚文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // 兼容汉字
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK 兼容形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角 ASCII
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // 全角符号
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f) // 汉字扩展 B 及以后
  );
}

/**
 * 估算一段文本的 token 数。
 *
 * 纯函数、无 I/O、对同一输入恒等 —— 压缩的所有阈值判断都建立在它之上。
 * 空串返回 0（调用方不要指望「空摘要」能过预检，见 `summary.ts` 的空摘要失败策略）。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let cjkChars = 0;
  let otherChars = 0;
  // for…of 按码点迭代，代理对（emoji / 扩展汉字）算一个字符，不会被拆成两个半个字符
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (isCjkCodePoint(codePoint)) {
      cjkChars += 1;
    } else {
      otherChars += 1;
    }
  }

  return cjkChars + Math.ceil(otherChars / TOKEN_ESTIMATE.asciiCharsPerToken);
}

/**
 * 估算一条消息的 token 数（正文 + 结构开销 + 工具元信息 + 思考块）。
 *
 * 工具结果**按正文估算**：截断前后唯一的区别就是正文长度，估别的没有意义。
 */
export function estimateMessageTokens(message: MessageLike): number {
  let total = TOKEN_ESTIMATE.messageOverheadTokens;
  total += estimateTokens(message.content);

  if (typeof message.toolName === 'string' && message.toolName.length > 0) {
    total += estimateTokens(message.toolName);
  }
  if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
    total += estimateTokens(message.toolCallId);
  }
  if (typeof message.thinking === 'string' && message.thinking.length > 0) {
    total += TOKEN_ESTIMATE.thinkingOverheadTokens + estimateTokens(message.thinking);
  }
  for (const call of message.toolCalls ?? []) {
    total += TOKEN_ESTIMATE.toolCallOverheadTokens;
    total += estimateTokens(call.id);
    if (typeof call.name === 'string' && call.name.length > 0) {
      total += estimateTokens(call.name);
    }
  }

  return total;
}

/**
 * 估算一组消息的 token 数（顺序求和）。
 *
 * 不做去重、不做缓存：消息数组最多几百条，逐条算比维护一个失效逻辑更省心。
 */
export function estimateMessagesTokens(messages: readonly MessageLike[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}
