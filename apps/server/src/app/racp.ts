/**
 * 装配层：**一次 run 一条 RACP 通道**（`pi-host` 的 WebSocket 连接）。
 *
 * 为什么通道是「每 run 一个」而不是「进程一个」：
 *  - `TaskRunnerDeps.ops` / `deps.events` 都是**静态**注入点，而 RACP 的 `ops` 必须绑定到
 *    一条具体连接（`RacpOps` 持 `RacpClient`）。把连接做成进程级单例，就得让 `ops` 在
 *    内部维护「当前连接」，并发 3 个任务时这条「当前」立刻不成立；
 *  - 断线语义（`client.ts` 第 2 条）也要求「断线 → 在飞调用全拒、不重发」。一条连接的
 *    生命周期与一次 run 对齐，最省心。
 *
 * 代价：每次 run 多一次 handshake（`connection/initialize`）。这个开销相对于按分钟计的
 * turn 可以忽略，换来的是「谁在什么时候连着 host」一目了然。
 *
 * 注入：`RacpChannelFactory` 是唯一入口，默认实现真连 pi-host（本机没有 bundle，所以
 * 端到端测试注入的是「连着自建假 host 的同一个真客户端」，见 `test/helpers/fake-racp-host.ts`）。
 */
import { AppError, createNullLogger } from '../../../../packages/shared/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { RacpClient, RacpOps } from '../../../../packages/racp-client/src/index.ts';
import type { EventEnvelope } from '../../../../packages/racp-client/src/index.ts';
import type { TurnDriverOps } from '../runtime/index.ts';
import type { HostEndpoint } from '../worker/index.ts';

/** 通道装配的错误码（都是「配置/环境不对」，不是程序 bug）。 */
export const RACP_CHANNEL_ERROR_CODES = {
  tokenMissing: 'RACP_TOKEN_MISSING',
  connectFailed: 'RACP_CONNECT_FAILED',
} as const;

/**
 * 一份事件流的入参（与 `TaskRunnerDeps.events` / `TurnDriverParams.events` 同形）。
 *
 * `turnId` 是**这一轮**的 id：`driveTurn()` 在 `turn/start` 之后才把它交下来，
 * 所以「这一轮的事件该给谁」只能由通道自己按调用顺序推断（见 `createChannelEventRouter`）。
 */
export interface RacpEventContext {
  readonly sessionId: string;
  readonly turnId: string;
}

/**
 * 一条可用连接交给 worker 的三样东西。
 *
 * `events` 的签名与 `TaskRunnerDeps.events` 一致（`{sessionId, turnId} => AsyncIterable`），
 * 它是**本轮**的事件流：`driveTurn` 在 `turn/start` 之后才开始迭代，而 `events/subscribe`
 * 的结果早于它 —— 所以这里必须自己缓冲，不能指望「订阅晚于事件」不发生。
 * 每次调用返回的是**新的一份** feed（上一轮 `return()` 只结束上一轮，见
 * `createChannelEventRouter()`），否则第 2 轮只能读到「上一轮药渣 + 立刻结束」。
 */
export interface RacpChannel {
  readonly ops: TurnDriverOps;
  readonly events: (context: RacpEventContext) => AsyncIterable<EventEnvelope>;
  readonly close: () => Promise<void>;
}

export type RacpChannelFactory = (endpoint: HostEndpoint) => Promise<RacpChannel>;

export interface CreateRacpChannelFactoryOptions {
  readonly logger?: Logger;
  /** pi-host 只监听 loopback（§3.1）。 */
  readonly host?: string;
  /** `PIN.json` 里的 hostVersion；给了就必须协商一致（§2.2）。 */
  readonly expectedHostVersion?: string;
  /** 单次 operation 超时（分钟级的 turn 不在这一次里等，只有握手与短调用）。 */
  readonly requestTimeoutMs?: number;
}

/** 默认 host 地址：pi-host 只在 loopback 上（tech-plan §3.1）。 */
export const DEFAULT_RACP_HOST = '127.0.0.1';

/**
 * 单订阅者事件缓冲：`push` 可早于迭代开始（订阅响应先到、事件后到）。
 *
 * 为什么不用数组 + 索引：`driveTurn` 只消费一次且必须**阻塞等**新事件 —— 事件流结束时
 * （`turn/*` 终态之后没有更多事件）循环靠终态判据退出，不靠 `done`，但 `done` 仍要正确，
 * 否则 `for await` 会挂住。
 *
 * 一份 `EventFeed` 对应**一轮** turn：它是「从游标起的一段流」，不是「通道的一生」。
 * 谁来决定事件进哪份 feed 是 `createChannelEventRouter()` 的事。
 */
export interface EventFeed {
  push(event: EventEnvelope): void;
  end(): void;
  iterable(): AsyncIterable<EventEnvelope>;
  readonly size: number;
}

export function createEventFeed(): EventFeed {
  const buffer: EventEnvelope[] = [];
  let ended = false;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };

  return {
    push(event) {
      buffer.push(event);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    get size() {
      return buffer.length;
    },
    iterable() {
      return {
        [Symbol.asyncIterator](): AsyncIterator<EventEnvelope, undefined> {
          return {
            async next(): Promise<IteratorResult<EventEnvelope, undefined>> {
              for (;;) {
                const next = buffer.shift();
                if (next !== undefined) {
                  return { done: false, value: next };
                }
                if (ended) {
                  return { done: true, value: undefined };
                }
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
            },
            async return(): Promise<IteratorResult<EventEnvelope, undefined>> {
              // 消费方提前退出（终态事件已到）：把余下的丢掉，避免内存里堆一整轮事件
              ended = true;
              buffer.length = 0;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}

/**
 * 通道级事件分发：把 Host 推来的事件按**轮**交给 `events()` 建立的那份 feed。
 *
 * 为什么必须按轮（一份通道级缓冲不够）：
 *  - `driveTurn()` 的顺序是 `events/subscribe` → `turn/start` → 迭代 `events()`，
 *    所以一次订阅拿到的只是**从游标起的一段流**，不是「这条通道的一生」；
 *  - 消费方一看到 `turn/*` 终态就 `return()`。老实现把这次 `return()` 当成「通道结束」
 *    （`ended=true`），于是第 2 轮迭代到的是「上一轮药渣 + 立刻 done」：实机表现为
 *    `terminal='stream-ended'`、事件数 0 —— 只读工具轮白跑一轮。
 *
 * 于是状态分两层，边界就落在这里：
 *  - `buffered`：**还没归属到任何一轮**的事件。订阅响应之后、`turn/start` 之后、直到本轮
 *    `events()` 建立之前到达的事件（含第 1 轮 `return()` 之后、第 2 轮 `events()` 之前那一段）
 *    全落这里，不能丢；
 *  - `current`：本轮正在被迭代的那份 feed。`return()` 只摘掉它，通道仍然活着，
 *    下一轮 `events()` 会拿到一份新 feed。
 *
 * 断线 / `close()` 走 `end()`：结束当前轮，并让之后建立的每一轮立刻 `done`
 * —— 「断线 = 本轮到此为止」，不能因为按轮改造就变成「挂住等一个永远不来的终态」。
 */
export interface ChannelEventRouter {
  /** Host 推来一条事件（`client.onEvent()` 的落地）。 */
  push(event: EventEnvelope): void;
  /** 本轮的事件流（`driveTurn()` 在 `turn/start` **之后**才调它）。 */
  events(context: RacpEventContext): AsyncIterable<EventEnvelope>;
  /** 断线 / 关闭：结束当前轮；之后再起的轮次立刻结束（不挂住）。 */
  end(): void;
  /** 还没归属到某一轮的事件条数（观测与测试用）。 */
  readonly pendingCount: number;
  /** 已经建立过几轮 feed（观测与测试用）。 */
  readonly rounds: number;
}

export function createChannelEventRouter(): ChannelEventRouter {
  /** 还没归属到某一轮的事件（见上面的两层状态说明）。 */
  const buffered: EventEnvelope[] = [];
  /** 本轮 feed；`null` = 没有轮在迭代，新事件一律进 `buffered`。 */
  let current: EventFeed | null = null;
  /** 通道级终态（断线 / close）：它之后建立的每一轮都立刻结束。 */
  let ended = false;
  let rounds = 0;

  /**
   * 一轮的 iterable：`return()` 只结束**这一份** feed（内含的余量由
   * `createEventFeed()` 自己丢掉），通道级状态保持原样。
   *
   * 为什么必须在这里摘掉 `current`：不摘的话，本轮之后到达的事件会继续压进这份
   * 已经没人在读的 feed —— 既读不到（消费方已经 return），又永远等不到下一轮。
   */
  const roundOf = (feed: EventFeed): AsyncIterable<EventEnvelope> => ({
    [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
      const inner = feed.iterable()[Symbol.asyncIterator]();
      return {
        next: () => inner.next(),
        return: async () => {
          if (current === feed) {
            current = null;
          }
          return inner.return === undefined ? { done: true, value: undefined } : inner.return();
        },
      };
    },
  });

  return {
    push(event) {
      if (current !== null) {
        current.push(event);
        return;
      }
      // 没有轮在迭代（订阅之后 / `turn/start` 之前 / 上一轮 `return()` 之后）：先存通道级缓冲。
      // 断线之后照旧入缓冲而不是丢弃 —— 与改造前一致（那时 `feed.push()` 也是照收），
      // 差别只是现在这些事件不会再等来一次「同一条 feed 的继续读」。
      buffered.push(event);
    },
    get pendingCount() {
      return buffered.length;
    },
    get rounds() {
      return rounds;
    },
    events(_context) {
      rounds += 1;
      const feed = createEventFeed();
      // 把「订阅之后 / `turn/start` 之后 / 本轮迭代之前」到达的事件搬进新 feed。
      // 只按到达顺序 append、不重排：`sequence` 的单调性由 Host 保证。
      for (const event of buffered) {
        feed.push(event);
      }
      buffered.length = 0;
      current = feed;
      if (ended) {
        // 断线之后仍被调起的一轮：先让它读完残留，再立刻 `done`
        // （`driveTurn` 于是以 `stream-ended` 收尾，而不是挂到任务级超时）
        feed.end();
      }
      return roundOf(feed);
    },
    end() {
      ended = true;
      const feed = current;
      current = null;
      // `feed.end()` **不清**缓冲：消费方先把已到的事件读完再拿到 `done`，
      // 与改造前「断线只置 `ended`」逐字节一致。
      feed?.end();
    },
  };
}

/**
 * 默认通道工厂：`RacpClient.connect()` → `RacpOps` → 事件缓冲。
 *
 * 失败一律抛 `AppError`（`failureClass:'unknown'`，`retriable:true` 只在**连接**阶段成立）：
 * worker 的 `signalFromError` 会把它们归成 `unknown`/`sandbox-crash` 之外的分类，
 * 不会误判成「任务逻辑有问题」。
 */
export function createRacpChannelFactory(
  options: CreateRacpChannelFactoryOptions = {},
): RacpChannelFactory {
  const logger = options.logger ?? createNullLogger();
  const host = options.host ?? DEFAULT_RACP_HOST;

  return async (endpoint) => {
    if (endpoint.token === undefined || endpoint.token === '') {
      throw new AppError(
        'RACP 连不上：没有设备令牌（PI_BOT_HOST_TOKEN / host_credentials）。先跑 `pi-bot bootstrap-host` 配对',
        {
          code: RACP_CHANNEL_ERROR_CODES.tokenMissing,
          failureClass: 'unknown',
          retriable: false,
          details: { hostId: endpoint.hostId, port: endpoint.port, version: endpoint.version },
        },
      );
    }

    const client = new RacpClient({
      port: endpoint.port,
      host,
      token: endpoint.token,
      clientInfo: { name: 'pi-bot', version: '0.1.0' },
      ...(options.expectedHostVersion === undefined
        ? {}
        : { expectedHostVersion: options.expectedHostVersion }),
      ...(options.requestTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.requestTimeoutMs }),
    });

    // 通道级分发器：`client.onEvent` 只往这里塞，由它决定这条事件属于哪一轮
    // （没有轮在迭代时进通道级缓冲，见 `createChannelEventRouter()`）。
    const router = createChannelEventRouter();
    const offEvent = client.onEvent((event) => {
      router.push(event);
    });
    const offClose = client.onDisconnect((info) => {
      // 断线 = **本轮**事件流到此为止：让 `driveTurn` 以 `stream-ended` 收尾，而不是挂着等。
      // 注意这里断的是「这一轮」而不是「这条通道还能不能起下一轮」——
      // 但连接都断了就没有下一轮可跑，所以 `router.end()` 同时把之后的轮次也置为立刻结束。
      logger.warn({ code: info.code, reason: info.reason }, 'RACP 连接断开，结束本轮事件流');
      router.end();
    });

    try {
      await client.connect();
    } catch (error) {
      offEvent();
      offClose();
      await client.close().catch(() => undefined);
      throw new AppError('连不上 pi-host', {
        code: RACP_CHANNEL_ERROR_CODES.connectFailed,
        failureClass: 'unknown',
        retriable: true,
        details: { host, port: endpoint.port, hostId: endpoint.hostId },
        cause: error,
      });
    }

    logger.debug({ hostId: endpoint.hostId, port: endpoint.port }, 'RACP 已连接');

    const ops = new RacpOps(client);
    let closed = false;

    return {
      ops,
      // 每轮 `events()` 拿一份**新的** feed：上一轮的 `return()` 只结束上一轮，
      // 第 2 轮（只读工具轮）才有源可读。
      events: (context) => router.events(context),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        offEvent();
        offClose();
        router.end();
        await client.close().catch((error: unknown) => {
          // 关闭失败不影响任务结论（连接已经没用了），只记日志
          logger.warn({ err: String(error) }, 'RACP 关闭时出错（已忽略）');
        });
      },
    };
  };
}

/** 没有 host 时用的通道工厂：调用即抛，错误信息直指「本机没有 bundle」。 */
export function createUnavailableRacpChannelFactory(reason: string): RacpChannelFactory {
  return async () => {
    throw new AppError(`RACP 通道不可用：${reason}`, {
      code: RACP_CHANNEL_ERROR_CODES.connectFailed,
      failureClass: 'unknown',
      retriable: false,
    });
  };
}
