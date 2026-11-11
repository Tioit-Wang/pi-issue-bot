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

import type { ActionRecord, WriteTargetContext } from '../src/worker/types.ts';
import { executeActions, isWriteBackAllowed, taskSourceOf, toWriteActions, withMention } from '../src/worker/writeback.ts';
import { createFakeWriteApi } from './helpers/fake-github.ts';

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

describe('两条通道：只有人工触发才写回评论（plan §5 / W2-D 第 4 条）', () => {
  it('taskSourceOf：显式传入优先；缺省按命令名推（auto:* → 自动通道）', () => {
    expect(taskSourceOf({ source: 'command', command: 'auto:triage' })).toBe('command');
    expect(taskSourceOf({ source: 'cron', command: '/issue-triage' })).toBe('cron');
    expect(taskSourceOf({ command: 'auto:triage' })).toBe('webhook');
    expect(taskSourceOf({ command: 'auto:compliance' })).toBe('webhook');
    expect(taskSourceOf({ command: '/issue-triage' })).toBe('command');
    expect(taskSourceOf({ command: '@answer' })).toBe('command');
  });

  it('isWriteBackAllowed：只有 comment 受 source 约束', () => {
    expect(isWriteBackAllowed({ intent: 'comment', source: 'command' })).toBe(true);
    expect(isWriteBackAllowed({ intent: 'comment', source: 'webhook' })).toBe(false);
    expect(isWriteBackAllowed({ intent: 'comment', source: 'cron' })).toBe(false);
    // 标签 / 新建 issue / 推分支在两条通道里都一样
    expect(isWriteBackAllowed({ intent: 'label', source: 'webhook' })).toBe(true);
    expect(isWriteBackAllowed({ intent: 'create_issue', source: 'cron' })).toBe(true);
  });

  it('执行侧：自动通道的 comment 被跳过（不打 GitHub、不写 actions 行），label 照常执行', async () => {
    const api = createFakeWriteApi();
    const records: ActionRecord[] = [];
    const store = {
      async beginRun() {},
      async appendEvent() {},
      async recordEnvelope() {},
      async recordAction(record: ActionRecord) {
        records.push(record);
      },
      async recordUsage() {},
      async recordDegeneracyHit() {},
      async finishRun() {},
      async markTask() {},
    };

    const result = await executeActions({
      runId: 'run-1',
      repo: 'o/r',
      targetNumber: 7,
      actions: [
        { intent: 'comment', body: '结论' },
        { intent: 'label', add: ['bug'], remove: [] },
      ] as never,
      dryRun: false,
      source: 'webhook',
      api,
      target: TARGET,
      store,
      clock: () => 1_700_000_000_000,
    });

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'applied']);
    expect(result.outcomes[0]?.reason).toContain('自动通道零评论');
    // 只有 label 落了 actions 行
    expect(records.map((record) => record.intent)).toEqual(['label']);
    expect(api.calls.map((call) => call.method)).toEqual(['addLabels']);
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

describe('withMention：模型自拟的 `@agent` 换成真实提问人', () => {
  it('以 @agent 开头 → 换成 @alice（保留后面的正文与换行）', () => {
    expect(withMention('@agent 结论：缺复现步骤。', 'alice')).toBe('@alice 结论：缺复现步骤。');
    expect(withMention('@agent\n结论：缺复现步骤。', 'alice')).toBe('@alice\n结论：缺复现步骤。');
    expect(withMention('  @Agent 结论', 'alice')).toBe('@alice 结论');
  });

  it('@agentX 这类别的账号不算占位称呼（各 @ 各自的）', () => {
    expect(withMention('@agentX 你好', 'alice')).toBe('@alice @agentX 你好');
  });

  it('正文没有 @ 时照旧前缀', () => {
    expect(withMention('结论：信息不足。', 'alice')).toBe('@alice 结论：信息不足。');
  });
});
