/**
 * `runtime/pin.ts` 的单测：PIN.json 的形状、逐文件 SHA256、握手常量、版本比对。
 *
 * 本机没有 `vendor/pi-host` bundle，所以用内存文件表冒充 bundle 目录；
 * 这不降低覆盖度——校验逻辑只依赖「读到的字节」，与字节来自磁盘还是内存无关。
 */
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/runtime/crypto.ts';
import {
  PIN_ERROR_CODES,
  PIN_FILE_NAME,
  assertHostVersionMatches,
  bundleBinaryPath,
  parsePinFile,
  verifyPin,
} from '../src/runtime/pin.ts';
import { RACP_WS_PATH, RACP_WS_SUBPROTOCOL } from '../src/runtime/deps.ts';
import { createMemoryReadFile } from './helpers/fake-pi-host.ts';

const BUNDLE = resolve('/tmp/vendor/pi-host/1.0.0');
const SCHEMA_PATH = join(BUNDLE, 'racp.schema.json');
const BIN_PATH = join(BUNDLE, 'bin', 'pi-host');
const SCHEMA_TEXT = '{"$id":"racp","version":"1.0.0"}';
const BIN_TEXT = '#!/bin/sh\nexit 0\n';

interface BundleFixture {
  readonly files: ReturnType<typeof createMemoryReadFile>;
  /** PIN 里记录的相对路径 → 期望哈希 */
  readonly pin: Record<string, unknown>;
}

function makeBundle(
  overrides: {
    readonly hostVersion?: string;
    readonly wsPath?: string;
    readonly wsSubprotocol?: string;
    readonly pinExtra?: Record<string, unknown>;
    readonly schemaText?: string;
    readonly binText?: string;
    /** 故意给错哈希（验「哈希不符」） */
    readonly schemaHash?: string;
    /** 不写 PIN.json */
    readonly withoutPin?: boolean;
  } = {},
): BundleFixture {
  const schemaText = overrides.schemaText ?? SCHEMA_TEXT;
  const binText = overrides.binText ?? BIN_TEXT;
  const pin = {
    hostVersion: overrides.hostVersion ?? '1.0.0',
    wsPath: overrides.wsPath ?? RACP_WS_PATH,
    wsSubprotocol: overrides.wsSubprotocol ?? RACP_WS_SUBPROTOCOL,
    sha256: {
      'racp.schema.json': overrides.schemaHash ?? sha256Hex(schemaText),
      'bin/pi-host': sha256Hex(binText),
    },
    fetchedAt: '2026-06-01T00:00:00.000Z',
    upstreamRef: 'pi-desktop@v1.0.0',
    ...overrides.pinExtra,
  };

  const files = createMemoryReadFile({
    [SCHEMA_PATH]: schemaText,
    [BIN_PATH]: binText,
    ...(overrides.withoutPin === true ? {} : { [join(BUNDLE, PIN_FILE_NAME)]: JSON.stringify(pin) }),
  });

  return { files, pin };
}

describe('parsePinFile：形状与握手常量', () => {
  it('合法 PIN.json 归一化后返回（哈希统一小写、常量原样）', () => {
    const { pin } = makeBundle();
    const parsed = parsePinFile({
      ...pin,
      sha256: { 'bin/pi-host': (pin['sha256'] as Record<string, string>)['bin/pi-host']?.toUpperCase() },
    });
    expect(parsed.hostVersion).toBe('1.0.0');
    expect(parsed.wsPath).toBe(RACP_WS_PATH);
    expect(parsed.wsSubprotocol).toBe(RACP_WS_SUBPROTOCOL);
    expect(parsed.sha256['bin/pi-host']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('缺 hostVersion / fetchedAt 不可解析 → PIN_INVALID', () => {
    const { pin } = makeBundle();
    expect(() => parsePinFile({ ...pin, hostVersion: '' })).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.invalid }),
    );
    expect(() => parsePinFile({ ...pin, fetchedAt: 'not-a-date' })).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.invalid }),
    );
  });

  it('sha256 为空表 → PIN_INVALID（空表等于没有钉扎）', () => {
    const { pin } = makeBundle();
    expect(() => parsePinFile({ ...pin, sha256: {} })).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.invalid }),
    );
  });

  it('wsPath 与 racp-client 常量不符 → PIN_WS_BINDING_MISMATCH', () => {
    const { pin } = makeBundle({ wsPath: '/v1/racp' });
    expect(() => parsePinFile(pin)).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.bindingMismatch }),
    );
  });

  it('wsSubprotocol 与 racp-client 常量不符 → PIN_WS_BINDING_MISMATCH', () => {
    const { pin } = makeBundle({ wsSubprotocol: 'pi-racp.v2.jsonrpc' });
    expect(() => parsePinFile(pin)).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.bindingMismatch }),
    );
  });

  it("sha256 的键不许绝对路径、不许包含 '..' → PIN_INVALID", () => {
    const { pin } = makeBundle();
    const digest = sha256Hex('x');
    expect(() => parsePinFile({ ...pin, sha256: { '/etc/passwd': digest } })).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.invalid }),
    );
    expect(() => parsePinFile({ ...pin, sha256: { '../outside.js': digest } })).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.invalid }),
    );
    expect(() => parsePinFile({ ...pin, sha256: { 'C:\\Windows\\system32\\x.dll': digest } })).toThrowError(
      expect.objectContaining({ code: PIN_ERROR_CODES.invalid }),
    );
  });
});

describe('verifyPin：逐文件哈希', () => {
  it('全部匹配 → 返回每份文件的校验结果', async () => {
    const { files } = makeBundle();
    const verified = await verifyPin({ bundleDir: BUNDLE, readFile: files.readFile });
    expect(verified.files.map((file) => file.relativePath).sort()).toEqual(['bin/pi-host', 'racp.schema.json']);
    expect(verified.hostVersion).toBe('1.0.0');
    expect(verified.versionMismatch).toBeUndefined();
  });

  it('哈希不符 → PIN_HASH_MISMATCH（failureClass=auth，不可重试）', async () => {
    const { files } = makeBundle({ schemaHash: sha256Hex('别的字节') });
    await expect(verifyPin({ bundleDir: BUNDLE, readFile: files.readFile })).rejects.toMatchObject({
      code: PIN_ERROR_CODES.hashMismatch,
      failureClass: 'auth',
      retriable: false,
    });
  });

  it('哈希不符时 allowHostVersionMismatch 也放不过（永不放松哈希）', async () => {
    const { files } = makeBundle({ schemaHash: sha256Hex('别的字节') });
    await expect(
      verifyPin({
        bundleDir: BUNDLE,
        readFile: files.readFile,
        allowHostVersionMismatch: true,
        negotiatedHostVersion: '9.9.9',
      }),
    ).rejects.toMatchObject({ code: PIN_ERROR_CODES.hashMismatch });
  });

  it('PIN 里记录的文件不存在 → PIN_HASH_MISMATCH（actual=null）', async () => {
    const { files, pin } = makeBundle();
    const withoutBin = createMemoryReadFile({
      [SCHEMA_PATH]: SCHEMA_TEXT,
      [join(BUNDLE, PIN_FILE_NAME)]: JSON.stringify(pin),
    });
    expect(files.paths.length).toBe(3);
    await expect(verifyPin({ bundleDir: BUNDLE, readFile: withoutBin.readFile })).rejects.toMatchObject({
      code: PIN_ERROR_CODES.hashMismatch,
      details: expect.objectContaining({ relativePath: 'bin/pi-host', actual: null }),
    });
  });

  it('PIN.json 缺失 → PIN_FILE_MISSING；JSON 坏 → PIN_INVALID', async () => {
    const missing = makeBundle({ withoutPin: true });
    await expect(verifyPin({ bundleDir: BUNDLE, readFile: missing.files.readFile })).rejects.toMatchObject({
      code: PIN_ERROR_CODES.missing,
    });

    const broken = createMemoryReadFile({ [join(BUNDLE, PIN_FILE_NAME)]: '{ not json' });
    await expect(verifyPin({ bundleDir: BUNDLE, readFile: broken.readFile })).rejects.toMatchObject({
      code: PIN_ERROR_CODES.invalid,
    });
  });
});

describe('verifyPin / assertHostVersionMatches：版本协商', () => {
  it('协商版本与 PIN 不符 → HOST_VERSION_MISMATCH', async () => {
    const { files } = makeBundle();
    await expect(
      verifyPin({ bundleDir: BUNDLE, readFile: files.readFile, negotiatedHostVersion: '2.0.0' }),
    ).rejects.toMatchObject({ code: PIN_ERROR_CODES.hostVersionMismatch, failureClass: 'auth' });
  });

  it('allowHostVersionMismatch 只放宽版本：生效版本取协商值并留痕', async () => {
    const { files } = makeBundle();
    const verified = await verifyPin({
      bundleDir: BUNDLE,
      readFile: files.readFile,
      negotiatedHostVersion: '2.0.0',
      allowHostVersionMismatch: true,
    });
    expect(verified.hostVersion).toBe('2.0.0');
    expect(verified.versionMismatch).toEqual({ expected: '1.0.0', actual: '2.0.0' });
  });

  it('assertHostVersionMatches 直调：相等时不产生 mismatch 留痕', () => {
    expect(assertHostVersionMatches('1.0.0', '1.0.0')).toEqual({
      hostVersion: '1.0.0',
      versionMismatch: undefined,
    });
  });
});

describe('bundle 布局', () => {
  it('binary 固定在 bin/pi-host 下', () => {
    expect(bundleBinaryPath(BUNDLE)).toBe(BIN_PATH);
  });
});
