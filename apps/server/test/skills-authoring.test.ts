/**
 * 内置技能的**写作规范**断言（防退化，不是文案校对）。
 *
 * 背景：最初的默认技能靠 `{{repo}}` / `{{target}}` 占位符「留位置」，正文既没写清用哪个工具，
 * 也没告诉模型这些事实从哪来 —— 模型只能猜。这里把「什么叫合格的一个技能」固化成断言：
 *
 * 1. 正文不得出现 `{{...}}`：事实（仓库、编号、当前标签、标签词表、提交 sha）由
 *    `skills/prompt.ts` 用运行时真值渲染进 `## 任务上下文` / `## 项目标签`，技能引用段名即可。
 * 2. 每个技能必须有「工具用法」与「边界」两节：技能回答的就是「用哪个工具、怎么用、用不了怎么办」。
 * 3. 正文里点名调用的工具必须在该技能的 `allowed-tools` 里 —— 否则写了也调不动（矩阵外一律 deny），
 *    这是「技能与工具面脱节」最容易出的一类谎话。
 * 4. `description` 写「何时用」（检索用），不写步骤。
 * 5. 不出现 `\`` 这类转义残留：模板字符串里多写一个反斜杠，用户看到的就是一屏反斜杠。
 */
import { describe, expect, it } from 'vitest';

import { BUILTIN_SKILL_FILES, BUILTIN_SKILL_NAMES } from '../src/skills/builtin.ts';
import { parseSkillFile } from '../src/skills/frontmatter.ts';

const TOOL_CALL_RE = /\b(Read|Write|Edit|Glob|Grep|Bash)\(/gu;

const parsedSkills = BUILTIN_SKILL_FILES.map((file) => ({
  path: file.path,
  text: file.text,
  parsed: parseSkillFile(file.text),
}));

function skillNameOf(path: string): string {
  return path.split('/').slice(-2)[0] ?? path;
}

describe('内置技能：无占位符', () => {
  it('任何内置技能的正文都不含 `{{...}}`', () => {
    for (const { path, text } of parsedSkills) {
      const body = text.split(/^---$/mu).slice(2).join('---');
      expect(body, `${skillNameOf(path)} 正文仍含占位符`).not.toMatch(/\{\{[^}]*\}\}/u);
    }
  });

  it('正文里没有多余的转义残留（`\\``）', () => {
    for (const { path, text } of parsedSkills) {
      expect(text, `${skillNameOf(path)} 里有转义残留`).not.toContain('\\`');
    }
  });
});

describe('内置技能：方法层完整', () => {
  it('frontmatter 全部合法，且名字与内置清单一致', () => {
    for (const { path, parsed } of parsedSkills) {
      expect(parsed.ok, `${path} 解析失败：${parsed.ok ? '' : parsed.detail}`).toBe(true);
    }
    expect(parsedSkills).toHaveLength(BUILTIN_SKILL_NAMES.length);
  });

  it('每个技能都有「工具用法」与「边界」两节', () => {
    for (const { path, parsed } of parsedSkills) {
      const body = parsed.ok ? parsed.body : '';
      expect(body, `${skillNameOf(path)} 缺「工具用法」`).toContain('## 工具用法');
      expect(body, `${skillNameOf(path)} 缺「边界与不要做」`).toContain('## 边界与不要做');
    }
  });

  it('正文点名的工具都在 allowed-tools 里（技能不能调用没声明的工具）', () => {
    for (const { path, parsed } of parsedSkills) {
      if (!parsed.ok) continue;
      const allowed = new Set<string>(parsed.frontmatter['allowed-tools'] ?? []);
      const mentioned = new Set<string>();
      for (const match of parsed.body.matchAll(TOOL_CALL_RE)) {
        if (match[1] !== undefined) mentioned.add(match[1]);
      }
      for (const tool of mentioned) {
        expect(allowed.has(tool), `${skillNameOf(path)} 正文用了 ${tool}，但 allowed-tools 里没有`).toBe(true);
      }
      // 反向：声明了却一句没提也不算合格（说明清单是抄来的，没落到具体用法）
      expect(mentioned.size, `${skillNameOf(path)} 的「工具用法」一节没有列出任何工具调用`).toBeGreaterThan(0);
    }
  });

  it('description 写「何时用」，不写成步骤', () => {
    for (const { path, parsed } of parsedSkills) {
      if (!parsed.ok) continue;
      const { description } = parsed.frontmatter;
      expect(description, `${skillNameOf(path)} 的 description 没写适用场景`).toContain('适用于');
      expect(description.length).toBeLessThanOrEqual(1024);
    }
  });
});

describe('内置技能：动作层写对', () => {
  it('/label-triage 明确「打标只能走 actions 的 label 动作」', () => {
    const file = BUILTIN_SKILL_FILES.find((item) => item.path.includes('/label-triage/'));
    expect(file).toBeDefined();
    expect(file?.text).toContain('"intent":"label"');
    expect(file?.text).toContain('verdict.labels');
    expect(file?.text).toContain('不写回');
  });

  it('/issue-triage 是静默分诊：不带 comment 意图', () => {
    const file = BUILTIN_SKILL_FILES.find((item) => item.path.includes('/issue-triage/'));
    const parsed = parseSkillFile(file?.text ?? '');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontmatter.outputs).toEqual(['labels']);
    expect(parsed.body).toContain('不要');
  });
});
