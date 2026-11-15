/**
 * 请求前的压缩检查点（FR-5.6 全篇的**接线层**）。
 *
 * 三层分工，别混：
 *  - `engine.ts`：给定「窗口 + 完整历史」，算阈值、跑六阶降级、落一行 `agent_compactions`，
 *    返回**喂给模型的视图**（checkpoint 摘要 + 真实最近窗口）；
 *  - 本文件：把「宿主侧发生的事实」翻译成引擎的输入，再把引擎的结论翻译成「这一轮到底发什么」；
 *  - `runtime/turn-driver.ts`：在 `turn/start` 之前调一次，拿到 `send:false` 就**不发送请求**。
 *
 * 历史从哪来（这是本层必须诚实交代的一点）：
 *  `session/attach` 的快照（`SessionSnapshot`）带 `items` 与 `hasMoreHistory` —— 那是宿主侧
 * 唯一可读的会话记录，也是我们唯一不需要新协议能力就能拿到的「真实历史」。三条已知边界：
 *  1. 只拿得到**第一页**：`hasMoreHistory=true` 时更老的条目读不到，因此 token 估算对超长会话
 *     是**下界**（`CompactionNote.historyComplete=false` 会如实标出来）；
 *  2. 条目内容是 `unknown`（`ItemSummary.content`），只能按已知字段容错抽取（见 `messagesFromSnapshotItems`）；
 *  3. `turn/start` 只接受 `{ messageId, text }`，RACP **没有**「替换会话上下文」的 operation
 *     （`packages/racp-client/src/ops.ts` 全表核对过）。
 *
 * 第 3 条决定了本层的形状，而它能落成两种实现 —— FR-5.6「压缩结果怎么放」的三句话要的是后者：
 *  - **重建**（主路径，`rebuild`）：换会话。归档当前会话 → `session/create` 新会话 →
 *    在新会话上发「checkpoint 摘要 + 保留的真实最近消息 + 本轮指令」。新会话的宿主上下文是空的，
 *    所以**真正变小了**；原始对话一条不删，仍在 `agent_messages` / `agent_compactions` 里。
 *  - **前缀**（退路，`text`）：把 checkpoint 拼在本轮提示词前面。宿主历史一条不删，因此它
 *    **不减小请求**，只用于「换会话失败」这一种情况（`turn-driver` 负责退回并 warn）。
 * 两条正文都从同一次压缩结果派生，差别只在本轮到底发什么：所以后台视图与模型视图是两套。
 * TODO(FR-5.6): RACP 增加 `session/history`（分页读全量）后，`historyComplete` 才能真正为 `true`；
 *  在那之前这个标记只是「这次估算是不是下界」的如实交代。
 *
 * 失败一律**不抛**（`runTask` 不抛异常、`driveTurn` 只抛语义错误）：压缩器自身出问题不能把
 * 一整轮已经跑起来的任务判死，代价是这种情况下按原文发送（见 `catch` 里的注释）。
 */
import { estimateTokens } from './tokens.ts';
import type { MessageLike, MessageRole, ToolCallLike } from './tokens.ts';
import type { CompactDeps, CompactInput, CompactResult, CompactSuccess } from './engine.ts';
import { createReminderLedger, takeReminder } from './remind.ts';
import type { ReminderLedger, ReminderTier } from './remind.ts';
import { resolveCompactionBudget, resolveModelWindow } from './window.ts';
import type { ResolvedWindow } from './window.ts';

/* ── 端口契约 ─────────────────────────────────────────────────────────────── */

/** 压缩硬边界：过了就不发请求（FR-5.6「触发」+ 降级第 6 步）。 */
export const COMPACTION_LIMIT_CODE = 'COMPACTION_HARD_LIMIT';

/** 一次请求前检查的输入（由 `driveTurn` 在 `turn/start` **之前**填）。 */
export type TurnCompactionRequest = {
  readonly sessionId: string;
  /** 本轮将要发送的提示词（原文；压缩层只做前缀拼装，不改写它） */
  readonly turnText: string;
  /** 从 `session/attach` 快照还原的历史（宿主侧真实条目） */
  readonly history: readonly MessageLike[];
  /** `false` = 快照只给了第一页，更老的历史读不到（估算因此是下界） */
  readonly historyComplete: boolean;
};

/** 一次压缩的可观测结论（AC-25：前后 token / 摘要长度 / 是否兜底 / 第几代）。 */
export type CompactionNote = {
  readonly generation: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly summaryChars: number;
  readonly fallback: boolean;
  /** 走了哪几阶降级（排查「这次压缩为什么这么差」） */
  readonly layers: readonly string[];
  /** 快照是否给全了历史（`false` → `beforeTokens` 是下界） */
  readonly historyComplete: boolean;
};

/**
 * 换会话重建的正文（`turn-driver` 见到就在**新会话**上原样发它）。
 *
 * 为什么它不是「前缀」：新会话的宿主上下文是空的，这段文本就是模型能看到的全部内容，
 * 所以它的大小就是「真正发出去的包」的大小 —— 硬边界必须按它判（`tokens`）。
 */
export type TurnCompactionRebuild = {
  /** 摘要 + 保留的真实最近消息 + 本轮指令 */
  readonly text: string;
  /** 上面那段正文的 token 估算（判硬边界的真实口径） */
  readonly tokens: number;
  /** 重建视图里保留的真实消息条数（AC-25 / 日志要能说清「保留了多少」） */
  readonly recentMessages: number;
};

/** 本轮的结论：要么照发（前缀 / 提醒 / 换会话重建），要么**拒绝发送**。 */
export type TurnCompactionOutcome =
  | {
      readonly send: true;
      /**
       * **不换会话**时本轮要发的文本（checkpoint 前缀 / 临边提醒 + 原文）。
       *
       * 换会话成功时用 `rebuild.text`；换会话失败时退回来用它 —— 见 `turn-driver.ts`
       * 的 `rebuildSession()`：退路只有这一条，不能退回「什么都不发」。
       */
      readonly text: string;
      readonly note: CompactionNote | null;
      readonly reminder: ReminderTier | null;
      /**
       * 有值 = 本轮应当换会话重建（FR-5.6「喂给模型的内容 = 从最新 checkpoint 重建」）。
       *
       * 端口不自己换会话：换会话要动 `session/*` operation，那是 `turn-driver` 的职责
       * （本文件不持有 ops，也不该把「发送点」变成两处）。
       */
      readonly rebuild?: TurnCompactionRebuild;
    }
  | {
      readonly send: false;
      readonly code: string;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

/** `runtime/turn-driver.ts` 注入的端口。**实现绝不抛错**，失败也走 `TurnCompactionOutcome`。 */
export type TurnCompactionPort = (request: TurnCompactionRequest) => Promise<TurnCompactionOutcome>;

/* ── 快照条目 → 消息 ──────────────────────────────────────────────────────── */

/** 单条条目正文最多保留多少字符（`ItemSummary.content` 是 `unknown`，兜底 JSON 化必须设上限）。 */
export const SNAPSHOT_TEXT_LIMIT = 8_000;

/** 只处理最近这么多条快照条目（`session/attach` 的首页不会更大；给个上界避免病理输入）。 */
export const SNAPSHOT_ITEM_LIMIT = 600;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** 从任意 content 里抠出正文：先按已知字段名找字符串，再按 part 数组拼，最后退化成有界 JSON。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => textOfContent(part)).filter((part) => part.length > 0).join('\n');
  }
  const record = asRecord(content);
  if (record === undefined) {
    return '';
  }
  for (const key of ['text', 'content', 'output', 'result', 'message', 'summary']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (Array.isArray(value)) {
      const nested = value.map((part) => textOfContent(part)).filter((part) => part.length > 0).join('\n');
      if (nested.length > 0) {
        return nested;
      }
    }
  }
  try {
    const json = JSON.stringify(content);
    return typeof json === 'string' ? json.slice(0, SNAPSHOT_TEXT_LIMIT) : '';
  } catch {
    return '';
  }
}

function stringField(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function toolCallsOf(content: Record<string, unknown> | undefined): readonly ToolCallLike[] {
  const raw = content?.['toolCalls'] ?? content?.['tool_calls'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: ToolCallLike[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const id = stringField(record, ['id', 'toolCallId', 'callId']);
    if (id === undefined) {
      continue;
    }
    const name = stringField(record, ['name', 'toolName']);
    calls.push({ ...(name === undefined ? {} : { name }), id });
  }
  return calls;
}

function roleOf(itemType: string, content: Record<string, unknown> | undefined): MessageRole {
  if (itemType === 'tool') {
    return 'tool';
  }
  const declared = content?.['role'];
  if (declared === 'system' || declared === 'user' || declared === 'assistant') {
    return declared;
  }
  return 'user';
}

/**
 * `ItemSummary[]` → 压缩器视角的消息数组。
 *
 * 三条容错（都是为了「不确定也不炸」）：
 *  - `itemType==='compaction'` 的条目**跳过**：那是宿主自己写下的压缩标记，不是对话内容，
 *    当消息喂进去会让摘要去总结「摘要」；
 *  - 正文抽不出来且没有工具调用的条目**跳过**（空消息只会让 token 估算凭空多算结构开销）；
 *  - 每条正文截到 `SNAPSHOT_TEXT_LIMIT`：兜底 JSON 化可能很大，不截会把这个函数变成内存炸弹。
 */
export function messagesFromSnapshotItems(items: readonly unknown[]): MessageLike[] {
  const tail = items.length > SNAPSHOT_ITEM_LIMIT ? items.slice(items.length - SNAPSHOT_ITEM_LIMIT) : items;
  const messages: MessageLike[] = [];

  for (const entry of tail) {
    const item = asRecord(entry);
    if (item === undefined) {
      continue;
    }
    const itemType = typeof item['itemType'] === 'string' ? item['itemType'] : 'message';
    if (itemType === 'compaction') {
      continue;
    }

    const content = asRecord(item['content']);
    const rawText = textOfContent(item['content']);
    const kept = rawText.length > SNAPSHOT_TEXT_LIMIT ? rawText.slice(0, SNAPSHOT_TEXT_LIMIT) : rawText;
    // 纯空白等于没内容：留着它只会让 token 估算凭空多算一条消息的结构开销
    const text = kept.trim().length === 0 ? '' : kept;

    const toolCalls = toolCallsOf(content);
    const toolCallId = stringField(content, ['toolCallId', 'tool_call_id', 'callId']) ?? stringField(item, ['toolCallId']);
    const toolName = stringField(content, ['toolName', 'tool_name', 'name']) ?? stringField(item, ['toolName']);
    const thinking = stringField(content, ['thinking', 'reasoning']);

    if (text.length === 0 && toolCalls.length === 0) {
      continue;
    }

    messages.push({
      role: roleOf(itemType, content),
      content: text,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    });
  }

  return messages;
}

/* ── 提示词拼装 ───────────────────────────────────────────────────────────── */

/** checkpoint 前缀的正文（`null` 时整块省略，输出与本层接线前**逐字节一致**）。 */
export type CheckpointBlock = {
  readonly generation: number;
  readonly summary: string;
  readonly fallback: boolean;
};

/**
 * 拼「不换会话」时本轮真正要发的文本：checkpoint 前缀 → 提醒 → 原提示词。
 *
 * 这是**退路**形态（换会话失败时用），不是主路径：前缀随本轮请求一起进入宿主历史，
 * 之后的轮次它自己又成了历史，所以它**不减小请求**。主路径见 `composeRebuildText()`。
 */
export function composeTurnText(input: {
  readonly turnText: string;
  readonly checkpoint?: CheckpointBlock | null;
  readonly reminder?: string | null;
}): string {
  const blocks: string[] = [];

  const checkpoint = input.checkpoint ?? null;
  if (checkpoint !== null && checkpoint.summary.trim().length > 0) {
    /**
     * 两种措辞，差在**一句断言**：只有正常压缩才允许说「旧历史已不在上下文里」。
     *
     * 兜底是规则化留存（摘要模型不可用），宿主的会话历史其实一条都没少；此时告诉模型
     * 「旧历史没了」会让它白白重读文件、重跑命令 —— 正是 FR-5.6「保留策略·理由」里
     * 最贵的那种返工。
     */
    const header = checkpoint.fallback
      ? `【上下文 checkpoint · 第 ${String(checkpoint.generation)} 代（兜底 · 规则化留存）】`
      : `【上下文 checkpoint · 第 ${String(checkpoint.generation)} 代（自动压缩）】`;
    const framing = checkpoint.fallback
      ? [
          '本次会话的上下文已接近安全预算，系统在本次请求前写了一份**兜底** checkpoint：',
          '摘要模型当前不可用，这份内容只是规则化留存（首个任务摘要 + 系统抠出的文件清单 + 明确的缺口标记）。',
          '会话历史本身没有丢，需要细节仍可按需重读；但请立刻收敛：把必须留存的精确路径 / 函数名 /',
          '报错原文写进正文，别指望后面还能保住。',
        ]
      : [
          '这段 checkpoint 覆盖了你此前的全部工作记录；其中精确的文件路径、函数名、报错原文已原样保留，',
          '直接使用，不要凭印象改写或重新试探。窗口之外的旧历史已不在本次上下文中。',
        ];
    blocks.push([header, ...framing, '', checkpoint.summary.trim(), '【checkpoint 结束】'].join('\n'));
  }

  const reminder = input.reminder ?? null;
  if (reminder !== null && reminder.trim().length > 0) {
    blocks.push(reminder.trim());
  }

  if (blocks.length === 0) {
    return input.turnText;
  }
  blocks.push(input.turnText);
  return blocks.join('\n\n');
}

/** 重建视图里一条真实消息的标签（模型要能分清「谁说的」「哪次工具调用」）。 */
function messageLabelOf(message: MessageLike): string {
  if (message.role === 'tool') {
    const name = message.toolName === undefined || message.toolName === '' ? '' : ` · ${message.toolName}`;
    const id = message.toolCallId === undefined || message.toolCallId === '' ? '' : ` · ${message.toolCallId}`;
    return `工具结果${name}${id}`;
  }
  if (message.role === 'assistant') {
    return '助手';
  }
  return message.role === 'system' ? '系统' : '用户';
}

/** 一条消息的正文：正文为空但有工具调用时，至少让模型看到「调了什么」。 */
function messageBodyOf(message: MessageLike): string {
  const content = message.content.trim();
  if (content.length > 0) {
    return message.content;
  }
  const calls = message.toolCalls ?? [];
  if (calls.length === 0) {
    return '（空）';
  }
  return calls.map((call) => `[工具调用] ${call.name ?? '未知工具'}(${call.id})`).join('\n');
}

/**
 * 把「保留的真实最近消息」渲染成重建视图里的一段。
 *
 * 为什么保留原文而不是再摘要一次：FR-5.6「保留策略」的刻意偏离 —— 判断与动作都在这一段里，
 * 一旦被改写成概述，模型只能重读文件、重跑命令（长任务里这一次返工比多占 20k token 贵得多）。
 */
function renderRecentTranscript(messages: readonly MessageLike[]): string {
  const lines = messages.map(
    (message) => `[${messageLabelOf(message)}]\n${messageBodyOf(message)}`,
  );
  return ['【重建视图 · 保留的真实最近消息（原样，未改写）】', ...lines, '【重建视图结束】'].join('\n');
}

/**
 * 拼「换会话重建」后真正发出去的正文（FR-5.6「喂给模型的内容 = 从最新 checkpoint 重建」）。
 *
 * 与 `composeTurnText()` 的差别不是措辞，而是**事实**：
 *  - 前缀路径下宿主历史一条没删，所以那里能说「会话历史本身没有丢」；
 *  - 重建路径下新会话的上下文是空的，窗口之外的旧历史**真的不在上下文里**了
 *    （原始记录仍在后台），所以这里必须换一套说法，否则模型会以为自己还能翻前面的对话。
 *
 * 兜底分支还要额外点破一件事：兜底摘要的「约束与偏好」「关键决策」两栏是空的，
 * 如果不说，模型会把「摘要没写」当成「没有约束」—— AC-24 要防的正是这种误判。
 */
export function composeRebuildText(input: {
  readonly turnText: string;
  readonly checkpoint: CheckpointBlock;
  readonly recent: readonly MessageLike[];
}): string {
  const checkpoint = input.checkpoint;
  const header = checkpoint.fallback
    ? `【上下文 checkpoint · 第 ${String(checkpoint.generation)} 代（兜底 · 规则化留存）】`
    : `【上下文 checkpoint · 第 ${String(checkpoint.generation)} 代（自动压缩）】`;
  const framing = checkpoint.fallback
    ? [
        '本次请求的上下文由这份**兜底** checkpoint 重建：摘要模型当前不可用，摘要正文只是规则化留存',
        '（首个任务摘录 + 系统抠出的文件清单），未经模型分析 —— 「约束与偏好」「关键决策」两栏空着',
        '不代表没有约束。窗口之外的旧对话已不在本次上下文中（原始记录仍完整保存在后台）。',
        '需要精确细节请按需重读文件 / 重跑命令，不要凭印象改写。',
      ]
    : [
        '本次请求的上下文由这份 checkpoint 重建：窗口之外的旧对话已不在本次上下文中',
        '（原始对话仍完整保存在后台，不可见但可查）。摘要里的精确文件路径、函数名、报错原文',
        '已原样保留，直接使用，不要凭印象改写或重新试探。',
      ];

  const blocks: string[] = [
    [header, ...framing, '', checkpoint.summary.trim(), '【checkpoint 结束】'].join('\n'),
  ];
  if (input.recent.length > 0) {
    blocks.push(renderRecentTranscript(input.recent));
  }
  blocks.push(`【本轮任务】\n${input.turnText}`);
  return blocks.join('\n\n');
}

/* ── 生产端口 ─────────────────────────────────────────────────────────────── */

/** 端口只需要两件事的日志能力（不 import 运行时/共享包的 Logger，保持本模块可独立单测）。 */
export type TurnCompactionLogger = {
  debug?: (detail: Readonly<Record<string, unknown>>, message: string) => void;
  info?: (detail: Readonly<Record<string, unknown>>, message: string) => void;
  warn?: (detail: Readonly<Record<string, unknown>>, message: string) => void;
};

export type CreateTurnCompactionOptions = {
  readonly repo: string;
  readonly issueNumber: number;
  /** 引擎句柄（`createCompactor(deps)` 的结果）：本层不关心摘要模型与存储怎么来 */
  readonly compact: (input: CompactInput) => Promise<CompactResult>;
  /** 模型名（窗口由 `resolveModelWindow()` 现算；模型名在进程生命周期内不变，所以默认在构造时算一次） */
  readonly modelName?: string | null;
  /** 直接给现算好的窗口（测试与「宿主报窗口」打通后走这条） */
  readonly window?: ResolvedWindow;
  readonly ledger?: ReminderLedger;
  readonly logger?: TurnCompactionLogger;
};

/** 摘要正文写进 checkpoint（前缀 / 重建两种形态都算）时的上限（防御：极端模型输出不该把一轮请求撑爆）。 */
export const CHECKPOINT_SUMMARY_LIMIT = 16_000;

/**
 * **退路**（前缀路径）本轮真正要发出去的 token 估算：宿主历史 + 拼上去的那段文本。
 *
 * 主路径（换会话重建）不用它：新会话的上下文是空的，发出去的包就是 `rebuild.text` 本身，
 * 直接 `estimateTokens(rebuild.text)` 才是真实口径。
 *
 * 为什么退路也不能只看引擎的视图 token：视图描述的是「如果宿主能按 checkpoint 重建上下文，
 * 应该发什么」；前缀路径下宿主历史一条不删（见文件头），两者不是同一个包 —— 拿视图守门
 * 等于用一个不存在的请求去比上限，真实请求超了照样发出去。
 *
 * 这是上界估计：宁可早一点判超限（少发一轮、明确报错），也不要发出去撞 provider 的 400。
 */
function realRequestTokensOf(beforeTokens: number, appendedText: string): number {
  return beforeTokens + estimateTokens(appendedText);
}

function noteOf(success: CompactSuccess, historyComplete: boolean): CompactionNote {
  return {
    generation: success.generation,
    beforeTokens: success.beforeTokens,
    afterTokens: success.afterTokens,
    summaryChars: success.summary.length,
    fallback: success.fallback,
    layers: success.layers,
    historyComplete,
  };
}

/**
 * 造一个可注入给 `driveTurn` 的压缩端口。
 *
 * 关键取舍：**压缩出任何问题都不抛**。`driveTurn` 只该因为「注定被拒的请求」而拒绝发送
 * （`send:false`），不该因为「压缩器自己坏了」把一轮已经开始的任务判死；因此 `catch` 里
 * 记 warn 并按原文发送。代价是压缩器崩掉时会一路撞到 provider 的上下文上限——这条路径
 * 依然会留下 warn 日志（可发现），且不会静默丢历史。
 */
export function createTurnCompaction(options: CreateTurnCompactionOptions): TurnCompactionPort {
  const ledger = options.ledger ?? createReminderLedger();
  // 预算口径与提醒线分开：未命中模型表时不能拿 32K 当真实安全预算去砍上下文（见 `window.ts`）。
  const window = resolveCompactionBudget(options.window ?? resolveModelWindow(options.modelName));

  return async (request: TurnCompactionRequest): Promise<TurnCompactionOutcome> => {
    const send = (
      text: string,
      note: CompactionNote | null,
      reminder: ReminderTier | null,
      rebuild?: TurnCompactionRebuild,
    ): TurnCompactionOutcome => ({
      send: true,
      text,
      note,
      reminder,
      ...(rebuild === undefined ? {} : { rebuild }),
    });

    // 没有历史（`ephemeral` 会话 / 本轮新建会话）：压缩无从谈起，一个字节都不改
    if (request.history.length === 0) {
      return send(request.turnText, null, null);
    }

    try {
      const result = await options.compact({
        repo: options.repo,
        issueNumber: options.issueNumber,
        sessionId: request.sessionId,
        windowTokens: window.tokens,
        ...(window.outputTokens === undefined ? {} : { outputLimitTokens: window.outputTokens }),
        messages: request.history,
      });

      if (!result.compacted) {
        if (result.reason === 'hard-limit') {
          const message = result.error ?? '上下文超过硬边界，拒绝发送请求（FR-5.6）';
          options.logger?.warn?.(
            {
              sessionId: request.sessionId,
              beforeTokens: result.beforeTokens,
              hardLimit: result.plan.hardLimit,
              layers: result.layers,
            },
            '压缩检查点：仍超硬边界，拒绝发送本轮请求',
          );
          return {
            send: false,
            code: COMPACTION_LIMIT_CODE,
            message,
            details: {
              sessionId: request.sessionId,
              beforeTokens: result.beforeTokens,
              hardLimit: result.plan.hardLimit,
              autoLimit: result.plan.autoLimit,
              layers: result.layers,
              historyComplete: request.historyComplete,
            },
          };
        }

        // `below`（未过自动线）依然可能落在临边提醒的两档里 —— 提醒比压缩更早到
        const reminder = takeReminder({
          sessionId: request.sessionId,
          facts: { currentTokens: result.beforeTokens, hardLimit: result.plan.hardLimit },
          ledger,
        });
        return send(
          composeTurnText({
            turnText: request.turnText,
            ...(reminder === null ? {} : { reminder: reminder.text }),
          }),
          null,
          reminder?.tier ?? null,
        );
      }

      const note = noteOf(result, request.historyComplete);
      const summary =
        result.summary.length > CHECKPOINT_SUMMARY_LIMIT
          ? `${result.summary.slice(0, CHECKPOINT_SUMMARY_LIMIT)}\n\n[checkpoint 已截断 ${String(
              result.summary.length - CHECKPOINT_SUMMARY_LIMIT,
            )} 字符]`
          : result.summary;

      const checkpoint: CheckpointBlock = {
        generation: result.generation,
        summary,
        fallback: result.fallback,
      };

      // 两条正文，对应两种「本轮怎么发」：
      //  - rebuild：换会话后**真正发出去的包**（新会话上下文为空，这段就是模型能看到的全部内容）；
      //  - prefix：换会话失败时的退路（宿主历史一条不删，所以它不减小请求，见文件头）。
      const prefixText = composeTurnText({ turnText: request.turnText, checkpoint });
      const rebuiltText = composeRebuildText({
        turnText: request.turnText,
        checkpoint,
        recent: result.view.messages,
      });
      const rebuiltTokens = estimateTokens(rebuiltText);
      const prefixTokens = realRequestTokensOf(result.beforeTokens, prefixText);
      const facts = {
        sessionId: request.sessionId,
        generation: note.generation,
        beforeTokens: note.beforeTokens,
        viewTokens: note.afterTokens,
        rebuiltTokens,
        prefixTokens,
        hardLimit: result.plan.hardLimit,
        summaryChars: note.summaryChars,
        fallback: note.fallback,
        layers: note.layers,
        historyComplete: note.historyComplete,
      };

      // 主路径：重建视图自己就是发出去的包，所以直接用它的 token 比硬边界
      // （不再是「假想视图」—— 这正是审查打回的那一条）。
      if (rebuiltTokens < result.plan.hardLimit) {
        options.logger?.info?.(
          { ...facts, recentMessages: result.view.messages.length },
          '压缩检查点：已追加一条 checkpoint，本轮换会话重建上下文（原始对话未改写）',
        );
        return send(prefixText, note, null, {
          text: rebuiltText,
          tokens: rebuiltTokens,
          recentMessages: result.view.messages.length,
        });
      }

      // 重建视图都越线了：退回前缀路径再看一次（它的真实包 = 宿主历史 + 前缀 + 本轮指令）。
      // 极端情况下会出现「重建超界但整段历史还没过线」——那时照发前缀仍然安全。
      if (prefixTokens < result.plan.hardLimit) {
        options.logger?.warn?.(
          facts,
          '压缩检查点：重建视图仍超硬边界，退回前缀路径（本轮请求不会变小）',
        );
        return send(prefixText, note, null);
      }

      // 两条路都越线：按需求「过硬边界不发请求、记录失败原因」办，
      // 而不是带着一个注定被 provider 拒掉的包去撞 400（既费一次调用，也看不出是压缩问题）。
      options.logger?.warn?.(facts, '压缩检查点：重建视图与前缀路径都超硬边界，拒绝发送本轮请求');
      return {
        send: false,
        code: COMPACTION_LIMIT_CODE,
        message: `压缩后仍超硬边界（重建视图 ${String(rebuiltTokens)} token、前缀路径 ${String(
          prefixTokens,
        )} token，硬边界 ${String(result.plan.hardLimit)}）：拒绝发送请求`,
        details: facts,
      };
    } catch (error) {
      // 见函数头：压缩器自身故障 → 记 warn 并按原文发送（不把任务判死，也不假装压缩成功）
      options.logger?.warn?.(
        { sessionId: request.sessionId, err: error instanceof Error ? error.message : String(error) },
        '压缩检查点失败（按原文发送本轮请求）',
      );
      return send(request.turnText, null, null);
    }
  };
}

/* ── 没有摘要模型客户端时的降级 ───────────────────────────────────────────── */

/**
 * 「本进程没有摘要模型客户端」的错误码。
 *
 * 为什么要一个专门的字面量而不是随便 throw：`isFatalSummarizeError()` 的判据是错误里
 * 的 status / code 或文案命中；装配层还会显式传 `isFatal: () => true` 把这类失败归成致命，
 * 于是引擎**第一次失败直接走阶 5（兜底 checkpoint）**，不会白等 2+4+8 秒的退避。
 */
export const SUMMARIZE_UNAVAILABLE_CODE = 'COMPACTION_SUMMARIZE_UNAVAILABLE';

/**
 * 本进程没有摘要模型客户端时用的 `summarize`（由装配层注入）。
 *
 * 事实陈述：这个仓库刻意**不做 provider 客户端**（见 `app/model-env.ts` 的分工：端点配置
 * 只换算成 pi-host 的环境变量，说模型协议的是宿主），而 RACP 目前也没有「让宿主替我摘要」
 * 的操作。两条通道都没打通之前，引擎只能走到阶 5：规则化兜底 checkpoint ——
 * `fallback=true`（可观测），提示词里也明确自称兜底（见 `composeTurnText`）。
 *
 * TODO(FR-5.6): 摘要模型任一条通道打通后，只换这里的实现；端口与引擎都不用动。
 */
export function createUnavailableSummarize(reason: string): CompactDeps['summarize'] {
  return async () => {
    const error = new Error(`${SUMMARIZE_UNAVAILABLE_CODE}: ${reason}`);
    // 引擎的 `isFatalSummarizeError()` 认 `code` 字段；装配层还会再显式传 `isFatal: () => true`
    throw Object.assign(error, { code: SUMMARIZE_UNAVAILABLE_CODE });
  };
}
