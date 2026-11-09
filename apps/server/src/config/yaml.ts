/**
 * `.github/pi-bot.yml` 需要的 **受限 YAML 子集**解析器（B11）。
 *
 * 为什么自己写而不引 `yaml` / `js-yaml`：
 *  - dev-plan E9 规定本轮 lockfile 归 PM 独占，本 session 不得 `pnpm add`；这两个包只在
 *    pnpm store 里作为别的工具链的传递依赖存在，**没有链进 `apps/server/node_modules`**，
 *    直接 import 会在运行时 `ERR_MODULE_NOT_FOUND`。
 *  - 仓库配置的形状是**固定的**（`docs/spec/contract-api.md` + `packages/contract/src/repo-config.ts`）：
 *    嵌套映射、标量、字符串数组，没有锚点、多文档、tag、块标量。
 *
 * 因此这里只实现「够用且有明确边界」的子集，遇到不支持的写法**明确报错**（带行号），
 * 绝不猜语义——配置写坏时必须让 `config_valid=false` 并通知 owner（plan §10），
 * 而不是静默用默认值继续跑。
 *
 * 支持的语法：
 *  - 注释：整行 `#` 或行尾 ` #`（引号内不算）
 *  - 映射：`key: value`，用**空格**缩进嵌套（制表符明确报错）
 *  - 序列：`- item`；`- key: value` 形式的映射项
 *  - 标量：`true` / `false` / `null` / `~` / 整数 / 小数 / 裸字符串 / 单引号 / 双引号
 *  - 行内数组 `[a, b, "c"]`、空映射 `{}`、空值（`key:` 后无内容 → `null`）
 *
 * 不支持的：块标量（`|` / `>`）、锚点与别名、多文档 `---`、行内映射 `{a: 1}`、flow 嵌套。
 */

/** 解析失败（带 1-based 行号，直接进 `repos.config_error` 与 owner 通知）。 */
export class YamlSubsetError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`第 ${line} 行：${message}`);
    this.name = 'YamlSubsetError';
    this.line = line;
  }
}

export type YamlScalar = string | number | boolean | null;
export type YamlMap = { [key: string]: YamlValue };
export type YamlValue = YamlScalar | YamlValue[] | YamlMap;

/** 词法后的行：缩进（空格数）已归一化，注释已剥离。 */
type Line = {
  indent: number;
  content: string;
  number: number;
};

const TRUE_LITERALS = new Set(['true', 'True', 'TRUE']);
const FALSE_LITERALS = new Set(['false', 'False', 'FALSE']);
const NULL_LITERALS = new Set(['null', 'Null', 'NULL', '~']);
const NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

/**
 * 剥掉行尾注释。
 *
 * 只把「不在引号内、且前面是行首或空白」的 `#` 当注释起点：
 * 标签名里出现 `#` 是合法的（例如 `area/db#1`），不能一刀切。
 */
function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote !== null) {
      if (char === quote) {
        // 单引号里的 '' 是转义的单引号，跳过第二个
        if (quote === "'" && raw[index + 1] === "'") {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/u.test(raw[index - 1] ?? ''))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  const rawLines = openLines(text);
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? '';
    const number = index + 1;
    // 制表符缩进在 YAML 里非法。按 1 列算会静默解析出错误的层级，宁可报错。
    if (/^[\t ]*\t/u.test(raw)) {
      throw new YamlSubsetError('缩进不能用制表符（只能用空格）', number);
    }
    if (/^(---|\.\.\.)\s*$/u.test(raw)) {
      throw new YamlSubsetError('不支持多文档（--- / ...）', number);
    }
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') {
      continue;
    }
    const trimmedStart = withoutComment.trimStart();
    const indent = withoutComment.length - trimmedStart.length;
    lines.push({ indent, content: trimmedStart.trimEnd(), number });
  }
  return lines;
}

function openLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

/** 该行看起来是不是 `key: ...`（键后面是 `:` 且下一个字符是空白或行尾）。 */
function isMappingLine(content: string): boolean {
  return splitKeyValue(content, 0).ok;
}

type KeySplit =
  | { readonly ok: true; readonly key: string; readonly rest: string }
  | { readonly ok: false };

function splitKeyValue(content: string, lineNumber: number): KeySplit {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== ':') {
      continue;
    }
    const next = content[index + 1];
    if (next !== undefined && !/\s/u.test(next)) {
      // `a:b` 不是键值对（例如 URL），继续找
      continue;
    }
    const rawKey = content.slice(0, index).trim();
    if (rawKey === '') {
      if (lineNumber !== 0) {
        throw new YamlSubsetError('缺少键名', lineNumber);
      }
      return { ok: false };
    }
    const key = unquoteKey(rawKey, lineNumber);
    return { ok: true, key, rest: content.slice(index + 1).trim() };
  }
  return { ok: false };
}

function unquoteKey(raw: string, lineNumber: number): string {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const value = parseQuoted(raw, lineNumber);
    if (typeof value !== 'string') {
      throw new YamlSubsetError('键必须是字符串', lineNumber);
    }
    return value;
  }
  return raw;
}

function parseQuoted(raw: string, lineNumber: number): YamlScalar {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as YamlScalar;
    } catch {
      throw new YamlSubsetError(`双引号字符串没有正确闭合：${raw}`, lineNumber);
    }
  }
  if (!raw.endsWith("'")) {
    throw new YamlSubsetError(`单引号字符串没有正确闭合：${raw}`, lineNumber);
  }
  return raw.slice(1, -1).replace(/''/gu, "'");
}

function splitInlineArray(inner: string, lineNumber: number): string[] {
  const items: string[] = [];
  let quote: '"' | "'" | null = null;
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? '';
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    throw new YamlSubsetError('行内数组里有未闭合的引号', lineNumber);
  }
  const tail = current.trim();
  if (tail !== '') {
    items.push(tail);
  }
  return items;
}

function parseScalar(raw: string, lineNumber: number): YamlValue {
  const text = raw.trim();
  if (text === '') {
    return null;
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    return parseQuoted(text, lineNumber);
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) {
      throw new YamlSubsetError(`行内数组没有闭合：${text}`, lineNumber);
    }
    const inner = text.slice(1, -1).trim();
    if (inner === '') {
      return [];
    }
    return splitInlineArray(inner, lineNumber).map((item) => parseScalar(item, lineNumber));
  }
  if (text.startsWith('{')) {
    // 只支持空映射；非空的内联映射（flow mapping）本子集不实现，明确报错
    if (text === '{}') {
      return {};
    }
    throw new YamlSubsetError('不支持行内映射，请改成缩进写法', lineNumber);
  }
  if (text === '|' || text === '>' || text.startsWith('|') || text.startsWith('>')) {
    throw new YamlSubsetError('不支持块标量（| / >）', lineNumber);
  }
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('!')) {
    throw new YamlSubsetError('不支持锚点 / 别名 / tag', lineNumber);
  }
  if (TRUE_LITERALS.has(text)) {
    return true;
  }
  if (FALSE_LITERALS.has(text)) {
    return false;
  }
  if (NULL_LITERALS.has(text)) {
    return null;
  }
  if (NUMBER_PATTERN.test(text)) {
    return Number(text);
  }
  return text;
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new YamlSubsetError('序列项的缩进比同级项深', line.number);
    }
    if (!line.content.startsWith('-')) {
      break;
    }
    const rest = line.content.slice(1).trim();
    if (rest === '') {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= indent) {
        items.push(null);
        index += 1;
        continue;
      }
      const [nested, nextIndex] = parseBlock(lines, index + 1, next.indent);
      items.push(nested);
      index = nextIndex;
      continue;
    }
    const restLine: Line = { indent: indent + 2, content: rest, number: line.number };
    lines[index] = restLine;
    if (isMappingLine(rest)) {
      // `- key: value` 后可能还有同级的键（缩进 = 该项缩进 + 2）
      const [nested, nextIndex] = parseMapping(lines, index, indent + 2);
      items.push(nested);
      index = nextIndex;
      continue;
    }
    items.push(parseScalar(rest, line.number));
    index += 1;
    const after = lines[index];
    if (after !== undefined && after.indent > indent) {
      throw new YamlSubsetError('标量序列项后面出现了更深缩进的行', after.number);
    }
  }
  return [items, index];
}

function parseMapping(lines: Line[], start: number, indent: number): [YamlMap, number] {
  const map: YamlMap = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new YamlSubsetError('缩进与同级键不一致', line.number);
    }
    if (line.content.startsWith('-') && line.content !== '-') {
      break;
    }
    const split = splitKeyValue(line.content, line.number);
    if (!split.ok) {
      throw new YamlSubsetError(`期望 \`键: 值\`，收到 ${line.content}`, line.number);
    }
    if (Object.hasOwn(map, split.key)) {
      throw new YamlSubsetError(`重复的键「${split.key}」`, line.number);
    }
    if (split.rest === '') {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= indent) {
        map[split.key] = null;
        index += 1;
        continue;
      }
      const [nested, nextIndex] = parseBlock(lines, index + 1, next.indent);
      map[split.key] = nested;
      index = nextIndex;
      continue;
    }
    map[split.key] = parseScalar(split.rest, line.number);
    index += 1;
    const after = lines[index];
    if (after !== undefined && after.indent > indent) {
      throw new YamlSubsetError('「键: 值」后面出现了更深缩进的行（值后不能挂子节点）', after.number);
    }
  }
  return [map, index];
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start];
  if (first === undefined) {
    return [null, start];
  }
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

/**
 * 解析入口。空文档返回 `{}`（与 YAML 的「空文档 = null」不同：仓库配置缺失字段时
 * 由 zod 的默认值兜底，所以给 `{}` 比给 `null` 更好用）。
 */
export function parseYamlSubset(text: string): YamlValue {
  const lines = tokenize(text);
  if (lines.length === 0) {
    return {};
  }
  const first = lines[0] as Line;
  const [value, consumed] = parseBlock(lines, 0, first.indent);
  const leftover = lines[consumed];
  if (leftover !== undefined) {
    throw new YamlSubsetError('缩进不一致（多余的行无法归入任何块）', leftover.number);
  }
  return value;
}
