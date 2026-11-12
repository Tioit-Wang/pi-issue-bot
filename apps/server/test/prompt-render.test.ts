import { describe, expect, it, vi } from 'vitest';
import {
  PLACEHOLDER_NAMES,
  needsRepoIssues,
  renderTemplate,
  renderTemplateAsync,
} from '../src/prompt/render.ts';
import type { RenderContext } from '../src/prompt/render.ts';

/**
 * 占位符渲染（FR-2.3 / §6.3，`docs/v21-contract.md` §3）。
 *
 * 这里守的是三条**容易被"优化"掉**的规则：
 *  1. 一次遍历替换（替换结果不参与二次替换）——用 `for + replaceAll` 实现就会破；
 *  2. 重复占位符全部替换——`replace` 不带 `g` 就会破；
 *  3. 未知占位符原样保留 + 收进 `unknown`——悄悄替成空串就会破（用户永远发现不了漏配）。
 */

/** 一份完整的渲染上下文（含评论与 issue 索引，便于逐占位符断言）。 */
function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    repo: 'org/repo',
    actor: 'carol',
    eventAction: 'opened',
    issue: {
      author: 'alice',
      number: 1950,
      url: 'https://github.com/org/repo/issues/1950',
      title: '导出按钮点击后闪退',
      content: '用户在 iOS 18 上导出闪退…',
      labels: ['bug', 'needs-info'],
      updatedAt: '2026-11-12T08:00:00Z',
    },
    comment: { author: 'bob', body: '这条和 #1942 是同一个问题吗' },
    repoIssues: '#1942 [open] 导出闪退',
    ...overrides,
  };
}

describe('12 个正式占位符（§6.3 表格）', () => {
  it('清单就是 12 个，不多不少', () => {
    expect(PLACEHOLDER_NAMES).toHaveLength(12);
  });

  it('每个占位符都能渲染出值（有评论、有 issue 索引的上下文）', () => {
    const ctx = makeContext();
    for (const name of PLACEHOLDER_NAMES) {
      const result = renderTemplate(`[{{${name}}}]`, ctx);
      expect(result.unknown, name).toEqual([]);
      expect(result.text, name).not.toBe(`[{{${name}}}]`);
      expect(result.text.length, name).toBeGreaterThan(2);
    }
  });

  it('取值口径逐项对得上需求表格', () => {
    const ctx = makeContext();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['issue.author', 'alice'],
      ['issue.number', '1950'],
      ['issue.url', 'https://github.com/org/repo/issues/1950'],
      ['issue.content', '用户在 iOS 18 上导出闪退…'],
      ['issue.labels', 'bug, needs-info'],
      ['issue.title', '导出按钮点击后闪退'],
      ['repo.issues', '#1942 [open] 导出闪退'],
      ['comment.author', 'bob'],
      ['comment.body', '这条和 #1942 是同一个问题吗'],
      ['repo', 'org/repo'],
      ['actor', 'carol'],
      ['event.action', 'opened'],
    ];
    for (const [name, expected] of cases) {
      expect(renderTemplate(`{{${name}}}`, ctx).text, name).toBe(expected);
    }
  });
});

describe('FR-2.3 三条替换规则', () => {
  it('重复出现的占位符每一处都替换', () => {
    const result = renderTemplate('#{{issue.number}} 和 #{{issue.number}} 都看下', makeContext());
    expect(result.text).toBe('#1950 和 #1950 都看下');
    expect(result.unknown).toEqual([]);
  });

  it('一次遍历：替换进去的值里带占位符不会被二次替换', () => {
    const ctx = makeContext({
      issue: {
        ...makeContext().issue,
        // 正文里正好写了另一个占位符的字面形态
        content: '用户把模板贴进正文了：{{issue.url}}',
      },
    });
    const result = renderTemplate('正文：{{issue.content}}', ctx);
    expect(result.text).toBe('正文：用户把模板贴进正文了：{{issue.url}}');
    // 关键：没有被当成「未知占位符」收集（它压根没参与第二遍扫描）
    expect(result.unknown).toEqual([]);
  });

  it('未知占位符原样保留，并按首次出现顺序去重收集', () => {
    const result = renderTemplate('{{issue.foo}} / {{issue.bar}} / {{issue.foo}}', makeContext());
    expect(result.text).toBe('{{issue.foo}} / {{issue.bar}} / {{issue.foo}}');
    expect(result.unknown).toEqual(['issue.foo', 'issue.bar']);
  });

  it('已知但本轮没有值的占位符渲染成空串（不算未知）', () => {
    const result = renderTemplate('[{{comment.author}}][{{comment.body}}]', makeContext({ comment: undefined }));
    expect(result.text).toBe('[][]');
    expect(result.unknown).toEqual([]);
  });

  it('没有任何占位符时原样返回（空行、缩进都不动）', () => {
    const template = '  /issue-format\n\n\n  原样返回  ';
    expect(renderTemplate(template, makeContext())).toEqual({ text: template, unknown: [] });
  });

  it('空模板渲染成空串', () => {
    expect(renderTemplate('', makeContext())).toEqual({ text: '', unknown: [] });
  });
});

describe('{{issue.labels}}：逗号+空格、空集空串、保持传入顺序', () => {
  it('空集渲染为空串（不填「无」之类的占位词）', () => {
    const ctx = makeContext({ issue: { ...makeContext().issue, labels: [] } });
    expect(renderTemplate('[{{issue.labels}}]', ctx).text).toBe('[]');
  });

  it('保序：不做排序（同一 issue 两次渲染结果要稳定可比对）', () => {
    const ctx = makeContext({ issue: { ...makeContext().issue, labels: ['needs-info', 'bug'] } });
    expect(renderTemplate('{{issue.labels}}', ctx).text).toBe('needs-info, bug');
  });
});

describe('{{repo.issues}}：惰性与未准备时的处理', () => {
  it('没准备 issue 索引时按未知占位符处理（原样保留 + 记 unknown）', () => {
    const ctx = makeContext({ repoIssues: undefined });
    const result = renderTemplate('#{{issue.number}}\n{{repo.issues}}', ctx);
    expect(result.text).toBe('#1950\n{{repo.issues}}');
    expect(result.unknown).toEqual(['repo.issues']);
  });

  it('给字符串就直接用；给同步函数就调用一次', () => {
    expect(renderTemplate('{{repo.issues}}', makeContext({ repoIssues: 'a\nb' })).text).toBe('a\nb');
    const factory = vi.fn(() => '#1 [open] 标题');
    expect(renderTemplate('{{repo.issues}}', makeContext({ repoIssues: factory })).text).toBe('#1 [open] 标题');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('needsRepoIssues 只看模板里有没有写这个占位符', () => {
    expect(needsRepoIssues('{{repo.issues}}')).toBe(true);
    expect(needsRepoIssues('{{repo}} issues')).toBe(false);
  });
});

describe('renderTemplateAsync：仅当模板写了 {{repo.issues}} 才去取数据（§6.3 惰性）', () => {
  it('模板没写 → 不调用取数函数', async () => {
    const factory = vi.fn(async () => '#1 [open] 标题');
    const result = await renderTemplateAsync('{{issue.title}}', { ...makeContext(), repoIssues: factory });
    expect(factory).not.toHaveBeenCalled();
    expect(result.text).toBe('导出按钮点击后闪退');
  });

  it('模板写了 → await 之后渲染进结果', async () => {
    const factory = vi.fn(async () => '#1942 [open] 导出闪退\n#1943 [open] 登录后跳转异常');
    const result = await renderTemplateAsync('列表：\n{{repo.issues}}', {
      ...makeContext(),
      repoIssues: factory,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('列表：\n#1942 [open] 导出闪退\n#1943 [open] 登录后跳转异常');
    expect(result.unknown).toEqual([]);
  });

  it('没给 repoIssues 时仍是未知占位符', async () => {
    const result = await renderTemplateAsync('{{repo.issues}}', { ...makeContext(), repoIssues: undefined });
    expect(result.text).toBe('{{repo.issues}}');
    expect(result.unknown).toEqual(['repo.issues']);
  });
});
