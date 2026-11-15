/**
 * 消息 fingerprint（`agent_messages` 主键的第三部分，`docs/dev-plan-issue-agent.md` §2.1）。
 *
 * 两条口径**刻意不同**：
 *  - **人消息（mention）永久幂等**：`sha256(repo, issue, 归一化文本)` 前 16 位。同一句话在
 *    同一个 issue 上永远只执行一次（需求 §5 规则 2 / §7 P3，副作用已知并接受）；
 *  - **事件消息（event）豁免永久幂等**：key 里带 `templateId` 与 `issue.updated_at`。
 *    模板文本天然相同，若也按纯文本 hash，同一 issue 的第二次编辑会被永久吞掉，
 *    与需求 §1.4「edited 每次都投」直接冲突（L-07 / OQ-12）。
 *
 * 事件消息不是「不去重」：同一个 `updated_at` 的重复投递仍然命中同一行 —— 幂等的单位是
 * 「一次内容变更」而不是「一次投递」。
 */
import { createHash } from 'node:crypto';
import { AGENT_FINGERPRINT_LENGTH } from './constants.ts';
import { normalizeForIdempotency } from './canonical-text.ts';

/** `sha256(parts.join('\u0000'))` 的前 16 位十六进制（NUL 分隔，避免字段拼接歧义）。 */
function digest(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, AGENT_FINGERPRINT_LENGTH);
}

/** 人消息的 fingerprint（永久幂等）。 */
export function mentionFingerprint(input: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly text: string;
}): string {
  return digest([input.repo, String(input.issueNumber), 'mention', normalizeForIdempotency(input.text)]);
}

/** 事件消息的 fingerprint（含 `templateId` + `issue.updated_at`；不参与永久幂等）。 */
export function eventFingerprint(input: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly templateId: string;
  readonly issueUpdatedAt: string;
}): string {
  return digest([
    input.repo,
    String(input.issueNumber),
    'event',
    input.templateId,
    input.issueUpdatedAt.trim(),
  ]);
}

/**
 * 评论消息的 fingerprint（FR-3.5 的**内容级**去重）。
 *
 * 为什么不能复用 `eventFingerprint`：事件级键是「模板 + `issue.updated_at`」，对评论来说
 * `updated_at` 只在评论落库时变一次、精度到秒 —— 同一秒里的两条不同评论会撞成同一条
 * （第二条被静默丢弃），而同一段话被重投时若 `updated_at` 已变又会重复消费。
 * 需求 §5 把「同一 issue 内评论正文（规范化后）」定为内容级键，与作者无关、不跨 issue。
 */
export function commentFingerprint(input: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly text: string;
}): string {
  return digest([input.repo, String(input.issueNumber), 'comment', normalizeForIdempotency(input.text)]);
}
