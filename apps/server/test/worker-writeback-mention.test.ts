/**
 * 回复的 `@提问者` 前缀（`worker/writeback.ts`）。
 *
 * 需求（`docs/spec/ux-issue-sessions.md` R1）：处理完成后**只发最终结果**一条评论，并以 `@<提问者>` 开头；
 * R2：任何面向用户的回复里都不出现任务编号。
 *
 * 为什么单独立一个文件：`worker-run-task.test.ts` 跑的是整条链路（假端口 + 假 host），
 * 而这里要钉的是**纯函数**的边界（空 login、已带 @、login 自带 @、非 comment 动作不受影响）。
 */
import { describe, expect, it } from 'vitest';

import type { WriteTargetContext } from '../src/worker/types.ts';
import { toWriteActions, withMention } from '../src/worker/writeback.ts';

const TARGET: WriteTargetContext = { currentLabels: [], botLabels: [] };

function contextFor(mention?: string | null): {
  readonly repo: string;
  readonly targetNumber: number;
  readonly target: WriteTargetContext;
  readonly mention?: string | null;
} {
  return { repo: 'o/r', targetNumber: 7, target: TARGET, ...(mention === undefined ? {} : { mention }) };
}

describe('withMention', () => {
  it('没给 login：原样返回（issue 自动分类这类没有提问者的任务）', () => {
    expect(withMention('结论一', null)).toBe('结论一');
    expect(withMention('结论一', undefined)).toBe('结论一');
    expect(withMention('结论一', '   ')).toBe('结论一');
  });

  it('给了 login：加 `@login ` 前缀', () => {
    expect(withMention('结论一', 'alice')).toBe('@alice 结论一');
  });

  it('login 自带 @ 不会变成 @@', () => {
    expect(withMention('结论一', '@alice')).toBe('@alice 结论一');
  });

  it('正文已经以 @login 开头就不再重复', () => {
    expect(withMention('@alice 结论一', 'alice')).toBe('@alice 结论一');
    expect(withMention('  \n@alice 结论一', 'alice')).toBe('  \n@alice 结论一');
  });

  it('别的 login 的前缀不算重复（各 @ 各自的）', () => {
    expect(withMention('@bob 结论一', 'alice')).toBe('@alice @bob 结论一');
  });
});

describe('toWriteActions：comment 动作带 @，其它动作不受影响', () => {
  it('comment 正文被加前缀', () => {
    const actions = toWriteActions({ intent: 'comment', body: '根因是只读挂载。' } as never, contextFor('alice'));
    expect(actions).toHaveLength(1);
    const action = actions[0];
    // 收窄判别联合：`WriteAction` 是 union，只有 comment 才有 body
    if (action === undefined || action.kind !== 'comment') {
      throw new Error('期望产出 comment 动作');
    }
    expect(action).toMatchObject({ kind: 'comment', repo: 'o/r', target: 7 });
    expect(action.body).toBe('@alice 根因是只读挂载。');
  });

  it('没给 mention（旧调用点）时正文一字不改', () => {
    const actions = toWriteActions({ intent: 'comment', body: '根因是只读挂载。' } as never, contextFor());
    const action = actions[0];
    if (action === undefined || action.kind !== 'comment') {
      throw new Error('期望产出 comment 动作');
    }
    expect(action.body).toBe('根因是只读挂载。');
  });

  it('label 动作不掺 @ 前缀', () => {
    const actions = toWriteActions(
      { intent: 'label', add: ['bug'], remove: [] } as never,
      contextFor('alice'),
    );
    expect(actions[0]).toMatchObject({ kind: 'label', desired: ['bug'] });
    expect(JSON.stringify(actions[0])).not.toContain('@alice');
  });
});
