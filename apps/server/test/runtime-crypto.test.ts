/**
 * `runtime/crypto.ts` 的单测（tech-plan §7.2 / §10.4）。
 *
 * 三条要证明的事：
 *  1. AES-256-GCM 往返正确，且每次 IV 不同（同明文两次密文不同）；
 *  2. 换 key / 改一个字节 / 截断 / 版本不对，解密**必须失败**，不能返回空串；
 *  3. 走真实 logger 打日志时，明文令牌不会出现在输出里（§10.2 「日志不得出现密钥」的机械保证）。
 */
import { describe, expect, it } from 'vitest';

import {
  AES_KEY_BYTES,
  CRYPTO_ERROR_CODES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  TOKEN_CIPHER_VERSION,
  assertSecretKey,
  decryptSecret,
  encryptSecret,
  generateSecretKey,
  looksEncrypted,
  secretKeyFromBase64,
  secretKeyFromHex,
  sha256Hex,
} from '../src/runtime/crypto.ts';
import { createLogger } from '../src/runtime/deps.ts';

const TOKEN = 'pdt1.Zm9vYmFyYmF6cXV1eC0wMDEyMzQ1Njc4OQ';
const KEY = new Uint8Array(AES_KEY_BYTES).fill(7);

/** pino 目标流：把每条 JSON 行收进数组。 */
function createCaptureStream(): { readonly lines: string[]; write(chunk: string): boolean } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string): boolean {
      lines.push(chunk);
      return true;
    },
  };
}

describe('encryptSecret / decryptSecret：往返与格式', () => {
  it('往返得到原明文；格式是 `v1:<iv>:<tag>:<ct>`', () => {
    const encrypted = encryptSecret(TOKEN, { key: KEY });
    expect(encrypted.startsWith(`${TOKEN_CIPHER_VERSION}:`)).toBe(true);
    expect(encrypted.split(':')).toHaveLength(4);
    expect(decryptSecret(encrypted, { key: KEY })).toBe(TOKEN);
  });

  it('每次加密都用新的随机 IV：同一明文两次密文不同，但都能解回原文', () => {
    const first = encryptSecret(TOKEN, { key: KEY });
    const second = encryptSecret(TOKEN, { key: KEY });
    expect(first).not.toBe(second);
    expect(decryptSecret(first, { key: KEY })).toBe(TOKEN);
    expect(decryptSecret(second, { key: KEY })).toBe(TOKEN);

    const ivHex = Buffer.from(first.split(':')[1] ?? '', 'base64');
    expect(ivHex.byteLength).toBe(GCM_IV_BYTES);
    const tag = Buffer.from(first.split(':')[2] ?? '', 'base64');
    expect(tag.byteLength).toBe(GCM_TAG_BYTES);
  });

  it('密文里不含明文（否则加密就是摆设）', () => {
    const encrypted = encryptSecret(TOKEN, { key: KEY });
    expect(encrypted).not.toContain('pdt1.');
    expect(encrypted).not.toContain(TOKEN);
  });

  it('固定 IV 时结果稳定（便于排查，但生产路径不传 IV）', () => {
    const iv = new Uint8Array(GCM_IV_BYTES).fill(3);
    expect(encryptSecret(TOKEN, { key: KEY, iv })).toBe(encryptSecret(TOKEN, { key: KEY, iv }));
  });
});

describe('decryptSecret：失败路径必须报错', () => {
  it('换错 key → CRYPTO_DECRYPT_FAILED（failureClass=auth）', () => {
    const encrypted = encryptSecret(TOKEN, { key: KEY });
    const otherKey = generateSecretKey();
    expect(() => decryptSecret(encrypted, { key: otherKey })).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.decryptFailed, failureClass: 'auth' }),
    );
  });

  it('篡改密文的任意一个字节 → 失败（GCM tag 校验）', () => {
    const encrypted = encryptSecret(TOKEN, { key: KEY });
    const parts = encrypted.split(':');
    const cipherBytes = Buffer.from(parts[3] ?? '', 'base64');
    cipherBytes[0] = (cipherBytes[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], cipherBytes.toString('base64')].join(':');
    expect(() => decryptSecret(tampered, { key: KEY })).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.decryptFailed }),
    );
  });

  it('篡改 tag / 截断 / 版本不对 → 失败', () => {
    const encrypted = encryptSecret(TOKEN, { key: KEY });
    const [version, iv, tag, ct] = encrypted.split(':') as [string, string, string, string];
    const badTag = Buffer.from(tag, 'base64');
    badTag[0] = (badTag[0] ?? 0) ^ 0xff;
    expect(() => decryptSecret([version, iv, badTag.toString('base64'), ct].join(':'), { key: KEY })).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.decryptFailed }),
    );

    expect(() => decryptSecret(`${version}:${iv}:${tag}`, { key: KEY })).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.invalidPayload }),
    );
    expect(() => decryptSecret(`v2:${iv}:${tag}:${ct}`, { key: KEY })).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.invalidPayload }),
    );
    expect(() => decryptSecret('pdt1.plain-text-token', { key: KEY })).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.invalidPayload }),
    );
  });
});

describe('key 的来源与校验', () => {
  it('key 必须是 32 字节的 Uint8Array（不接受字符串 / 错误长度）', () => {
    expect(() => assertSecretKey(new Uint8Array(16))).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.invalidKey }),
    );
    // 运行期类型错误（TS 层挡住，这里模拟绕过类型检查的调用）
    expect(() => assertSecretKey('a'.repeat(32) as unknown as Uint8Array)).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.invalidKey }),
    );
    expect(assertSecretKey(KEY).byteLength).toBe(AES_KEY_BYTES);
  });

  it('hex / base64 明确转换（避免「32 个字符的字符串」歧义）', () => {
    const hex = 'a'.repeat(64);
    expect(secretKeyFromHex(hex).byteLength).toBe(AES_KEY_BYTES);
    expect(() => secretKeyFromHex('abc')).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.invalidKey }),
    );

    const base64 = Buffer.from(generateSecretKey()).toString('base64');
    expect(secretKeyFromBase64(base64).byteLength).toBe(AES_KEY_BYTES);
    expect(() => secretKeyFromBase64(Buffer.alloc(8).toString('base64'))).toThrowError(
      expect.objectContaining({ code: CRYPTO_ERROR_CODES.invalidKey }),
    );
  });

  it('generateSecretKey 每次不同；looksEncrypted 只认本模块的密文前缀', () => {
    expect(generateSecretKey().equals(generateSecretKey())).toBe(false);
    expect(looksEncrypted(encryptSecret(TOKEN, { key: KEY }))).toBe(true);
    expect(looksEncrypted(TOKEN)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
  });

  it('sha256Hex 与 node:crypto 一致（PIN 校验用同一套原语）', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('日志里不会有明文令牌（tech-plan §10.2）', () => {
  it('把密文与凭据行一起打日志：输出里没有明文，值级脱敏把误打进去的明文换成 <redacted>', () => {
    const stream = createCaptureStream();
    const logger = createLogger({ service: 'runtime-crypto-test', destination: stream });
    const tokenEnc = encryptSecret(TOKEN, { key: KEY });

    // 正常路径：只打密文长度与 hostId（§4.2 第 5 步的日志）
    logger.info({ hostId: 'host-1', tokenCipherLength: tokenEnc.length }, '设备令牌已加密写入');

    // 最坏情况：有人把整行凭据打了出来
    logger.info({ row: { hostId: 'host-1', tokenEnc } }, 'credential row');

    // 更坏的情况：明文被拼进了消息字符串
    logger.warn({}, `手工排障时不小心带了令牌 ${TOKEN}`);

    const output = stream.lines.join('\n');
    expect(output).toContain(tokenEnc);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain('pdt1.');
    expect(output).toContain('<redacted>');
  });
});
