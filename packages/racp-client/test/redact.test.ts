import { describe, expect, it } from 'vitest';
import { previewRedacted, redactSecrets, redactValue } from '../src/redact.ts';
import { RacpError } from '../src/errors.ts';

describe('redact：值级脱敏（tech-plan §10.2）', () => {
  it('pdt1. / ppt1. 令牌被替换为 <redacted>，前后文保留', () => {
    const text = 'connect with Bearer pdt1.abcDEF123456 done';
    expect(redactSecrets(text)).toBe('connect with Bearer <redacted> done');
    expect(redactSecrets('token=ppt1.xyz789;')).toBe('token=<redacted>;');
  });

  it('GitHub 前缀与 App JWT / PEM 私钥也覆盖', () => {
    expect(redactSecrets('ghp_abcdefghijklmnop')).toBe('<redacted>');
    expect(redactSecrets('github_pat_11ABCDEFG_abcdefghij')).toBe('<redacted>');
    expect(
      redactSecrets('jwt=eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJlLXNpZw'),
    ).toBe('jwt=<redacted>');
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----';
    expect(redactSecrets(`key: ${pem}`)).toBe('key: <redacted>');
  });

  it('不含凭证的文本原样返回（不过度脱敏）', () => {
    const text = 'turn/start 超时 30000ms，session=s-1';
    expect(redactSecrets(text)).toBe(text);
    // 单独的 eyJ 不是 JWT，不该被吞。
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9')).toBe('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redactValue 深度遍历对象与数组，不动 Date', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const value = redactValue({
      url: 'ws://127.0.0.1:1/v1/racp/ws',
      headers: { Authorization: 'Bearer pdt1.secret-value' },
      list: ['ppt1.another', 42, date],
    });
    expect(value.headers.Authorization).toBe('Bearer <redacted>');
    expect(value.list[0]).toBe('<redacted>');
    expect(value.list[1]).toBe(42);
    expect(value.list[2]).toBe(date);
  });

  it('redactValue 遇到循环引用不抛（脱敏不能成为新的失败点）', () => {
    const circular: Record<string, unknown> = { token: 'pdt1.loop' };
    circular.self = circular;
    expect(() => redactValue(circular)).not.toThrow();
  });

  it('RacpError 构造时统一脱敏：message / details / toJSON 都不含令牌', () => {
    const error = new RacpError({
      code: 'INTERNAL',
      message: 'failed with pdt1.leaked-token',
      details: { authorization: 'Bearer ppt1.also-leaked', token: 'pdt1.deep-leaked' },
    });
    const serialized = JSON.stringify({ message: error.message, details: error.details, json: error.toJSON() });
    expect(serialized).not.toContain('leaked-token');
    expect(serialized).not.toContain('also-leaked');
    expect(serialized).not.toContain('deep-leaked');
    expect(error.message).toContain('<redacted>');
  });

  it('previewRedacted 截断并脱敏', () => {
    const preview = previewRedacted({ token: 'pdt1.x'.repeat(200) }, 60);
    expect(preview.length).toBeLessThanOrEqual(61);
    expect(preview).not.toContain('pdt1.');
  });
});
