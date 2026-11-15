/**
 * 信封原文（`IssueTurn.verdict` / `IssueTurn.actions`）的读与截断。
 *
 * ## 为什么需要截断而不是整段渲染
 *
 * 这两列是**模型原始产出**（契约 `envelopeJsonValueSchema`，形状不固定）：v2.1 单条评论
 * 正文上限 60 000 字（`packages/envelope/src/v21.ts`），一轮 `actions` 理论可达 ~1 MB。
 * 直接 `JSON.stringify` 进 DOM 会让「打开一条 issue」变成一次白屏 —— 折叠块本身是为了
 * 「想核的时候能看到」，不是为了把 1 MB 塞进页面。
 *
 * 所以：默认收起 → 展开后显示**前 `ENVELOPE_PREVIEW_CHARS` 个字符**，并在下方如实写明
 * 「原文共 N 字符，这里只显示前 M；完整体现在任务详情 / `/trace`」。**一律不改写内容**，
 * 截断也不补省略号到 JSON 中间（那会让人以为是模型的输出）。
 *
 * ## 三种状态
 *
 * `absent`（响应里没有这个键，旧服务端）/ `null`（服务端说本轮没有）/ `value`。
 * `null` 与「有值但是空对象」不同：前者是**没有这一项**，后者是模型交了 `{}`。
 */
export type EnvelopeFieldState = 'value' | 'null' | 'absent';

export type EnvelopeField = {
  state: EnvelopeFieldState;
  /** 展示用文本（已按 `limit` 截断）；`state !== 'value'` 时为 `null`。 */
  text: string | null;
  /** 原文总字符数（截断前的完整 JSON 长度）。 */
  totalChars: number;
  /** 是否被截断（`text.length < totalChars`）。 */
  truncated: boolean;
};

/**
 * 展开后的预览上限（字符）。
 *
 * 4 000 字符 ≈ 一屏半的 `<pre>`：足够看清一轮信封的结构（kind / labels / 两三条 action），
 * 又不会让展开动作卡住渲染。
 */
export const ENVELOPE_PREVIEW_CHARS = 4_000;

/**
 * 读一个信封字段并按上限截断。
 *
 * `source` 是整轮（`IssueTurn`），`key` 只能是 `verdict` / `actions`：这两个键的名字
 * 是契约里定死的，不做「候选名」猜测（猜错会把 `text` 当信封显示）。
 */
export function readEnvelopeField(
  source: unknown,
  key: 'verdict' | 'actions',
  limit: number = ENVELOPE_PREVIEW_CHARS,
): EnvelopeField {
  const record = typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : null;
  if (record === null || !(key in record)) return { state: 'absent', text: null, totalChars: 0, truncated: false };

  const raw = record[key];
  if (raw === null || raw === undefined) return { state: 'null', text: null, totalChars: 0, truncated: false };

  // 缩进 2 空格是为了让人能一眼看出层次；`JSON.stringify` 对坏产出也不会抛（只是可能给 `undefined`）
  const json = JSON.stringify(raw, null, 2) ?? String(raw);
  // 按 UTF-16 码元切会切坏 emoji / 生僻字：先用码点切，再拼回去
  const chars = Array.from(json);
  const text = chars.length <= limit ? json : chars.slice(0, limit).join('');
  return { state: 'value', text, totalChars: chars.length, truncated: chars.length > limit };
}

/**
 * 一轮里是否**有**信封可显示（`null` 也算「有」：那说明这一轮确实没有结论，是事实）。
 *
 * 两个字段都 `absent` 时返回 `false` —— 响应里根本没有这两个键（旧服务端 / 夹具）。
 * 此时不渲染空块：`AC-30` 要的是「收起真实内容」，画一个永远空着的折叠块只会让人
 * 反复点它。契约缺字段这件事在原文卡与系统提示词两处已经如实报过一次，不重复刷屏。
 */
export function hasEnvelope(verdict: EnvelopeField, actions: EnvelopeField): boolean {
  return verdict.state !== 'absent' || actions.state !== 'absent';
}

/** 折叠块标题右侧的一句话摘要：`结论 1 项 · 动作 2 条` / `本轮没有交付信封`。 */
export function envelopeSummary(verdict: EnvelopeField, actions: EnvelopeField): string {
  const parts: string[] = [];
  if (verdict.state === 'value') parts.push(`结论 ${String(countOf(verdict))} 项`);
  if (actions.state === 'value') parts.push(`动作 ${String(countOf(actions))} 条`);
  if (parts.length > 0) return parts.join(' · ');
  return verdict.state === 'null' && actions.state === 'null' ? '本轮没有交付信封' : '只有一半字段';
}

/** 数一下顶层条目（数组长度 / 对象键数）；`value` 之外的调用返回 0。 */
function countOf(field: EnvelopeField): number {
  if (field.state !== 'value' || field.text === null) return 0;
  try {
    const parsed: unknown = JSON.parse(field.text);
    if (Array.isArray(parsed)) return parsed.length;
    if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed).length;
    return 1;
  } catch {
    // 截断后的 JSON 解不出来（正常：`truncated` 就是这种情况）→ 不猜条目数
    return 0;
  }
}
