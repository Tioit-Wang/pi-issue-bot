import { WebSocket as WsWebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import {
  RacpTransport,
  RACP_LOOPBACK_HOSTS,
  RACP_WS_PATH,
  RACP_WS_SUBPROTOCOL,
  assertBearerToken,
  assertLoopbackHost,
  buildAuthorizationHeader,
  buildRacpUrl,
  type CloseInfo,
  type WebSocketHandshakeOptions,
  type WebSocketLike,
} from '../src/transport.ts';
import { RacpError } from '../src/errors.ts';
import { MOCK_DEVICE_TOKEN, MockHost } from './mock-host.ts';

const expectRacpError = (run: () => unknown, code: string): RacpError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RacpError);
    const racpError = error as RacpError;
    expect(racpError.code).toBe(code);
    return racpError;
  }
  throw new Error(`期望抛出 ${code}，但什么都没抛`);
};

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

/** 可注入的假 socket：用来精确复现「握手成功但子协议不对」「连接卡住」这类真服务器造不出的分支。 */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  protocol = '';
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener as unknown as (...args: unknown[]) => void);
    this.#listeners.set(event, list);
    return this;
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string): void {
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

describe('transport：握手常量必须是字面量（tech-plan §4.2）', () => {
  it('路径与子协议就是文档里那两个字面量', () => {
    expect(RACP_WS_PATH).toBe('/v1/racp/ws');
    expect(RACP_WS_SUBPROTOCOL).toBe('pi-racp.v1.jsonrpc');
  });

  it('完整 URL：默认 127.0.0.1，IPv6 用方括号，端口来自 PI_HOST_READY', () => {
    expect(buildRacpUrl(7300)).toBe('ws://127.0.0.1:7300/v1/racp/ws');
    expect(buildRacpUrl(7300, 'localhost')).toBe('ws://localhost:7300/v1/racp/ws');
    expect(buildRacpUrl(7300, '::1')).toBe('ws://[::1]:7300/v1/racp/ws');
    expect(buildRacpUrl(7300, '[::1]')).toBe('ws://[::1]:7300/v1/racp/ws');
    expect(buildRacpUrl(7300, ' 127.0.0.1 ')).toBe('ws://127.0.0.1:7300/v1/racp/ws');
  });

  it('loopback 白名单只有文档里的三个', () => {
    expect([...RACP_LOOPBACK_HOSTS]).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  it('Authorization 头的值形如 Bearer <pdt1.…>', () => {
    expect(buildAuthorizationHeader(MOCK_DEVICE_TOKEN)).toBe(`Bearer ${MOCK_DEVICE_TOKEN}`);
  });
});

describe('transport：该失败的时候必须显式失败', () => {
  it('非 loopback 一律拒绝（pi-host 侧也会拒，我们不在本地装作能连）', () => {
    for (const host of ['10.0.0.5', '0.0.0.0', 'example.com', '127.0.0.2', '::', '']) {
      expectRacpError(() => assertLoopbackHost(host), 'INVALID_ARGUMENT');
    }
    // 单条错误消息里要能看出「只允许 loopback」和实际收到的值。
    const error = expectRacpError(() => assertLoopbackHost('10.0.0.5'), 'INVALID_ARGUMENT');
    expect(error.message).toContain('loopback');
    expect(error.message).toContain('10.0.0.5');
  });

  it('缺 Bearer / 前缀不对 / 只有前缀，都是本地参数错误', () => {
    expectRacpError(() => assertBearerToken(''), 'INVALID_ARGUMENT');
    expectRacpError(() => assertBearerToken(undefined), 'INVALID_ARGUMENT');
    expectRacpError(() => assertBearerToken('ghp_sometoken'), 'INVALID_ARGUMENT');
    expectRacpError(() => assertBearerToken('ppt1.'), 'INVALID_ARGUMENT');
    expect(assertBearerToken('  ppt1.abc  ')).toBe('ppt1.abc');
  });

  it('端口必须是 1..65535（--port 0 的随机端口由 Host 打印，不归我们挑）', () => {
    expectRacpError(() => buildRacpUrl(0), 'INVALID_ARGUMENT');
    expectRacpError(() => buildRacpUrl(70_000), 'INVALID_ARGUMENT');
    expectRacpError(() => buildRacpUrl(1.5), 'INVALID_ARGUMENT');
  });

  it('构造函数就把配置错误炸出来（配错不该等到第一次调用）', () => {
    expectRacpError(() => new RacpTransport({ port: 1, host: '10.0.0.5', token: MOCK_DEVICE_TOKEN }), 'INVALID_ARGUMENT');
    expectRacpError(() => new RacpTransport({ port: 1, token: '' }), 'INVALID_ARGUMENT');
  });

  it('Host 不选 RACP 子协议 → 握手失败且归类为 PROTOCOL_MISMATCH', async () => {
    const host = await MockHost.start({ acceptSubprotocol: false });
    try {
      const transport = new RacpTransport({ port: host.port, token: MOCK_DEVICE_TOKEN, handshakeTimeoutMs: 2_000 });
      await expectAsyncRacpError(() => transport.open(), 'PROTOCOL_MISMATCH');
      expect(transport.state).toBe('closed');
    } finally {
      await host.close();
    }
  });

  it('子协议协商结果不是那一个值 → PROTOCOL_MISMATCH（假 socket 精确复现）', async () => {
    const fake = new FakeSocket();
    fake.protocol = 'pi-racp.v2.jsonrpc';
    const transport = new RacpTransport({
      port: 1,
      token: MOCK_DEVICE_TOKEN,
      websocketFactory: () => {
        setTimeout(() => fake.emit('open'), 0);
        return fake;
      },
    });
    const error = await expectAsyncRacpError(() => transport.open(), 'PROTOCOL_MISMATCH');
    expect(error.details).toMatchObject({ expected: RACP_WS_SUBPROTOCOL, negotiated: 'pi-racp.v2.jsonrpc' });
  });

  it('mock host 真的在握手上拒绝缺 Authorization 的连接（这样 401 用例才有意义）', async () => {
    const host = await MockHost.start();
    try {
      // 直接用裸 ws 客户端连：不带 Authorization，只带正确的子协议与路径。
      const raw = new WsWebSocket(host.url, [RACP_WS_SUBPROTOCOL]);
      const error = await new Promise<Error>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('握手没有被拒绝')), 2_000);
        raw.on('error', (cause) => {
          clearTimeout(timer);
          resolve(cause);
        });
        raw.on('open', () => {
          clearTimeout(timer);
          reject(new Error('握手竟然成功了：mock host 没有校验 Authorization'));
        });
      });
      expect(error.message).toContain('401');
    } finally {
      await host.close();
    }
  });

  it('401（令牌不对）→ UNAUTHORIZED，且错误消息里不出现令牌', async () => {
    const host = await MockHost.start({ acceptedToken: 'pdt1.hostside-expected-token' });
    try {
      const transport = new RacpTransport({ port: host.port, token: 'pdt1.client-wrong-token', handshakeTimeoutMs: 2_000 });
      const error = await expectAsyncRacpError(() => transport.open(), 'UNAUTHORIZED');
      expect(error.failureClass).toBe('auth');
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      expect(serialized).not.toContain('client-wrong-token');
      expect(serialized).not.toContain('hostside-expected-token');
    } finally {
      await host.close();
    }
  });

  it('Host 没起来（端口拒连）→ HOST_DISCONNECTED（可重试，交给 runtime 的退避）', async () => {
    const host = await MockHost.start();
    const port = host.port;
    await host.close();
    const transport = new RacpTransport({ port, token: MOCK_DEVICE_TOKEN, handshakeTimeoutMs: 2_000 });
    const error = await expectAsyncRacpError(() => transport.open(), 'HOST_DISCONNECTED');
    expect(error.retriable).toBe(true);
  });

  it('握手卡住 → TIMEOUT（不无限等）', async () => {
    const transport = new RacpTransport({
      port: 1,
      token: MOCK_DEVICE_TOKEN,
      handshakeTimeoutMs: 20,
      websocketFactory: () => new FakeSocket(), // 永远不 emit open
    });
    const error = await expectAsyncRacpError(() => transport.open(), 'TIMEOUT');
    expect(error.kind).toBe('timeout');
  });

  it('注入的工厂收到的正是那三个握手常量（Authorization / 子协议 / 路径）', async () => {
    const fake = new FakeSocket();
    const seen: Array<{ url: string; options: WebSocketHandshakeOptions }> = [];
    const transport = new RacpTransport({
      port: 7300,
      token: MOCK_DEVICE_TOKEN,
      websocketFactory: (url, options) => {
        seen.push({ url, options });
        setTimeout(() => {
          fake.protocol = RACP_WS_SUBPROTOCOL;
          fake.emit('open');
        }, 0);
        return fake;
      },
    });
    await transport.open();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('ws://127.0.0.1:7300/v1/racp/ws');
    expect(seen[0]?.options.headers.Authorization).toBe(`Bearer ${MOCK_DEVICE_TOKEN}`);
    expect(seen[0]?.options.protocols).toEqual([RACP_WS_SUBPROTOCOL]);
  });
});

describe('transport：连接生命周期与帧透传', () => {
  it('连上后文本帧按 isBinary=false 透传（拒绝由帧层做，传输层不越权）', async () => {
    const host = await MockHost.start();
    try {
      const transport = new RacpTransport({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const frames: Array<{ data: unknown; isBinary: boolean }> = [];
      transport.onFrame((data, isBinary) => frames.push({ data, isBinary }));
      await transport.open();
      expect(transport.state).toBe('open');
      expect(transport.negotiatedProtocol).toBe(RACP_WS_SUBPROTOCOL);

      host.sendRaw('{"jsonrpc":"2.0","method":"events/event","params":{}}');
      await waitFor(() => frames.length === 1);
      expect(frames[0]?.isBinary).toBe(false);
      expect(String(frames[0]?.data)).toContain('events/event');

      host.sendBinary('{"jsonrpc":"2.0","id":1,"result":1}');
      await waitFor(() => frames.length === 2);
      expect(frames[1]?.isBinary).toBe(true);
    } finally {
      await host.close();
    }
  });

  it('close() 幂等地关闭，并把 initiatedByClient=true 报给监听器', async () => {
    const host = await MockHost.start();
    try {
      const transport = new RacpTransport({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const closes: CloseInfo[] = [];
      transport.onClose((info) => closes.push(info));
      await transport.open();
      await transport.close();
      await transport.close();
      expect(transport.state).toBe('closed');
      expect(closes).toHaveLength(1);
      expect(closes[0]).toMatchObject({ initiatedByClient: true, code: 1000 });
      // 关掉之后再发帧是显式失败，而不是静默丢弃。
      expectRacpError(() => transport.send('{}'), 'CLIENT_CLOSED');
    } finally {
      await host.close();
    }
  });

  it('Host 掐断连接 → onClose(wasClean=false, initiatedByClient=false)', async () => {
    const host = await MockHost.start();
    try {
      const transport = new RacpTransport({ port: host.port, token: MOCK_DEVICE_TOKEN });
      const closes: CloseInfo[] = [];
      transport.onClose((info) => closes.push(info));
      await transport.open();
      host.terminateClients();
      await waitFor(() => closes.length === 1);
      expect(closes[0]).toMatchObject({ wasClean: false, initiatedByClient: false });
      expect(transport.state).toBe('closed');
    } finally {
      await host.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
