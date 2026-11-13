import { describe, expect, it } from 'vitest';
import { isPlaceholderCommentBody } from '../src/worker/writeback.ts';

describe('评论正文的占位句拦截', () => {
  it('提示词示例句原样抄进来 → 判为占位（不写回）', () => {
    expect(isPlaceholderCommentBody('与第一段一致的说明（可省略这条动作）')).toBe(true);
    expect(isPlaceholderCommentBody('  @Tioit-Wang 与第一段一致的说明（可省略这条动作）  ')).toBe(true);
    expect(isPlaceholderCommentBody('（此处放【第一段】的完整正文；照抄本示例会被丢弃）')).toBe(true);
  });

  it('空串 / 未给正文 → 判为占位', () => {
    expect(isPlaceholderCommentBody('')).toBe(true);
    expect(isPlaceholderCommentBody('   ')).toBe(true);
    expect(isPlaceholderCommentBody(undefined)).toBe(true);
  });

  it('正常评论（哪怕很短）照常写回', () => {
    expect(isPlaceholderCommentBody('合规：复现步骤、版本、期望/实际都齐了。')).toBe(false);
    expect(isPlaceholderCommentBody('缺版本环境。')).toBe(false);
  });
});
