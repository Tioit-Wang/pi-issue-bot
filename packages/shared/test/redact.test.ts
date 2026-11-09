import { describe, expect, it } from 'vitest';
import { REDACTED, previewRedacted, redactSecrets, redactValue } from '../src/redact.ts';

describe('redactSecrets', () => {
  it('抹掉设备令牌与配对令牌', () => {
    const text = 'connect Bearer pdt1.abcDEF123 and pair ppt1.zzz999';
    const out = redactSecrets(text);
    expect(out).not.toContain('pdt1.');
    expect(out).not.toContain('ppt1.');
    expect(out).toContain(REDACTED);
  });

  it('抹掉 GitHub 各类令牌前缀（含细粒度 PAT）', () => {
    for (const token of ['ghs_abc123', 'ghu_def456', 'ghp_ghi789', 'gho_jkl012', 'ghr_mno345', 'github_pat_11ABC']) {
      const out = redactSecrets(`token=${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain(REDACTED);
    }
  });

  it('抹掉三段式 App JWT，但不误伤裸 eyJ 开头的普通文本', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTY3OCJ9.c2lnbmF0dXJlc2lnbmF0dXJl';
    expect(redactSecrets(`auth ${jwt}`)).not.toContain(jwt);

    const innocent = 'eyJhbGciOiJSUzI1NiJ9 只是一个 base64 头';
    expect(redactSecrets(innocent)).toBe(innocent);
  });

  it('整块抹掉 PEM 私钥，而不是只抹第一行', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'].join('\n');
    const out = redactSecrets(`key:\n${pem}\nend`);
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toBe(`key:\n${REDACTED}\nend`);
  });

  it('幂等：已脱敏文本再跑一遍不变', () => {
    const once = redactSecrets('pdt1.secret-value');
    expect(redactSecrets(once)).toBe(once);
  });

  it('保留令牌周围的标点与空格（日志可读）', () => {
    expect(redactSecrets('a pdt1.tok, b')).toBe(`a ${REDACTED}, b`);
  });
});

describe('redactValue', () => {
  it('递归处理对象、数组与嵌套 Error', () => {
    const value = {
      token: 'pdt1.deep',
      nested: { list: ['ghp_aaa', 42], ok: true },
      error: new Error('boom ghs_leak'),
    };
    const out = redactValue(value);
    expect(JSON.stringify(out)).not.toContain('pdt1.deep');
    expect(JSON.stringify(out)).not.toContain('ghp_aaa');
    expect(JSON.stringify(out)).not.toContain('ghs_leak');
    expect(out.nested.ok).toBe(true);
    expect(out.nested.list[1]).toBe(42);
  });

  it('非字符串原样返回（不改变类型）', () => {
    expect(redactValue(7)).toBe(7);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
  });
});

describe('previewRedacted', () => {
  it('先脱敏再截断', () => {
    const long = `pdt1.${'x'.repeat(300)}`;
    const out = previewRedacted(long, 20);
    expect(out).not.toContain('pdt1.');
    expect(out.length).toBeLessThan(60);
  });
});
