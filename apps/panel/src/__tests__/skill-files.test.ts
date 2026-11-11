/**
 * `lib/skill-files.ts` 的单测：文件树构建、可编辑判定、字节格式化。
 *
 * 为什么值得单独钉：树是**端上算**的（服务端只回 `path` + `text`），排序与嵌套规则只此一份；
 * 一旦「目录排在文件后面」或「多级目录只缩进一层」，模态框里就再也找不到 `references/guides/x.md`。
 */
import { describe, expect, it } from 'vitest';
import {
  buildSkillFileTree,
  defaultSkillFilePath,
  formatBytes,
  isEditableSkillPath,
  utf8ByteLength,
  type SkillTreeDirNode,
  type SkillTreeFileNode,
} from '../lib/skill-files.ts';

/** 树 → 便于断言的行文本（`dir/` 表示目录，缩进两格表示层级）。 */
function outline(nodes: readonly ReturnType<typeof buildSkillFileTree>[number][]): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'dir'
      ? [`${node.name}/`, ...outline(node.children).map((line) => `  ${line}`)]
      : [node.name],
  );
}

function dir(nodes: readonly unknown[]): SkillTreeDirNode {
  const found = nodes.find((node): node is SkillTreeDirNode => (node as SkillTreeDirNode).kind === 'dir');
  if (found === undefined) throw new Error('没有目录节点');
  return found;
}

function file(nodes: readonly unknown[], name: string): SkillTreeFileNode {
  const found = nodes.find(
    (node): node is SkillTreeFileNode => (node as SkillTreeFileNode).kind === 'file' && (node as SkillTreeFileNode).name === name,
  );
  if (found === undefined) throw new Error(`没有文件节点：${name}`);
  return found;
}

describe('buildSkillFileTree', () => {
  it('根文件与目录混排：目录在前，同类按名字字母序', () => {
    const tree = buildSkillFileTree([
      { path: 'SKILL.md', text: '# skill\n' },
      { path: 'references/publishing.md', text: 'publish\n' },
      { path: 'assets/checklist.md', text: '- [ ] a\n' },
      { path: 'NOTES.md', text: 'n\n' },
    ]);

    expect(outline(tree)).toEqual([
      'assets/',
      '  checklist.md',
      'references/',
      '  publishing.md',
      'NOTES.md',
      'SKILL.md',
    ]);
    // 目录节点带路径（拼下一级时要靠它）
    expect(dir(tree).path).toBe('assets');
  });

  it('多级嵌套：`references/guides/versioning.md` 落进两层目录，路径完整', () => {
    const tree = buildSkillFileTree([
      { path: 'SKILL.md', text: 'body\n' },
      { path: 'references/guides/versioning.md', text: 'semver\n' },
      { path: 'references/API.md', text: 'api\n' },
    ]);

    const references = dir(tree);
    expect(references.name).toBe('references');
    expect(outline(references.children)).toEqual(['guides/', '  versioning.md', 'API.md']);
    // 子目录的 path 是相对技能根的完整路径（保存时要提交它）
    expect(dir(references.children).path).toBe('references/guides');
    expect(file(dir(references.children).children, 'versioning.md').path).toBe(
      'references/guides/versioning.md',
    );
  });

  it('字节数按 UTF-8 算（中文 3 字节），不是按字符数', () => {
    const tree = buildSkillFileTree([{ path: 'SKILL.md', text: '技能' }]);
    const node = file(tree, 'SKILL.md');
    expect(node.bytes).toBe(6);
    expect(node.bytes).toBe(utf8ByteLength('技能'));
  });

  it('同名前缀不合并：`assets.md` 与 `assets/x.md` 是两回事', () => {
    const tree = buildSkillFileTree([
      { path: 'assets.md', text: 'file\n' },
      { path: 'assets/x.md', text: 'nested\n' },
    ]);
    expect(outline(tree)).toEqual(['assets/', '  x.md', 'assets.md']);
  });

  it('脏路径（空串 / 前导斜杠 / 重复）不会造出空目录或重复行', () => {
    const tree = buildSkillFileTree([
      { path: '', text: 'x' },
      { path: '/SKILL.md', text: 'a' },
      { path: 'SKILL.md', text: 'b' },
      { path: 'SKILL.md', text: 'c' },
    ]);
    expect(outline(tree)).toEqual(['SKILL.md']);
    // 重复路径保留第一次出现的内容
    expect(file(tree, 'SKILL.md').path).toBe('SKILL.md');
    expect(file(tree, 'SKILL.md').bytes).toBe(1);
  });

  it('空输入是空树（不是一层空目录）', () => {
    expect(buildSkillFileTree([])).toEqual([]);
  });
});

describe('isEditableSkillPath', () => {
  it('md / markdown / txt / json / yaml / yml / toml 可编辑，脚本与图片不可编辑', () => {
    for (const path of ['SKILL.md', 'references/API.MD', 'notes.markdown', 'a.txt', 'b.json', 'c.yml', 'd.yaml', 'e.toml']) {
      expect(isEditableSkillPath(path), path).toBe(true);
    }
    for (const path of ['assets/run.sh', 'assets/logo.png', 'SKILL', 'x.mdx.swp']) {
      expect(isEditableSkillPath(path), path).toBe(false);
    }
  });
});

describe('formatBytes', () => {
  it('B / KB / MB 三档，整数值不留 `.0`', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1_200 * 1024)).toBe('1.2 MB');
  });

  it('非法输入不编 0（返回 —）', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('defaultSkillFilePath', () => {
  it('优先 SKILL.md，其次第一个可编辑文件，再否则第一个文件', () => {
    expect(
      defaultSkillFilePath([
        { path: 'assets/run.sh', text: '' },
        { path: 'SKILL.md', text: '' },
      ]),
    ).toBe('SKILL.md');
    expect(
      defaultSkillFilePath([
        { path: 'assets/run.sh', text: '' },
        { path: 'references/API.md', text: '' },
      ]),
    ).toBe('references/API.md');
    expect(defaultSkillFilePath([{ path: 'assets/run.sh', text: '' }])).toBe('assets/run.sh');
    expect(defaultSkillFilePath([])).toBeNull();
  });
});
