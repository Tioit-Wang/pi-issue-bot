/**
 * 技能目录的**纯函数**（无 React、无请求）：文件树、可编辑判定、字节格式化。
 *
 * 为什么单独一个文件：模态框要「文件树 + 当前文件 + 字节数」，列表行要「有几个文件」，
 * 单测还要能不挂 DOM 就断言构建规则。树是**端上算**的（服务端只给 `path` + `text`，
 * 见 `GET /api/skills/:id/files`），所以排序与嵌套规则必须只有这一份。
 *
 * 三条约定：
 *  - 路径按 `/` 分段：段数 >1 就是目录，末段是文件名；没有任何「目录项」概念，
 *    空目录不会出现（服务端只回文件）；
 *  - 排序：**目录在前、文件在后**，同类按名字的 `localeCompare('en')`——大小写混排也不会跳；
 *  - 字节数按 UTF-8 编码算（`SKILL.md` 里中文很多，按 `text.length` 算会低估三倍）。
 */
import type { SkillFileText } from '../../../../packages/contract/src/index.ts';

/** 树里的一个文件（`path` 是相对技能根的完整路径）。 */
export type SkillTreeFileNode = {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  /** UTF-8 字节数（由 `text` 算出，不信任外部给的字节）。 */
  readonly bytes: number;
};

/** 树里的一个目录（`path` 是不带末尾斜杠的相对路径）。 */
export type SkillTreeDirNode = {
  readonly kind: 'dir';
  readonly name: string;
  readonly path: string;
  readonly children: SkillTreeNode[];
};

export type SkillTreeNode = SkillTreeDirNode | SkillTreeFileNode;

/** UTF-8 字节数：中文字符算 3 字节，所以不能用 `String.length`。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 可编辑扩展名 —— **与服务端 `apps/server/src/skills/files.ts::isEditableSkillPath` 一致**。
 *
 * 前端这一份只为「提前把非法目标变成只读并给一句说明」，真正的门禁在服务端（400 原文照样展示）。
 * 两边不一致的后果是「面板说能改、保存被拒」，所以改这里必须同时改那边。
 */
const EDITABLE_PATH_RE = /\.(md|markdown|txt|json|ya?ml|toml)$/iu;

export function isEditableSkillPath(path: string): boolean {
  return EDITABLE_PATH_RE.test(path);
}

/** `1536` → `1.5 KB`；`0` → `0 B`。非有限数返回 `—`（不编 0）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/u, '')} KB`;
  return `${(kb / 1024).toFixed(1).replace(/\.0$/u, '')} MB`;
}

/** 按名字排序：同名前缀（目录 `references` vs 文件 `references.md`）目录仍在前。 */
function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, 'en');
}

type MutableDir = {
  readonly name: string;
  readonly path: string;
  readonly dirs: Map<string, MutableDir>;
  readonly files: SkillTreeFileNode[];
};

function emptyDir(name: string, path: string): MutableDir {
  return { name, path, dirs: new Map(), files: [] };
}

/**
 * `SkillFileText[]` → 文件树（目录在前、字母序）。
 *
 * 边界处理得直接：空路径 / 只有斜杠 / 重复路径一律跳过（服务端不会给，但这里是纯函数，
 * 不能靠「调用方保证」）；`a//b.md` 的中间空段被忽略而不是变成一层空目录。
 */
export function buildSkillFileTree(files: readonly SkillFileText[]): SkillTreeNode[] {
  const root = emptyDir('', '');
  const seen = new Set<string>();

  for (const file of files) {
    const path = file.path.trim().replace(/^\/+/u, '');
    if (path === '' || seen.has(path)) continue;

    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
    const fileName = segments.at(-1);
    if (fileName === undefined) continue;
    seen.add(path);

    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      const child = dir.dirs.get(segment) ?? emptyDir(segment, dir.path === '' ? segment : `${dir.path}/${segment}`);
      dir.dirs.set(segment, child);
      dir = child;
    }
    dir.files.push({
      kind: 'file',
      name: fileName,
      path: segments.join('/'),
      bytes: utf8ByteLength(file.text),
    });
  }

  return toNodes(root);
}

function toNodes(dir: MutableDir): SkillTreeNode[] {
  const dirs = [...dir.dirs.values()]
    .sort(byName)
    .map<SkillTreeNode>((child) => ({ kind: 'dir', name: child.name, path: child.path, children: toNodes(child) }));
  const files = [...dir.files].sort(byName);
  return [...dirs, ...files];
}

/**
 * 打开模态框时默认选中哪个文件：`SKILL.md` 优先（技能的唯一入口），
 * 否则第一个**可编辑**文件，再否则第一个文件（让树不是「打开了但右边空白」）。
 */
export function defaultSkillFilePath(files: readonly SkillFileText[]): string | null {
  const paths = files.map((file) => file.path.trim().replace(/^\/+/u, '')).filter((path) => path !== '');
  if (paths.length === 0) return null;
  const entry = paths.find((path) => path === 'SKILL.md');
  if (entry !== undefined) return entry;
  const editable = [...paths].sort((left, right) => left.localeCompare(right, 'en')).find(isEditableSkillPath);
  return editable ?? paths[0] ?? null;
}
