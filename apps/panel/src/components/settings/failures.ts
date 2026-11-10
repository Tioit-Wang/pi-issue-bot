/**
 * 写失败 → 人话（W3-I）。
 *
 * 服务端三种拒绝都要能被看清：
 *  1. **校验失败**（`PUT .../settings` 的 400）：`details.issues` 是 `"labels.map.foo: 必须是字符串"` 这种
 *     「字段路径: 原因」字符串数组（`apps/server/src/config/repo-config.ts` 的 `validateRepoSettings`），
 *     面板把路径拆出来等宽显示，用户才知道是**哪个字段**写错了；
 *  2. **预算超限**（`PUT .../prompt` 的 400）：`details.budget = {available, requested}`；
 *  3. **写被拒**（403）：缺 CSRF 头 / `PI_BOT_PANEL_WRITE=off` / 未登录（401）。
 *
 * 这个模块只做「错误 → 结构」的转换，不渲染：`save-bar.tsx` 与提示词分区共用同一份解析。
 */
import { ApiError } from '../../lib/api.ts';

/** 一条校验问题：`path` 是字段路径（服务端没给就为 `null`）。 */
export type SaveIssue = { path: string | null; message: string };

export type WriteFailure = {
  /** 一句话结论（带 HTTP 状态与错误码）。 */
  message: string;
  issues: SaveIssue[];
  /** 仅提示词保存会带：`available` 是这一版还能占多少字符。 */
  budget: { available: number; requested: number } | null;
};

/** 字段路径的样子：`labels.map`、`triggers.faces.issue_opened`、`labels.vocabulary[0].name`。 */
const PATH_LIKE = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+|\[\d+\])*$/iu;

/** `"labels.max_per_issue: 不能大于 20"` → `{path:'labels.max_per_issue', message:'不能大于 20'}`。 */
export function splitIssue(raw: string): SaveIssue {
  const text = raw.trim();
  const index = text.indexOf(': ');
  if (index > 0) {
    const head = text.slice(0, index);
    if (PATH_LIKE.test(head)) return { path: head, message: text.slice(index + 2).trim() };
  }
  return { path: null, message: text };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** zod 的 `issue.path` 可能是数组或已拼好的字符串；统一成 `a.b[0]`。 */
function pathOf(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (!Array.isArray(value)) return null;
  const parts = value.map((part) => String(part));
  if (parts.length === 0) return null;
  return parts.reduce((acc, part) => (/^\d+$/u.test(part) ? `${acc}[${part}]` : acc === '' ? part : `${acc}.${part}`), '');
}

/**
 * `details.issues` → `SaveIssue[]`。
 *
 * 容忍三种漂移：字符串数组（本仓库的现状）、`{path,message}` 对象数组、zod 的 `flatten()`
 * 形状（`{formErrors,fieldErrors}`）；都不是就退化成一行长文本（绝不吞掉原始信息）。
 */
export function normalizeIssues(value: unknown): SaveIssue[] {
  if (typeof value === 'string') return value === '' ? [] : [splitIssue(value)];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === 'string') return [splitIssue(entry)];
      const record = asRecord(entry);
      if (record === null) return [];
      const message = typeof record['message'] === 'string' ? record['message'] : JSON.stringify(entry);
      return [{ path: pathOf(record['path']), message }];
    });
  }

  const record = asRecord(value);
  if (record === null) return [];
  const issues: SaveIssue[] = [];
  const formErrors = record['formErrors'];
  if (Array.isArray(formErrors)) {
    for (const message of formErrors) issues.push({ path: null, message: String(message) });
  }
  const fieldErrors = asRecord(record['fieldErrors']);
  if (fieldErrors !== null) {
    for (const [key, messages] of Object.entries(fieldErrors)) {
      if (!Array.isArray(messages)) continue;
      for (const message of messages) issues.push({ path: key, message: String(message) });
    }
  }
  return issues.length === 0 ? [{ path: null, message: JSON.stringify(value) }] : issues;
}

/** 403/401 的「为什么不能写」：错误码都一样，只有这一层能说清下一步做什么。 */
const WRITE_ERROR_HINT: Record<string, string> = {
  forbidden: '写操作被拒：缺 X-Pi-Bot-CSRF 头，或服务端把面板写权限关了（PI_BOT_PANEL_WRITE=off）',
  unauthorized: '面板会话已过期：重新登录后再保存',
  'not-found': '这个仓库在 repos 表里不存在（装 App 或先在系统页添加）',
  'payload-too-large': '请求体过大：提示词正文上限 20000 字符',
};

function budgetOf(details: Record<string, unknown> | undefined): WriteFailure['budget'] {
  const raw = asRecord(details?.['budget']);
  if (raw === null) return null;
  const available = raw['available'];
  const requested = raw['requested'];
  if (typeof available !== 'number' || typeof requested !== 'number') return null;
  return { available, requested };
}

/** 任意写失败 → `{message, issues, budget}`（`action` 只进结论句，例如「保存失败」）。 */
export function describeWriteFailure(error: unknown, action: string): WriteFailure {
  if (error instanceof ApiError) {
    const hint = WRITE_ERROR_HINT[error.code];
    const head = `${action}失败（HTTP ${String(error.status)} ${error.code}）`;
    return {
      message: hint === undefined ? `${head}：${error.message}` : `${head}：${hint}`,
      issues: normalizeIssues(error.details?.['issues']),
      budget: budgetOf(error.details),
    };
  }
  if (error instanceof Error) return { message: `${action}失败：${error.message}`, issues: [], budget: null };
  return { message: `${action}失败：未知错误`, issues: [], budget: null };
}
