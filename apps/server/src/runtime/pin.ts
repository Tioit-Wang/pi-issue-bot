/**
 * pi-host bundle 的钉扎与校验（tech-plan §2.2 末尾五条 / §4.2 第 0 步）。
 *
 * 为什么需要这个文件：`racp.schema.json` 与 pi-host bundle 来自**另一个仓库**。
 * 如果「今天 checkout 到的上游」就是事实源，那升级、回滚、被替换都无法判定。
 * `PIN.json` 把契约变成「本仓库的一份文件」：每份产物的 SHA256 + `hostVersion`
 * + 两个握手常量（`wsPath` / `wsSubprotocol`），启动期逐项比对。
 *
 * 四条规则（与文档逐条对应，任何一条放宽都是安全回归）：
 *  1. **哈希永不放松**。`allowHostVersionMismatch` 只放宽 `hostVersion` 这一条；
 *     任一文件哈希不符 → `PIN_HASH_MISMATCH`，没有开关能放过（§2.2 第 4 条）。
 *  2. **协商版本必须等于 PIN 的 `hostVersion`**，否则 `HOST_VERSION_MISMATCH`。
 *     这一步在启动期就做，而不是等运行期撞 Host 的同类错误（§2.2 第 2 条）。
 *  3. **握手常量也要校验**：`wsPath` 必须等于 `racp-client` 的 `RACP_WS_PATH`，
 *     `wsSubprotocol` 必须等于 `RACP_WS_SUBPROTOCOL`。Host 升级若改了绑定，
 *     启动期就报出来，而不是第一次握手被拒才发现（§4.2 / §2.2 第 5 条）。
 *  4. **`PIN.json` 里的路径必须是相对路径且不许 `..`**：它决定「我们去读哪个文件算哈希」，
 *     一个 `../../etc/passwd` 或者绝对路径会把校验变成「校验攻击者指定的文件」。
 *
 * 全部 I/O 通过 `readFile` 注入：本机没有 `vendor/pi-host`（dev-plan §13.1），
 * 单测用内存文件表跑，生产用 `node:fs/promises` 的薄包装。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Hex } from './crypto.ts';
import { RACP_WS_PATH, RACP_WS_SUBPROTOCOL, AppError } from './deps.ts';

/** `vendor/pi-host/<version>/PIN.json`（§2.2 的目录图）。 */
export const PIN_FILE_NAME = 'PIN.json';

/** 校验相关的错误码。doctor、启动自检、bootstrap 都按它判。 */
export const PIN_ERROR_CODES = {
  missing: 'PIN_FILE_MISSING',
  invalid: 'PIN_INVALID',
  hashMismatch: 'PIN_HASH_MISMATCH',
  bindingMismatch: 'PIN_WS_BINDING_MISMATCH',
  hostVersionMismatch: 'HOST_VERSION_MISMATCH',
  runnerInvalid: 'BUNDLE_RUNNER_INVALID',
} as const;
/** `PIN.json` 的形状（§2.2：`{ hostVersion, wsPath, wsSubprotocol, sha256, fetchedAt, upstreamRef }`）。 */
export interface PinFile {
  /** 这一份 bundle 的版本，用于与 `connection/initialize` 协商出的版本比对。 */
  readonly hostVersion: string;
  /** 握手路径，当前 `/v1/racp/ws`（必须等于 `RACP_WS_PATH`）。 */
  readonly wsPath: string;
  /** 子协议，当前 `pi-racp.v1.jsonrpc`（必须等于 `RACP_WS_SUBPROTOCOL`）。 */
  readonly wsSubprotocol: string;
  /** 相对路径 → SHA256（hex，64 字符）。 */
  readonly sha256: Readonly<Record<string, string>>;
  /** 拉取时间（ISO 8601）。 */
  readonly fetchedAt: string;
  /** 上游引用（tag 或 commit），升级 PR 要能追到源。 */
  readonly upstreamRef: string;
}

/**
 * 读文件：返回字节；**文件不存在返回 `undefined`**（不抛错，由调用方决定是
 * `PIN_FILE_MISSING` 还是 `PIN_HASH_MISMATCH`）。
 */
export type PinReadFile = (absolutePath: string) => Promise<Uint8Array | undefined>;

export interface VerifyPinOptions {
  /** `vendor/pi-host/<version>/` 的绝对路径。 */
  readonly bundleDir: string;
  readonly readFile: PinReadFile;
  /** 已协商出的 `hostVersion`（`connection/initialize` 的 `server.version`）；不传就只校验 PIN 自身。 */
  readonly negotiatedHostVersion?: string;
  /** 只放宽「协商版本与 PIN 不符」；哈希校验永不放松。 */
  readonly allowHostVersionMismatch?: boolean;
}

export interface PinVerifiedFile {
  /** `PIN.json` 里记的相对路径（原样返回，便于错误消息与人核对）。 */
  readonly relativePath: string;
  /** 实际被哈希的绝对路径。 */
  readonly absolutePath: string;
  readonly sha256: string;
}

export interface PinVerification {
  readonly pin: PinFile;
  readonly bundleDir: string;
  readonly files: readonly PinVerifiedFile[];
  /** 生效版本：允许版本不符时是协商值，否则等于 `pin.hostVersion`。 */
  readonly hostVersion: string;
  /** 版本不符但被放行时留痕（doctor 报 warn，审计能查到）。 */
  readonly versionMismatch: { readonly expected: string; readonly actual: string } | undefined;
}

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function pinError(message: string, code: string, details?: Record<string, unknown>): AppError {
  // `failureClass: 'auth'`：钉扎失败是「本地前置条件不满足」，重试没有意义，
  // 与令牌/凭证失效同类（§7.3 的重试矩阵只读这个字段）。
  return new AppError(message, {
    code,
    failureClass: 'auth',
    retriable: false,
    ...(details === undefined ? {} : { details }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** `PIN.json` 里的路径必须是相对路径、不含 `..`，否则我们可能在「校验攻击者指定的文件」。 */
function assertSafeRelativePath(relativePath: string, source: string): void {
  if (relativePath.trim().length === 0) {
    throw pinError(`${source} 里有一个空的文件路径`, PIN_ERROR_CODES.invalid, { relativePath });
  }
  // Windows 盘符（`C:\…`）与 POSIX 绝对路径（`/…`）都拒。
  const isAbsolute = relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:/.test(relativePath);
  if (isAbsolute) {
    throw pinError(`${source} 里的文件路径必须是相对路径：${relativePath}`, PIN_ERROR_CODES.invalid, {
      relativePath,
    });
  }
  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    throw pinError(`${source} 里的文件路径不许包含 '..'：${relativePath}`, PIN_ERROR_CODES.invalid, {
      relativePath,
    });
  }
}

/**
 * 校验 `PIN.json` 自身（形状 + 常量），不读任何 bundle 文件。
 * 抽出来是因为 `doctor` 想「先验形状、再逐文件哈希」，两处都要用同一套判定。
 */
export function parsePinFile(value: unknown, source = PIN_FILE_NAME): PinFile {
  if (!isRecord(value)) {
    throw pinError(`${source}: 顶层应为对象`, PIN_ERROR_CODES.invalid);
  }

  const { hostVersion, wsPath, wsSubprotocol, sha256, fetchedAt, upstreamRef } = value;
  if (!nonEmptyString(hostVersion)) {
    throw pinError(`${source}: hostVersion 缺失或为空`, PIN_ERROR_CODES.invalid);
  }
  if (!nonEmptyString(fetchedAt)) {
    throw pinError(`${source}: fetchedAt 缺失或为空`, PIN_ERROR_CODES.invalid);
  }
  if (Number.isNaN(Date.parse(fetchedAt))) {
    throw pinError(`${source}: fetchedAt 不是可解析的时间：${fetchedAt}`, PIN_ERROR_CODES.invalid);
  }
  if (!nonEmptyString(upstreamRef)) {
    throw pinError(`${source}: upstreamRef 缺失或为空`, PIN_ERROR_CODES.invalid);
  }
  if (!isRecord(sha256)) {
    throw pinError(`${source}: sha256 缺失或不是对象`, PIN_ERROR_CODES.invalid);
  }

  const entries = Object.entries(sha256);
  if (entries.length === 0) {
    throw pinError(`${source}: sha256 不得为空（空表等于没有钉扎）`, PIN_ERROR_CODES.invalid);
  }
  const normalized: Record<string, string> = {};
  for (const [relativePath, digest] of entries) {
    assertSafeRelativePath(relativePath, source);
    if (!nonEmptyString(digest) || !HEX64_RE.test(digest)) {
      throw pinError(`${source}: ${relativePath} 的 sha256 不是 64 个 hex 字符`, PIN_ERROR_CODES.invalid, {
        relativePath,
      });
    }
    normalized[relativePath] = digest.toLowerCase();
  }

  // 握手常量：与 racp-client 的字面量严格相等（§4.2 的三个握手常量）。
  if (wsPath !== RACP_WS_PATH) {
    throw pinError(`${source}: wsPath=${String(wsPath)} 与 RACP_WS_PATH=${RACP_WS_PATH} 不符`, PIN_ERROR_CODES.bindingMismatch, {
      field: 'wsPath',
      expected: RACP_WS_PATH,
      actual: wsPath,
    });
  }
  if (wsSubprotocol !== RACP_WS_SUBPROTOCOL) {
    throw pinError(
      `${source}: wsSubprotocol=${String(wsSubprotocol)} 与 RACP_WS_SUBPROTOCOL=${RACP_WS_SUBPROTOCOL} 不符`,
      PIN_ERROR_CODES.bindingMismatch,
      { field: 'wsSubprotocol', expected: RACP_WS_SUBPROTOCOL, actual: wsSubprotocol },
    );
  }

  return { hostVersion, wsPath, wsSubprotocol, sha256: normalized, fetchedAt, upstreamRef };
}

/**
 * 比对「协商出的 hostVersion」与 PIN。
 * 返回生效版本与（被放行时的）不符留痕；不允许时抛 `HOST_VERSION_MISMATCH`。
 */
export function assertHostVersionMatches(
  expected: string,
  actual: string,
  options: { readonly allowHostVersionMismatch?: boolean } = {},
): { readonly hostVersion: string; readonly versionMismatch: { expected: string; actual: string } | undefined } {
  if (actual === expected) {
    return { hostVersion: expected, versionMismatch: undefined };
  }
  if (options.allowHostVersionMismatch === true) {
    return { hostVersion: actual, versionMismatch: { expected, actual } };
  }
  throw new AppError(
    `pi-host 协商版本 ${actual} 与 PIN.json 记录的 ${expected} 不符（升级请走显式 PR 重算 PIN.json）`,
    {
      code: PIN_ERROR_CODES.hostVersionMismatch,
      failureClass: 'auth',
      retriable: false,
      details: { expected, actual },
    },
  );
}

/**
 * 一次完整的 PIN 校验：形状/常量 → 逐文件 SHA256 → （可选）版本比对。
 * 任何一步失败都抛 `AppError`（`failureClass:'auth'`，不重试）。
 */
export async function verifyPin(options: VerifyPinOptions): Promise<PinVerification> {
  const pinPath = join(options.bundleDir, PIN_FILE_NAME);
  const raw = await options.readFile(pinPath);
  if (raw === undefined) {
    throw pinError(`找不到 ${pinPath}（bundle 未 vendored 或版本目录不对）`, PIN_ERROR_CODES.missing, { pinPath });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch (error) {
    throw new AppError(`${pinPath} 不是合法 JSON`, {
      code: PIN_ERROR_CODES.invalid,
      failureClass: 'auth',
      retriable: false,
      cause: error,
    });
  }

  const pin = parsePinFile(parsed, pinPath);

  const files: PinVerifiedFile[] = [];
  for (const [relativePath, expected] of Object.entries(pin.sha256)) {
    const absolutePath = join(options.bundleDir, relativePath);
    const bytes = await options.readFile(absolutePath);
    if (bytes === undefined) {
      // 「文件没了」与「哈希不符」是同一件事：都被替换/删掉了，一律 fail。
      throw pinError(`PIN.json 里记录的 ${relativePath} 不存在（期望 sha256=${expected}）`, PIN_ERROR_CODES.hashMismatch, {
        relativePath,
        absolutePath,
        expected,
        actual: null,
      });
    }
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      throw pinError(`PIN.json 哈希校验失败：${relativePath}`, PIN_ERROR_CODES.hashMismatch, {
        relativePath,
        absolutePath,
        expected,
        actual,
      });
    }
    files.push({ relativePath, absolutePath, sha256: actual });
  }

  const negotiated = options.negotiatedHostVersion;
  const version =
    negotiated === undefined
      ? { hostVersion: pin.hostVersion, versionMismatch: undefined }
      : assertHostVersionMatches(pin.hostVersion, negotiated, {
          ...(options.allowHostVersionMismatch === undefined
            ? {}
            : { allowHostVersionMismatch: options.allowHostVersionMismatch }),
        });

  return {
    pin,
    bundleDir: options.bundleDir,
    files,
    hostVersion: version.hostVersion,
    versionMismatch: version.versionMismatch,
  };
}

/**
 * `vendor/pi-host/<version>/` 下 bundle 的固定布局（§2.2）：`bin/pi-host`。
 * bootstrap 用它拼 spawn 的 `binaryPath`；doctor 用它做「文件在不在」的第一道判断。
 */
export function bundleBinaryPath(bundleDir: string): string {
  return join(bundleDir, 'bin', 'pi-host');
}

/**
 * bundle 可选的启动描述文件（`<bundleDir>/runner.json`）：
 * `{ "command": "bin/node.exe", "args": ["pi-host.js"] }`。
 *
 * 为什么需要：`bin/pi-host` 是 POSIX 启动脚本（`#!/bin/sh` + `exec node pi-host.js`）。
 * Windows 既不认 shebang，也不接受无扩展名的非 PE 文件——`spawn('…/bin/pi-host')` 直接
 * `ENOENT`。把启动命令写成数据而不是写死在代码里，就能在开发机上用同一份 bundle
 * （`{ "command": "node", "args": ["pi-host.js"] }`），而 Linux 生产侧一行都不改。
 *
 * 边界：`runner.json` **不放松**任何安全约束——相对路径按 bundleDir 解析，
 * 哈希校验仍在 `PIN.json`。
 */
export const BUNDLE_RUNNER_FILE_NAME = 'runner.json';

/** 启动命令（`command` + 前置参数，前置参数排在 `buildHostArgs` 之前）。 */
export interface BundleCommand {
  readonly command: string;
  readonly prependArgs: readonly string[];
}

/** `runner.json` 的读取器：文件不存在返回 `undefined`（不抛错）。 */
export type BundleRunnerReadText = (absolutePath: string) => string | undefined;

/** 默认读取器：`node:fs` 同步读；不存在/不可读一律当「没有 runner.json」。 */
function defaultReadText(absolutePath: string): string | undefined {
  try {
    const raw = readFileSync(absolutePath, 'utf8');
    // Windows 上手工写的 JSON 常带 BOM（PowerShell 5.1 的 `Set-Content -Encoding utf8`），
    // `JSON.parse` 会因此报错。剥掉它比要求人手清理现实。
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch {
    return undefined;
  }
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value);
}

/** 相对路径按 bundleDir 解析；`--flag` 这类参数原样保留。 */
function resolveArg(bundleDir: string, value: string): string {
  if (value.startsWith('-')) {
    return value;
  }
  return isAbsoluteLike(value) ? value : join(bundleDir, value);
}

/**
 * 决定「怎么启动这个 bundle」。
 *
 * - 没有 `runner.json`：`{ command: bundleBinaryPath(bundleDir), prependArgs: [] }`，
 *   与 §2.2 的布局完全一致（Linux 生产走这条）。
 * - 有 `runner.json`：按它启动，`args` 里非 `-` 开头的项按 bundleDir 解析成绝对路径
 *   （`node pi-host.js` 里的 `pi-host.js` 不该依赖 `cwd`）。
 */
export function resolveBundleCommand(
  bundleDir: string,
  readText: BundleRunnerReadText = defaultReadText,
): BundleCommand {
  const raw = readText(join(bundleDir, BUNDLE_RUNNER_FILE_NAME));
  if (raw === undefined) {
    return { command: bundleBinaryPath(bundleDir), prependArgs: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError(`${BUNDLE_RUNNER_FILE_NAME} 不是合法 JSON`, {
      code: PIN_ERROR_CODES.runnerInvalid,
      failureClass: 'parse',
      retriable: false,
      cause: error,
    });
  }
  if (!isRecord(parsed) || !nonEmptyString(parsed['command'])) {
    throw pinError(
      `${BUNDLE_RUNNER_FILE_NAME} 必须形如 { "command": "…", "args": ["…"] }`,
      PIN_ERROR_CODES.runnerInvalid,
    );
  }
  const argsValue = parsed['args'];
  if (argsValue !== undefined && (!Array.isArray(argsValue) || argsValue.some((item) => typeof item !== 'string'))) {
    throw pinError(`${BUNDLE_RUNNER_FILE_NAME} 的 args 必须是字符串数组`, PIN_ERROR_CODES.runnerInvalid);
  }

  const command = String(parsed['command']);
  const args = (Array.isArray(argsValue) ? argsValue : []) as readonly string[];
  return {
    command: isAbsoluteLike(command) ? command : join(bundleDir, command),
    prependArgs: args.map((arg) => resolveArg(bundleDir, arg)),
  };
}
