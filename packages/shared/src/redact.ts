/**
 * 值级脱敏（tech-plan §10.2）。
 *
 * 为什么需要「值级」这一道：pino 的 `redact` 只按字段路径匹配（`authorization`、`token`…），
 * 但令牌经常以「字符串里的一部分」出现——拼在 URL、错误消息、git remote、argv 里。
 * plan §10 要求「日志不得出现密钥」，只有对**字符串内容**做前缀/形状匹配才能机械保证。
 *
 * 覆盖范围（与 tech-plan §10.2 一一对应）：
 * - 设备/配对令牌：`pdt1.` / `ppt1.`
 * - GitHub 令牌：`ghs_` / `ghu_` / `ghp_` / `gho_` / `ghr_` / `github_pat_`
 * - App JWT：三段式 `eyJ….….…`（不能裸匹配 `eyJ`，它会匹配到绝大多数 JWT 头，误伤正常数据）
 * - PEM 私钥块：`-----BEGIN … PRIVATE KEY-----` 到 `-----END … PRIVATE KEY-----`（整块吞掉，
 *   不能只替换第一行，否则密钥体留在日志里）
 */

/** 脱敏后统一替换成这个标记，便于在日志里 grep「有没有漏」。 */
export const REDACTED = '<redacted>';

/** 逐段替换的前缀令牌。顺序无关，长的在前只是让正则更易读。 */
export const SECRET_PREFIXES = [
  'github_pat_',
  'pdt1.',
  'ppt1.',
  'ghs_',
  'ghu_',
  'ghp_',
  'gho_',
  'ghr_',
] as const;

/**
 * 前缀令牌的字符集：直到空白或常见的分隔符为止。
 * 不用 `\S*`（会把后面的标点一起吞掉，日志可读性变差），也不用 `\w*`（base64url 里有 `-`/`_`）。
 */
const PREFIX_TOKEN_RE = new RegExp(`(?:${SECRET_PREFIXES.map(escapeRegExp).join('|')})[A-Za-z0-9._~+/=-]*`, 'g');

/** JWT：三段式。第二、三段要求至少 8 字符，避免误伤 `eyJhbGci.abc` 这类非令牌文本。 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** PEM 私钥块（含 RSA / EC / OPENSSH / 通用形式）。 */
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 对单个字符串做值级脱敏。幂等：已经 `<redacted>` 的文本再跑一遍不变。 */
export function redactSecrets(text: string): string {
  return text.replace(PEM_RE, REDACTED).replace(JWT_RE, REDACTED).replace(PREFIX_TOKEN_RE, REDACTED);
}

/** 递归脱敏任意值。只处理字符串键值、数组与 `Error`，其余原样返回。 */
export function redactValue<T>(value: T, depth = 0): T {
  if (typeof value === 'string') {
    return redactSecrets(value) as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // 防循环引用把日志写挂：超过 6 层就不再往下钻。
  if (depth > 6) {
    return value;
  }
  if (value instanceof Error) {
    const copy = {
      name: value.name,
      message: redactSecrets(value.message),
      stack: value.stack === undefined ? undefined : redactSecrets(value.stack),
    } as unknown as T;
    return copy;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1)) as unknown as T;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    out[key] = redactValue(item, depth + 1);
  }
  return out as unknown as T;
}

/** 简短预览：给日志/错误用，超长截断（不泄露全文，也不撑爆日志）。 */
export function previewRedacted(text: string, limit = 200): string {
  const clean = redactSecrets(text);
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…(${clean.length} chars)`;
}
