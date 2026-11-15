/**
 * 原文卡与系统提示词的**读取层**（契约字段缺失时如实说明，不编造）。
 *
 * ## 为什么还要这一层（字段已经有了）
 *
 * 契约（`packages/contract/src/api.ts`）现在有 `IssueSummary.body` / `author` / `createdAt`
 * 与 `IssueSessionResponse.systemPrompt`，服务端**总是**给出这些键（有值或 `null`）。
 * 所以这里的第一职责不再是「候补字段名」，而是**区分三种状态**：
 *
 * | 状态 | 含义 | 面板要说的话 |
 * |---|---|---|
 * | `value` | 有值 | 原样显示 |
 * | `null` | 服务端给了 `null`：**确实没有**正文 / 这次会话没有提示词记录 | 「没有正文」/「没有记录」 |
 * | `absent` | 响应里**没有这个键**（旧服务端 / mock 夹具 / 代理裁掉了） | 「契约没有提供这个字段」 |
 *
 * 第三种与前两种不能混为一谈：把「字段缺失」说成「没有正文」是在给用户一个错误事实
 * （他会以为人真的没写正文）；把「没有正文」说成「字段缺失」是在报告一个不存在的 bug。
 *
 * 候选名（`originalBody` / `system_prompt` 等）保留是因为 mock 夹具与旧响应仍可能用它们；
 * 判定顺序始终是「契约名优先」。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 一个字段的三种状态（见文件头表格）。 */
export type FieldState = 'value' | 'null' | 'absent';

type Picked = { state: FieldState; text: string | null };

/**
 * 从若干候选名里取一个文本字段，并判定它的状态。
 *
 * - 某个候选名**存在且是非空字符串** → `value`；
 * - 存在但是 `null` / 空串 → `null`（服务端明确说了「没有」）；
 * - 全都不存在 → `absent`（响应里没有这个键）。
 */
function pickText(source: Record<string, unknown>, keys: readonly string[]): Picked {
  let sawNull = false;
  for (const key of keys) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim() !== '') return { state: 'value', text: raw };
    // 键在、值不是可用文本（`null` / `''` / 非字符串）：如实记成「服务端说没有」
    sawNull = true;
  }
  return { state: sawNull ? 'null' : 'absent', text: null };
}

export type OriginalBody = {
  /** 正文（issue 主贴 markdown 原文）；没有正文或没有字段时为 `null`。 */
  body: string | null;
  /** 正文那三种状态（`value` / `null` / `absent`）—— 决定展示「没有正文」还是「字段缺失」。 */
  bodyState: FieldState;
  /** 作者 login。 */
  author: string | null;
  /** 发表时间（ISO8601）。 */
  at: string | null;
};

/**
 * 读 issue 主贴原文。
 *
 * 候选字段名（按优先级）：正文 `body` → `originalBody`；作者 `author` → `authorLogin` → `user`；
 * 时间 `createdAt` → `openedAt` → `at`。
 */
export function readOriginalBody(issue: unknown): OriginalBody {
  const record = asRecord(issue);
  if (record === null) return { body: null, bodyState: 'absent', author: null, at: null };
  const body = pickText(record, ['body', 'originalBody']);
  const author = pickText(record, ['author', 'authorLogin', 'user']);
  const at = pickText(record, ['createdAt', 'openedAt', 'at']);
  return { body: body.text, bodyState: body.state, author: author.text, at: at.text };
}

export type SystemPrompt = {
  /** 系统通道下发的那段 markdown **原文**；没有记录时为 `null`。 */
  text: string | null;
  /** 三种状态（与 `OriginalBody.bodyState` 同一套语义）。 */
  state: FieldState;
  /** 副标题（来源 / 项目级 or 内置默认）；没有就是 `null`。 */
  meta: string | null;
};

/**
 * 读这次会话的系统提示词。
 *
 * 为什么不在客户端按项目配置拼一遍：拼出来的那份与服务端**下发的那份**不是同一个东西
 * （配置随时会被改，历史会话不会跟着变，见 `db/schema.ts` 的 `agent_sessions.system_prompt`
 * 注释）。`AC-29` 要的正是「发给模型的到底是什么」，所以只接受服务端返回的原文。
 */
export function readSystemPrompt(data: unknown): SystemPrompt {
  const top = asRecord(data);
  if (top === null) return { text: null, state: 'absent', meta: null };
  const nested = asRecord(top['issue']);
  // 契约字段在响应顶层；`issue` 里是历史/夹具形态，一起认
  const candidates = [top, nested];
  let sawNull = false;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const picked = pickText(candidate, ['systemPrompt', 'system_prompt']);
    if (picked.state === 'value') {
      return { text: picked.text, state: 'value', meta: pickText(candidate, ['systemPromptSource']).text };
    }
    if (picked.state === 'null') sawNull = true;
  }
  return { text: null, state: sawNull ? 'null' : 'absent', meta: null };
}
