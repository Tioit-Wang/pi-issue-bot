import { describe, expect, it } from 'vitest';
import { findLegalMention, isLegalMention, isMentionSeparator } from '../src/trigger/mention.ts';

/**
 * FR-2.5「合法提及」的判定（`docs/v21-contract.md` §2 第 2 条）。
 *
 * 四条判定示例**逐条**来自需求表格（§6.6 的「判定 / 评论内容 / 原因」表），
 * 它们不是随手编的用例：漏掉任何一条都会出现「面板说能触发、线上不触发」或反过来的静默偏差。
 */

const PI_BOT = [{ keyword: 'pi-bot' }] as const;

describe('FR-2.5 需求表格里的四条判定', () => {
  it('合法：@pi-bot 帮我看看这条（关键词后是空格，正文独立）', () => {
    const hit = findLegalMention('@pi-bot 帮我看看这条', PI_BOT);
    expect(hit).toEqual({ keyword: 'pi-bot', start: 0, end: 7 });
  });

  it('合法：@pi-bot（只有提及、没有正文，也认）', () => {
    expect(findLegalMention('@pi-bot', PI_BOT)).toEqual({ keyword: 'pi-bot', start: 0, end: 7 });
  });

  it('不合法：@pi-bot帮我看看这条（关键词与正文粘连，无法确定边界）', () => {
    expect(findLegalMention('@pi-bot帮我看看这条', PI_BOT)).toBeNull();
  });

  it('不合法：@pi-botx 帮我看看（命中的是另一个更长的名字）', () => {
    expect(findLegalMention('@pi-botx 帮我看看', PI_BOT)).toBeNull();
  });

  it('只有提及、后面是换行也算分隔符', () => {
    expect(findLegalMention('@pi-bot\n正文在下一行', PI_BOT)).not.toBeNull();
  });

  it('句末句号 / 逗号 / 中文逗号 / 括号都算分隔符', () => {
    for (const body of ['@pi-bot.', '@pi-bot, 看下', '@pi-bot，看下', '@pi-bot（帮看下）', '@pi-bot：看下']) {
      expect(findLegalMention(body, PI_BOT), body).not.toBeNull();
    }
  });
});

describe('代码区不算提及（蒙版复用 contract 的 maskCodeRegions）', () => {
  it('围栏代码块里的 @pi-bot 不触发', () => {
    const body = ['用法：', '```', '@pi-bot 这样叫', '```', '以上是文档'].join('\n');
    expect(findLegalMention(body, PI_BOT)).toBeNull();
  });

  it('行内代码里的 @pi-bot 不触发', () => {
    expect(findLegalMention('把 `@pi-bot` 写在说明里', PI_BOT)).toBeNull();
  });

  it('代码区之外的那次提及仍然触发', () => {
    const body = ['把 `@pi-bot` 写在说明里', '@pi-bot 帮我看看'].join('\n');
    const hit = findLegalMention(body, PI_BOT);
    expect(hit).not.toBeNull();
    expect(hit?.start).toBeGreaterThan(0);
  });
});

describe('大小写（缺省不区分，case_sensitive 打开后严格）', () => {
  it('缺省：@Pi-Bot 命中，返回配置里的原样关键词', () => {
    expect(findLegalMention('@Pi-Bot 看下', PI_BOT)).toEqual({ keyword: 'pi-bot', start: 0, end: 7 });
  });

  it('case_sensitive: true 时 @Pi-Bot 不命中、@pi-bot 命中', () => {
    const sensitive = [{ keyword: 'pi-bot', case_sensitive: true }] as const;
    expect(findLegalMention('@Pi-Bot 看下', sensitive)).toBeNull();
    expect(findLegalMention('@pi-bot 看下', sensitive)).not.toBeNull();
  });
});

describe('最长优先与最早出现', () => {
  it('同一位置上最长关键词优先（pi 与 pi.bot 同时能命中时取 pi.bot）', () => {
    const mentions = [{ keyword: 'pi' }, { keyword: 'pi.bot' }] as const;
    expect(findLegalMention('@pi.bot 看下', mentions)?.keyword).toBe('pi.bot');
  });

  it('返回最早出现的那一个（一次评论只该产生一轮处理）', () => {
    const hit = findLegalMention('先说一句，@pi-bot 帮我看看', PI_BOT);
    expect(hit?.start).toBe(5);
  });

  it('前面的 @xxx 不合法时会继续往后找', () => {
    expect(findLegalMention('@someone 和 @pi-bot 都看下', PI_BOT)?.start).toBe(11);
  });
});

describe('前导字符与边界', () => {
  it('foo@pi-bot 不算命中（邮箱形态）', () => {
    expect(findLegalMention('foo@pi-bot 看下', PI_BOT)).toBeNull();
  });

  it('a.b@pi-bot / x-@pi-bot / @@pi-bot 都不算命中', () => {
    for (const body of ['a.b@pi-bot 看下', 'x-@pi-bot 看下', '@@pi-bot 看下']) {
      expect(findLegalMention(body, PI_BOT), body).toBeNull();
    }
  });

  it('中文前缀算边界（你好@pi-bot 看下）', () => {
    expect(findLegalMention('你好@pi-bot 看下', PI_BOT)?.start).toBe(2);
  });

  it('空关键词被忽略（手改坏的配置不该让任意 @ 都触发）', () => {
    expect(findLegalMention('@someone 看下', [{ keyword: '  ' }])).toBeNull();
  });

  it('关键词清单为空 → 永不命中', () => {
    expect(findLegalMention('@pi-bot 看下', [])).toBeNull();
  });
});

describe('中文关键词（§6.6 的 @小豆）', () => {
  const mentions = [{ keyword: '小豆' }] as const;

  it('@小豆 你好 命中；@小豆你好 不命中（中文不是分隔符）', () => {
    expect(findLegalMention('@小豆 你好', mentions)).toEqual({ keyword: '小豆', start: 0, end: 3 });
    expect(findLegalMention('@小豆你好', mentions)).toBeNull();
  });
});

describe('isLegalMention / isMentionSeparator', () => {
  it('isLegalMention 与 findLegalMention 口径一致', () => {
    expect(isLegalMention('@pi-bot 看下', PI_BOT)).toBe(true);
    expect(isLegalMention('@pi-botx 看下', PI_BOT)).toBe(false);
  });

  it('空串（字符串结尾）与空白／标点是分隔符，字母数字与中文不是', () => {
    expect(isMentionSeparator('')).toBe(true);
    expect(isMentionSeparator(' ')).toBe(true);
    expect(isMentionSeparator('\n')).toBe(true);
    expect(isMentionSeparator('。')).toBe(true);
    expect(isMentionSeparator('a')).toBe(false);
    expect(isMentionSeparator('你')).toBe(false);
    expect(isMentionSeparator('-')).toBe(false);
  });
});
