/**
 * `writeback/v21/comments.ts` 的单测（`docs/v21-contract.md` §5 / FR-5.5 / AC-15）。
 *
 * 核心不变量只有一个：**同一个槽位永远只有一条评论**。
 * 所以用例都围绕「第二次写是覆盖不是新增」「原评论没了能认出是重建」展开；
 * 标记的生成/解析互为逆运算，是这套语义能成立的前提。
 */
import { describe, expect, it } from 'vitest';

import type { SlotComment, SlotTarget } from '../src/writeback/v21/comments.ts';
import {
  SLOT_MARKER_PREFIX,
  buildSlotMarker,
  composeSlotBody,
  findSlotComment,
  parseSlotMarkers,
  planSlotWrite,
} from '../src/writeback/v21/comments.ts';

const target: SlotTarget = { repo: 'acme/widgets', issueNumber: 42, slot: 'result' };
const marker = buildSlotMarker(target);

/** 造一条带指定标记的评论（正文里可夹其它文字，模拟人手工编辑过）。 */
function comment(id: number, body: string | null): SlotComment {
  return { id, body };
}

describe('槽位标记：生成 / 解析', () => {
  it('buildSlotMarker 生成精确的 `<!-- pi-bot:slot repo#issue:slot -->`', () => {
    expect(marker).toBe('<!-- pi-bot:slot acme/widgets#42:result -->');
    expect(marker).toContain(SLOT_MARKER_PREFIX);
  });

  it('parseSlotMarkers 是 buildSlotMarker 的逆运算', () => {
    expect(parseSlotMarkers(marker)).toEqual([target]);
  });

  it('一段正文里多个标记按出现顺序全部解析（含空白被手工改过的形态）', () => {
    const other = buildSlotMarker({ repo: 'acme/widgets', issueNumber: 42, slot: 'failure' });
    const edited = '<!--pi-bot:slot  acme/widgets#7:status-->';
    const parsed = parseSlotMarkers(`正文 ${marker}\n\n${other}\n${edited}`);
    expect(parsed).toEqual([
      target,
      { repo: 'acme/widgets', issueNumber: 42, slot: 'failure' },
      { repo: 'acme/widgets', issueNumber: 7, slot: 'status' },
    ]);
  });

  it('空正文 / null / 无标记的正文 → 空数组', () => {
    expect(parseSlotMarkers('')).toEqual([]);
    expect(parseSlotMarkers(null)).toEqual([]);
    expect(parseSlotMarkers(undefined)).toEqual([]);
    expect(parseSlotMarkers('<!-- pi-bot:slot 坏形状 -->')).toEqual([]);
    expect(parseSlotMarkers('普通评论，什么都没有')).toEqual([]);
  });
});

describe('findSlotComment：按槽位键精确匹配', () => {
  it('命中同槽位标记 → 返回那条评论（其它评论不干扰）', () => {
    const comments: readonly SlotComment[] = [
      comment(1, '人来的一条普通评论'),
      comment(2, buildSlotMarker({ repo: 'acme/widgets', issueNumber: 42, slot: 'failure' })),
      comment(3, `结论正文\n\n${marker}`),
      comment(4, null),
    ];
    expect(findSlotComment(comments, marker)).toEqual({ id: 3, body: comments[2]?.body ?? null });
  });

  it('只匹配同一 (repo, issue, slot)，槽位/issue/repo 换一个都不算', () => {
    const others: readonly string[] = [
      buildSlotMarker({ repo: 'acme/widgets', issueNumber: 42, slot: 'failure' }),
      buildSlotMarker({ repo: 'acme/widgets', issueNumber: 43, slot: 'result' }),
      buildSlotMarker({ repo: 'other/widgets', issueNumber: 42, slot: 'result' }),
    ];
    const comments = others.map((body, index) => comment(index + 1, body));
    expect(findSlotComment(comments, marker)).toBeNull();
  });

  it('标记被手工改过空白仍然认得出来（语义匹配而非字符串逐字相等）', () => {
    const edited = comment(9, '结论\n\n<!--pi-bot:slot  acme/widgets#42:result-->');
    expect(findSlotComment([edited], marker)?.id).toBe(9);
  });

  it('非法 marker / 空列表 → null', () => {
    expect(findSlotComment([comment(1, marker)], '不是标记')).toBeNull();
    expect(findSlotComment([], marker)).toBeNull();
  });
});

describe('planSlotWrite：覆盖而非新增', () => {
  it('找到现有评论 → op=update，带 commentId，recreated=false', () => {
    const existing = comment(7, `旧结论\n\n${marker}`);
    const plan = planSlotWrite({ existing, body: '新结论', marker, historyCommentId: 7 });
    expect(plan.op).toBe('update');
    if (plan.op !== 'update') {
      return;
    }
    expect(plan.commentId).toBe(7);
    expect(plan.recreated).toBe(false);
    expect(plan.body).toBe(`新结论\n\n${marker}`);
  });

  it('找不到现有评论且没有历史 → op=create，recreated=false（首次写）', () => {
    const plan = planSlotWrite({ existing: null, body: '结论', marker });
    expect(plan.op).toBe('create');
    expect(plan.recreated).toBe(false);
    expect(plan.body).toBe(`结论\n\n${marker}`);
  });

  it('索引里有历史 id 但列表里找不到 → op=create 且 recreated=true', () => {
    const plan = planSlotWrite({ existing: null, body: '结论', marker, historyCommentId: 7 });
    expect(plan.op).toBe('create');
    expect(plan.recreated).toBe(true);
  });

  it('historyCommentId=null 等价于没有历史', () => {
    const plan = planSlotWrite({ existing: null, body: '结论', marker, historyCommentId: null });
    expect(plan.recreated).toBe(false);
  });
});

describe('composeSlotBody：正文归一 + 末尾标记', () => {
  it('正文去首尾空白，正文与标记之间恰好一个空行', () => {
    expect(composeSlotBody('  结论正文\n\n ', marker)).toBe(`结论正文\n\n${marker}`);
  });

  it('正文与标记拼好后仍能解析回同一个槽位（写出去的东西能读回来）', () => {
    const body = composeSlotBody('  \n 处理后的结论 \n', marker);
    expect(parseSlotMarkers(body)).toEqual([target]);
    expect(findSlotComment([comment(1, body)], marker)?.id).toBe(1);
  });

  it('全空白正文只留标记（不写一行空正文）', () => {
    expect(composeSlotBody('   \n  ', marker)).toBe(marker);
  });
});
