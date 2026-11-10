/**
 * 步骤 7：**结构化校验任务信封**（tech-plan §4.3 第 7 步 / plan §5）。
 *
 * 两件事分开写，因为它们失败的语义不同：
 *   1. **找**：agent 把信封写在事件流的哪一条里？`racp.schema.json` 还没 vendored（§2.2），
 *      所以这里对几种常见承载位置都试一遍（`item.completed` / `turn.completed` 的
 *      `text` / `content` / `output`，以及正文里的 ```json 代码块），**用 `parseEnvelopeJson()`
 *      当探针**：能通过 Ajv 的那一段就是信封。找不到就是 `parse` 失败（不猜、不拼）。
 *   2. **校验**：拿到原文后用 `validateEnvelope()` 正式判一次，并把错误明细拍平成
 *      `envelopes.errors` 的形状。**不合规也入库**（`valid=false` + `errors`），
 *      否则「模型交了什么」这件事在面板上就查不到了（plan §6.5 审计要求）。
 *
 * 动作过滤（`filterActions`）不在这里做，但它依赖的 options 形状在这里定义：
 * 校验通过之后才谈「哪些动作能执行」，两件事不能混在一个函数里（一个好动作不该被
 * 一个坏动作连累，见 `packages/envelope/src/actions.ts` 的语义）。
 */
import { filterActions, parseEnvelopeJson, validateEnvelope } from './deps.ts';
import type { EnvelopeAction, TaskEnvelope } from './deps.ts';
import type { PreparedEnvelope } from './types.ts';

/** 一条已落库/待落库的事件（能自动抽取的最小形状）。 */
export interface CapturedEvent {
  readonly eventId?: string;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * 信封可能出现的载体：事件 payload 里可能的字符串路径。
 *
 * 第一组是**真 pi-host v0.22.0 的形状**（对着 `run_events` 里一条真实 `item.completed` 核过）：
 * `{ event: { type: 'message_end', message: { role, content, … } }, itemId, itemType }` ——
 * 信封就在 `message.content` 里。少了这条，真跑出来的信封永远被判 `missing-envelope`，
 * 后面那些兼容路径只是 `{ text }` 这种简化形状（单测/假 host 用）。
 */
const ENVELOPE_TEXT_PATHS: readonly (readonly string[])[] = [
  ['event', 'message', 'content'],
  ['message', 'content'],
  ['event', 'message', 'text'],
  ['text'],
  ['message', 'text'],
  ['item', 'text'],
  ['content'],
  ['output'],
  ['result'],
  ['envelope'],
];

/** 参与「找信封」的事件 kind（其余 kind 的文本一律不试，避免把日志当信封）。 */
const ENVELOPE_EVENT_KINDS: readonly string[] = ['item.completed', 'turn.completed', 'turn.failed'];

/** 从正文里切 ```json 代码块。 */
const FENCED_JSON = /```(?:json|jsonc)?\s*([\s\S]*?)```/gu;

function pickString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.includes('{') ? current : undefined;
}

/** 一个候选字符串的全部可能切片：整串 + 每个 ```json 代码块。 */
function candidatesOf(text: string): string[] {
  const out = [text];
  for (const matched of text.matchAll(FENCED_JSON)) {
    const block = matched[1];
    if (block !== undefined) {
      out.unshift(block.trim());
    }
  }
  return out;
}

/** 粗略的形状判定：是不是「像一封信封」（有 verdict / actions / usage 三个键）。 */
function looksLikeEnvelope(candidate: string): boolean {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    return 'verdict' in record && 'actions' in record && 'usage' in record;
  } catch {
    return false;
  }
}

/**
 * 找出这轮 run 交出来的信封原文。
 *
 * 从**最后**一条事件往前找：同一次任务里 agent 可能中途贴出过草稿，终态那条消息才是最终产出。
 *
 * 两级判定，缺一不可：
 *  1. 先用 `parseEnvelopeJson()` 当探针找**能通过 Ajv** 的那一段（干净路径，草稿不会劫持）；
 *  2. 一个都不合规时，退回到「像一封信封」的那一段（有 `verdict`/`actions`/`usage` 三个键）。
 *     没有第 2 步，「不合规的信封」会退化成「没交信封」——`envelopes.valid=false` 就只会写
 *     `missing-envelope`，面板再也看不到「模型到底错在哪个字段」（§4.3 第 7 步要求不合规也留）。
 */
export function findEnvelopeText(
  events: readonly CapturedEvent[],
): { readonly text: string; readonly eventId: string | undefined } | null {
  let fallback: { readonly text: string; readonly eventId: string | undefined } | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !ENVELOPE_EVENT_KINDS.includes(event.kind)) {
      continue;
    }
    for (const path of ENVELOPE_TEXT_PATHS) {
      const raw = pickString(event.payload, path);
      if (raw === undefined) {
        continue;
      }
      for (const candidate of candidatesOf(raw)) {
        if (parseEnvelopeJson(candidate).ok) {
          return { text: candidate, eventId: event.eventId };
        }
        if (fallback === null && looksLikeEnvelope(candidate)) {
          fallback = { text: candidate, eventId: event.eventId };
        }
      }
    }
  }
  return fallback;
}

export interface EnvelopeFilterOptions {
  readonly allowedIntents?: readonly ('comment' | 'label' | 'create_issue' | 'push_branch')[];
  readonly allowPushBranch?: boolean;
  readonly allowedLabels?: readonly string[];
}

/** 从任意 JSON 值里尽力取出 verdict / actions / usage（不合规的信封也要能展示原文）。 */
function splitEnvelopeShape(value: unknown): Pick<PreparedEnvelope, 'valid'> & {
  readonly verdict: unknown;
  readonly actions: unknown;
  readonly usage: unknown;
} {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    verdict: record['verdict'] ?? null,
    actions: record['actions'] ?? null,
    usage: record['usage'] ?? null,
    valid: false,
  };
}

/**
 * 校验一段信封原文并过滤动作。
 *
 * @param text `findEnvelopeText()` 的结果；`null` 表示这轮没有交信封（`parse` 失败）
 */
export function prepareEnvelope(text: string | null, options: EnvelopeFilterOptions = {}): PreparedEnvelope {
  if (text === null) {
    return {
      text: null,
      valid: false,
      errors: [
        {
          path: '/',
          keyword: 'missing-envelope',
          message: '事件流里没有找到能通过校验的任务信封（plan §5 的 JSON 产出）',
        },
      ],
      envelope: null,
      accepted: [],
      dropped: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      text,
      valid: false,
      errors: [
        {
          path: '/',
          keyword: 'json-parse',
          message: error instanceof Error ? error.message : 'JSON 解析失败',
        },
      ],
      envelope: null,
      accepted: [],
      dropped: [],
    };
  }

  const validated = validateEnvelope(parsed);
  if (!validated.ok) {
    return {
      text,
      valid: false,
      errors: validated.issues,
      envelope: null,
      accepted: [],
      dropped: [],
    };
  }

  const envelope: TaskEnvelope = validated.envelope;
  const filtered = filterActions(envelope, {
    ...(options.allowedIntents === undefined ? {} : { allowedIntents: options.allowedIntents }),
    ...(options.allowPushBranch === undefined ? {} : { allowPushBranch: options.allowPushBranch }),
    ...(options.allowedLabels === undefined ? {} : { allowedLabels: options.allowedLabels }),
  });

  return {
    text,
    valid: true,
    errors: [],
    envelope,
    accepted: filtered.accepted as EnvelopeAction[],
    dropped: filtered.dropped.map((item) => ({
      index: item.index,
      intent: item.intent,
      reason: item.reason,
      detail: item.detail,
    })),
  };
}

/** 把信封拆成 `envelopes` 行的三列（不合规时尽量保留原文，便于面板展示）。 */
export function envelopeRowOf(
  text: string | null,
  prepared: PreparedEnvelope,
): { verdict: unknown; actions: unknown; usage: unknown } {
  if (prepared.envelope !== null) {
    return {
      verdict: prepared.envelope.verdict,
      actions: prepared.envelope.actions,
      usage: prepared.envelope.usage,
    };
  }
  if (text === null) {
    return { verdict: null, actions: null, usage: null };
  }
  try {
    const shape = splitEnvelopeShape(JSON.parse(text) as unknown);
    return { verdict: shape.verdict, actions: shape.actions, usage: shape.usage };
  } catch {
    // 连 JSON 都不是：只留原文摘要，供人看模型到底吐了什么
    return { verdict: null, actions: null, usage: { raw: text.slice(0, 2_000) } };
  }
}
