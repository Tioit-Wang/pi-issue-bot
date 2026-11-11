/**
 * 技能页的**共享纯函数**：来源文案、内置技能的排序、SKILL.md 文本的拼/拆、写操作错误 → 人话。
 *
 * 为什么单独一个文件：项目技能页（`routes/repo-skills.tsx`）与技能编辑器模态框
 * （`components/skills/skill-editor-modal.tsx`）都要「来源徽章」「保存失败提示」「内置技能排在前面」。
 * 各写一份的话，迟早会出现「列表说内置、弹窗说默认」这种同一事物的两种说法。
 *
 * 三条诚实约定：
 *  - 三个内置技能只按**名字**排序（不认 id：id 是运行时生成的，重装就变）；
 *  - SKILL.md 文本优先取服务端给的 `text`（若将来详情带上它），否则由
 *    `frontmatter + body` 重新拼出一份合法 YAML —— 拼装只为「可编辑」，不做展示渲染；
 *  - 写操作失败一律把服务端 `code` 翻成一句人话，不把 zod 报错糊到页面上。
 */
import { ApiError } from './api.ts';
import type { SkillDetail, SkillListItem, SkillSourceKind } from '../../../../packages/contract/src/index.ts';

/** 来源 → 徽章文案（内置 / 仓库文件 / 面板上传）。 */
export const SOURCE_LABEL: Record<SkillSourceKind, string> = {
  builtin: '内置',
  'repo-file': '仓库文件',
  upload: '面板上传',
};

/** 来源 → 徽章色调（只用设计系统的四档 tone，不自造颜色）。 */
export const SOURCE_TONE: Record<SkillSourceKind, 'neutral' | 'info' | 'success'> = {
  builtin: 'neutral',
  'repo-file': 'info',
  upload: 'success',
};

/**
 * 三个内置技能的固定顺序。
 *
 * 只按名字排：它们在 `/api/skills` 里可能出现在任意位置（列表默认按名字排序），
 * 而用户打开项目技能页最想先看到的是「引擎默认就有的那三个」。
 */
export const BUILTIN_SKILL_ORDER = ['/issue-format', '/label-triage', '/issue-analysis'] as const;

/** 名字是不是三个内置技能之一。 */
export function isBuiltinSkillName(name: string): boolean {
  return (BUILTIN_SKILL_ORDER as readonly string[]).includes(name);
}

/** 内置技能的名次（0/1/2）；不是内置技能 → 排在它们之后。 */
export function builtinRank(name: string): number {
  const index = (BUILTIN_SKILL_ORDER as readonly string[]).indexOf(name);
  return index === -1 ? BUILTIN_SKILL_ORDER.length : index;
}

/**
 * 项目技能页的排序：三个内置技能按固定顺序在最前，其余按名字；
 * 同名时先列本项目那份（它才是真正生效的那一份）。
 */
export function sortProjectSkills(items: readonly SkillListItem[]): SkillListItem[] {
  return [...items].sort((left, right) => {
    const byRank = builtinRank(left.name) - builtinRank(right.name);
    if (byRank !== 0) return byRank;
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) return byName;
    // 技能只属于项目，同名同项目不会有第二份；同名的内置技能排在本项目那份之后
    if (left.source === right.source) return 0;
    return left.source === 'builtin' ? 1 : -1;
  });
}

/* ── SKILL.md 文本 ────────────────────────────────────────────────────────── */

/** 服务端将来可能把整份 SKILL.md 原文放在详情里（`text`），带了就优先用它。 */
type DetailWithText = SkillDetail & { readonly text?: unknown };

/** 详情 → 可编辑的完整 SKILL.md（frontmatter + 正文）。 */
export function skillTextOf(detail: SkillDetail): string {
  const text = (detail as DetailWithText).text;
  if (typeof text === 'string' && text.trim() !== '') return text;
  return composeSkillText(detail.frontmatter, detail.body);
}

/** `frontmatter` + `body` → SKILL.md 文本（YAML 前端块 + 正文）。 */
export function composeSkillText(frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter).flatMap(([key, value]) => yamlEntryLines(key, value, 0));
  if (lines.length === 0) return body;
  const normalizedBody = body === '' || body.startsWith('\n') ? body : `\n${body}`;
  return `---\n${lines.join('\n')}\n---\n${normalizedBody}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 一个 `key: value` 条目（值可能是标量 / 数组 / 嵌套对象）。 */
function yamlEntryLines(key: string, value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    return [`${pad}${key}:`, ...value.flatMap((item) => yamlItemLines(item, indent + 2))];
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...entries.flatMap(([childKey, child]) => yamlEntryLines(childKey, child, indent + 2))];
  }
  return [`${pad}${key}: ${yamlScalar(value)}`];
}

/** 数组里的一项（对象用 `- key: value` 起飞，后续键缩进对齐）。 */
function yamlItemLines(item: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (isPlainRecord(item)) {
    const entries = Object.entries(item);
    if (entries.length === 0) return [`${pad}- {}`];
    return entries.flatMap(([key, value], index) => {
      const lines = yamlEntryLines(key, value, indent + 2);
      if (index !== 0) return lines;
      const first = lines[0] ?? '';
      return [`${pad}- ${first.trimStart()}`, ...lines.slice(1)];
    });
  }
  if (Array.isArray(item)) {
    // 契约里没有「数组套数组」；真遇到就内联成 JSON，宁可难看也不丢内容
    return [`${pad}- ${JSON.stringify(item)}`];
  }
  return [`${pad}- ${yamlScalar(item)}`];
}

/** 需要加引号的字符串：任意 YAML 特殊字符、首尾空白、纯数字、布尔/空值字面量。 */
const YAML_UNSAFE =
  /^\s|\s$|[:#[\]{}&*!|>'"%@`,?]|^[-?:]|^(?:true|false|null|yes|no|on|off|~)$|^[0-9]/iu;

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    if (value === '') return "''";
    if (/[\r\n]/u.test(value)) return JSON.stringify(value);
    return YAML_UNSAFE.test(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

/* ── 写操作错误 → 一句人话 ─────────────────────────────────────────────────── */

/**
 * 服务端 `code` → 一句话。
 *
 * 覆盖上传与保存两条写路径（spec §6 / §9 的错误码）；没列到的退回服务端 `message`，
 * 不编造原因。
 */
export const SKILL_WRITE_ERROR_HINT: Record<string, string> = {
  'bad-request': '服务端不接受这份内容：检查 frontmatter 是否完整、是否含不可见字符或超长正文',
  'payload-too-large': 'zip 超过 5 MB 上限',
  forbidden: '写操作被拒：缺 X-Pi-Bot-CSRF 头，或服务端 PI_BOT_PANEL_WRITE=off',
  conflict: '同名技能已存在于本项目（先删除，或改用另一个名字）',
  'not-found': '技能不存在（可能已被别人删掉）',
  SKILL_FRONTMATTER_INVALID:
    'frontmatter 不合规：name 必须以 / 开头、description 必须单行，allowed-tools / outputs 只能用契约里的值',
  SKILL_LIMIT: '技能数量已达上限：先删掉不用的技能再保存',
  SKILL_ZIP_INVALID: 'zip 里必须有且只有一个 SKILL.md（允许一层包裹目录）',
  SKILL_ZIP_UNSAFE: 'zip 内含不安全路径 / 符号链接 / 超体积条目，已拒绝',
  SKILL_NAME_CONFLICT: '同名技能已存在于本项目',
  SKILL_WRITE_DISABLED: '面板写操作已关闭（PI_BOT_PANEL_WRITE=off）',
};

/** `保存失败（HTTP 400 SKILL_FRONTMATTER_INVALID）：…` —— 状态码与错误码都留着，便于对照服务端日志。 */
export function describeSkillWriteError(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    const hint = SKILL_WRITE_ERROR_HINT[error.code];
    return `${action}失败（HTTP ${String(error.status)} ${error.code}）：${hint ?? error.message}`;
  }
  if (error instanceof Error) return `${action}失败：${error.message}`;
  return `${action}失败：未知错误`;
}
