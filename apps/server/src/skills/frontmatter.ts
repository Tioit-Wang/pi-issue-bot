/**
 * 技能文件的 **frontmatter 解析 + 校验**（契约 §2 / §4.2 的「加载期」）。
 *
 * 三步，任何一步失败都给出人读原因（不静默忽略——契约 §3 最后一行要求「被禁用的技能仍要在面板可见」）：
 *  1. 切分：首个 `---` 与第二个 `---` 之间是 YAML，之后是正文。
 *  2. 解析：复用 `.github/pi-bot.yml` 那个**受限 YAML 子集**解析器（`config/yaml.ts`）。
 *     为什么复用而不是引 `yaml` 包：本 session 不得改 lockfile（dev-plan E13.2 / E9），而
 *     仓库配置与技能 frontmatter 需要的语法完全同一套（标量、行内数组、缩进映射）。
 *     副作用是有意的好事：块标量（`description: |`）在解析阶段就被拒（契约 §5.3 第 1 条）。
 *  3. 校验：`skillFrontmatterSchema`（`.strict()`）。未知键、枚举外工具、保留名、
 *     超时格式非法全部在这一步被拒——这里**不做任何截断或兜底**，截断只发生在
 *     `effectiveSkillTimeout()`（合法但超 `30m` 的那一种，契约 §3）。
 */
import { skillFrontmatterSchema } from '../../../../packages/contract/src/index.ts';
import type { SkillFrontmatter } from '../../../../packages/contract/src/index.ts';
import { YamlSubsetError, parseYamlSubset } from '../config/yaml.ts';

/** frontmatter 分隔行。 */
export const FRONTMATTER_FENCE = '---';

/** 切分结果。失败时 `detail` 直接进日志与面板的 `disabledReason` 说明。 */
export type FrontmatterSplit =
  | { readonly ok: true; readonly yaml: string; readonly body: string }
  | { readonly ok: false; readonly detail: string };

/** 解析结果。`name` 尽力而为：即使 frontmatter 非法，也尽量给出归一化名，让面板能显示这一行。 */
export type ParsedSkillFile =
  | {
      readonly ok: true;
      readonly frontmatter: SkillFrontmatter;
      readonly body: string;
      /** 归一化名（小写）。 */
      readonly name: string;
    }
  | {
      readonly ok: false;
      readonly detail: string;
      readonly name: string | null;
      readonly issues: readonly string[];
    };

const isFence = (line: string): boolean => {
  const trimmed = line.trimEnd();
  return trimmed === FRONTMATTER_FENCE || trimmed === '...';
};

/**
 * 切分 frontmatter 与正文。
 *
 * 宽容的两处（都是「写文件的人不该被格式细节坑」）：
 *  - 允许文件开头有 BOM 与空行；
 *  - 结束分隔行允许是 `...`（YAML 的文档结束符）。
 * 刻意不宽容的一处：**结束分隔行必须是独立的整行**（`--- x` 不算），否则正文里的一条
 * 水平线会把 frontmatter 提前截断，而截断后的结果看起来「解析成功了」——这比报错危险。
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const body = text.replace(/^\uFEFF/u, '');
  const lines = body.split(/\r?\n/u);
  let cursor = 0;
  while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') {
    cursor += 1;
  }
  const first = lines[cursor];
  if (first === undefined || first.trimEnd() !== FRONTMATTER_FENCE) {
    return { ok: false, detail: '文件第一行必须是 `---`（缺少 frontmatter）' };
  }
  const start = cursor;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isFence(lines[index] ?? '')) {
      return {
        ok: true,
        yaml: lines.slice(start + 1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
      };
    }
  }
  return { ok: false, detail: 'frontmatter 没有结束分隔行 `---`' };
}

/** 归一化命令名：小写（契约 §2 表 `name` 行：匹配大小写不敏感，存储与展示归一化为小写）。 */
/**
 * 归一化命令名：小写 + **补前导 `/`**。
 *
 * 只做小写是不够的：Agent Skills 标准写 `name: issue-format`，而本仓的注册表键、
 * 命令解析（`@bot /issue-format`）、面板与 `store.upload` 的 `SKILL_NAME_RE` 全部按
 * `/issue-format` 索引。少了这一步，同一个技能会「注册成 `issue-format`、按 `/issue-format` 找」，
 * 表现就是运行时 `Skill … not available`（实测踩过）。
 */
export function normalizeSkillName(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  if (lowered === '') return '';
  return lowered.startsWith('/') ? lowered : `/${lowered}`;
}

/** 把 zod 的 issue 列表压成 `path: message` 的行，便于一次看全。 */
function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

/**
 * 解析一份技能文件（frontmatter + 正文）。
 *
 * 只做「文件 → 结构化结果」，不决定禁用/覆盖：那是 `registry.ts` 的事。
 * 这样单测可以直接喂一段文本，不需要文件系统。
 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const split = splitFrontmatter(text);
  if (!split.ok) {
    return { ok: false, detail: split.detail, name: bestEffortName(text), issues: [split.detail] };
  }

  let raw: unknown;
  try {
    raw = parseYamlSubset(split.yaml);
  } catch (error) {
    const detail =
      error instanceof YamlSubsetError ? `frontmatter 不是受支持的 YAML：${error.message}` : describeError(error);
    return { ok: false, detail, name: bestEffortName(split.yaml), issues: [detail] };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const detail = 'frontmatter 必须是一个映射（key: value）';
    return { ok: false, detail, name: null, issues: [detail] };
  }

  const parsed = skillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error.issues);
    return {
      ok: false,
      detail: `技能 frontmatter 不符合契约：${issues.join('; ')}`.slice(0, 500),
      name: bestEffortName(split.yaml),
      issues,
    };
  }

  return {
    ok: true,
    frontmatter: parsed.data,
    body: split.body.trim(),
    name: normalizeSkillName(parsed.data.name),
  };
}

/**
 * 尽力取出 `name`：frontmatter 非法时也要让面板能显示「是哪个文件坏了」。
 *
 * 只认「`name:` 开头的一行」，不解析整份 YAML —— 解析失败正是走到这里的原因。
 */
export function bestEffortName(text: string): string | null {
  const match = /^\s*name\s*:\s*(.+)$/mu.exec(text);
  if (match === null) {
    return null;
  }
  const value = (match[1] ?? '').trim().replace(/^['"]|['"]$/gu, '');
  if (value === '') {
    return null;
  }
  return normalizeSkillName(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
