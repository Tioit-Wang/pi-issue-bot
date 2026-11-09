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
 * 一条可用连接交给 worker 的三样东西。
 *
 * `events` 的签名与 `TaskRunnerDeps.events` 一致（`{sessionId, turnId} => AsyncIterable`），
 * 它是**本轮**的事件流：`driveTurn` 在 `turn/start` 之后才开始迭代，而 `events/subscribe`
 * 的结果早于它 —— 所以这里必须自己缓冲，不能指望「订阅晚于事件」不发生。
 */
export interface RacpChannel {
  readonly ops: TurnDriverOps;
  readonly events: (context: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => AsyncIterable<EventEnvelope>;
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

    const feed = createEventFeed();
    const offEvent = client.onEvent((event) => {
      feed.push(event);
    });
    const offClose = client.onDisconnect((info) => {
      // 断线 = 本轮事件流到此为止：让 `driveTurn` 以 `stream-ended` 收尾，而不是挂着等
      logger.warn({ code: info.code, reason: info.reason }, 'RACP 连接断开，结束本轮事件流');
      feed.end();
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
      events: () => feed.iterable(),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        offEvent();
        offClose();
        feed.end();
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
