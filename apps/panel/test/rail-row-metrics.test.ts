/**
 * `rail-row` 的**盒模型契约**（`FR-7.4` / `AC-31`）。
 *
 * 为什么要有这个测试：jsdom 没有排版引擎，`getBoundingClientRect()` 恒为 0，
 * 所以「三个左栏的行被压扁、两行文字互相重叠」这种缺陷在面板测试里**测不出来** ——
 * 2026-11-15 实机浏览器里就是这样：`rail-row` 把行高写死 28px，而 Issue 队列 / 设置分区 /
 * 技能列表的条目都是「主行 + 次行」，次行被 `height` 裁掉、`overflow: visible` 又让它
 * 画到下一行上，于是 20 行条目整片叠字。
 *
 * 能机械守住的部分是规则本身：行高必须是 `min-height`（单行仍是 28，两行按内容撑开），
 * 不能是 `height`。这条断言读的是真源（`index.css`），改回去就红。
 *
 * 与 `agent-skill-wiring.test.ts` 同一手法：约束写在文档里会漂，写在源文件上不会。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 读真源用 `readFileSync` + Vitest 的 root（`apps/panel`）：jsdom 里 `import.meta.url`
// 不是 file 协议，`fileURLToPath` 会直接抛，所以按包根拼路径。
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
/** 取出 `@utility <name> { ... }` 的整段声明（大括号配对，避免匹配到别的块）。 */
function utilityBlock(name: string): string {
  const start = css.indexOf(`@utility ${name} {`);
  expect(start, `index.css 里找不到 @utility ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`@utility ${name} 的大括号没有闭合`);
}

describe('左栏行（rail-row）的盒模型', () => {
  it('行高用 min-height 而不是 height：单行仍是 28，两行按内容撑开', () => {
    const block = utilityBlock('rail-row');
    expect(block).toContain('min-height: var(--rail-row-height);');
    // 反向断言：写死 height 会让次行画到下一行上（2026-11-15 实机叠字）
    expect(block).not.toMatch(/(^|\n)\s*height:\s*var\(--rail-row-height\)/);
  });

  it('行高令牌仍是需求里的 28px', () => {
    expect(css).toContain('--rail-row-height: 1.75rem;');
  });

  it('三个左栏都走同一个工具类，没有各自一份数值', () => {
    // 数值只有一处：`rail-row` 里引用 `--rail-row-height`，别处不许再写死行高
    const occurrences = css.match(/--rail-row-height/g) ?? [];
    expect(occurrences).toHaveLength(3); // 定义 + 间距令牌别名 + rail-row 引用
  });

  it('选中态是左侧 3px 强调条 + 浅强调底（不是胶囊、不是整行染色）', () => {
    const block = utilityBlock('rail-row-selected');
    expect(block).toContain('border-left-color: var(--brand);');
    expect(block).toContain('background-color: var(--brand-soft);');
  });
});
