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

/**
 * 技能内相对路径的**唯一**规则（`SKILL.md`、`references/api.md`、`说明.md`）。
 *
 * 为什么必须合成一处：`zip.ts` 与 `files.ts` 曾经各有一套 —— zip 只挡控制字符/`..`/绝对路径，
 * 允许中文、空格、长文件名；`files.ts` 另有一条 `[A-Za-z0-9._-]` 的段正则。结果是一条
 * 上传成功的技能（附件叫 `参考 文档.md`）在面板里改任何一个字都会 400「非法文件路径」，
 * 而报错点名的是他**没动过的文件**。
 *
 * 现在的口径：只要不是「逃逸路径」就允许（安全靠 `..` / 绝对路径 / 盘符 / 控制字符这几条挡），
 * 长度按 `skillFileMetaSchema.path` 的 300 上限。中文与空格是正常文件名，不是攻击面。
 */
const MAX_SKILL_FILE_PATH = 300;
/** 单段长度上限（NTFS 单段 255，留出余量；同时防「一个文件名塞爆 UI」）。 */
const MAX_SEGMENT = 120;

const sha256Hex = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');

export type SkillFileTextInput = { path: string; text: string };

export type SkillPathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 校验并规范化一个技能内相对路径。**不抛异常**（调用方决定 400 还是记 warning）。
 *
 * 与 `normalizeEntryPath` 的关系：那个是 zip 侧的严格版（越界直接抛 `ZipError`），
 * 这个给「手输路径 / 重建整包」用；两者接受同一批字符，差别只在错误表达方式。
 */
export function checkSkillPath(raw: string): SkillPathCheck {
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return { ok: false, reason: '路径含控制字符' };
    }
  }
  const slashed = raw.trim().replace(/\\/gu, '/');
  if (slashed === '') return { ok: false, reason: '路径为空' };
  if (slashed.length > MAX_SKILL_FILE_PATH) {
    return { ok: false, reason: `路径超过 ${String(MAX_SKILL_FILE_PATH)} 字符` };
  }
  if (slashed.startsWith('/') || /^[A-Za-z]:/u.test(slashed)) {
    return { ok: false, reason: '不接受绝对路径' };
  }
  const kept: string[] = [];
  const segments = slashed.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (segment === '') {
      if (index === segments.length - 1) continue; // 末尾目录斜杠
      return { ok: false, reason: '路径含空段' };
    }
    if (segment === '.') continue;
    if (segment === '..') return { ok: false, reason: '路径含 `..` 段' };
    if (segment.length > MAX_SEGMENT) {
      return { ok: false, reason: `单段超过 ${String(MAX_SEGMENT)} 字符` };
    }
    kept.push(segment);
  }
  if (kept.length === 0) return { ok: false, reason: '路径为空' };
  return { ok: true, path: kept.join('/') };
}

/** 兼容旧调用点：返回规范化路径，非法给 `null`（等价于 `checkSkillPath` 的 `ok:false`）。 */
export function normalizeSkillFilePath(raw: string): string | null {
  const checked = checkSkillPath(raw);
  return checked.ok ? checked.path : null;
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
    // 用 `checkSkillPath`（与 `zip.ts` 同一批字符规则）：以前这里是一条 `[A-Za-z0-9._-]` 段正则，
    // 于是「zip 能上传、面板改一个字就 400」—— 而且 400 点名的是他没动过的中文附件。
    const checked = checkSkillPath(file.path);
    if (!checked.ok) {
      errors.push(`非法文件路径（${checked.reason}）：${String(file.path).slice(0, 120)}`);
      continue;
    }
    const path = checked.path;
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
      if (text === null) {
        // 二进制附件不进包：必须出声，否则「导入后图标没了」永远查不出来（单包路径也是这么做的）。
        warnings.push(`跳过二进制文件：${relative}`);
        continue;
      }
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
