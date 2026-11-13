/**
 * `app/racp.ts` 事件喂的**按轮**语义 —— 只读工具轮（v2.3 §3 B，多轮 `driveTurn`）的根因回归。
 *
 * 要钉住的故障：`driveTurn()` 的时序是 `events/subscribe` → `turn/start` → 迭代 `events()`，
 * 消费方一拿到 `turn/*` 终态就 `return()`。老实现把这次 `return()` 当成「整条通道结束」
 * （单份 `EventFeed` 的 `ended=true`），于是第 2 轮迭代到的是「上一轮药渣 + 立刻 done」：
 * 实机表现 `terminal='stream-ended'`、事件数 0，工具轮白跑一轮。
 *
 * 手法：不连 WebSocket（本机没有 pi-host bundle），假 Host 落在 **operation 层** ——
 * `turnStart()` 像真 Host 那样往通道里 `push()` 事件：
 *  - `beforeReply`：`turn/start` 回包**之前**就推（模拟 Host 抢在 RPC 回包前面推送）；
 *  - `afterReply`：`turn/start` 回包**之后**异步推（这时本轮 feed 已经/即将建立）。
 * `driveTurn()` 与 `createChannelEventRouter()` 都是真的，所以「第 2 轮有没有拿到自己的
 * 事件」由真事件循环判定，不是桩说了算。
 *
 * 与 `runtime-turn-driver.test.ts` 的分工：那份钉的是单轮的调用顺序与时间闸，
 * 本文件只钉「事件归属哪一轮」以及单轮行为没有回退。
 */
import { describe, expect, it } from 'vitest';

import { createChannelEventRouter } from '../src/app/racp.ts';
import type { ChannelEventRouter } from '../src/app/racp.ts';
import { driveTurn } from '../src/runtime/turn-driver.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import type { EventEnvelope } from '../src/runtime/deps.ts';

const SESSION_ID = 'session-1';
const WORKTREE_ROOT = 'C:/jobs/1/work';
/** 每个 `next()` 最多等这么久：超时即判「挂住」（正常路径都在毫秒级落地）。 */
const WATCHDOG_MS = 500;

const HANG = Symbol('hang');

/** 给异步迭代加一个 watchdog：`HANG` = 没落地（= 挂住），而不是「没事件」。 */
async function within<T>(promise: Promise<T>): Promise<T | typeof HANG> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof HANG>((resolve) => {
    timer = setTimeout(() => {
      resolve(HANG);
    }, WATCHDOG_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** 取下一事件；`done` 或挂住都直接失败（这两条都是被断言的对象）。 */
async function nextEvent(iterator: AsyncIterator<EventEnvelope>, label: string): Promise<EventEnvelope> {
  const result = await within(iterator.next());
  if (result === HANG) {
    throw new Error(`${label}：next() 在 ${String(WATCHDOG_MS)}ms 内没有落地（挂住）`);
  }
  if (result.done === true) {
    throw new Error(`${label}：事件流提前结束了`);
  }
  return result.value;
}

/** 断言「立刻结束且不挂住」。 */
async function expectDone(iterator: AsyncIterator<EventEnvelope>, label: string): Promise<void> {
  const result = await within(iterator.next());
  if (result === HANG) {
    throw new Error(`${label}：next() 挂住（本该已经 done）`);
  }
  expect(result).toEqual({ done: true, value: undefined });
}

function envelope(
  turnId: string,
  sequence: number,
  kind: EventEnvelope['kind'],
  payload: unknown = {},
): EventEnvelope {
  return {
    eventId: `${turnId}-e${String(sequence)}`,
    scope: 'session',
    sessionId: SESSION_ID,
    turnId,
    epoch: 'epoch-1',
    sequence,
    revision: sequence,
    kind,
    occurredAt: '2026-06-01T00:00:00.000Z',
    payload,
  };
}

/** 一轮的「Host 脚本」：什么时候推哪几条事件。 */
interface RoundScript {
  readonly turnId: string;
  /** `turn/start` 回包**之前**推（这一段必须靠通道级 pending 缓冲接住）。 */
  readonly beforeReply?: readonly EventEnvelope[];
  /** `turn/start` 回包**之后**异步推（走本轮 feed）。 */
  readonly afterReply?: readonly EventEnvelope[];
}

interface FakeHost {
  readonly ops: TurnDriverOps;
  /** `turn/start` 的提示词（确认第 2 轮用的是工具结果段，不是重发原文）。 */
  readonly prompts: string[];
}

/**
 * 假 Host：`turnStart()` 按脚本把事件推进通道。
 *
 * `afterReply` 用 `setTimeout(…, 0)` 推：`driveTurn` 在 `turn/start` 之后紧接着调
 * `events()`，定时器要到下一个宏任务才跑，所以这一批一定落在「本轮 feed 已建立」之后。
 */
function createFakeHost(router: ChannelEventRouter, rounds: readonly RoundScript[]): FakeHost {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    ops: {
      async projectRegister() {
        return { projectId: 'project-1' };
      },
      async sessionCreate() {
        return { id: SESSION_ID };
      },
      async sessionAttach() {
        return { cursor: 0 };
      },
      async eventsSubscribe() {
        return {};
      },
      async turnStart(params) {
        prompts.push(params.input.text);
        const script = rounds[index];
        index += 1;
        if (script === undefined) {
          throw new Error(`假 Host 没有第 ${String(index)} 轮的脚本`);
        }
        for (const event of script.beforeReply ?? []) {
          router.push(event);
        }
        const after = script.afterReply ?? [];
        if (after.length > 0) {
          setTimeout(() => {
            for (const event of after) {
              router.push(event);
            }
          }, 0);
        }
        return { id: script.turnId };
      },
      async turnInterrupt() {
        return {};
      },
      async approvalRespond() {
        return {};
      },
      async inputRespond() {
        return {};
      },
      async workspaceDiff() {
        return { diff: '' };
      },
      async sessionArchive() {
        return {};
      },
    },
  };
}

/** 收一轮里 `onEvent` 见到的东西（kind 与 turnId：后者用来证明「不是上一轮药渣」）。 */
interface Seen {
  readonly kinds: string[];
  readonly turnIds: string[];
  readonly sequences: number[];
}

function createSeen(): Seen & {
  readonly sink: (event: EventEnvelope) => void;
} {
  const kinds: string[] = [];
  const turnIds: string[] = [];
  const sequences: number[] = [];
  return {
    kinds,
    turnIds,
    sequences,
    sink: (event) => {
      kinds.push(event.kind);
      turnIds.push(String(event.turnId ?? ''));
      if (typeof event.sequence === 'number') {
        sequences.push(event.sequence);
      }
    },
  };
}

describe('通道事件喂：按轮（多轮只读工具轮的根因）', () => {
  it('第 2 轮拿到的是自己的事件（不是空、不是第 1 轮药渣），并拿到终态 turn.completed', async () => {
    const router = createChannelEventRouter();
    const host = createFakeHost(router, [
      {
        turnId: 'turn-1',
        beforeReply: [envelope('turn-1', 1, 'turn.started')],
        afterReply: [
          envelope('turn-1', 2, 'item.completed', { text: '```json\n{"actions":[],"tool_calls":[]}\n```' }),
          envelope('turn-1', 3, 'turn.completed', { status: 'completed' }),
        ],
      },
      {
        turnId: 'turn-2',
        beforeReply: [envelope('turn-2', 4, 'turn.started')],
        afterReply: [
          envelope('turn-2', 5, 'item.completed', { text: '第二轮的结论' }),
          envelope('turn-2', 6, 'turn.completed', { status: 'completed' }),
        ],
      },
    ]);

    const firstSeen = createSeen();
    const first = await driveTurn({
      ops: host.ops,
      worktreeRoot: WORKTREE_ROOT,
      prompt: '第一轮的任务说明',
      messageId: 'run-1:1',
      session: { mode: 'ephemeral' },
      events: (context) => router.events(context),
      onEvent: firstSeen.sink,
    });

    expect(first.terminal).toBe('turn.completed');
    expect(first.events).toBe(3);
    expect(firstSeen.kinds).toEqual(['turn.started', 'item.completed', 'turn.completed']);
    expect(router.rounds).toBe(1);

    // ── 第 2 轮：与 `run-task.ts` 的工具轮同形（复用刚建好的会话，`after` = 上一轮游标）──
    const secondSeen = createSeen();
    const second = await driveTurn({
      ops: host.ops,
      worktreeRoot: WORKTREE_ROOT,
      prompt: '## 工具结果\n…',
      messageId: 'run-1:1:r2',
      session: {
        mode: 'persistent',
        sessionId: first.sessionId,
        ...(first.cursor === null ? {} : { after: first.cursor }),
      },
      events: (context) => router.events(context),
      onEvent: secondSeen.sink,
    });

    // 关键断言 1：第 2 轮拿到了终态（老实现这里恒为 `stream-ended`）
    expect(second.terminal).toBe('turn.completed');
    // 关键断言 2：事件数不是 0 —— 通道没有因为上一轮的 `return()` 变成「再也读不到」
    expect(second.events).toBe(3);
    expect(secondSeen.kinds).toEqual(['turn.started', 'item.completed', 'turn.completed']);
    // 关键断言 3：收到的是**这一轮**的事件，不是第 1 轮的药渣（turnId / sequence 都属于 turn-2）
    expect(secondSeen.turnIds).toEqual(['turn-2', 'turn-2', 'turn-2']);
    expect(secondSeen.sequences).toEqual([4, 5, 6]);
    // 两轮各自的提示词：第 2 轮用的是工具结果段（不是重发原文）
    expect(host.prompts).toEqual(['第一轮的任务说明', '## 工具结果\n…']);
    expect(second.cursor).toBe(6);
    expect(router.rounds).toBe(2);
  });

  it('单轮路径不变：条数/顺序照旧，return() 之后既不再投递也不挂住', async () => {
    const router = createChannelEventRouter();
    const host = createFakeHost(router, [
      {
        turnId: 'turn-1',
        beforeReply: [envelope('turn-1', 1, 'turn.started')],
        afterReply: [
          envelope('turn-1', 2, 'item.completed', { text: '结论' }),
          envelope('turn-1', 3, 'turn.completed', { status: 'completed' }),
        ],
      },
    ]);
    const seen = createSeen();
    let captured: AsyncIterable<EventEnvelope> | undefined;

    const result = await driveTurn({
      ops: host.ops,
      worktreeRoot: WORKTREE_ROOT,
      prompt: '单轮',
      messageId: 'run-2:1',
      events: (context) => {
        captured = router.events(context);
        return captured;
      },
      onEvent: seen.sink,
    });

    // 条数、顺序、终态：与改造前逐字节一致
    expect(result.terminal).toBe('turn.completed');
    expect(result.events).toBe(3);
    expect(seen.kinds).toEqual(['turn.started', 'item.completed', 'turn.completed']);
    expect(seen.sequences).toEqual([1, 2, 3]);
    expect(router.rounds).toBe(1);
    expect(captured).toBeDefined();

    // 消费方 `return()` 之后：这一轮不再投递，而且**不挂住**（立刻 done）
    const dead = captured![Symbol.asyncIterator]();
    await expectDone(dead, '单轮 return() 之后');

    // 通道里再来事件也不会让这条已经结束的轮次复活（它们进通道级缓冲，留给下一轮）
    router.push(envelope('turn-1', 4, 'item.delta', { text: '迟到的增量' }));
    expect(router.pendingCount).toBe(1);
    await expectDone(dead, '单轮 return() 之后（通道又来了事件）');
  });

  it('turn/start 与 events() 之间到达的事件不丢（通道级 pending 缓冲）', async () => {
    const router = createChannelEventRouter();
    // ① `events/subscribe` 之后、`turn/start` 之前；② `turn/start` 之后、`events()` 之前
    router.push(envelope('turn-1', 1, 'turn.started'));
    router.push(envelope('turn-1', 2, 'item.completed', { text: '抢跑的一条' }));
    expect(router.pendingCount).toBe(2);

    const round = router.events({ sessionId: SESSION_ID, turnId: 'turn-1' })[Symbol.asyncIterator]();
    expect(router.pendingCount).toBe(0);
    expect((await nextEvent(round, 'pending 搬运后第 1 条')).sequence).toBe(1);
    expect((await nextEvent(round, 'pending 搬运后第 2 条')).sequence).toBe(2);

    // 消费方拿到终态就 return（`driveTurn` 的做法）：此后到达的事件留给下一轮，不丢
    await round.return?.();
    router.push(envelope('turn-2', 3, 'turn.started'));
    expect(router.pendingCount).toBe(1);

    const next = router.events({ sessionId: SESSION_ID, turnId: 'turn-2' })[Symbol.asyncIterator]();
    const carried = await nextEvent(next, '第二轮开头');
    expect(carried.turnId).toBe('turn-2');
    expect(carried.sequence).toBe(3);
    await next.return?.();
  });

  it('断线（end()）：本轮正常收尾，下一轮立刻结束而不是挂住', async () => {
    const router = createChannelEventRouter();
    const round = router.events({ sessionId: SESSION_ID, turnId: 'turn-1' })[Symbol.asyncIterator]();

    const pendingNext = nextEvent(round, '断线前的第 1 条');
    // 断线 = 本轮事件流到此为止：迭代必须落地（`done`），不能挂着等一个永远不来的终态
    router.push(envelope('turn-1', 1, 'turn.started'));
    expect((await pendingNext).kind).toBe('turn.started');
    router.end();
    await expectDone(round, '断线之后当前轮');

    // 断线之后仍被调起的一轮同样立刻结束（`driveTurn` 于是走到 `stream-ended`，不挂到超时）
    const afterEnd = router.events({ sessionId: SESSION_ID, turnId: 'turn-2' })[Symbol.asyncIterator]();
    await expectDone(afterEnd, '断线之后新起的一轮');
  });
});
