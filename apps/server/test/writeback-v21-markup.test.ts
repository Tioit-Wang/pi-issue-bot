/**
 * `writeback/v21/markup.ts` 的单测（`docs/plan-issue-tools.md` §2 的四条结论）。
 *
 * 这四件事全是**字符串运算**，而字符串运算最容易写成「看起来对、实际少一个字符」：
 * 「`@someone` 会不会真的把人 @ 到」「`fixes #12` 会不会在合并时自动关单」
 * 都只能靠断言**逐字符**看结果，不能靠读代码判断。
 *
 * 因此这里钉死四件事：
 *  1. 引用抽取的三种写法（`#12` / `o/r#12` / 完整 URL）与**不误抓**（`https://x/#12`）；
 *  2. 提及中和只动不在允许清单里的人（插零宽空格，人看不到、GitHub 不再渲染）；
 *  3. closing keyword 中和（PR 正文专用）；
 *  4. 回复正文的引用块格式（逐行 `>`、空原文、超长截断）。
 */
import { describe, expect, it } from 'vitest';

import {
  LINK_MARKER_PREFIX,
  buildLinkNote,
  findIssueReferences,
  findMentions,
  isLinkNote,
  neutralizeClosingKeywords,
  neutralizeMentions,
  renderReplyBody,
} from '../src/writeback/v21/markup.ts';

/** 零宽空格：中和后的提及长这样（人读不到，渲染不再命中）。 */
const ZWSP = '\u200b';

describe('findIssueReferences：抽取正文里的 issue / PR 引用', () => {
  it('`#12` 是本仓库引用（repo=null）', () => {
    expect(findIssueReferences('参见 #12')).toEqual([{ raw: '#12', number: 12, repo: null }]);
  });

  it('`o/r#12` 带仓库前缀', () => {
    expect(findIssueReferences('参见 other/repo#12')).toEqual([
      { raw: 'other/repo#12', number: 12, repo: 'other/repo' },
    ]);
  });

  it('完整 URL 解析成 owner/repo + 编号（issues 与 pull 两种路径）', () => {
    const refs = findIssueReferences(
      '见 https://github.com/acme/widgets/issues/12 与 https://github.com/acme/widgets/pull/7',
    );
    expect(refs).toEqual([
      { raw: 'https://github.com/acme/widgets/issues/12', number: 12, repo: 'acme/widgets' },
      { raw: 'https://github.com/acme/widgets/pull/7', number: 7, repo: 'acme/widgets' },
    ]);
  });

  it('不误抓 `https://x/#12`（`#` 前是斜杠，不是引用）', () => {
    expect(findIssueReferences('https://x/#12')).toEqual([]);
  });

  it('同一编号只出现一次（按 (repo, number) 去重）', () => {
    const refs = findIssueReferences('#7 与 #7，再加 other/repo#7');
    // 抽取顺序按**写法**分组（完整 URL → `owner/repo#n` → `#n`），不是正文里的出现顺序：
    // 三种写法各扫一遍才能避免 `o/r#12` 被 `#12` 规则重复抓一次。
    expect(refs).toEqual([
      { raw: 'other/repo#7', number: 7, repo: 'other/repo' },
      { raw: '#7', number: 7, repo: null },
    ]);
  });

  it('没有引用时返回空数组', () => {
    expect(findIssueReferences('一行普通正文，含 #标签 与 v1.2.3')).toEqual([]);
  });
});

describe('findMentions / neutralizeMentions：提及', () => {
  it('抽取 @login（去重，`@org/team` 取前段）', () => {
    expect(findMentions('@alice 与 @bob 还有 @alice、@acme/reviewers').map((item) => item.login)).toEqual([
      'alice',
      'bob',
      'acme',
    ]);
  });

  it('允许清单里的 login 原样保留，其它插零宽空格', () => {
    const result = neutralizeMentions('@alice 和 @bob 都看一下', ['alice']);
    expect(result.body).toBe(`@alice 和 @${ZWSP}bob 都看一下`);
    expect(result.neutralized).toEqual(['bob']);
  });

  it('允许清单按大小写不敏感匹配（GitHub 的 login 不区分大小写）', () => {
    const result = neutralizeMentions('@Alice 看下', ['alice']);
    expect(result.body).toBe('@Alice 看下');
    expect(result.neutralized).toEqual([]);
  });

  it('空允许清单 = 谁都不许 @（全部中和）', () => {
    const result = neutralizeMentions('@a 与 @b', []);
    expect(result.neutralized).toEqual(['a', 'b']);
    expect(result.body).not.toContain('@a');
    expect(result.body).not.toContain('@b');
  });

  it('邮箱 / 代码里的 @ 不算提及（前缀是词字符或反引号）', () => {
    expect(findMentions('mail: foo@bar.com，代码 `@decorator`')).toEqual([]);
  });
});

describe('neutralizeClosingKeywords：PR 正文的 closing keyword', () => {
  it('`fixes #12` / `closes #7` / `resolved #3` 都被中和（关键字前保留，`#` 前插零宽空格）', () => {
    const body = neutralizeClosingKeywords('fixes #12 and closes #7, resolved #3');
    expect(body).toBe(`fixes ${ZWSP}#12 and closes ${ZWSP}#7, resolved ${ZWSP}#3`);
  });

  it('不是 closing keyword 的写法不动', () => {
    expect(neutralizeClosingKeywords('see #12 and fix the bug')).toBe('see #12 and fix the bug');
  });
});

describe('renderReplyBody：回复正文的引用块', () => {
  it('多行原文逐行加 `>`，空行保留成 `>`（否则引用会被截断成两段）', () => {
    const body = renderReplyBody({
      authorLogin: 'alice',
      originalBody: '第一行\n\n第二段',
      body: '收到，我来改',
    });
    expect(body).toBe('> **@alice** wrote:\n> 第一行\n>\n> 第二段\n\n@alice 收到，我来改');
  });

  it('原评论是空正文 → 不硬造空引用块，但仍然定向 @ 作者', () => {
    const body = renderReplyBody({ authorLogin: 'alice', originalBody: '', body: '收到' });
    expect(body).toBe('@alice 收到');
  });

  it('作者未知（幽灵用户）→ 只写「原评论：」，不带 @', () => {
    const body = renderReplyBody({ authorLogin: null, originalBody: '原文', body: '收到' });
    expect(body).toBe('> 原评论：\n> 原文\n\n收到');
  });

  it('超长原文按 maxQuoteChars 截断并标注总字数', () => {
    const body = renderReplyBody({
      authorLogin: 'alice',
      originalBody: 'abcdefgh',
      body: '收到',
      maxQuoteChars: 5,
    });
    expect(body).toContain('> abcde…（原评论共 8 字，已截断）');
    expect(body).toContain('@alice 收到');
  });
});

describe('buildLinkNote / isLinkNote：关联评论的兜底标记', () => {
  it('正文含人读的一句 + 隐藏标记，`isLinkNote()` 能认出来', () => {
    const note = buildLinkNote({ relation: 'relates', repo: 'acme/widgets', issueNumber: 42, targetNumber: 7 });
    expect(note).toContain('与 #7');
    expect(note).toContain(`<!-- ${LINK_MARKER_PREFIX} relates acme/widgets#42->#7 -->`);
    expect(isLinkNote(note)).toBe(true);
  });

  it('普通评论正文不算关联评论', () => {
    expect(isLinkNote('普通正文')).toBe(false);
    expect(isLinkNote(null)).toBe(false);
  });
});
