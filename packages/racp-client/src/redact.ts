/**
 * 值级脱敏（tech-plan §10.2 的「敏感前缀」那一条，最小实现）。
 *
 * 为什么本包自己有一份：`@pi-issue-bot/shared` 的 logger + redaction 还是骨架（空导出），
 * 而 `RacpError` 是全包唯一的错误出口 —— 令牌一旦借错误消息进了日志，就是 plan §10
 * 「日志不得出现密钥」的破口。所以先在唯一出口处做一次兜底：
 * `RacpError` 构造时对本模块过一遍（见 `errors.ts`），本包任何错误都漏不出 `pdt1.` / `ppt1.`。
 *
 * **权威实现在 `@pi-issue-bot/shared`**（tech-plan §10.2 规定由 logger 统一做，含
 * `authorization` / `token` 等字段路径的 `redact` 配置）。这里只覆盖「值级」那一半，
 * 且只覆盖 RACP 客户端真能见到的凭证类型；shared 落地后本模块删除、改为 import。
 * TODO(owner: 后端控制面 / shared)：把 `redactSecrets` 挪进 shared 并让本包引用。
 */

/**
 * 前缀式令牌（tech-plan §10.2 列表）。
 *
 * 为什么按「前缀 + 连续 token 字符」匹配而不是「前缀 + 任意字符」：`pdt1.` 后面紧跟的
 * 一定是令牌体，吞到第一个非 token 字符为止，避免把整句话一起删掉（过宽会让人看不出
 * 错误到底是什么）。反过来，宁可多吞一点 —— 过窄漏一个字符就等于没脱敏。
 */
const TOKEN_PREFIXES = [
  'pdt1.',
  'ppt1.',
  'ghs_',
  'ghu_',
  'ghp_',
  'gho_',
  'ghr_',
  'github_pat_',
] as const;

/** `[A-Za-z0-9]` 之后允许 `-` `_` `.` `~` `+` `/` `=`（base64url 与 JWT 段都会出现）。 */
const TOKEN_BODY = '[A-Za-z0-9_\\-.~+/=]+';

const REDACTED = '<redacted>';

const PATTERNS: readonly RegExp[] = [
  ...TOKEN_PREFIXES.map((prefix) => new RegExp(`${escapeRegExp(prefix)}${TOKEN_BODY}`, 'g')),
  // App JWT：三段式。不能裸匹配 `eyJ`（那是几乎所有 JWT 的 base64 头），
  // 所以要求三段都够长（tech-plan §10.2 明确写了这条理由）。
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // PEM 私钥块：从头吞到尾，避免只脱敏第一行而把密钥体留在日志里。
  /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 字符串里的令牌 → `<redacted>`。非字符串原样返回（`String(x)` 的语义不在这里）。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * 深拷贝式脱敏：只动字符串，结构与类型不变。
 *
 * 用 JSON 往返会改动 `Date` / `undefined` / `Map` 的语义，所以手写递归；
 * 循环引用直接返回 `'[circular]'` 而不是抛 —— 脱敏是兜底路径，它自己不能成为新的失败点。
 */
export function redactValue<T>(value: T, depth = 0): T {
  return redactInner(value, depth, new Set()) as T;
}

function redactInner(value: unknown, depth: number, seen: Set<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  // 深度上限：`error.details` 理论上是我们自己造的小对象，防的是调用方塞了任意结构。
  if (value === null || typeof value !== 'object' || depth >= 8) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactInner(item, depth + 1, seen));
    }
    if (value instanceof Error) {
      return { name: value.name, message: redactSecrets(value.message) };
    }
    if (value instanceof Date || value instanceof RegExp || value instanceof URL) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[redactSecrets(key)] = redactInner(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** 给人看的短摘要：`JSON.stringify` + 脱敏 + 截断（错误 `details` 里常用）。 */
export function previewRedacted(value: unknown, maxLength = 400): string {
  let text: string;
  try {
    text = JSON.stringify(redactValue(value)) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
