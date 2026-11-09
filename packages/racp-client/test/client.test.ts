import { describe, expect, it } from 'vitest';
import { RacpClient, EVENT_NOTIFICATION_METHOD } from '../src/client.ts';
import { RacpError } from '../src/errors.ts';
import type { EventEnvelope } from '../src/schema.ts';
import {
  MOCK_DEVICE_TOKEN,
  MOCK_HOST_VERSION,
  MockHost,
  mockEvent,
  type MockRequestRecord,
} from './mock-host.ts';

const expectAsyncRacpError = async (run: () => Promise<unknown>, code: string): Promise<RacpError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RacpError);
    const racpError = error as RacpError;
    expect(racpError.code).toBe(code);
    return racpError;
  }
  throw new Error(`期望异步抛出 ${code}，但成功返回了`);
};

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function lastRequestOf(requests: readonly MockRequestRecord[], method: string): MockRequestRecord | undefined {
  return [...requests].reverse().find((request) => request.method === method);
}

describe('client：建连与握手', () => {
  it('connect() 发 connection/initialize 并校验结果形状；状态变 open', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN, expectedHostVersion: MOCK_HOST_VERSION });
      const result = await client.connect();
      expect(result.server.version).toBe(MOCK_HOST_VERSION);
      expect(client.state).toBe('open');
      expect(client.hostVersion).toBe(MOCK_HOST_VERSION);
      expect(client.connectionId).toBe('connection-1');
      expect(client.url).toBe(host.url);

      const initialize = lastRequestOf(host.requests, 'connection/initialize');
      expect(initialize).toBeDefined();
      // initialize 是连接级 operation：只带 protocolVersion，不带 params.context。
      const params = initialize?.params as Record<string, unknown>;
      expect(params).toMatchObject({ protocolVersion: '1.0' });
      expect(params).not.toHaveProperty('context');
    } finally {
      await host.close();
    }
  });

  it('协商出的 hostVersion 与 PIN 不符 → HOST_VERSION_MISMATCH（tech-plan §2.2 第 2 条）', async () => {
    const host = await MockHost.start({ hostVersion: '0.22.0' });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN, expectedHostVersion: '0.21.0' });
      const error = await expectAsyncRacpError(() => client.connect(), 'HOST_VERSION_MISMATCH');
      expect(error.details).toMatchObject({ expected: '0.21.0', actual: '0.22.0' });
      expect(error.retriable).toBe(false);
      expect(client.state).toBe('disconnected');
    } finally {
      await host.close();
    }
  });

  it('protocolVersion 不是 1.0 → PROTOCOL_MISMATCH', async () => {
    const host = await MockHost.start({ protocolVersion: '2.0' });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await expectAsyncRacpError(() => client.connect(), 'PROTOCOL_MISMATCH');
    } finally {
      await host.close();
    }
  });

  it('initialize 结果形状不对 → PROTOCOL_ERROR（不静默当成空对象）', async () => {
    const host = await MockHost.start({ handlers: { 'connection/initialize': () => ({ ok: true }) } });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await expectAsyncRacpError(() => client.connect(), 'PROTOCOL_ERROR');
    } finally {
      await host.close();
    }
  });

  it('没 connect 就调用 → NOT_CONNECTED，且消息里带方法名与状态', async () => {
    const client = new RacpClient({ port: 1, token: MOCK_DEVICE_TOKEN });
    const error = await expectAsyncRacpError(() => client.request('turn/get', {}), 'NOT_CONNECTED');
    expect(error.message).toContain('turn/get');
    expect(error.message).toContain('idle');
  });

  it('close() 之后调用 → CLIENT_CLOSED；close() 幂等', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      await client.close();
      await client.close();
      expect(client.state).toBe('closed');
      await expectAsyncRacpError(() => client.request('turn/get', {}), 'CLIENT_CLOSED');
      await expectAsyncRacpError(() => client.connect(), 'CLIENT_CLOSED');
    } finally {
      await host.close();
    }
  });
});

describe('client：请求/响应配对与超时', () => {
  it('并发两个请求：按 id 配对，不串台', async () => {
    const host = await MockHost.start({
      handlers: {
        'workspace/diff': async () => {
          await sleep(20);
          return { diff: 'diff-body' };
        },
        'connection/ping': () => ({ pong: 1 }),
      },
    });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      const [diff, pong] = await Promise.all([
        client.request<{ diff: string }>('workspace/diff', { sessionId: 's' }),
        client.request<{ pong: number }>('connection/ping', {}),
      ]);
      expect(diff).toEqual({ diff: 'diff-body' });
      expect(pong).toEqual({ pong: 1 });
      expect(client.inFlightCount).toBe(0);
    } finally {
      await host.close();
    }
  });

  it('Host 不回 → TIMEOUT，在飞表清空，后续请求仍可用', async () => {
    const host = await MockHost.start({ silentMethods: ['turn/get'] });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      const error = await expectAsyncRacpError(
        () => client.request('turn/get', { sessionId: 's', turnId: 't' }, { timeoutMs: 30 }),
        'TIMEOUT',
      );
      expect(error.failureClass).toBe('timeout');
      expect(client.inFlightCount).toBe(0);

      // 迟到的响应不应该让配对表错乱：再来一个正常请求照常工作。
      await expect(client.request('connection/ping', {})).resolves.toEqual({ pong: true });
    } finally {
      await host.close();
    }
  });

  it('调用方 AbortSignal 取消 → ABORTED（不是 TIMEOUT）', async () => {
    const host = await MockHost.start({ silentMethods: ['turn/get'] });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      const controller = new AbortController();
      const pending = client.request('turn/get', {}, { signal: controller.signal, timeoutMs: 5_000 });
      await waitFor(() => host.requests.some((request) => request.method === 'turn/get'));
      controller.abort(new Error('任务级时间闸'));
      const error = await expectAsyncRacpError(() => pending, 'ABORTED');
      expect(error.failureClass).toBe('timeout');
      expect(client.inFlightCount).toBe(0);
    } finally {
      await host.close();
    }
  });

  it('已 abort 的 signal 立即拒绝，且不发出请求', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      const controller = new AbortController();
      controller.abort();
      await expectAsyncRacpError(() => client.request('turn/get', {}, { signal: controller.signal }), 'ABORTED');
      expect(host.requests.some((request) => request.method === 'turn/get')).toBe(false);
    } finally {
      await host.close();
    }
  });

  it('Host 回的 RACP 错误（error.data 是 RemoteError）原样保留 code / retriable / traceId', async () => {
    const host = await MockHost.start({
      handlers: {
        'turn/get': () => {
          const payload = {
            code: 'AGENT_BUSY',
            message: 'session 正在跑另一个 turn',
            retriable: false,
            traceId: 'trace-1',
          };
          throw Object.assign(new Error('busy'), { payload });
        },
      },
    });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      // mock 在 handler 抛出时回的是 -32000 + INTERNAL 语义载荷；这里只断言「错误被映射成 RacpError」。
      const error = await expectAsyncRacpError(() => client.request('turn/get', {}), 'INTERNAL');
      expect(error.kind).toBe('rpc');
      expect(error.failureClass).toBe('sandbox');
    } finally {
      await host.close();
    }
  });
});

describe('client：断线语义（不重发）', () => {
  it('断线时在飞调用以 HOST_DISCONNECTED 拒绝，且 Host 只收到一次请求', async () => {
    const host = await MockHost.start({ silentMethods: ['turn/start'] });
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      const pending = client.request('turn/start', { sessionId: 's' }, { timeoutMs: 10_000 });
      await waitFor(() => host.requests.some((request) => request.method === 'turn/start'));

      const dispatches: Array<{ rejectedInFlight: number; wasClean: boolean }> = [];
      client.onDisconnect((info) => dispatches.push({ rejectedInFlight: info.rejectedInFlight, wasClean: info.wasClean }));

      host.terminateClients();
      const error = await expectAsyncRacpError(() => pending, 'HOST_DISCONNECTED');
      expect(error.retriable).toBe(true);
      expect(error.kind).toBe('transport');
      expect(client.inFlightCount).toBe(0);
      expect(client.state).toBe('disconnected');

      // 不重发：等一会儿，Host 侧那条 turn/start 仍然只有一次。
      await sleep(60);
      expect(host.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
      expect(dispatches).toEqual([{ rejectedInFlight: 1, wasClean: false }]);
    } finally {
      await host.close();
    }
  });

  it('同一条连接里不会自动恢复订阅：重连要调用方自己带游标重订阅', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      await client.connect();
      host.terminateClients();
      await waitFor(() => client.state === 'disconnected');

      // 重连：新 transport + 重新 initialize，但不会自动 events/subscribe。
      await client.connect();
      expect(client.state).toBe('open');
      expect(host.requests.filter((request) => request.method === 'events/subscribe')).toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});

describe('client：事件与 after 重放', () => {
  it('params 就是 EventEnvelope 时进 onEvent', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const events: EventEnvelope[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      host.sendEvent(mockEvent(1) as unknown as Record<string, unknown>);
      await waitFor(() => events.length === 1);
      expect(events[0]).toMatchObject({ eventId: 'event-1', kind: 'turn.started', sequence: 1 });
    } finally {
      await host.close();
    }
  });

  it('params.event 包一层的形状也能进 onEvent（fixture 未 vendored，两种都兜住）', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const events: EventEnvelope[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      host.sendNotification(EVENT_NOTIFICATION_METHOD, { event: mockEvent(2) });
      await waitFor(() => events.length === 1);
      expect(events[0]).toMatchObject({ eventId: 'event-2' });
    } finally {
      await host.close();
    }
  });

  it('events/subscribe 的 after 原样透传；Host 按游标补发后续事件', async () => {
    const host = await MockHost.start();
    try {
      host.pushEvent(mockEvent(1) as unknown as Record<string, unknown>);
      host.pushEvent(mockEvent(2) as unknown as Record<string, unknown>);
      host.pushEvent(mockEvent(3) as unknown as Record<string, unknown>);

      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const events: EventEnvelope[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      await client.request('events/subscribe', {
        sessionId: 'session-1',
        after: { epoch: 'epoch-1', sequence: 1 },
      });
      await waitFor(() => events.length === 2);
      expect(events.map((event) => event.sequence)).toEqual([2, 3]);
      // 游标原样发出去了（客户端没有自作聪明地改成 0 或省略）。
      const subscribe = lastRequestOf(host.requests, 'events/subscribe');
      expect(subscribe?.params).toMatchObject({ after: { epoch: 'epoch-1', sequence: 1 } });
    } finally {
      await host.close();
    }
  });

  it('after: 0 重放全部历史事件（tech-plan §4.3 第 3 步的写法）', async () => {
    const host = await MockHost.start();
    try {
      host.pushEvent(mockEvent(1) as unknown as Record<string, unknown>);
      host.pushEvent(mockEvent(2) as unknown as Record<string, unknown>);

      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const events: EventEnvelope[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();
      await client.request('events/subscribe', { sessionId: 'session-1', after: 0 });
      await waitFor(() => events.length === 2);
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    } finally {
      await host.close();
    }
  });

  it('不认识的通知方法进 onNotification（不丢），不进 onEvent', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const events: EventEnvelope[] = [];
      const notifications: Array<{ method: string; params: unknown }> = [];
      client.onEvent((event) => events.push(event));
      client.onNotification((notification) => notifications.push(notification));
      await client.connect();

      host.sendNotification('host/changed', { revision: 2 });
      await waitFor(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({ method: 'host/changed' });
      expect(events).toHaveLength(0);
    } finally {
      await host.close();
    }
  });

  it('binary 帧 → onError(BINARY_FRAME)，连接不断、后续请求照常', async () => {
    const host = await MockHost.start();
    try {
      const client = new RacpClient({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const errors: RacpError[] = [];
      client.onError((error) => errors.push(error));
      await client.connect();

      host.sendBinary('{"jsonrpc":"2.0","id":99,"result":1}');
      await waitFor(() => errors.length === 1);
      expect(errors[0]?.code).toBe('BINARY_FRAME');
      expect(client.state).toBe('open');
      await expect(client.request('connection/ping', {})).resolves.toEqual({ pong: true });
    } finally {
      await host.close();
    }
  });
});

describe('client：脱敏', () => {
  it('错误消息与 details 里的 pdt1./ppt1. 令牌被替换为 <redacted>', async () => {
    const host = await MockHost.start({ acceptedToken: 'pdt1.real-device-token-value' });
    try {
      const client = new RacpClient({ port: host.port, token: 'pdt1.leaked-in-message', handshakeTimeoutMs: 2_000 });
      const error = await expectAsyncRacpError(() => client.connect(), 'UNAUTHORIZED');
      const serialized = JSON.stringify({ message: error.message, details: error.details, json: error.toJSON() });
      expect(serialized).not.toContain('leaked-in-message');
      expect(serialized).not.toContain('real-device-token-value');
    } finally {
      await host.close();
    }
  });
});
