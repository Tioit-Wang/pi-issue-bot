import { describe, expect, it } from 'vitest';
import {
  InFlightTable,
  JsonRpcIdSequence,
  decodeIncomingFrame,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeSuccess,
  idKey,
  isErrorFrame,
  isNotificationFrame,
  isResponseFrame,
  JSONRPC_VERSION,
} from '../src/frames.ts';
import { RacpError } from '../src/errors.ts';

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

describe('frames：编码', () => {
  it('请求帧只带 id/method/params，params 为 undefined 时不出现该字段', () => {
    const withParams = JSON.parse(encodeRequest({ id: 1, method: 'turn/get', params: { sessionId: 's' } }));
    expect(withParams).toEqual({ jsonrpc: '2.0', id: 1, method: 'turn/get', params: { sessionId: 's' } });

    const withoutParams = JSON.parse(encodeRequest({ id: 2, method: 'connection/ping' }));
    expect(withoutParams).toEqual({ jsonrpc: '2.0', id: 2, method: 'connection/ping' });
    expect(Object.hasOwn(withoutParams, 'params')).toBe(false);
  });

  it('JSONRPC_VERSION 是字面量 "2.0"', () => {
    expect(JSONRPC_VERSION).toBe('2.0');
  });

  it('method 为空 / id 非法时是协议错误（我们自己造错了帧）', () => {
    expect(expectRacpError(() => encodeRequest({ id: 1, method: '' }), 'PROTOCOL_ERROR').kind).toBe('protocol');
    expectRacpError(() => encodeRequest({ id: Number.NaN, method: 'x' }), 'PROTOCOL_ERROR');
  });

  it('params 不可序列化时抛 PROTOCOL_ERROR 而不是让 JSON.stringify 的原始异常漏出去', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const error = expectRacpError(() => encodeRequest({ id: 1, method: 'x', params: circular }), 'PROTOCOL_ERROR');
    expect(error.message).toContain('无法序列化');
  });

  it('通知与响应帧的编码形状', () => {
    expect(JSON.parse(encodeNotification({ method: 'events/event', params: { a: 1 } }))).toEqual({
      jsonrpc: '2.0',
      method: 'events/event',
      params: { a: 1 },
    });
    expect(JSON.parse(encodeSuccess({ id: 7, result: { ok: true } }))).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { ok: true },
    });
    expect(JSON.parse(encodeError({ id: 7, error: { code: -32601, message: 'nope' } }))).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'nope' },
    });
  });
});

describe('frames：解码', () => {
  it('成功响应', () => {
    const frame = decodeIncomingFrame('{"jsonrpc":"2.0","id":3,"result":{"turnId":"t1"}}', false);
    expect(isResponseFrame(frame)).toBe(true);
    expect(frame).toEqual({ jsonrpc: '2.0', id: 3, result: { turnId: 't1' } });
  });

  it('错误响应：id 可以是 null，data 原样带出', () => {
    const frame = decodeIncomingFrame(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error","data":{"code":"INTERNAL"}}}',
      false,
    );
    expect(isResponseFrame(frame)).toBe(true);
    if (!isResponseFrame(frame)) throw new Error('unreachable');
    expect(isErrorFrame(frame)).toBe(true);
    if (!isErrorFrame(frame)) throw new Error('unreachable');
    expect(frame.id).toBeNull();
    expect(frame.error.code).toBe(-32700);
    expect(frame.error.data).toEqual({ code: 'INTERNAL' });
  });

  it('通知帧没有 id', () => {
    const frame = decodeIncomingFrame('{"jsonrpc":"2.0","method":"events/event","params":{"k":1}}', false);
    expect(isNotificationFrame(frame)).toBe(true);
    if (!isNotificationFrame(frame)) throw new Error('unreachable');
    expect(frame.method).toBe('events/event');
    expect(frame.params).toEqual({ k: 1 });
  });

  it('Buffer 载荷（ws 的实参类型）也能读', () => {
    const frame = decodeIncomingFrame(Buffer.from('{"jsonrpc":"2.0","id":"a","result":1}'), false);
    expect(frame).toEqual({ jsonrpc: '2.0', id: 'a', result: 1 });
  });

  it('binary 帧一律拒绝：BINARY_FRAME（不是尽力解析）', () => {
    const error = expectRacpError(
      () => decodeIncomingFrame(Buffer.from('{"jsonrpc":"2.0","id":1,"result":1}'), true),
      'BINARY_FRAME',
    );
    expect(error.kind).toBe('protocol');
    expect(error.failureClass).toBe('sandbox');
    expect(error.retriable).toBe(false);
  });

  it('不是合法 JSON → PROTOCOL_ERROR，且 details 里的原文被截断脱敏', () => {
    const error = expectRacpError(
      () => decodeIncomingFrame('not json at all -----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----', false),
      'PROTOCOL_ERROR',
    );
    expect(error.message).toContain('合法 JSON');
    expect(JSON.stringify(error.details)).not.toContain('PRIVATE KEY');
  });

  it.each([
    ['缺 jsonrpc', '{"id":1,"result":1}'],
    ['jsonrpc 不是 2.0', '{"jsonrpc":"1.0","id":1,"result":1}'],
    ['数组而不是对象', '[]'],
    ['既无 method 也无 result/error', '{"jsonrpc":"2.0","id":1}'],
    ['result 与 error 同时出现', '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":-1,"message":"x"}}'],
    ['成功响应 id 为 null', '{"jsonrpc":"2.0","id":null,"result":1}'],
    ['error.code 不是整数', '{"jsonrpc":"2.0","id":1,"error":{"code":"X","message":"x"}}'],
    ['error.message 不是字符串', '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":7}}'],
    ['通知 method 为空', '{"jsonrpc":"2.0","method":"","params":{}}'],
  ])('形状不对：%s → PROTOCOL_ERROR', (_label, text) => {
    expectRacpError(() => decodeIncomingFrame(text, false), 'PROTOCOL_ERROR');
  });

  it('Host 发来带 id 的请求（server→client request）明确拒绝，而不是静默丢弃', () => {
    const error = expectRacpError(
      () => decodeIncomingFrame('{"jsonrpc":"2.0","id":9,"method":"approval/request","params":{}}', false),
      'PROTOCOL_ERROR',
    );
    expect(error.message).toContain('serverRequests');
  });
});

describe('frames：id 与在飞表', () => {
  it('idKey 区分数字与字符串，且能互相命中同一类型', () => {
    expect(idKey(1)).toBe('n:1');
    expect(idKey('1')).toBe('s:1');
    expect(idKey(1)).not.toBe(idKey('1'));
  });

  it('JsonRpcIdSequence 单调递增且可指定起点', () => {
    const sequence = new JsonRpcIdSequence();
    expect([sequence.next(), sequence.next()]).toEqual([1, 2]);
    expect(new JsonRpcIdSequence(41).next()).toBe(41);
  });

  it('InFlightTable：一个 id 只能被消费一次，drain 一次排空', () => {
    const table = new InFlightTable<string>();
    table.set(1, 'a');
    table.set('1', 'b');
    expect(table.size).toBe(2);
    expect(table.take(1)).toBe('a');
    expect(table.get(1)).toBeUndefined();
    expect(table.take('1')).toBe('b');

    table.set(2, 'c');
    table.set(3, 'd');
    const drained = table.drain();
    expect(drained.map((entry) => entry.entry)).toEqual(['c', 'd']);
    expect(table.size).toBe(0);
  });

  it('InFlightTable：重复 id 是协议错误（不会悄悄覆盖一条在飞调用）', () => {
    const table = new InFlightTable<string>();
    table.set(1, 'a');
    expectRacpError(() => table.set(1, 'b'), 'PROTOCOL_ERROR');
  });
});
