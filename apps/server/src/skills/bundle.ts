/**
 * 技能包（zip 里的 `SKILL.md` 目录）—— **语义层**，结构解包在 `zip.ts`。
 *
 * 为什么分两层：`zip.ts` 只回答「这堆字节是不是一个安全的 zip」，`bundle.ts` 回答
 * 「它是不是**一个**技能」。混在一起会让 zip 的安全限额和技能的 frontmatter 校验互相
 * 纠缠——而它们的失败语义完全不同（`docs/spec/skill-management.md` §9）：
 *
 *  - **结构性坏输入抛 `ZipError`**（不是 zip、zip slip、超限额、校验和不符）：这些是
 *    「上传的东西根本不是我们能处理的文件」，HTTP 层映射成 `SKILL_ZIP_UNSAFE` /
 *    `SKILL_ZIP_INVALID`，**不入库**；
 *  - **技能内容问题一律进 `validation.errors`**（缺 `SKILL.md`、多个技能、frontmatter
 *    不合规、正文为空）：这些是「文件读得懂，但写错了」，需要一次性把人读原因全列给上传者，
 *    所以**不抛**。`ok=false` 的版本同样不入库（§5 `skill_versions.validation`）。
 *
 * 决策 D2（宽松入、规范存）落在这里：`name: review-pr` 会被补成 `/review-pr` 再校验，
 * 因为「正则只在入库那一刻严格、写文件的人不必记这个斜杠」比「让人对着错误码猜」有用。
 */
import { createHash } from 'node:crypto';

import { SKILL_NAME_RE } from '../../../../packages/contract/src/index.ts';
import { bestEffortName, normalizeSkillName, parseSkillFile, splitFrontmatter } from './frontmatter.ts';
import { canonicalSkillName } from './registry.ts';
import { readZipEntries } from './zip.ts';
import type { ZIP_LIMITS, ZipEntry } from './zip.ts';

/**
 * 结构性错误与错误码从这一层转出：调用方（`http/api/skills.ts`）只需要 import 一个模块就能
 * 「解包 + 分辨失败类型」，不用记「zip 错误的类在哪个文件」。
 */
export { ZipError } from './zip.ts';
export type { ZipErrorCode, ZipEntry } from './zip.ts';

/** 技能包的入口文件（行业形态：`<skill-name>/SKILL.md` + 可选附件，`skill-management.md` §2.1）。 */
export const SKILL_ENTRY_FILE = 'SKILL.md';

/** `files` 里的一项：只含**文本**文件（二进制被排除，理由见 `extractSkillBundle`）。 */
export type SkillBundleFile = { path: string; bytes: number; sha256: string; text: string };

/** 校验结果。形状与契约 `skillValidationSchema` 一致（各 ≤50 条、每条 ≤500 字符）。 */
export type SkillBundleValidation = { ok: boolean; errors: string[]; warnings: string[] };

export type SkillBundle = {
  /** 归一化命令名 `/xxx`；非法时用 bestEffortName 的结果，errors 里记录原因。 */
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** 只含文本文件（UTF-8 可解码且非二进制），按 path 字典序。 */
  files: SkillBundleFile[];
  treeSha256: string;
  validation: SkillBundleValidation;
  /** zip 内的技能根目录（'' = zip 根）。 */
  rootDir: string;
};

/** 打包工具/metadata 目录，统一忽略（`skill-management.md` R2）。 */
const IGNORED_TOP_DIRS = new Set(['__MACOSX']);
/** 打包工具/metadata 文件，统一忽略。 */
const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * 可执行脚本的扩展名。§8：「允许 `.sh/.py/.js` 作为**资源**存在，但不自动执行」——
 * 所以这里是 **warning 不是 error**：带脚本的合法技能（例如带一个辅助脚本）不该被拒，
 * 但上传者要被明确告知「它不会自动跑」。
 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.exe',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
]);

/** 附件数量提醒阈值（超了只 warn：技能能用，但要人看一眼是不是打错包了）。 */
const MAX_ATTACHMENTS = 50;
/** 与契约 `skillValidationSchema` 的上限对齐（errors/warnings 各 ≤50 条）。 */
const MAX_ISSUES = 50;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 解包 + 校验一个技能包 zip。
 *
 * @throws ZipError 结构性失败（透传自 `zip.ts`：不是 zip / zip slip / 超限额 / 校验和不符）。
 */
export function extractSkillBundle(
  buffer: Uint8Array,
  options: { limits?: Partial<typeof ZIP_LIMITS> } = {},
): SkillBundle {
  const entries = readZipEntries(buffer, options.limits ?? {}).filter(
    (entry) => !isIgnoredPath(entry.path),
  );

  const errors: string[] = [];
  const warnings: string[] = [];

  const { rootDir, skillEntry } = locateSkillRoot(entries, errors);

  // 收集技能根之下的文件：路径一律转成「相对技能根」，二进制不进 `files`。
  const files: SkillBundleFile[] = [];
  const attachmentPaths: string[] = [];
  for (const entry of entries) {
    const relative = toRelativePath(entry.path, rootDir);
    if (relative === null) {
      warnings.push(`忽略技能根之外的文件：${entry.path}`);
      continue;
    }
    if (relative !== SKILL_ENTRY_FILE) {
      attachmentPaths.push(relative);
    }
    const text = decodeText(entry.bytes);
    if (text === null) {
      warnings.push(`跳过二进制文件：${relative}`);
      continue;
    }
    // 决策 D2「宽松入、规范存」：**磁盘上的 SKILL.md 必须是规范名**。
    // 只在解析时补斜杠是不够的 —— 装配期（`worker-deps` 的 enricher）会重新 `parseSkillFile`
    // 磁盘上的文本，`name: demo` 在那里会被判 `skill-invalid`，技能静默不生效（实测于本次验收）。
    const stored = relative === SKILL_ENTRY_FILE ? withCanonicalName(text) : text;
    const storedBytes = new TextEncoder().encode(stored);
    files.push({ path: relative, bytes: storedBytes.byteLength, sha256: sha256Hex(storedBytes), text: stored });
  }
  files.sort((left, right) => comparePath(left.path, right.path));

  const parsed = readSkillEntry(skillEntry, rootDir, errors);

  // 附件相关的两条 warn（都只看路径，不看能否解码成文本）。
  for (const path of attachmentPaths) {
    if (isExecutablePath(path)) {
      warnings.push(`附件是可执行脚本（不会自动执行）：${path}`);
    }
  }
  if (attachmentPaths.length > MAX_ATTACHMENTS) {
    warnings.push(
      `附件数量超过上限：${attachmentPaths.length} > ${MAX_ATTACHMENTS}（技能仍可用，请确认没有多打包文件）`,
    );
  }

  const dedupedErrors = dedupe(errors);
  return {
    name: parsed.name,
    description: parsed.description,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    files,
    treeSha256: treeSha256Of(files),
    validation: {
      ok: dedupedErrors.length === 0,
      errors: dedupedErrors,
      warnings: dedupe(warnings),
    },
    rootDir,
  };
}

type LocatedRoot = { rootDir: string; skillEntry: ZipEntry | undefined };

/**
 * 定根（`skill-management.md` R2：「必须能找到 `<something>/SKILL.md`，允许一层包裹目录」）。
 *
 * 三种布局都认：
 *  - `SKILL.md` 在 zip 根 → `rootDir = ''`；
 *  - 恰好一个顶层目录里有 `SKILL.md` → `rootDir = 那个目录`；
 *  - 其余：0 个候选 → 「缺少 SKILL.md」；多个候选 → 「一个 zip 只能含一个技能」。
 *
 * 多个候选时仍挑第一个继续解析（而不是提前返回空壳）：上传者一次就能看到
 * 「你传了两个技能」+「第一个的 frontmatter 还有哪些问题」，不用改一次传一次。
 */
function locateSkillRoot(entries: readonly ZipEntry[], errors: string[]): LocatedRoot {
  const candidates: { dir: string; entry: ZipEntry }[] = [];
  const rootEntry = entries.find((entry) => entry.path === SKILL_ENTRY_FILE);
  if (rootEntry !== undefined) {
    candidates.push({ dir: '', entry: rootEntry });
  }
  for (const dir of topLevelDirs(entries)) {
    const entry = entries.find((candidate) => candidate.path === `${dir}/${SKILL_ENTRY_FILE}`);
    if (entry !== undefined) {
      candidates.push({ dir, entry });
    }
  }

  const first = candidates[0];
  if (candidates.length === 0) {
    errors.push(`缺少 ${SKILL_ENTRY_FILE}`);
    return { rootDir: '', skillEntry: undefined };
  }
  if (candidates.length > 1) {
    errors.push('一个 zip 只能含一个技能');
  }
  if (first === undefined) {
    return { rootDir: '', skillEntry: undefined };
  }
  return { rootDir: first.dir, skillEntry: first.entry };
}

type ParsedEntry = {
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

/**
 * 解析 `SKILL.md`：宽容化 `name`（D2）→ `parseSkillFile`（内部已做契约校验）→ 翻译错误。
 *
 * 顺带做两条 schema 管不到的校验：`description` 为空、正文为空。它们不是「格式错」而是
 * 「这份技能什么也没写」——注册表能加载它，但回复里会出现一条空描述的命令。
 */
function readSkillEntry(
  entry: ZipEntry | undefined,
  rootDir: string,
  errors: string[],
): ParsedEntry {
  if (entry === undefined) {
    // 缺 SKILL.md 已经由 `locateSkillRoot` 记录，这里只给一个可用的占位名。
    return { name: fallbackName('', rootDir), description: '', frontmatter: {}, body: '' };
  }

  const text = decodeText(entry.bytes);
  if (text === null) {
    errors.push(`${SKILL_ENTRY_FILE} 不是 UTF-8 文本（无法解析 frontmatter）`);
    return { name: fallbackName('', rootDir), description: '', frontmatter: {}, body: '' };
  }

  const split = splitFrontmatter(text);
  const looseBody = split.ok ? split.body.trim() : '';

  const parsed = parseSkillFile(withCanonicalName(text));
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      errors.push(describeFrontmatterIssue(issue));
    }
    return {
      name: fallbackName(text, rootDir),
      description: '',
      frontmatter: {},
      body: looseBody,
    };
  }

  const description = parsed.frontmatter.description;
  if (description.trim() === '') {
    errors.push('description 缺失或为空');
  }
  if (parsed.body === '') {
    errors.push('正文为空（frontmatter 之后必须有技能内容）');
  }
  return {
    name: parsed.name,
    description,
    frontmatter: { ...(parsed.frontmatter as unknown as Record<string, unknown>) },
    body: parsed.body,
  };
}

/**
 * 决策 D2「宽松入、规范存」：把 frontmatter 里的 `name` 先归一化成 `/xxx` 再交给契约校验。
 *
 * 只动 `name:` 那一行（不整份重写 YAML），因为重新序列化 YAML 会改变引号风格、
 * 丢掉注释，而这份文本随后还要进 `skill_versions` 的「谁传的什么」记录。
 */
function withCanonicalName(text: string): string {
  const split = splitFrontmatter(text);
  if (!split.ok) {
    return text;
  }
  let patched = false;
  const lines = split.yaml.split(/\r?\n/u).map((line) => {
    if (patched) {
      return line;
    }
    const match = /^(\s*name\s*:\s*)(.*)$/u.exec(line);
    if (match === null) {
      return line;
    }
    const prefix = match[1] ?? '';
    const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/gu, '');
    if (value === '') {
      return line;
    }
    patched = true;
    return `${prefix}${canonicalSkillName(normalizeSkillName(value))}`;
  });
  if (!patched) {
    return text;
  }
  return ['---', ...lines, '---', split.body].join('\n');
}

/**
 * 非法 frontmatter 的名字：先用 bestEffortName（面板要能显示「是哪个技能坏了」），
 * 再退回目录名（`my-skill/SKILL.md` 至少能定位到是哪个包）。
 */
function fallbackName(text: string, rootDir: string): string {
  const best = text === '' ? null : bestEffortName(text);
  if (best !== null && best !== '') {
    return canonicalSkillName(best);
  }
  return rootDir === '' ? '' : canonicalSkillName(rootDir);
}

/**
 * 把 `parseSkillFile` 的 issue（`path: message`）翻成人读中文。
 *
 * 为什么要翻而不是原样透传：zod 的英文消息会直接出现在面板的「校验失败」里
 * （`unrecognized_keys: Unrecognized key: "allowed-tool"`），对仓库维护者几乎不可读；
 * 而这里恰好知道每个字段**为什么**受限，能给出「要求是什么」而不只是「不对」。
 */
function describeFrontmatterIssue(issue: string): string {
  const text = issue.trim();
  const lower = text.toLowerCase();

  // 切分阶段（`splitFrontmatter`）的中文原因原样或轻微改写透传。
  if (text.includes('缺少 frontmatter')) {
    return '缺少 frontmatter（SKILL.md 第一行必须是 `---`）';
  }
  if (text.includes('结束分隔行')) {
    return 'frontmatter 没有结束分隔行 `---`';
  }
  if (text.includes('不是受支持的 YAML') || text.includes('必须是一个映射')) {
    return text;
  }

  // `.strict()` 的未知键（契约 §5.2 第 2 条：拼错的键静默忽略最危险）。
  if (lower.includes('unrecognized') || text.includes('未知键')) {
    const key = /"([^"]+)"/u.exec(text)?.[1] ?? '';
    return key === '' ? 'frontmatter 含未知键' : `frontmatter 含未知键：${key}`;
  }

  // 必填字段缺失：zod 对缺键报 `name: ... received undefined`。
  const missing = /^([a-z-]+)\s*:.*undefined/u.exec(lower);
  if (missing !== null) {
    return `frontmatter 缺少 ${missing[1] ?? ''}`;
  }

  const field = /^([a-z-]+)[.:]/u.exec(lower)?.[1] ?? '';
  switch (field) {
    case 'name':
      return /保留名/u.test(text)
        ? 'name 使用了保留名（/retry、/help、/skills 不可用）'
        : `name 不合规（要求 ${SKILL_NAME_RE}）`;
    case 'description':
      return 'description 不合规（10–1024 字符；多行会被折叠成单行）';
    case 'allowed-tools':
      return 'allowed-tools 不合规（非空，且只能是 Read/Write/Edit/Glob/Grep/Bash）';
    case 'outputs':
      return 'outputs 不合规（非空，且只能是 comment/labels/issue/pr）';
    case 'timeout':
      return 'timeout 不合规（<数字>s 或 <数字>m，例如 20m）';
    case 'model':
      return 'model 不合规（provider/model）';
    case 'inputs':
      return 'inputs 不合规（最多 8 项，每项 name/required 必填）';
    case 'requires-repo-config':
      return 'requires-repo-config 不合规（只接受字面量 true/false）';
    default:
      return `frontmatter 不合规：${text}`;
  }
}

/**
 * `treeSha256`：按 `path + '\0' + sha256 + '\n'` 排序串接后再 sha256（小写 hex）。
 *
 * 为什么要它：`skill_versions.tree_sha256` 是「这次上传的内容是否与上次相同」的唯一判据。
 * 用 `\0` 分隔路径与哈希、用 `\n` 分隔条目，是为了让「路径里含换行/制表符」这类恶意输入
 * 无法构造出与另一份内容相同的串（拼接歧义 = 哈希碰撞的可控版本）。
 */
function treeSha256Of(files: readonly SkillBundleFile[]): string {
  const sorted = [...files].sort((left, right) => comparePath(left.path, right.path));
  const payload = sorted.map((file) => `${file.path}\u0000${file.sha256}\n`).join('');
  return sha256Hex(new TextEncoder().encode(payload));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function comparePath(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.slice(0, 500)))].slice(0, MAX_ISSUES);
}

/** 二进制判定：含 NUL 字节，或 UTF-8 解码失败。 */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

function isIgnoredPath(path: string): boolean {
  const segments = path.split('/');
  const head = segments[0] ?? '';
  if (IGNORED_TOP_DIRS.has(head)) {
    return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return IGNORED_FILE_NAMES.has(base);
}

function topLevelDirs(entries: readonly ZipEntry[]): string[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    const index = entry.path.indexOf('/');
    if (index > 0) {
      dirs.add(entry.path.slice(0, index));
    }
  }
  return [...dirs].sort(comparePath);
}

/** 相对技能根的路径；不在技能根之下则返回 `null`。 */
function toRelativePath(path: string, rootDir: string): string | null {
  if (rootDir === '') {
    return path;
  }
  const prefix = `${rootDir}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  return path.slice(prefix.length);
}

function isExecutablePath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return false;
  }
  return EXECUTABLE_EXTENSIONS.has(base.slice(dot));
}
