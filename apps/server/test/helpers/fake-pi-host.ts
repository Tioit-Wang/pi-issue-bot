/**
 * 测试用的「假 pi-host」与「内存文件表」。
 *
 * 本机没有 `vendor/pi-host` bundle（dev-plan §13.1），而 `runtime/` 的监督与引导逻辑
 * 必须先通过「真进程」之外的方式验证，所以：
 *  - `createFakeHostSpawner()`：实现注入点 `HostSpawn`，把每次 spawn 的启动命令记下来，
 *    按脚本产出 stdout 行，`crash()` 模拟进程意外退出，`kill()` 记录信号；
 *  - `createMemoryReadFile()`：实现注入点 `PinReadFile`，用一张表冒充 bundle 目录。
 *
 * 与 `fake-github.ts` 同一个约定：文件放在 `test/helpers/` 且不叫 `*.test.ts`，
 * 因此不会被 vitest 当用例收集。
 */

import { resolve } from 'node:path';

import type {
  HostChildProcess,
  HostProcessExit,
  HostSpawn,
  HostSpawnCommand,
} from '../../src/runtime/host-supervisor.ts';
import type { PinReadFile } from '../../src/runtime/pin.ts';

/** 一次 spawn 的脚本。 */
export interface FakeHostScript {
  /** 依次产出的 stdout 行。 */
  readonly lines: readonly string[];
  /** 产完 `lines` 后：`true` = 流结束；`false`（默认）= 挂住，模拟长驻进程。 */
  readonly endAfterLines?: boolean;
  /** 收到 SIGTERM 是否真的退出；默认 `true`（测「宽限期到点再 SIGKILL」时传 `false`）。 */
  readonly exitOnSigterm?: boolean;
}

/** 假子进程。 */
export class FakeHostProcess implements HostChildProcess {
  readonly pid: number;
  readonly signals: ('SIGTERM' | 'SIGKILL')[] = [];
  readonly #script: FakeHostScript;
  #resolveExit: (exit: HostProcessExit) => void = () => {};
  readonly #exited: Promise<HostProcessExit>;

  constructor(pid: number, script: FakeHostScript) {
    this.pid = pid;
    this.#script = script;
    this.#exited = new Promise<HostProcessExit>((resolveExit) => {
      this.#resolveExit = resolveExit;
    });
  }

  get exited(): Promise<HostProcessExit> {
    return this.#exited;
  }

  get stdoutLines(): AsyncIterable<string> {
    const lines = this.#script.lines;
    const endAfterLines = this.#script.endAfterLines === true;
    return {
      [Symbol.asyncIterator]: async function* generator(): AsyncGenerator<string> {
        for (const line of lines) {
          yield line;
        }
        if (endAfterLines) {
          return;
        }
        // 长驻进程：流一直开着，直到测试结束（不 resolve 也不会阻止进程退出）。
        await new Promise<void>(() => {});
      },
    };
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || this.#script.exitOnSigterm !== false) {
      this.#resolveExit({ code: null, signal });
    }
    return true;
  }

  /** 模拟「自己崩了」（不是被 kill 的）。 */
  crash(exit: HostProcessExit = { code: 1, signal: null }): void {
    this.#resolveExit(exit);
  }
}

export interface FakeHostSpawnerOptions {
  /** 第 n 次 spawn 用第 n 个脚本；用完复用最后一个；不传则用 `defaultLines`。 */
  readonly scripts?: readonly FakeHostScript[];
  readonly defaultLines?: readonly string[];
}

export interface FakeHostSpawner {
  readonly spawn: HostSpawn;
  /** 每次 spawn 的启动命令（断言启动参数用）。 */
  readonly commands: HostSpawnCommand[];
  /** 每次 spawn 出的子进程（断言信号/崩溃用）。 */
  readonly children: FakeHostProcess[];
  /** 让最近一个子进程崩溃。 */
  crash(index?: number): void;
}

/** 建一个假 spawn 注入点。 */
export function createFakeHostSpawner(options: FakeHostSpawnerOptions = {}): FakeHostSpawner {
  const scripts = options.scripts ?? [];
  const defaultLines = options.defaultLines ?? [];
  const commands: HostSpawnCommand[] = [];
  const children: FakeHostProcess[] = [];
  let pid = 4_000;

  return {
    commands,
    children,
    spawn: (command) => {
      commands.push(command);
      const script = scripts[Math.min(children.length, Math.max(scripts.length - 1, 0))] ?? {
        lines: defaultLines,
      };
      pid += 1;
      const child = new FakeHostProcess(pid, script);
      children.push(child);
      return child;
    },
    crash: (index) => {
      const child = children[index ?? children.length - 1];
      child?.crash();
    },
  };
}

/** `PI_HOST_READY {…}` 行。 */
export function readyLine(
  overrides: {
    readonly hostId?: string;
    readonly host?: string;
    readonly port?: number;
    readonly version?: string;
  } = {},
): string {
  return `PI_HOST_READY ${JSON.stringify({
    hostId: overrides.hostId ?? 'host-1',
    host: overrides.host ?? '127.0.0.1',
    port: overrides.port ?? 51_234,
    version: overrides.version ?? '1.0.0',
  })}`;
}

/** `PI_HOST_PAIRING_TOKEN {…}` 行。 */
export function pairingTokenLine(
  overrides: { readonly token?: string; readonly expiresAt?: string } = {},
): string {
  return `PI_HOST_PAIRING_TOKEN ${JSON.stringify({
    token: overrides.token ?? 'ppt1.test-pairing-token-0001',
    expiresAt: overrides.expiresAt ?? '2026-11-09T20:00:00.000Z',
  })}`;
}

/** 内存文件表：键会被 `resolve` 归一化，这样 `join()` 出来的路径一定命中。 */
export interface MemoryFiles {
  readonly readFile: PinReadFile;
  /** 供断言/篡改：按（归一化后的）路径改内容。 */
  write(path: string, bytes: string | Uint8Array): void;
  readonly paths: string[];
}

export function createMemoryReadFile(files: Readonly<Record<string, string | Uint8Array>>): MemoryFiles {
  const store = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    store.set(
      resolve(path),
      typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content),
    );
  }

  return {
    readFile: async (absolutePath) => store.get(resolve(absolutePath)),
    write: (path, bytes) => {
      store.set(resolve(path), typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes));
    },
    get paths() {
      return [...store.keys()];
    },
  };
}

/** 轮询等待某个条件成立（用于等监督循环的异步重启）。 */
export async function waitFor(
  predicate: () => boolean,
  options: { readonly timeoutMs?: number; readonly label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`等待条件超时（${String(timeoutMs)}ms）：${options.label ?? '未命名条件'}`);
    }
    await new Promise<void>((resolveTick) => {
      setTimeout(resolveTick, 2);
    });
  }
}
