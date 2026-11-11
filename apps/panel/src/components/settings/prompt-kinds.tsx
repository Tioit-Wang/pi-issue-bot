/**
 * 四个提示词 kind 的**静态事实**：tab 文案、保存期上限、可用占位符、hash 拼法、错误码文案。
 *
 * 为什么单独一个文件：这些值在三个地方要被用（提示词分区的 tab、流水线分区的入口行、
 * 层序预览的说明），三处各写一份必然漂移；而它们都不依赖 React，放在这里可以单独推理。
 *
 * 数字来源：`apps/server/src/skills/stage-prompts.ts` 的 `PIPELINE_PROMPT_LIMITS`
 * （project 4000 / format_check 8000 / classify 8000 / agent 4000）。服务端响应里的 `limit`
 * 优先，这里是**兜底与 tab 文案**（mock / 旧服务端不给 `limit` 时用它）。
 */
import type { PromptKind } from '../../../../../packages/contract/src/index.ts';
import { ApiError } from '../../lib/api.ts';
import { formatCount } from '../../lib/format.ts';

export type PromptKindMeta = {
  kind: PromptKind;
  /** tab 与入口行的短标题（2–4 个字）。 */
  label: string;
  /** 保存期上限（兜底值，服务端 `limit` 优先）。 */
  limit: number;
  /** 是否是「阶段系统提示词」（`project` 是 P1 人格层，语义不同）。 */
  stage: boolean;
};

/** 顺序 = 界面顺序 = 流程顺序（格式检查 → 分类 → Agent），`project` 在最前（现有 P1）。 */
export const PROMPT_KIND_META: readonly PromptKindMeta[] = [
  { kind: 'project', label: '项目约定', limit: 4_000, stage: false },
  { kind: 'format_check', label: '格式检查', limit: 8_000, stage: true },
  { kind: 'classify', label: '分类', limit: 8_000, stage: true },
  { kind: 'agent', label: 'Agent', limit: 4_000, stage: true },
];

export function promptKindMeta(kind: PromptKind): PromptKindMeta {
  const found = PROMPT_KIND_META.find((meta) => meta.kind === kind);
  // 数组是穷举的，找不到只能是类型被改坏；退回 project 也不会静默写错 kind
  return found ?? { kind: 'project', label: '项目约定', limit: 4_000, stage: false };
}

export function promptKindLimit(kind: PromptKind): number {
  return promptKindMeta(kind).limit;
}

export function isPromptKind(value: string | null | undefined): value is PromptKind {
  return PROMPT_KIND_META.some((meta) => meta.kind === value);
}

/* ── hash 路由（`#prompt/classify`） ────────────────────────────────────────── */

export const PROMPT_HASH_PREFIX = 'prompt';

export function promptKindHash(kind: PromptKind): string {
  return `#${PROMPT_HASH_PREFIX}/${kind}`;
}

/**
 * `#prompt/classify` → `classify`；`#prompt` / 空 hash / 非法 kind → `null`（调用方用默认 tab）。
 *
 * 为什么 hash 而不是查询串：设置分区本身是路径段（`/settings/prompt`），kind 是这一页的
 * **子视图**；放 hash 里刷新不丢、可以直接贴给别人，也不会让服务端多一条路由。
 */
export function parsePromptHash(hash: string): PromptKind | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  const [head, tail] = text.split('/');
  if (head !== PROMPT_HASH_PREFIX) return null;
  return isPromptKind(tail) ? tail : null;
}

/* ── 占位符 ───────────────────────────────────────────────────────────────── */

/**
 * 写作提示用的占位符 chip（面板**不做替换**，原样发给模型）。
 *
 * 两个阶段 kind 的可用集合来自服务端的报错文案（`prompt/store.ts` 的 `placeholder-unknown`）：
 * `{{title}} {{body}} {{repo}} {{target}} {{labels}} {{author}} {{url}} {{recheck}}`。
 * `format_check` 必须含 `{{title}}` 与 `{{body}}`（保存 400 的依据，V11）。
 */
export function promptKindPlaceholders(kind: PromptKind): readonly string[] {
  if (kind === 'project') return ['{{repo}}', '{{default_branch}}', '{{labels}}', '{{triggers}}'];
  return ['{{title}}', '{{body}}', '{{repo}}', '{{target}}', '{{labels}}', '{{author}}', '{{url}}', '{{recheck}}'];
}

/** `format_check` 必填的占位符（其他 kind 不强制）。 */
export const FORMAT_REQUIRED_PLACEHOLDERS = ['{{title}}', '{{body}}'] as const;

/* ── 保存期错误 → 文案 ─────────────────────────────────────────────────────── */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const braces = (names: readonly string[]): string => names.map((name) => `{{${name}}}`).join('、');

/**
 * 提示词写失败的**专用文案**。
 *
 * 服务端把具体原因放在 `details.code`（顶层 `code` 是 `bad-request`），三种都带明细：
 *  - `placeholder-unknown` → `details.unknownPlaceholders`（未知占位符名）
 *  - `placeholder-missing` → `details.missingPlaceholders`
 *  - `body-too-long` → 无明细，用本地的 kind 上限说清「超出 N 字符」
 *
 * 返回 `null` 表示「不是这三种」（交给 `describeWriteFailure` 的通用文案）。
 */
export function promptWriteReason(error: unknown, kind: PromptKind): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = asRecord(error.details);
  const code = typeof details?.['code'] === 'string' ? details['code'] : error.code;

  if (code === 'placeholder-unknown') {
    const names = asStrings(details?.['unknownPlaceholders']);
    return names.length === 0 ? '未知占位符' : `未知占位符：${braces(names)}`;
  }
  if (code === 'placeholder-missing') {
    const names = asStrings(details?.['missingPlaceholders']);
    if (kind === 'format_check') return '格式检查必须包含 {{title}} 与 {{body}}';
    return names.length === 0 ? '缺少必需的占位符' : `缺少必需的占位符：${braces(names)}`;
  }
  if (code === 'body-too-long') {
    return `超出 ${formatCount(promptKindLimit(kind))} 字符`;
  }
  if (code === 'empty-body') {
    return '正文不能为空（要恢复内置默认，点「恢复默认」）';
  }
  return null;
}

/** 版本指针的展示文案：`v3 · 项目版本` / `系统默认`（入口行与 tab 顶部共用一套口径）。 */
export function promptVersionLabel(activeVersion: number, isSystemDefault: boolean, stage: boolean): string {
  if (isSystemDefault || activeVersion === 0) {
    return stage ? '系统默认' : '系统默认（未覆盖）';
  }
  return `v${formatCount(activeVersion)} · 项目版本`;
}
