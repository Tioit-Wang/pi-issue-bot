/**
 * 技能目录的**按文件**操作（面板模态框编辑用）。
 *
 * 为什么要这一层：既有 `bundle.ts` 只认「一个 zip = 一个技能包」，而面板要能
 *  1) 列出技能目录里的每个文件（树形显示）；
 *  2) 单独修改其中任意一个 markdown 文件并保存成新版本；
 *  3) 一个 zip 里含多个技能目录（`a/SKILL.md`、`b/SKILL.md`）时批量导入。
 *
 * 三者都归约到同一个原语：`bundleFromFiles(files)` —— 用「文件文本列表」重建
 * 一个 `SkillBundle`，再交给 `store.upload` 走既有落库/校验/审计路径，
 * 不另开一套写库逻辑。
 *
 * 依赖方向：只依赖 `node:crypto` + 同目录的 `frontmatter.ts` / `bundle.ts` / `zip.ts`，
 * 不碰 db / http（校验与写库的边界仍在 store）。
 */
import { createHash } from 'node:crypto';
import { SKILL_ENTRY_FILE, type SkillBundle, type SkillBundleFile } from './bundle.ts';
import { normalizeSkillName, parseSkillFile } from './frontmatter.ts';
import { readZipEntries, type ZipEntry } from './zip.ts';

/** 与 `skillFileMetaSchema` 的上限对齐。 */
const MAX_FILES = 200;
const MAX_TEXT_BYTES = 5_000_000;
/** 单个 zip 里允许的技能目录数（防「一次打包整个仓库」）。 */
const MAX_BUNDLES_PER_ZIP = 50;

const sha256Hex = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');

/** 路径段：不允许空段、`.`、`..`、绝对路径与反斜杠（zip slip 在 zip.ts 已挡，这里挡手输路径）。 */
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,80}$/u;

export type SkillFileTextInput = { path: string; text: string };

/**
 * 规范化并校验一个技能内相对路径（`SKILL.md`、`references/API.md`）。
 * 返回 `null` 表示非法，调用方转 400。
 */
export function normalizeSkillFilePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/gu, '/');
  if (trimmed === '' || trimmed.length > 300 || trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT_RE.test(segment))) {
    return null;
  }
  return segments.join('/');
}

/** 面板编辑器只渲染/编辑 markdown 与纯文本；二进制一律不可见不可改。 */
export function isEditableSkillPath(path: string): boolean {
  return /\.(md|markdown|txt|json|ya?ml|toml)$/iu.test(path);
}

/**
 * 用「文件文本列表」重建技能包。
 *
 * - 根必须有 `SKILL.md`，否则 `validation.ok=false`；
 * - `name` 归一成 `/xxx`（存储口径，见 `contract-skill.md` D2）；
 * - `treeSha256` 按「路径 + 内容」字典序算，与 store 的 `treeHashOf` 语义一致；
 * - 永不抛异常：非法输入走 `validation.errors`，由调用方决定 400 还是落库。
 */
export function bundleFromFiles(files: readonly SkillFileTextInput[], warnings: string[] = []): SkillBundle {
  const errors: string[] = [];
  const normalized: SkillBundleFile[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const path = normalizeSkillFilePath(file.path);
    if (path === null) {
      errors.push(`非法文件路径：${String(file.path).slice(0, 120)}`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`文件路径重复：${path}`);
      continue;
    }
    seen.add(path);
    const bytes = Buffer.byteLength(file.text, 'utf8');
    if (bytes > MAX_TEXT_BYTES) {
      errors.push(`文件过大：${path}（${String(bytes)} 字节）`);
      continue;
    }
    normalized.push({ path, bytes, sha256: sha256Hex(file.text), text: file.text });
  }

  if (normalized.length > MAX_FILES) {
    errors.push(`文件数量超过上限：${String(normalized.length)} > ${String(MAX_FILES)}`);
  }
  normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const entry = normalized.find((file) => file.path === SKILL_ENTRY_FILE);
  const parsed = entry === undefined ? null : parseSkillFile(entry.text);
  if (entry === undefined) {
    errors.push(`缺少入口文件 ${SKILL_ENTRY_FILE}`);
  } else if (parsed !== null && !parsed.ok) {
    errors.push(`SKILL.md frontmatter 非法：${parsed.detail}`);
  }

  const frontmatter =
    parsed !== null && parsed.ok ? (parsed.frontmatter as Record<string, unknown>) : {};
  const rawName = typeof frontmatter['name'] === 'string' ? (frontmatter['name'] as string) : '';
  // 存储名一律带前导 `/`（`SKILL_NAME_RE` 的口径）；`normalizeSkillName` 只做小写归一，
  // 不补斜杠 —— 少了这一步 `store.upload` 会判 `invalid-skill`（与 `defaults.ts` 同一个坑）。
  const normalizedName = normalizeSkillName(rawName).replace(/^\//u, '');
  const name = normalizedName === '' ? '/invalid-skill' : `/${normalizedName}`;
  const description =
    typeof frontmatter['description'] === 'string' ? (frontmatter['description'] as string) : '';

  // 与 `bundle.ts::treeSha256Of` / `store.ts::treeHashOf` **同一个算法**：
  // `${path}\u0000${sha256}\n` 按路径排序拼接再哈希。口径不一致会让「PUT 落库的 tree_sha256」
  // 与「上传路径算出的」对不上（子代理实测两值不同），所以这里照抄格式而不是另定。
  const treeSha256 = sha256Hex(
    normalized.map((file) => `${file.path}\u0000${file.sha256}\n`).join(''),
  );

  return {
    name,
    description: description.slice(0, 1024),
    frontmatter,
    body: parsed !== null && parsed.ok ? parsed.body : '',
    files: normalized,
    treeSha256,
    validation: { ok: errors.length === 0, errors: errors.slice(0, 50), warnings: warnings.slice(0, 50) },
    rootDir: '',
  };
}

/** 在现有文件列表上「写入/替换一个文件」，返回新列表（不改入参）。 */
export function replaceFileIn(
  files: readonly SkillFileTextInput[],
  path: string,
  text: string,
): SkillFileTextInput[] {
  const next = files.filter((file) => file.path !== path);
  next.push({ path, text });
  return next;
}

export type ZipBundleSplit = {
  /** 每个含 `SKILL.md` 的目录一个包；目录前缀不进包内路径。 */
  bundles: SkillBundle[];
  /** 结构性错误（例如 zip 里一个 `SKILL.md` 都没有）。 */
  errors: string[];
};

/** 一个 zip 条目集合里的 `SKILL.md` 所在目录（`'a/b/SKILL.md'` → `'a/b'`）。 */
function rootOfEntry(path: string): string | null {
  const match = /^(?:(.*)\/)?SKILL\.md$/u.exec(path);
  return match === null ? null : (match[1] ?? '');
}

/**
 * 拆一个 zip 为多个技能包（要求 4「上传 zip 自动解析并新增技能」）。
 *
 * 分组规则：以 `SKILL.md` 所在目录为技能根；根之外的条目（例如 zip 根下的 README）
 * 归到根为 `''` 的那个包，没有则丢弃并记 warning。
 */
export function splitZipBundles(buffer: Uint8Array): ZipBundleSplit {
  const entries = readZipEntries(buffer).filter((entry) => entry.path !== '' && !isIgnored(entry.path));
  // 技能根 = 含 SKILL.md 的目录。条目按**最深匹配**归组：
  // `a/SKILL.md` + `a/b/SKILL.md` 同时存在时，`a/b/x.md` 归 `a/b`，`a/x.md` 归 `a`；
  // 根为 `''` 的扁平包天然匹配所有条目，因为排序把更长的根排在前面。
  const roots = new Set<string>();
  for (const entry of entries) {
    const root = rootOfEntry(entry.path);
    if (root !== null) roots.add(root);
  }
  const sortedRoots = [...roots].sort((left, right) => right.length - left.length);
  const groups = new Map<string, ZipEntry[]>(sortedRoots.map((root) => [root, []]));
  const loose: ZipEntry[] = [];

  for (const entry of entries) {
    const owner = sortedRoots.find((root) => root === '' || entry.path.startsWith(`${root}/`));
    if (owner === undefined) {
      loose.push(entry);
      continue;
    }
    groups.get(owner)?.push(entry);
  }

  if (groups.size === 0) {
    return { bundles: [], errors: [`zip 里找不到 ${SKILL_ENTRY_FILE}（每个技能必须是一个含 SKILL.md 的目录）`] };
  }
  if (groups.size > MAX_BUNDLES_PER_ZIP) {
    return { bundles: [], errors: [`一个 zip 里最多 ${String(MAX_BUNDLES_PER_ZIP)} 个技能`] };
  }

  const warnings: string[] = [];
  if (loose.length > 0 && !groups.has('')) {
    warnings.push(`忽略技能目录之外的文件：${loose.map((entry) => entry.path).slice(0, 5).join('、')}`);
  }

  const bundles: SkillBundle[] = [];
  for (const [root, group] of groups) {
    // 组内条目转成「相对技能根」；解码失败的（二进制）跳过并记 warning。
    const files: SkillFileTextInput[] = [];
    for (const entry of group) {
      const relative = root === '' ? entry.path : entry.path.slice(root.length + 1);
      const text = decodeUtf8(entry.bytes);
      if (text === null) continue;
      files.push({ path: relative, text });
    }
    bundles.push(bundleFromFiles(files, warnings));
  }
  bundles.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { bundles, errors: [] };
}

function isIgnored(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return path.startsWith('__MACOSX/') || base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini';
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}
