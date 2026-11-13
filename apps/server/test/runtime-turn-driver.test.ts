/**
 * `runtime/turn-driver.ts` 的单测：tech-plan §4.3 的调用顺序与 §4.7 的任务级时间闸。
 *
 * 用假 `ops` 记录调用序列（真实 `RacpOps` 需要 Host，本机没有 bundle），
 * 用假事件流驱动审批/反问/终态三条分支，并验证：
 *  1. 顺序严格是 register → create → subscribe → start → 事件 → diff → archive；
 *  2. 超时先 `turn/interrupt` 再抛出 `failureClass:'timeout'`；
 *  3. 取消（父 signal）走同一条中断路径，分类是 `interrupt`；
 *  4. 事件流先结束（没有终态事件）时仍归档，并如实报告 `stream-ended`。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TURN_TIMEOUT_MS,
  REVIEW_PR_TURN_TIMEOUT_MS,
  driveTurn,
  extractApprovalRequest,
  extractInputRequest,
  isTurnTimeout,
} from '../src/runtime/turn-driver.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import { resolve } from 'node:path';
import type { EventEnvelope } from '../src/runtime/deps.ts';
import type { ApprovalAudit } from '../src/runtime/approval-policy.ts';

const ROOT = resolve('/jobs/1/work');
const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
const PROJECT_ID = 'project-1';

type Call = { readonly method: string; readonly params: Record<string, unknown> };

/** 假 ops：记录调用顺序，返回最小可用结果。 */
function createFakeOps(): TurnDriverOps & { readonly calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string, params: Record<string, unknown>): void => {
    calls.push({ method, params });
  };

  return {
    calls,
    projectRegister: async (params) => {
      record('project/register', { ...params });
      return { projectId: PROJECT_ID };
    },
    sessionCreate: async (params) => {
      record('session/create', { ...params });
      return { id: SESSION_ID };
    },
    eventsSubscribe: async (params) => {
      record('events/subscribe', { ...params });
      return {};
    },
    turnStart: async (params) => {
      record('turn/start', { sessionId: params.sessionId, messageId: params.input.messageId, text: params.input.text });
      return { id: TURN_ID };
    },
    turnInterrupt: async (params) => {
      record('turn/interrupt', { ...params });
      return {};
    },
    approvalRespond: async (params) => {
      record('approval/respond', { ...params });
      return {};
    },
    inputRespond: async (params) => {
      record('input/respond', { approvalId: undefined, inputId: params.inputId, answers: params.answers });
      return {};
    },
    workspaceDiff: async (params) => {
      record('workspace/diff', { ...params });
      return { diff: 'diff --git a/x b/x', truncated: false };
    },
    sessionArchive: async (params) => {
      record('session/archive', { ...params });
      return {};
    },
  };
}

function event(index: number, kind: EventEnvelope['kind'], payload: unknown = {}): EventEnvelope {
  return {
    eventId: `e-${String(index)}`,
    scope: 'session',
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    epoch: 'epoch-1',
    sequence: index,
    revision: index,
    kind,
    occurredAt: '2026-06-01T00:00:00.000Z',
    payload,
  };
}

function stream(events: readonly EventEnvelope[]): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]: async function* generator() {
      for (const item of events) {
        yield item;
      }
    },
  };
}

/** 永不结束的事件流（用来验证 deadline）。 */
function forever(first: EventEnvelope, onFirst?: () => void): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]: async function* generator() {
      yield first;
      onFirst?.();
      await new Promise<void>(() => {});
    },
  };
}

const APPROVAL_INSIDE = {
  id: 'approval-1',
  toolName: 'Write',
  input: { path: 'src/a.ts' },
};
const APPROVAL_OUTSIDE = {
  id: 'approval-2',
  toolName: 'Write',
  input: { path: '../../etc/passwd' },
};

describe('调用顺序（tech-plan §4.3）', () => {
  it('register → create → subscribe → start → 事件 → diff → archive', async () => {
    const ops = createFakeOps();
    const audits: ApprovalAudit[] = [];
    const seen: string[] = [];

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: '/review-pr 42',
      messageId: 'msg-1',
      title: 'task 42',
      events: () =>
        stream([
          event(1, 'turn.started'),
          event(2, 'approval.requested', APPROVAL_INSIDE),
          event(3, 'approval.requested', APPROVAL_OUTSIDE),
          event(4, 'input.requested', { id: 'input-1', questions: [{ id: 'q1', question: '分支名？' }] }),
          event(5, 'turn.completed'),
        ]),
      onEvent: (item) => {
        seen.push(item.kind);
      },
      onAudit: (audit) => {
        audits.push(audit);
      },
    });

    expect(ops.calls.map((call) => call.method)).toEqual([
      'project/register',
      'session/create',
      'events/subscribe',
      'turn/start',
      'approval/respond',
      'approval/respond',
      'input/respond',
      'workspace/diff',
      'session/archive',
    ]);

    // 第 1/2/3/4 步的参数契约
    expect(ops.calls[0]?.params).toEqual({ path: ROOT });
    expect(ops.calls[1]?.params).toMatchObject({
      projectId: PROJECT_ID,
      permissionMode: 'ask',
      mode: 'agent',
      title: 'task 42',
    });
    expect(ops.calls[2]?.params).toEqual({ sessionId: SESSION_ID, after: 0 });
    expect(ops.calls[3]?.params).toMatchObject({ sessionId: SESSION_ID, messageId: 'msg-1', text: '/review-pr 42' });

    // 审批：worktree 内 allow-once、越界 deny
    expect(ops.calls[4]?.params).toEqual({ approvalId: 'approval-1', decision: 'allow-once' });
    expect(ops.calls[5]?.params).toEqual({ approvalId: 'approval-2', decision: 'deny' });
    // 反问：固定应答
    expect(ops.calls[6]?.params).toMatchObject({ inputId: 'input-1', answers: [['无法提供，按现有信息继续']] });

    expect(result).toMatchObject({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      terminal: 'turn.completed',
      events: 5,
      approvals: 2,
      denies: 1,
      inputs: 1,
      eventSinkErrors: 0,
      archived: true,
    });
    expect(result.diff.diff).toContain('diff --git');
    expect(seen).toEqual(['turn.started', 'approval.requested', 'approval.requested', 'input.requested', 'turn.completed']);
    expect(audits).toHaveLength(3);
    expect(audits.map((audit) => audit.decision)).toEqual(['allow', 'deny', 'answer']);
  });

  it('事件流先结束（没有终态事件）→ terminal=stream-ended，仍然归档', async () => {
    const ops = createFakeOps();
    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events: () => stream([event(1, 'turn.started')]),
    });

    expect(result.terminal).toBe('stream-ended');
    expect(ops.calls.map((call) => call.method)).toContain('session/archive');
    expect(ops.calls.some((call) => call.method === 'turn/interrupt')).toBe(false);
  });

  it('onEvent 抛错不杀任务：只计 eventSinkErrors', async () => {
    const ops = createFakeOps();
    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events: () => stream([event(1, 'turn.started'), event(2, 'turn.completed')]),
      onEvent: () => {
        throw new Error('DB down');
      },
    });

    expect(result.eventSinkErrors).toBe(2);
    expect(result.terminal).toBe('turn.completed');
  });

  it('载荷解析不出来的审批/反问：跳过应答，不猜测放行', async () => {
    const ops = createFakeOps();
    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events: () =>
        stream([
          event(1, 'approval.requested', { unexpected: true }),
          event(2, 'input.requested', { unexpected: true }),
          event(3, 'turn.completed'),
        ]),
    });

    expect(result.approvals).toBe(0);
    expect(result.inputs).toBe(0);
    expect(ops.calls.some((call) => call.method === 'approval/respond')).toBe(false);
    expect(ops.calls.some((call) => call.method === 'input/respond')).toBe(false);
  });

  it('system 提示词只走「新建会话」：attach 复用不传，空串也不发', async () => {
    const ops = createFakeOps();
    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      systemPrompt: '你是 pi-bot（测试用身份）',
      messageId: 'm',
      events: () => stream([event(1, 'turn.completed')]),
    });
    const created = ops.calls.find((call) => call.method === 'session/create');
    // 身份说明进 system 通道（`session/create`），任务提示词那条 `turn/start` 里不该有它
    expect(created?.params).toMatchObject({ systemPrompt: '你是 pi-bot（测试用身份）' });
    const started = ops.calls.find((call) => call.method === 'turn/start');
    expect(started?.params['text']).toBe('p');

    // 会话已存在（persistent + attach 成功）→ 不建会话，也就没有 system 通道可带身份：
    // 身份由创建那一刻决定，再传一次等于给同一条会话两个身份来源。
    const reuseOps: TurnDriverOps & { readonly calls: Call[] } = {
      ...createFakeOps(),
      sessionAttach: async () => ({ cursor: 7 }),
    };
    await driveTurn({
      ops: reuseOps,
      worktreeRoot: ROOT,
      prompt: 'p',
      systemPrompt: '你不该被发送',
      messageId: 'm',
      session: { mode: 'persistent', sessionId: SESSION_ID, after: 7 },
      events: () => stream([event(1, 'turn.completed')]),
    });
    expect(reuseOps.calls.some((call) => call.method === 'session/create')).toBe(false);
    expect(reuseOps.calls.some((call) => JSON.stringify(call.params).includes('你不该被发送'))).toBe(false);

    // 空串不发：空串进 system 通道等于「这条会话没有身份」，还让 Host 多一条空值记录
    const blankOps = createFakeOps();
    await driveTurn({
      ops: blankOps,
      worktreeRoot: ROOT,
      prompt: 'p',
      systemPrompt: '',
      messageId: 'm',
      events: () => stream([event(1, 'turn.completed')]),
    });
    const blankCreate = blankOps.calls.find((call) => call.method === 'session/create');
    expect(blankCreate?.params).not.toHaveProperty('systemPrompt');
  });
});

describe('任务级时间闸（tech-plan §4.7）', () => {
  it('默认 20min，/review-pr 用 30min（常量可测、可由参数覆盖）', () => {
    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(20 * 60 * 1_000);
    expect(REVIEW_PR_TURN_TIMEOUT_MS).toBe(30 * 60 * 1_000);
  });

  it('超时：先 turn/interrupt（幂等）→ session/archive → 抛 failureClass=timeout', async () => {
    const ops = createFakeOps();

    const error = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      timeoutMs: 20,
      events: () => forever(event(1, 'turn.started')),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ failureClass: 'timeout', code: 'DEADLINE_EXCEEDED', retriable: false });
    const methods = ops.calls.map((call) => call.method);
    expect(methods).toContain('turn/interrupt');
    expect(methods).toContain('session/archive');
    expect(ops.calls.find((call) => call.method === 'turn/interrupt')?.params).toEqual({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
    });
    // interrupt 与 archive 都在抛错之前
    expect(methods.indexOf('turn/interrupt')).toBeLessThan(methods.indexOf('session/archive'));
    expect(isTurnTimeout(error)).toBe(true);
  });

  it('取消（父 signal）：同样走 interrupt 路径，分类是 interrupt', async () => {
    const ops = createFakeOps();
    const controller = new AbortController();

    const error = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      parent: controller.signal,
      events: () => forever(event(1, 'turn.started'), () => controller.abort()),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ failureClass: 'interrupt' });
    expect(ops.calls.some((call) => call.method === 'turn/interrupt')).toBe(true);
    expect(isTurnTimeout(error)).toBe(false);
  });

  it('还没拿到 sessionId 就失败：不调用 turn/interrupt（没有可中断的 turn）', async () => {
    const ops = createFakeOps();
    const failing: TurnDriverOps = {
      ...ops,
      sessionCreate: async () => {
        throw new Error('HOST_DISCONNECTED');
      },
    };

    await expect(
      driveTurn({
        ops: failing,
        worktreeRoot: ROOT,
        prompt: 'p',
        messageId: 'm',
        events: () => stream([event(1, 'turn.completed')]),
      }),
    ).rejects.toThrow(/HOST_DISCONNECTED/);

    expect(ops.calls.some((call) => call.method === 'turn/interrupt')).toBe(false);
  });

  it('turn/interrupt 自己也失败时：不掩盖原始超时错误', async () => {
    const ops = createFakeOps();
    const failing: TurnDriverOps = {
      ...ops,
      turnInterrupt: async () => {
        throw new Error('already finished');
      },
    };

    const error = await driveTurn({
      ops: failing,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      timeoutMs: 20,
      events: () => forever(event(1, 'turn.started')),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ failureClass: 'timeout' });
    // 归档仍然尝试过
    expect(ops.calls.some((call) => call.method === 'session/archive')).toBe(true);
  });
});

describe('事件载荷解析（容忍两种嵌套）', () => {
  it('approval.requested：平铺与 {approval, tool} 两种形态都能取到 tool 名与入参', () => {
    expect(extractApprovalRequest({ id: 'a1', toolName: 'Bash', input: { command: 'ls' } })).toEqual({
      id: 'a1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });

    expect(
      extractApprovalRequest({
        approval: { id: 'a2', kind: 'tool', summary: 'write file' },
        tool: { name: 'Write', input: { path: 'a.ts' } },
      }),
    ).toEqual({
      id: 'a2',
      toolName: 'Write',
      toolInput: { path: 'a.ts' },
      kind: 'tool',
      summary: 'write file',
    });

    expect(extractApprovalRequest({ noId: true })).toBeUndefined();
    expect(extractApprovalRequest('not-an-object')).toBeUndefined();
  });

  it('input.requested：questions 缺失也给出空列表（不炸）', () => {
    expect(extractInputRequest({ id: 'i1' })).toEqual({ id: 'i1', questions: [] });
    expect(extractInputRequest({ input: { id: 'i2', questions: [{ id: 'q', question: 'why' }] } })).toEqual({
      id: 'i2',
      questions: [{ id: 'q', question: 'why' }],
    });
    expect(extractInputRequest({})).toBeUndefined();
  });
});
