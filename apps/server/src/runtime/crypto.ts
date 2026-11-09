/**
 * RACP 设备令牌的静态加密（tech-plan §2.2 第 5 步 / §7.2 `host_credentials.token_enc` / §10.4）。
 *
 * 三条硬约束，对应三条测试：
 *  1. **key 从参数注入，不读 env**：`host_credentials` 的 key 来自 systemd `EnvironmentFile`，
 *     由入口解析后传进来。本模块（与 `db/pool.ts` 同一个理由）不碰 `process.env`，
 *     这样单测、`replay`、轮换脚本都能塞自己的 key。
 *  2. **每次加密都换随机 IV**（12 字节，GCM 的标准长度）：同一令牌加两次，密文必须不同，
 *     否则「同一明文 → 同一密文」会泄露「两个 host 用了同一个令牌」这类事实。
 *  3. **解密失败必须是错误，不能是空串**：换错 key、改一个字节、截断，全部抛
 *     `AppError{code:'CRYPTO_DECRYPT_FAILED', failureClass:'auth'}`。GCM 的 tag 校验就是这一条的保证。
 *
 * 密文格式（自描述，单列 `text` 就能存）：`v1:<base64(iv)>:<base64(tag)>:<base64(ct)>`
 * —— 与 `db/schema.ts` 里 `host_credentials.tokenEnc` 的注释一致。
 * 前缀 `v1` 是**轮换入口**：换算法/KDF 时新前缀与旧前缀并存，按前缀选解密路径，不需要停机。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { AppError } from './deps.ts';

/** 密文格式版本。换算法时递增，旧的解密路径保留一个发布周期。 */
export const TOKEN_CIPHER_VERSION = 'v1';

/** AES-256 的 key 长度（字节）。 */
export const AES_KEY_BYTES = 32;
/** GCM 的 IV 长度：12 字节是唯一推荐值（其它长度会走 GHASH 派生，慢且没有好处）。 */
export const GCM_IV_BYTES = 12;
/** GCM 认证标签长度。 */
export const GCM_TAG_BYTES = 16;

/** 密文/密钥相关错误的统一 code 表（doctor、轮换脚本、面板都会按它判断）。 */
export const CRYPTO_ERROR_CODES = {
  invalidKey: 'CRYPTO_INVALID_KEY',
  invalidPayload: 'CRYPTO_INVALID_PAYLOAD',
  decryptFailed: 'CRYPTO_DECRYPT_FAILED',
} as const;

/**
 * 校验并归一化 key。
 *
 * 只接受 `Uint8Array`（含 `Buffer`）且长度必须是 32 字节 —— **不接受字符串**：
 * 「32 个字符的字符串」既可能是 ASCII 也可能是 hex，歧义迟早变成线上事故。
 * 要传字符串请先在调用方用 `secretKeyFromHex` / `secretKeyFromBase64` 明确转换。
 */
export function assertSecretKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array)) {
    throw new AppError('AES-256-GCM 的 key 必须是 Uint8Array（32 字节），不接受字符串', {
      code: CRYPTO_ERROR_CODES.invalidKey,
      failureClass: 'auth',
      retriable: false,
    });
  }
  if (key.byteLength !== AES_KEY_BYTES) {
    throw new AppError(`AES-256-GCM 的 key 必须是 ${String(AES_KEY_BYTES)} 字节，实际 ${String(key.byteLength)} 字节`, {
      code: CRYPTO_ERROR_CODES.invalidKey,
      failureClass: 'auth',
      retriable: false,
      details: { expectedBytes: AES_KEY_BYTES, actualBytes: key.byteLength },
    });
  }
  return Buffer.from(key);
}

/** 生成一把新 key（引导/轮换时用；生产 key 仍应由 `EnvironmentFile` 提供，不由代码生成）。 */
export function generateSecretKey(): Buffer {
  return randomBytes(AES_KEY_BYTES);
}

/** `hex` → key。必须是 64 个 hex 字符（`EnvironmentFile` 里最常见的形式）。 */
export function secretKeyFromHex(hex: string): Buffer {
  const normalized = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new AppError('key 必须是 64 个 hex 字符（32 字节）', {
      code: CRYPTO_ERROR_CODES.invalidKey,
      failureClass: 'auth',
      retriable: false,
      details: { length: normalized.length },
    });
  }
  return Buffer.from(normalized, 'hex');
}

/** `base64` → key。解出来不是 32 字节就失败（不静默补齐/截断）。 */
export function secretKeyFromBase64(base64: string): Buffer {
  const decoded = Buffer.from(base64.trim(), 'base64');
  return assertSecretKey(decoded);
}

/** 文件哈希（`PIN.json` 的 SHA256 校验用它；放这里是为了「所有密码学原语只在本文件出现」）。 */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface EncryptSecretOptions {
  /** 32 字节 key（调用方从 `EnvironmentFile` 解析后注入）。 */
  readonly key: Uint8Array;
  /** 仅供测试固定 IV；生产路径**不要传**，否则随机性没了。 */
  readonly iv?: Uint8Array;
}

/**
 * 加密一段明文（RACP 设备令牌）。
 * 明文不落日志、不进错误消息 —— 出错的 `details` 里只有长度。
 */
export function encryptSecret(plaintext: string, options: EncryptSecretOptions): string {
  const key = assertSecretKey(options.key);
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new AppError('encryptSecret 的明文必须是非空字符串', {
      code: CRYPTO_ERROR_CODES.invalidPayload,
      failureClass: 'auth',
      retriable: false,
    });
  }

  const iv = options.iv === undefined ? randomBytes(GCM_IV_BYTES) : Buffer.from(options.iv);
  if (iv.byteLength !== GCM_IV_BYTES) {
    throw new AppError(`GCM 的 IV 必须是 ${String(GCM_IV_BYTES)} 字节`, {
      code: CRYPTO_ERROR_CODES.invalidPayload,
      failureClass: 'auth',
      retriable: false,
      details: { actualBytes: iv.byteLength },
    });
  }

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    TOKEN_CIPHER_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export interface DecryptSecretOptions {
  readonly key: Uint8Array;
}

/**
 * 解密 `encryptSecret` 的产物。
 * 换 key、改密文、改 tag、截断、前缀不对 —— 全部抛 `CRYPTO_DECRYPT_FAILED`。
 */
export function decryptSecret(payload: string, options: DecryptSecretOptions): string {
  const key = assertSecretKey(options.key);
  const parts = typeof payload === 'string' ? payload.split(':') : [];
  if (parts.length !== 4) {
    throw new AppError('密文格式应为 `v1:<iv>:<tag>:<ct>`', {
      code: CRYPTO_ERROR_CODES.invalidPayload,
      failureClass: 'auth',
      retriable: false,
      details: { segments: parts.length },
    });
  }

  const [version, ivPart, tagPart, cipherPart] = parts as [string, string, string, string];
  if (version !== TOKEN_CIPHER_VERSION) {
    throw new AppError(`不支持的密文版本：${version}`, {
      code: CRYPTO_ERROR_CODES.invalidPayload,
      failureClass: 'auth',
      retriable: false,
      details: { version, supported: TOKEN_CIPHER_VERSION },
    });
  }

  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');
  const ciphertext = Buffer.from(cipherPart, 'base64');
  if (iv.byteLength !== GCM_IV_BYTES || tag.byteLength !== GCM_TAG_BYTES) {
    throw new AppError('密文的 IV/tag 长度不对，疑似被截断或格式不符', {
      code: CRYPTO_ERROR_CODES.invalidPayload,
      failureClass: 'auth',
      retriable: false,
      details: { ivBytes: iv.byteLength, tagBytes: tag.byteLength },
    });
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    // 换错 key / 被篡改都走这里；不要把 payload 放进 details（它本身是密文，但对排障没有帮助）。
    throw new AppError('设备令牌解密失败：key 不对或密文被篡改', {
      code: CRYPTO_ERROR_CODES.decryptFailed,
      failureClass: 'auth',
      retriable: false,
      cause: error,
    });
  }
}

/** 形状判断：给 doctor / 面板用，避免拿明文（`pdt1.…`）去当密文解析。 */
export function looksEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${TOKEN_CIPHER_VERSION}:`);
}
