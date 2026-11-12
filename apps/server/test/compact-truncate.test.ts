/**
 * 分层截断的断言（FR-5.6「工具输出」）。
 *
 * 需求原话：「任何一层都不允许直接丢消息」。所以这里每一条都在钉同一件事：
 * **只改工具结果的正文长度，其他一律不动**（消息条数、角色、toolCallId、工具入参、非工具正文）。
 */
import { describe, expect, it } from 'vitest';

import type { MessageLike } from '../src/compact/tokens.ts';
import {
  TRUNCATE_LIMITS,
  layeredTruncate,
  stripOrphanToolResults,
  truncateToolResults,
} from '../src/compact/truncate.ts';

const BIG = 'x'.repeat(5_000);

function sample(): MessageLike[] {
  return [
    { role: 'system', content: '系统提示词不参与压缩' },
    { role: 'user', content: '看看这个报错' },
    {
      role: 'assistant',
      content: '我读一下日志',
      thinking: '先确认是不是空指针',
      toolCalls: [{ id: 'call-1', name: 'Read' }],
    },
    { role: 'tool', toolName: 'Read', toolCallId: 'call-1', content: BIG },
    { role: 'assistant', content: '结论：src/login.ts:88 空指针' },
  ];
}

describe('truncateToolResults', () => {
  it('只截 tool 消息，并留下「已截断 N 字符」标记', () => {
    const before = sample();
    const after = truncateToolResults(before, { maxChars: TRUNCATE_LIMITS.first });

    const toolMessage = after[3];
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toContain('已截断 3000 字符');
    expect(toolMessage?.content.startsWith('x'.repeat(TRUNCATE_LIMITS.first))).toBe(true);
    // 2000 保留 + 标记
    expect(toolMessage?.content.length ?? 0).toBeGreaterThan(TRUNCATE_LIMITS.first);
    expect(toolMessage?.content.length ?? 0).toBeLessThan(TRUNCATE_LIMITS.first + 40);
  });

  it('不删任何消息，条数与顺序不变', () => {
    const before = sample();
    const after = truncateToolResults(before, { maxChars: TRUNCATE_LIMITS.second });
    expect(after).toHaveLength(before.length);
    expect(after.map((message) => message.role)).toEqual(before.map((message) => message.role));
  });

  it('不改非工具消息的正文（系统提示词 / 用户 / 助手都不动）', () => {
    const before = sample();
    const after = truncateToolResults(before, { maxChars: TRUNCATE_LIMITS.second });
    expect(after[0]?.content).toBe(before[0]?.content);
    expect(after[1]?.content).toBe(before[1]?.content);
    expect(after[2]?.content).toBe(before[2]?.content);
    expect(after[4]?.content).toBe(before[4]?.content);
  });

  it('保留 toolCallId 与 toolName（否则会造出孤儿结果）', () => {
    const after = truncateToolResults(sample(), { maxChars: TRUNCATE_LIMITS.second });
    expect(after[3]?.toolCallId).toBe('call-1');
    expect(after[3]?.toolName).toBe('Read');
  });

  it('不重复截断：已短于上限的消息返回同一对象引用', () => {
    const before = sample();
    const after = truncateToolResults(before, { maxChars: 10_000 });
    expect(after[3]).toBe(before[3]);
  });

  it('dropThinking 把思考块置空（第二层降级）', () => {
    const kept = truncateToolResults(sample(), { maxChars: 10_000 });
    expect(kept[2]?.thinking).toBe('先确认是不是空指针');

    const dropped = truncateToolResults(sample(), { maxChars: TRUNCATE_LIMITS.second, dropThinking: true });
    expect(dropped[2]?.thinking).toBe('');
    // 正文不受 thinking 影响
    expect(dropped[2]?.content).toBe('我读一下日志');
  });
});

describe('layeredTruncate', () => {
  it('预算够大 → none，一处都不动', () => {
    const before = sample();
    const result = layeredTruncate(before, 1_000_000);
    expect(result.layer).toBe('none');
    expect(result.messages).toEqual(before);
    expect(result.messages[3]).toBe(before[3]);
  });

  it('第二层够用 → 2000 字符', () => {
    const result = layeredTruncate(sample(), 700);
    expect(result.layer).toBe('2000');
    expect(result.messages[3]?.content).toContain('已截断 3000 字符');
  });

  it('第二层仍不够 → 500 字符 + 丢 thinking', () => {
    const result = layeredTruncate(sample(), 100);
    expect(result.layer).toBe('500');
    expect(result.messages[3]?.content.startsWith('x'.repeat(TRUNCATE_LIMITS.second))).toBe(true);
    expect(result.messages[3]?.content).toContain('已截断 4500 字符');
    expect(result.messages[2]?.thinking).toBe('');
    // 依然一条不删
    expect(result.messages).toHaveLength(sample().length);
  });
});

describe('stripOrphanToolResults', () => {
  it('callId 在窗口内查不到调用方的工具结果被剔除，其余原样', () => {
    const messages: MessageLike[] = [
      { role: 'assistant', content: '发起两次调用', toolCalls: [{ id: 'call-1', name: 'Read' }] },
      { role: 'tool', toolCallId: 'call-1', content: '有主的输出' },
      { role: 'tool', toolCallId: 'call-orphan', content: '调用方被切到摘要侧了' },
      { role: 'user', content: '继续' },
    ];

    const stripped = stripOrphanToolResults(messages);
    expect(stripped.map((message) => message.content)).toEqual(['发起两次调用', '有主的输出', '继续']);
  });

  it('没有 toolCallId 的工具结果也算孤儿（无法证明它有主）', () => {
    const stripped = stripOrphanToolResults([{ role: 'tool', content: '来路不明' }]);
    expect(stripped).toEqual([]);
  });

  it('不删非工具消息（哪怕窗口里一条调用都没有）', () => {
    const messages: MessageLike[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    expect(stripOrphanToolResults(messages)).toHaveLength(2);
  });
});
