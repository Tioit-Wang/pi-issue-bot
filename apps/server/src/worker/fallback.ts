/**
 * 兜底回复：**信封不可信、但 agent 确实说了人话**时，把那一段话说出去（B13 补丁）。
 *
 * 为什么需要它（真实故障）：一次 `@answer` 的 turn 正常跑完（`turn.completed`，工具也跑了），
 * 但事件流里没有能通过 Ajv 校验的信封 —— 于是按「没有可信信封 → 不写回」的设计，
 * 用户看到的是「@ 了没反应」。信封校验是**安全边界**，一步都不能松；
 * 但「agent 已经写出面向人的答案」这件事不该被一起丢掉，所以补一条**只发评论**的窄出口。
 *
 * 四条纪律（安全边界不动的具体落法）：
 *  1. **只发评论**：本文件的写面只有一个 `comment`，没有标签、没有分支、没有 PR。
 *  2. **不改结局**：run 仍然记 `failure_class=parse`（质量统计不能失真），
 *     兜底评论本身失败也只是 `actions` 里一行 `applied_at = null`，不新增失败信号。
 *  3. **不碰 dry-run**：dry-run 的验收口径是「GitHub 零副作用 + `actions` 0 行」，
 *     所以兜底在 dry-run 下同样什么都不做（由调用方判断）。
 *  4. **只对评论类命令**：`/issue-triage`、`/issue-repro`、`@answer`。
 *     `/review-pr` 的结论若不可信就不该发（它会改变 PR 的去留），push 类任务更没有可发的东西。
 *
 * 正文取材：事件流里**最后一条 assistant 消息**的文本，去掉其中的 ```json 信封块
 * （那段是给机器用的，贴到 issue 上只会干扰人）。正文后面追加隐藏标记
 * `<!-- pi-issue-bot:fallback -->`，供去重与审计识别；`github/` 那一层还会再追加一个
 * `pi-bot:<repo>#<target>:fallback:<body-hash>` 标记，于是「同一段话」永不重复发。
 */
import { dispatchWriteAction } from '../github/index.ts';
import type { GithubWriteApi } from '../github/index.ts';
import type { CapturedEvent } from './envelope.ts';
import { signalFromGithub } from './failure.ts';
import type { ActionOutcome, RunStore } from './types.ts';
import { actionTargetOf, withMention } from './writeback.ts';

/** 兜底评论的隐藏标记（**不参与** `pi-bot:` 去重键，只用于人/审计识别这是兜底）。 */
export const FALLBACK_COMMENT_MARKER = '<!-- pi-issue-bot:fallback -->';

/** `actions.intent` 与去重标记里的 intent 段（`github/` 的 `assertIntent` 只允许 `[a-z0-9._-]`）。 */
export const FALLBACK_INTENT = 'fallback';

/** 兜底正文上限：GitHub 上限 65536，这里按「按字符算」留余量（同 `packages/envelope` 的 60000）。 */
export const MAX_FALLBACK_BODY_CHARS = 60_000;

/**
 * 允许兜底的命令（评论类）。`/review-pr` 与 push 类任务**不**兜底。
 *
 * v0.3 收敛成 `agent:mention` / `agent:event`（见 `agent/store.ts::agentTaskCommand`）：
 * 它们是 issue agent 的全部入口，产出默认就是一条评论。原来只列了 `/issue-triage`、
 * `/issue-repro` 和 `@answer`，于是 agent 任务一条都兜不住（实机 2026-11-11：模型只给
 * verdict、`actions` 空数组时，issue 上什么都没发出去）。
 */
export const COMMENT_FALLBACK_COMMANDS = [
  '/issue-triage',
  '/issue-repro',
  'agent:mention',
  'agent:event',
] as const;

/**
 * 自由问答的 `tasks.command`。
 *
 * 与 `http/webhook.ts::FREE_ANSWER_COMMAND` 同值，但**不 import 它**：
 * worker 反向依赖 `http/` 被 eslint 的 `import-x/no-restricted-paths` 拦着（tech-plan §8.2）。
 * 两份字面量的一致性由 `worker-fallback.test.ts` 的断言守住。
 */
export const FREE_ANSWER_COMMAND = '@answer';

/**
 * 这个命令是否允许兜底评论。
 *
 * 前缀判定留了空格 / `:` 两种分隔：`/issue-triage` 与「`/issue-triage focus`」、
 * 新格式 `@answer` 与兼容期的 `@answer:<base64url>` 都要认。
 */
export function supportsCommentFallback(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (normalized === FREE_ANSWER_COMMAND || normalized.startsWith(`${FREE_ANSWER_COMMAND}:`)) {
    return true;
  }
  return COMMENT_FALLBACK_COMMANDS.some(
    (name) => normalized === name || normalized.startsWith(`${name} `),
  );
}

const FENCED_BLOCK = /```[^\n]*\n?([\s\S]*?)```/gu;

/** 一段代码块正文是不是信封（凭 `verdict` / `actions` 两个键判，不要求是合法 JSON）。 */
function looksLikeEnvelopeBody(body: string): boolean {
  return /"?verdict"?\s*:/u.test(body) && /"?actions"?\s*:/u.test(body);
}

/** 末尾那段**无围栏**的裸信封（模型偶尔忘记写 ```）。 */
function stripTrailingBareEnvelope(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('}')) {
    return trimmed;
  }
  const start = Math.max(trimmed.lastIndexOf('\n{'), trimmed.lastIndexOf('\r\n{'));
  if (start < 0) {
    return trimmed;
  }
  const candidate = trimmed.slice(start + 1);
  return looksLikeEnvelopeBody(candidate) ? trimmed.slice(0, start).trimEnd() : trimmed;
}

/**
 * 模型常把提示词里的段落标签原样抄进回答（真实故障里就见到过「【第一段】」开头）。
 * 贴到 issue 上那是一句纯粹的噪音，所以只把**开头那一个标签**摘掉；
 * 正文里出现的同名字样一律不动（不该替人改措辞）。
 */
const LEADING_SECTION_LABEL = /^(?:【第一段】|\*\*第一段\*\*|第一段[：:])\s*/u;

/**
 * 把信封从正文里摘掉，只留人读部分。
 *
 * 判据用「文本里出现 `verdict` + `actions` 两个键」而不是 `JSON.parse`：
 * 模型给出的信封经常是**不合规**的（甚至不是合法 JSON），
 * 那正是要走兜底的情形 —— 此时 parse 必然失败，用它当判据会把机器段原样贴到 issue 上。
 */
export function stripEnvelopeBlocks(text: string): string {
  const withoutFenced = text.replace(FENCED_BLOCK, (whole: string, body: string) =>
    looksLikeEnvelopeBody(body) ? '' : whole,
  );
  const collapsed = stripTrailingBareEnvelope(withoutFenced.replaceAll('\r\n', '\n'))
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return collapsed.replace(LEADING_SECTION_LABEL, '').trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * 内容块里**不该进评论**的类型：模型的思考链（`thinking`）、工具调用/结果、图片。
 *
 * 兜底评论会发到公开 issue 上，所以这里用「排除已知的非正文类型」而不是「只认 text」：
 * 还没见过的类型只要有 `text` 就放开（宁可多解释一句，也别漏掉结论），
 * 但思考链一定要挡住 —— 那是模型的内部推理，不该出现在 issue 里。
 */
const NON_TEXT_BLOCK_TYPES: readonly string[] = [
  'thinking',
  'reasoning',
  'reasoning_content',
  'tool_use',
  'tool_result',
  'tool-call',
  'image',
];

/** 消息的 `content` 可能是字符串，也可能是内容块数组（`[{ type: 'text', text }]`）。 */
function textOfContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined) {
      continue;
    }
    const type = record['type'];
    if (typeof type === 'string' && NON_TEXT_BLOCK_TYPES.includes(type)) {
      continue;
    }
    const text = record['text'];
    if (typeof text === 'string') {
      parts.push(text);
    }
  }
  return parts.length === 0 ? null : parts.join('\n');
}

interface MessageText {
  readonly role: string | null;
  readonly content: string | null;
}

function messageOf(value: Record<string, unknown> | undefined): MessageText | null {
  if (value === undefined) {
    return null;
  }
  const role = typeof value['role'] === 'string' ? value['role'] : null;
  const text = value['text'];
  const content = textOfContent(value['content']) ?? (typeof text === 'string' ? text : null);
  return { role, content };
}

/**
 * 一条事件里的消息候选。
 *
 * 真 pi-host v0.22.0 的形状是
 * `{ event: { type: 'message_end', message: { role, content, ... } }, itemId, itemType }`；
 * 测试里的假 host 只给 `{ text }`。两种都认，其余形状一律不用（宁可不兜底，也不猜）。
 */
function messageCandidates(payload: unknown): readonly MessageText[] {
  const record = asRecord(payload);
  if (record === undefined) {
    return [];
  }
  const out: MessageText[] = [];
  for (const container of [asRecord(record['event']), asRecord(record['item']), record]) {
    if (container === undefined) {
      continue;
    }
    for (const candidate of [messageOf(container), messageOf(asRecord(container['message']))]) {
      if (candidate !== null && candidate.content !== null) {
        out.push(candidate);
      }
    }
  }
  return out;
}

/** 参与「找人话」的事件种类（只有完成态的消息才可能已定稿）。 */
const AGENT_TEXT_EVENT_KINDS: readonly string[] = ['item.completed'];

/**
 * 事件流里**最后一条** assistant 的文本（已摘掉信封块）；没有就返回 `null`。
 *
 * 从后往前扫：同一轮里 agent 说过很多次话（中间还夹着工具结果），
 * 只有最后那条 assistant 消息才是它交付的结论。
 */
export function findLastAgentText(events: readonly CapturedEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !AGENT_TEXT_EVENT_KINDS.includes(event.kind)) {
      continue;
    }
    const candidates = messageCandidates(event.payload);
    for (let position = candidates.length - 1; position >= 0; position -= 1) {
      const candidate = candidates[position];
      if (candidate === undefined || candidate.content === null) {
        continue;
      }
      // 只认 assistant；`role` 缺失的兼容形态（假 host 的 `{ text }`）放行。
      if (candidate.role !== null && candidate.role !== 'assistant') {
        continue;
      }
      const cleaned = stripEnvelopeBlocks(candidate.content);
      if (cleaned !== '') {
        return cleaned;
      }
    }
  }
  return null;
}

/** 拼最终正文：人读正文 + 隐藏标记；正文为空（只有信封）时返回 `null`（没有可兜底的东西）。 */
export function buildFallbackCommentBody(text: string): string | null {
  const body = stripEnvelopeBlocks(text);
  if (body === '') {
    return null;
  }
  const limited =
    body.length > MAX_FALLBACK_BODY_CHARS ? `${body.slice(0, MAX_FALLBACK_BODY_CHARS)}\n\n…（内容过长，已截断）` : body;
  return `${limited}\n\n${FALLBACK_COMMENT_MARKER}`;
}

export interface PostFallbackCommentInput {
  readonly runId: string;
  readonly repo: string;
  readonly targetNumber: number;
  /** 触发本轮的命令（写进 `actions.audit`，便于按命令统计兜底率）。 */
  readonly command: string;
  /** 已经过 `buildFallbackCommentBody()` 的正文（不含 `pi-bot:` 去重标记，那层由 `github/` 追加）。 */
  readonly body: string;
  /** 提问者 login：兜底评论同样要 `@login`（`worker/writeback.ts::withMention`）。 */
  readonly mention?: string | null | undefined;
  readonly api: GithubWriteApi;
  readonly store: RunStore;
  readonly clock: () => number;
}

/**
 * 发兜底评论并落 `actions` 行。
 *
 * **不抛异常**：兜底是「尽力而为」的那一步，失败只留痕（`applied_at = null` + `audit.reason`）。
 * 抛出去会让一条本来只是 `parse` 的 run 多出 `github_api` 信号，把失败分类带偏。
 */
export async function postFallbackComment(input: PostFallbackCommentInput): Promise<ActionOutcome> {
  const target = actionTargetOf(input.repo, input.targetNumber);

  try {
    const result = await dispatchWriteAction(
      {
        kind: 'comment',
        repo: input.repo,
        target: input.targetNumber,
        intent: FALLBACK_INTENT,
        body: withMention(input.body, input.mention),
      },
      { api: input.api },
    );
    // 类型收窄 + 意图自证：兜底只可能产出 comment（上面只传了这一种），
    // 别种分支到这里就是 bug，不能静默忽略。
    if (result.kind !== 'comment') {
      throw new Error(`兜底回复只允许 comment，实际分派出 ${result.kind}`);
    }
    const posted = result.outcome.action === 'posted';
    const outcome: ActionOutcome = {
      intent: FALLBACK_INTENT,
      status: posted ? 'applied' : 'skipped',
      target,
      externalRef: result.outcome.commentId === null ? null : String(result.outcome.commentId),
      reason: posted
        ? `信封不可信，兜底发出 agent 的人读回复（标记 ${result.outcome.marker}）`
        : `命中隐藏标记，跳过重复的兜底评论（commentId=${String(result.outcome.commentId)}）`,
    };
    await input.store.recordAction({
      runId: input.runId,
      intent: outcome.intent,
      target,
      externalRef: outcome.externalRef,
      // 与 `writeback.ts` 保持一致：命中去重也算「这条写操作发生了什么」（skipped 是它的结果）
      appliedAt: new Date(input.clock()),
      audit: {
        status: result.outcome.action,
        reason: 'envelope-invalid',
        command: input.command,
        marker: result.outcome.marker,
        dedupeAction: result.outcome.action,
        bodyChars: input.body.length,
      },
    });
    return outcome;
  } catch (error) {
    const signal = signalFromGithub(error);
    const reason = signal.detail ?? '兜底评论失败';
    await input.store
      .recordAction({
        runId: input.runId,
        intent: FALLBACK_INTENT,
        target,
        externalRef: null,
        appliedAt: null,
        audit: {
          status: 'failed',
          reason,
          command: input.command,
          failureClass: signal.failureClass,
          httpStatus: signal.httpStatus ?? null,
        },
      })
      .catch(() => undefined);
    return { intent: FALLBACK_INTENT, status: 'failed', target, externalRef: null, reason };
  }
}
