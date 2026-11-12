/**
 * 结构化摘要的提示词与解析（FR-5.6「压缩方式」/「多次压缩」）。
 *
 * 三条硬约束，全部落在提示词里（模型不看代码，只能靠指令）：
 *  1. **覆盖切点之前的全部消息** —— 不允许出现「消息离开了上下文却没被摘要覆盖」；
 *  2. **精确的文件路径 / 函数名 / 报错原文原样保留** —— 被改写成概述就等于丢信息，
 *     模型下次只能重新读文件重跑命令，返工成本远高于多写几十个字；
 *  3. **不允许拼接多份摘要** —— 多段摘要互相矛盾比没有摘要更糟。
 *
 * 增量与首次的区别（FR-5.6「多次压缩」）：
 *  - 首次：重压「切点前全部消息」；
 *  - 第二次起：输入是「上一版摘要 + 之后的新增消息」，走 UPDATE 语义
 *    （保留旧信息 / 补充新进展 / 把「进行中」迁移到「已完成」）。**不是重压全量**。
 *  - 两次都要求输出**完整六段**：产物是一份自洽的 checkpoint，不是差异补丁。
 *
 * 本模块纯函数：不调模型、不查库。调模型与落库都在 `engine.ts`。
 */
import { estimateMessagesTokens } from './tokens.ts';
import type { MessageLike } from './tokens.ts';

/**
 * 六个必填小节（顺序即提示词里的顺序）。
 *
 * 为什么是这六段：目标/约束决定「做什么、不能做什么」；进度与下一步决定「接着干什么」；
 * 关键决策解释「为什么不那样做」（防止模型重走已否决的路）；关键上下文装精确路径/命令/报错。
 */
export const SUMMARY_SECTIONS = [
  '目标',
  '约束与偏好',
  '进度',
  '关键决策',
  '下一步',
  '关键上下文',
] as const;

export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

/** 解析结果：要么拿到可用摘要，要么明确失败（**空摘要视为失败**，FR-5.6「失败降级」末条）。 */
export type SummaryParseResult =
  | { readonly ok: true; readonly summary: string }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'missing-sections';
      /** 缺失的小节名（`reason==='empty'` 时是全部六段） */
      readonly missing: readonly SummarySection[];
    };

/** `buildSummaryPrompt` 的输入。 */
export type BuildSummaryPromptInput = {
  /** 上一版摘要。只在「第二代及以后」参与；首次压缩传 undefined */
  readonly previousSummary?: string;
  /** 本次要覆盖的消息（首次 = 切点前全部；增量 = 上一版摘要之后的新增） */
  readonly messages: readonly MessageLike[];
  /** 即将生成的代数（1 = 首次；≥2 = 增量） */
  readonly generation: number;
  /**
   * 系统侧补充的文件清单（FR-5.6「压缩区间内读写过的文件清单由系统追加，不依赖模型记忆」）。
   * 由 `collectFileMentions` 从消息正文里抠出来，不做语义判断。
   */
  readonly fileList?: readonly string[];
};

/** 六个小节的标题清单（提示词与测试共用一份，改口径只改一处）。 */
function renderSectionList(): string {
  return SUMMARY_SECTIONS.map((section) => `## ${section}`).join('\n');
}

/**
 * 判断这次是不是增量摘要。
 *
 * 没有上一版摘要时**退回首次语义**：让模型凭空「增量」只会得到一份自说自话的摘要，
 * 不如老实按首次提示词要求它覆盖全部消息。
 */
function isIncremental(input: BuildSummaryPromptInput): boolean {
  if (input.generation <= 1) {
    return false;
  }
  return typeof input.previousSummary === 'string' && input.previousSummary.trim().length > 0;
}

/** 把消息数组渲染成提示词里的对话片段（逐条带序号与角色，工具消息带工具名/callId）。 */
function renderTranscript(messages: readonly MessageLike[]): string {
  const lines: string[] = [];
  messages.forEach((message, index) => {
    const header = [`[${String(index + 1)}]`, message.role];
    if (typeof message.toolName === 'string' && message.toolName.length > 0) {
      header.push(`tool=${message.toolName}`);
    }
    if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
      header.push(`callId=${message.toolCallId}`);
    }
    lines.push(header.join(' '));
    lines.push(message.content);
    lines.push('');
  });
  return lines.join('\n');
}

/** 系统补充的文件清单块（无文件时整块省略，避免提示词里出现空标题）。 */
function renderFileList(fileList: readonly string[] | undefined): string {
  if (fileList === undefined || fileList.length === 0) {
    return '';
  }
  return [
    '【系统补充·压缩区间涉及的文件（原样保留，不要改写）】',
    fileList.map((file) => `- ${file}`).join('\n'),
    '',
  ].join('\n');
}

/**
 * 造摘要提示词。
 *
 * 首次与增量的差异全部在这里，engine 只负责「什么时候调用、失败怎么办」。
 */
export function buildSummaryPrompt(input: BuildSummaryPromptInput): string {
  const total = input.messages.length;
  const transcript = renderTranscript(input.messages);
  const fileList = renderFileList(input.fileList);

  const commonRules = [
    '硬性要求（逐条遵守）：',
    '1. 精确的文件路径、函数名、命令、行号、报错原文必须**原样照抄**，不得改写、概括、翻译、补全或加引号修饰。',
    '2. 只输出摘要正文：不要前言、不要解释、不要用代码块包裹整份摘要。',
    '3. 严格用下面六个二级标题，顺序固定，六节都要写；某一节确实没有内容就写「（无）」。',
    renderSectionList(),
    '4. 「进度」必须分三档写：已完成 / 进行中 / 受阻（受阻项写清卡在哪一步）。',
    '5. 禁止把多份摘要拼接在一起，也禁止分段小结后并列：最终只允许一份自洽的摘要。',
  ].join('\n');

  if (!isIncremental(input)) {
    return [
      '你是上下文压缩器。把「切点之前」的整段对话压成一份结构化 checkpoint 摘要，供后续请求继续使用。',
      '',
      '覆盖范围：下面列出的**全部消息**，一条都不能漏 —— 不允许出现「消息离开了上下文却没被摘要覆盖」。',
      '宁可写得啰嗦，也不要把具体事实压成抽象概括。',
      '',
      commonRules,
      '',
      fileList,
      `需要覆盖的全部消息（共 ${String(total)} 条，按时间正序）：`,
      transcript,
    ]
      .filter((part) => part !== '')
      .join('\n');
  }

  const previousSummary = String(input.previousSummary);
  return [
    '你在做**增量更新**，不是重压全量：把「上一版摘要」与「其后的新增消息」合并成**一份**新摘要。',
    '',
    '三个动作（按此语义更新，不要推翻重写）：',
    '1. 保留（PRESERVE）：上一版里的「目标」「约束与偏好」「关键决策」原文保留，不要换措辞、不要丢条目。',
    '2. 补充（ADD）：把新增消息里的新事实、新结论、新的精确路径/函数名/报错原文补进对应小节。',
    '3. 迁移（MOVE）：把「进度」里已经完成的事项从「进行中」移到「已完成」；新出现的阻碍写进「受阻」。',
    '',
    commonRules,
    '6. 输出仍然是上面六个标题的**完整一份**摘要（不是差异补丁、不是 changelog）：',
    '   - 不要保留「上一版」「本次新增」这类分区标题；',
    '   - 不要把上一版摘要整段贴回来再在后面追加内容（那就是拼接）。',
    '',
    fileList,
    '【上一版摘要】',
    previousSummary.trim(),
    '【上一版摘要结束】',
    '',
    `下面是上一版摘要之后新增的消息（共 ${String(total)} 条，按时间正序）：`,
    transcript,
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * 判断某小节标题是否出现。
 *
 * 允许三种写法（模型实际会混用，没必要因为它用了 `**目标**` 就判失败）：
 *  - Markdown 标题：`## 目标` / `### 目标`
 *  - 加粗：`**目标**`
 *  - 方括号：`【目标】`
 */
function hasSectionHeading(text: string, section: SummarySection): boolean {
  const pattern = new RegExp(
    `^[ \\t]{0,3}(?:#{1,6}[ \\t]*|\\*\\*|【)[ \\t]*${section}`,
    'mu',
  );
  return pattern.test(text);
}

/**
 * 解析模型返回的摘要。
 *
 * **空摘要视为失败**：看起来压缩成功、实际把上下文丢了，比直接失败更糟 ——
 * 失败至少会被发现并走降级链。
 *
 * 缺段也一律失败（由调用方决定是重试、降级还是兜底）：六个小节是「不许丢关键信息」的
 * 最低结构化保证，缺一段就可能缺「下一步」或「约束」。
 */
export function parseSummary(text: string): SummaryParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty', missing: [...SUMMARY_SECTIONS] };
  }

  const missing = SUMMARY_SECTIONS.filter((section) => !hasSectionHeading(trimmed, section));
  if (missing.length > 0) {
    return { ok: false, reason: 'missing-sections', missing };
  }

  return { ok: true, summary: trimmed };
}

/**
 * 从消息正文里抠出「压缩区间涉及的文件」清单（FR-5.6 末条：由系统追加，不依赖模型记忆）。
 *
 * 只做正则匹配：不做路径规范化、不校验文件是否存在 —— 它要回答的是「这段历史里碰过哪些文件」，
 * 不是「这些文件现在长什么样」。命中顺序即出现顺序，去重后截断到 `limit` 条。
 */
export function collectFileMentions(
  messages: readonly MessageLike[],
  limit = 30,
): readonly string[] {
  const pattern = /[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|sql|py|go|rs|java|kt|rb|sh|yml|yaml|toml|css|scss|html|htm|txt|lock)\b/gu;
  const seen = new Set<string>();
  const files: string[] = [];

  for (const message of messages) {
    for (const match of message.content.matchAll(pattern)) {
      const candidate = match[0];
      // 纯扩展名（`.ts`）或纯分隔符噪声不算文件
      if (candidate.length <= 3 || /^[./-]+$/u.test(candidate)) {
        continue;
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      files.push(candidate);
      if (files.length >= limit) {
        return files;
      }
    }
  }

  return files;
}

/**
 * 摘要区的 token 预算够不够（供 engine 决策「要不要分块」）。
 *
 * 放在 summary.ts 是因为它只跟提示词长度有关：一份提示词 = 指令 + 片段 + 文件清单。
 */
export function promptTokens(prompt: string): number {
  return estimateMessagesTokens([{ role: 'user', content: prompt }]);
}
