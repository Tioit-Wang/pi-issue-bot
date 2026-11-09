import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, createNullLogger } from '../src/logger.ts';

function capture(): { lines: string[]; destination: Writable } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('输出 JSON 行并带 service 字段', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'pi-bot-test', destination: destination as never });
    logger.info({ taskId: 't1' }, 'hello');

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed['service']).toBe('pi-bot-test');
    expect(parsed['taskId']).toBe('t1');
    expect(parsed['msg']).toBe('hello');
    expect(parsed['level']).toBe('info');
  });

  it('字段值里的令牌被值级脱敏（不依赖字段名）', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'pi-bot-test', destination: destination as never });
    logger.warn({ note: 'used ghp_abcdef', message: 'pair token ppt1.zzz' }, 'check');

    const text = lines.join('');
    expect(text).not.toContain('ghp_abcdef');
    expect(text).not.toContain('ppt1.zzz');
    expect(text).toContain('<redacted>');
  });

  it('字符串消息也脱敏，且 child 的绑定同样脱敏', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'pi-bot-test', destination: destination as never });
    const child = logger.child({ deliveryId: 'd1', token: 'pdt1.abc' });
    child.error('boom ghs_z');

    const text = lines.join('');
    expect(text).toContain('d1');
    expect(text).not.toContain('pdt1.abc');
    expect(text).not.toContain('ghs_z');
  });

  it('level 透传，且 debug 被 info 级别过滤', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'pi-bot-test', level: 'info', destination: destination as never });
    expect(logger.level).toBe('info');
    logger.debug({ a: 1 }, 'invisible');
    logger.info({ a: 1 }, 'visible');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('visible');
  });
});

describe('createNullLogger', () => {
  it('不抛、不写、可 child', () => {
    const logger = createNullLogger();
    logger.info('x');
    logger.error({ a: 1 }, 'y');
    expect(logger.child({ a: 1 }).level).toBe('silent');
  });
});
