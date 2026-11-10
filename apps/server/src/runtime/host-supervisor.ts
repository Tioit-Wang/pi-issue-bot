/**
 * pi-host 子进程监督（tech-plan §3.4 崩溃半径 / §4.2 引导 / §4.3 每任务时序）。
 *
 * 一个 pi-host 常驻，任务级隔离靠 session（§4.3），因此「这个进程挂了怎么办」必须有确定答案：
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 启动成功 | 读 stdout **首行** `PI_HOST_READY {json}`；`--pair` 时读**第二行** `PI_HOST_PAIRING_TOKEN {json}` |
 * | 意外退出 | 退避 `0.5s → 1s → 2s` 重启（序列可注入） |
 * | 2 分钟内已重启 3 次 | **放弃**，把 `HOST_CRASH_LOOP` 交给上层（`waitForFatal()`） |
 * | `stop()` | `SIGTERM` → 等 `stopGraceMs` → 仍未退则 `SIGKILL` |
 *
 * 为什么全部依赖注入（spawn / 时钟 / sleep / 信号）：本机没有 `vendor/pi-host` bundle
 * （dev-plan §13.1），单测里不能 spawn 真实进程；同时「退避与放弃上限」这类
 * 时间相关逻辑，只有把 `sleep` 换成瞬时的，才能既快又确定地测出来。
 *
 * 进程信息对外只暴露 `{hostId, port, version, pid, restarts}`（外加 `host` 与 `pairing`）：
 * 上层（bootstrap / serve / doctor）不该拿到 ChildProcess 本身，否则「谁负责 kill」会变模糊。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  PAIRING_TOKEN_PREFIX,
  AppError,
  createNullLogger,
  previewRedacted,
  toAppError,
} from './deps.ts';
import type { Logger } from './deps.ts';

/** stdout 第一行的前缀（§4.2 已验证的 CLI 事实）。 */
export const PI_HOST_READY_PREFIX = 'PI_HOST_READY';
/** `--pair` 时 stdout 第二行的前缀。 */
export const PI_HOST_PAIRING_TOKEN_PREFIX = 'PI_HOST_PAIRING_TOKEN';

/** 退避默认序列：0.5s → 1s → 2s（§3.4）。 */
export const DEFAULT_HOST_BACKOFF_MS = [500, 1_000, 2_000] as const;
/** 重启计数窗口：2 分钟。 */
export const DEFAULT_RESTART_WINDOW_MS = 120_000;
/** 窗口内最多重启次数：3 次，之后放弃。 */
export const DEFAULT_MAX_RESTARTS_PER_WINDOW = 3;
/** 优雅停止等待期：SIGTERM 之后等这么久再 SIGKILL。 */
export const DEFAULT_STOP_GRACE_MS = 5_000;
/** 等 READY 行的上限：Host 起 sidecar + host-core 需要时间，但 15s 还没起来就是有问题。 */
export const DEFAULT_READY_TIMEOUT_MS = 15_000;

/** 监督相关的错误码。 */
export const HOST_SUPERVISOR_ERROR_CODES = {
  state: 'HOST_SUPERVISOR_STATE',
  readyParse: 'PI_HOST_READY_PARSE',
  readyMissing: 'PI_HOST_READY_MISSING',
  readyTimeout: 'PI_HOST_READY_TIMEOUT',
  pairingParse: 'PI_HOST_PAIRING_PARSE',
  pairingMissing: 'PI_HOST_PAIRING_MISSING',
  crashLoop: 'HOST_CRASH_LOOP',
} as const;

/** `PI_HOST_READY {"hostId","host","port","version"}` 的解析结果。 */
export interface HostReadyInfo {
  readonly hostId: string;
  /** bind 地址；`--port 0` 时只用于日志（恒为 loopback）。 */
  readonly host?: string;
  readonly port: number;
  readonly version: string;
}

/** `PI_HOST_PAIRING_TOKEN {"token","expiresAt"}` 的解析结果。 */
export interface HostPairingInfo {
  /** `ppt1.…` 配对令牌，单次消费。**不进日志**。 */
  readonly token: string;
  /** ISO 8601。默认寿命 10 分钟。 */
  readonly expiresAt: string;
}

/** 一次成功启动后对外暴露的信息。 */
export interface HostRuntimeInfo {
  readonly hostId: string;
  readonly host?: string;
  readonly port: number;
  readonly version: string;
  readonly pid: number | undefined;
  /** 到目前为止发生过的重启次数（0 = 首发进程）。 */
  readonly restarts: number;
  /** 只在 `pair: true` 时存在。 */
  readonly pairing?: HostPairingInfo;
}

export type HostSupervisorStatus = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed';

/** 传给注入的 spawn 的启动命令（`args` 可直接断言，便于测「启动参数由配置传入」）。 */
export interface HostSpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface HostProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * 注入的子进程视图。
 * `stdoutLines` 是**已按行切好**的异步序列（真实实现用 `node:readline`，假实现用生成器）。
 */
export interface HostChildProcess {
  readonly pid: number | undefined;
  readonly stdoutLines: AsyncIterable<string>;
  readonly stderrLines?: AsyncIterable<string>;
  /** 进程退出（已退出时立即 resolve）。 */
  readonly exited: Promise<HostProcessExit>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
}

export type HostSpawn = (command: HostSpawnCommand) => HostChildProcess;

export interface HostSupervisorOptions {
  readonly spawn: HostSpawn;
  /** pi-host 可执行文件（`vendor/pi-host/<version>/bin/pi-host`）。 */
  readonly binaryPath: string;
  /** `--data-dir`：Host 的会话/模型状态目录。 */
  /**
   * 排在 `buildHostArgs` 之前的参数（`runner.json` 的 `args`）。
   * Windows 开发机上 `command` 是 `node`、这里放 `pi-host.js`；Linux 生产恒为空。
   */
  readonly prependArgs?: readonly string[];
  readonly dataDir: string;
  /** `--port`，默认 0（随机端口，引导期用）。 */
  readonly port?: number;
  /** `--pair`：引导期传 true，正常启动不传（§4.2 第 6 步）。 */
  readonly pair?: boolean;
  readonly hostCorePath?: string;
  readonly sidecarPath?: string;
  readonly pairingLifetimeMs?: number;
  readonly logLevel?: string;
  /** 子进程基准环境（默认 `process.env`；显式传入便于测试断言）。 */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** 追加环境（例如模型 key 由 bot 继承给 Host，§10.4）。 */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** `PI_DESKTOP_BASH`（§4.5 的 shim）；引导期由部署配置给出。 */
  readonly sandboxBashPath?: string;
  readonly cwd?: string;
  /** 退避序列，默认 `[500,1000,2000]`。 */
  readonly backoffMs?: readonly number[];
  readonly restartWindowMs?: number;
  readonly maxRestartsPerWindow?: number;
  readonly stopGraceMs?: number;
  readonly readyTimeoutMs?: number;
  /** 可注入的等待（退避用）。默认 `setTimeout`。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 可注入的时钟（重启窗口用）。默认 `Date.now`。 */
  readonly now?: () => number;
  readonly logger?: Logger;
  /** 每次重启成功后回调（上层要重置会话/重连 WS）。 */
  readonly onRestart?: (info: HostRuntimeInfo) => void;
  /** 放弃时回调（与 `waitForFatal()` 二选一，两个都可用）。 */
  readonly onFatal?: (error: AppError) => void;
}

function parseError(message: string, code: string, details?: Record<string, unknown>): AppError {
  return new AppError(message, {
    code,
    failureClass: 'parse',
    retriable: false,
    ...(details === undefined ? {} : { details }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拆 `PREFIX {json}`：前缀必须严格匹配，json 部分必须是对象。 */
function splitPrefixedLine(line: string, prefix: string, code: string): Record<string, unknown> {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed.startsWith(prefix)) {
    throw parseError(`stdout 首行应为 ${prefix} …，实际是「${previewRedacted(trimmed, 120)}」`, code, {
      expectedPrefix: prefix,
    });
  }
  const rest = trimmed.slice(prefix.length).trim();
  if (!rest.startsWith('{')) {
    throw parseError(`${prefix} 之后应为 JSON 对象，实际是「${previewRedacted(rest, 120)}」`, code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest) as unknown;
  } catch (error) {
    throw new AppError(`${prefix} 后的 JSON 解析失败`, {
      code,
      failureClass: 'parse',
      retriable: false,
      details: { line: previewRedacted(trimmed, 200) },
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw parseError(`${prefix} 后的 JSON 应为对象`, code);
  }
  return parsed;
}

/** 解析 `PI_HOST_READY {json}`（首行）。格式错误抛 `PI_HOST_READY_PARSE`。 */
export function parseHostReadyLine(line: string): HostReadyInfo {
  const payload = splitPrefixedLine(line, PI_HOST_READY_PREFIX, HOST_SUPERVISOR_ERROR_CODES.readyParse);
  const { hostId, host, port, version } = payload;

  if (typeof hostId !== 'string' || hostId.length === 0) {
    throw parseError(`${PI_HOST_READY_PREFIX} 缺少 hostId`, HOST_SUPERVISOR_ERROR_CODES.readyParse);
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw parseError(`${PI_HOST_READY_PREFIX} 缺少 version`, HOST_SUPERVISOR_ERROR_CODES.readyParse);
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw parseError(`${PI_HOST_READY_PREFIX} 的 port 不是 1..65535 的整数：${String(port)}`, HOST_SUPERVISOR_ERROR_CODES.readyParse);
  }
  if (host !== undefined && typeof host !== 'string') {
    throw parseError(`${PI_HOST_READY_PREFIX} 的 host 应为字符串`, HOST_SUPERVISOR_ERROR_CODES.readyParse);
  }

  return {
    hostId,
    port,
    version,
    ...(typeof host === 'string' ? { host } : {}),
  };
}

/** 解析 `PI_HOST_PAIRING_TOKEN {json}`（`--pair` 时的第二行）。格式错误抛 `PI_HOST_PAIRING_PARSE`。 */
export function parseHostPairingTokenLine(line: string): HostPairingInfo {
  const payload = splitPrefixedLine(line, PI_HOST_PAIRING_TOKEN_PREFIX, HOST_SUPERVISOR_ERROR_CODES.pairingParse);
  const { token, expiresAt } = payload;

  if (typeof token !== 'string' || !token.startsWith(PAIRING_TOKEN_PREFIX)) {
    // 不把 token 打进 details：它本身是凭证。
    throw parseError(`${PI_HOST_PAIRING_TOKEN_PREFIX} 的 token 必须以 ${PAIRING_TOKEN_PREFIX} 开头`, HOST_SUPERVISOR_ERROR_CODES.pairingParse);
  }
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw parseError(
      `${PI_HOST_PAIRING_TOKEN_PREFIX} 的 expiresAt 不是可解析的时间`,
      HOST_SUPERVISOR_ERROR_CODES.pairingParse,
    );
  }

  return { token, expiresAt };
}

/** 拼启动参数（§4.2 已验证的 CLI 事实）。抽出来是为了能直接断言「参数由配置传入」。 */
export function buildHostArgs(options: {
  readonly dataDir: string;
  readonly port?: number;
  readonly pair?: boolean;
  readonly hostCorePath?: string;
  readonly sidecarPath?: string;
  readonly pairingLifetimeMs?: number;
  readonly logLevel?: string;
}): string[] {
  const args: string[] = ['--data-dir', options.dataDir, '--port', String(options.port ?? 0)];
  if (options.hostCorePath !== undefined) {
    args.push('--host-core', options.hostCorePath);
  }
  if (options.sidecarPath !== undefined) {
    args.push('--sidecar', options.sidecarPath);
  }
  if (options.pair === true) {
    args.push('--pair');
  }
  if (options.pairingLifetimeMs !== undefined) {
    args.push('--pairing-lifetime-ms', String(options.pairingLifetimeMs));
  }
  if (options.logLevel !== undefined) {
    args.push('--log-level', options.logLevel);
  }
  return args;
}

/**
 * 真实的 spawn 适配器：`node:child_process` + `node:readline`。
 *
 * 只在装配处使用；单测一律传假 `spawn`，因此测试进程里不会出现真实 pi-host。
 */
export function createNodeHostSpawn(): HostSpawn {
  return (command) => {
    const child = spawn(command.command, [...command.args], {
      env: { ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    });

    const stdoutLines = createInterface({ input: child.stdout });
    const stderrLines = createInterface({ input: child.stderr });

    const exited = new Promise<HostProcessExit>((resolve) => {
      child.once('exit', (code, signal) => {
        stdoutLines.close();
        stderrLines.close();
        resolve({ code, signal });
      });
      // spawn 自身失败（ENOENT 等）走 'error'：把它当「立刻退出」，交给监督逻辑重启或放弃。
      child.once('error', () => {
        resolve({ code: null, signal: null });
      });
    });

    return {
      pid: child.pid,
      stdoutLines,
      stderrLines,
      exited,
      kill: (signal) => child.kill(signal),
    };
  };
}

/** 默认 sleep（真实时钟）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 给「等一行」加超时；超时赢下时不留悬挂的计时器。 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, makeError: () => AppError): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(makeError());
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

type ResolvedOptions = Required<
  Pick<
    HostSupervisorOptions,
    | 'binaryPath'
    | 'dataDir'
    | 'backoffMs'
    | 'restartWindowMs'
    | 'maxRestartsPerWindow'
    | 'stopGraceMs'
    | 'readyTimeoutMs'
  >
> &
  Omit<HostSupervisorOptions, 'backoffMs' | 'restartWindowMs' | 'maxRestartsPerWindow' | 'stopGraceMs' | 'readyTimeoutMs'>;

/**
 * pi-host 监督器。生命周期：`idle → starting → ready → (restarting → ready)* → stopped | failed`。
 *
 * 用法（bootstrap / serve）：
 * ```ts
 * const supervisor = new HostSupervisor({ spawn: createNodeHostSpawn(), binaryPath, dataDir, pair: true, ... });
 * const info = await supervisor.start();          // 拿到 {hostId, port, version, pid}
 * …
 * await supervisor.stop();                         // SIGTERM → SIGKILL
 * ```
 * 崩溃循环放弃时：`await supervisor.waitForFatal()` 会 resolve 出 `HOST_CRASH_LOOP`；
 * 也可以传 `onFatal` 回调立刻处理。
 */
export class HostSupervisor {
  readonly #options: ResolvedOptions;
  readonly #logger: Logger;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  #status: HostSupervisorStatus = 'idle';
  #child: HostChildProcess | undefined;
  #info: HostRuntimeInfo | undefined;
  #restarts = 0;
  #restartTimes: number[] = [];
  #stopping = false;
  #failure: AppError | undefined;
  #crashed = false;
  #crashWaiters: (() => void)[] = [];
  #supervision: Promise<void> | undefined;
  readonly #fatal: Promise<AppError>;
  #resolveFatal: (error: AppError) => void = () => {};

  constructor(options: HostSupervisorOptions) {
    this.#options = {
      ...options,
      backoffMs: options.backoffMs ?? DEFAULT_HOST_BACKOFF_MS,
      restartWindowMs: options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS,
      maxRestartsPerWindow: options.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS_PER_WINDOW,
      stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    };
    this.#logger = options.logger ?? createNullLogger();
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
    this.#fatal = new Promise<AppError>((resolve) => {
      this.#resolveFatal = resolve;
    });
  }

  get status(): HostSupervisorStatus {
    return this.#status;
  }

  /** 最近一次成功启动的信息（未启动或已失败时为 `undefined`）。 */
  get info(): HostRuntimeInfo | undefined {
    return this.#info;
  }

  /** 累计重启次数（成本/稳定性指标）。 */
  get restarts(): number {
    return this.#restarts;
  }

  /** 放弃时 resolve 出错误（`HOST_CRASH_LOOP`）。永不 reject，避免 unhandled rejection。 */
  waitForFatal(): Promise<AppError> {
    return this.#fatal;
  }

  /** 放弃的原因（已放弃时非空）。 */
  get failure(): AppError | undefined {
    return this.#failure;
  }

  /** 启动并等 READY（`--pair` 时再等配对令牌行）。首次启动失败直接抛给调用方，不进入重启循环。 */
  async start(): Promise<HostRuntimeInfo> {
    if (this.#status !== 'idle') {
      throw new AppError(`pi-host 监督器已在 ${this.#status} 状态，不能重复 start()`, {
        code: HOST_SUPERVISOR_ERROR_CODES.state,
        failureClass: 'unknown',
        retriable: false,
        details: { status: this.#status },
      });
    }
    this.#status = 'starting';
    try {
      const info = await this.#spawnAndWait();
      this.#supervision = this.#loop();
      return info;
    } catch (error) {
      const appError = toAppError(error, { code: HOST_SUPERVISOR_ERROR_CODES.readyMissing, failureClass: 'unknown' });
      this.#failure = appError;
      this.#status = 'failed';
      this.#resolveFatal(appError);
      throw appError;
    }
  }

  /** 优雅停止：`SIGTERM` → 等待 `stopGraceMs` → 仍未退则 `SIGKILL`。可重复调用。 */
  async stop(): Promise<void> {
    if (this.#status === 'stopped') {
      return;
    }
    this.#stopping = true;
    const child = this.#child;
    if (child !== undefined) {
      this.#logger.info({ pid: child.pid }, '停止 pi-host（SIGTERM）');
      child.kill('SIGTERM');
      const exited = await Promise.race([
        child.exited.then(() => true),
        this.#sleep(this.#options.stopGraceMs).then(() => false),
      ]);
      if (!exited) {
        this.#logger.warn({ pid: child.pid }, 'pi-host 未在宽限期内退出，SIGKILL');
        child.kill('SIGKILL');
        await child.exited.catch(() => undefined);
      }
    }
    this.#status = 'stopped';
    // 唤醒监督循环（它可能正等下一次崩溃），让 stop() 之后不留下悬挂的 promise。
    this.#notifyCrash();
    if (this.#supervision !== undefined) {
      await this.#supervision.catch(() => undefined);
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  #buildCommand(): HostSpawnCommand {
    const options = this.#options;
    const env: Record<string, string> = {};
    const base = options.baseEnv ?? process.env;
    for (const [key, value] of Object.entries(base)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    Object.assign(env, options.extraEnv ?? {});
    if (options.sandboxBashPath !== undefined) {
      env['PI_DESKTOP_BASH'] = options.sandboxBashPath;
    }

    return {
      command: options.binaryPath,
      env,
      args: [...(this.#options.prependArgs ?? []), ...buildHostArgs(options)],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
  }

  async #spawnAndWait(): Promise<HostRuntimeInfo> {
    const command = this.#buildCommand();
    this.#logger.debug({ command: command.command, args: command.args }, '拉起 pi-host');
    const child = this.#options.spawn(command);
    this.#child = child;

    try {
      const iterator = child.stdoutLines[Symbol.asyncIterator]();
      const readyLine = await withTimeout(
        this.#nextLine(iterator, HOST_SUPERVISOR_ERROR_CODES.readyMissing, 'READY'),
        this.#options.readyTimeoutMs,
        () =>
          new AppError(`等待 ${PI_HOST_READY_PREFIX} 超时（${String(this.#options.readyTimeoutMs)}ms）`, {
            code: HOST_SUPERVISOR_ERROR_CODES.readyTimeout,
            failureClass: 'timeout',
            retriable: true,
            details: { readyTimeoutMs: this.#options.readyTimeoutMs },
          }),
      );
      const ready = parseHostReadyLine(readyLine);

      let pairing: HostPairingInfo | undefined;
      if (this.#options.pair === true) {
        const pairingLine = await withTimeout(
          this.#nextLine(iterator, HOST_SUPERVISOR_ERROR_CODES.pairingMissing, 'PAIRING'),
          this.#options.readyTimeoutMs,
          () =>
            new AppError(`等待 ${PI_HOST_PAIRING_TOKEN_PREFIX} 超时（${String(this.#options.readyTimeoutMs)}ms）`, {
              code: HOST_SUPERVISOR_ERROR_CODES.readyTimeout,
              failureClass: 'timeout',
              retriable: true,
            }),
        );
        pairing = parseHostPairingTokenLine(pairingLine);
      }

      this.#info = {
        hostId: ready.hostId,
        port: ready.port,
        version: ready.version,
        pid: child.pid,
        restarts: this.#restarts,
        ...(ready.host === undefined ? {} : { host: ready.host }),
        ...(pairing === undefined ? {} : { pairing }),
      };
      this.#status = 'ready';
      this.#logger.info(
        { hostId: ready.hostId, port: ready.port, version: ready.version, pid: child.pid, restarts: this.#restarts },
        'pi-host 就绪',
      );

      // 继续消费 stdout/stderr：管道没人读会写满，子进程会卡死在 write 上。
      void this.#drainInit(iterator);
      if (child.stderrLines !== undefined) {
        void this.#drainStderr(child.stderrLines);
      }
      void child.exited.then(
        (exit) => {
          if (this.#child === child) {
            this.#child = undefined;
            this.#notifyCrash();
            this.#logger.warn({ pid: child.pid, code: exit.code, signal: exit.signal }, 'pi-host 退出');
          }
        },
        () => {
          if (this.#child === child) {
            this.#child = undefined;
            this.#notifyCrash();
          }
        },
      );

      return this.#info;
    } catch (error) {
      // 起不来就别留孤儿进程。
      child.kill('SIGKILL');
      if (this.#child === child) {
        this.#child = undefined;
      }
      throw error;
    }
  }

  async #nextLine(
    iterator: AsyncIterator<string>,
    missingCode: string,
    label: string,
  ): Promise<string> {
    const result = await iterator.next();
    if (result.done === true || typeof result.value !== 'string') {
      throw new AppError(`pi-host 未输出 ${label} 行就退出了`, {
        code: missingCode,
        failureClass: 'parse',
        retriable: false,
      });
    }
    return result.value;
  }

  async #drainInit(iterator: AsyncIterator<string>): Promise<void> {
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done === true) {
          return;
        }
        if (typeof result.value === 'string' && result.value.trim().length > 0) {
          this.#logger.debug({ line: result.value }, 'pi-host stdout');
        }
      }
    } catch {
      // 流被关掉是正常路径（进程退出）。
    }
  }

  async #drainStderr(lines: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of lines) {
        if (line.trim().length > 0) {
          // 值级脱敏由 logger 门面统一做（§10.2），这里不自己拼字符串。
          this.#logger.warn({ line }, 'pi-host stderr');
        }
      }
    } catch {
      // 同上。
    }
  }

  #notifyCrash(): void {
    const waiter = this.#crashWaiters.shift();
    if (waiter !== undefined) {
      waiter();
      return;
    }
    this.#crashed = true;
  }

  async #awaitCrash(): Promise<void> {
    if (this.#crashed) {
      this.#crashed = false;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#crashWaiters.push(resolve);
    });
  }

  /** 监督循环：崩溃 → 窗口判限 → 退避 → 重启。放弃时 resolve `#fatal`。 */
  async #loop(): Promise<void> {
    for (;;) {
      await this.#awaitCrash();
      if (this.#stopping) {
        return;
      }

      const now = this.#now();
      this.#restartTimes = this.#restartTimes.filter((at) => now - at < this.#options.restartWindowMs);
      if (this.#restartTimes.length >= this.#options.maxRestartsPerWindow) {
        const error = new AppError(
          `pi-host 在 ${String(this.#options.restartWindowMs)}ms 内已重启 ${String(this.#restartTimes.length)} 次，放弃拉起`,
          {
            code: HOST_SUPERVISOR_ERROR_CODES.crashLoop,
            failureClass: 'sandbox-crash',
            retriable: false,
            details: {
              restarts: this.#restartTimes.length,
              windowMs: this.#options.restartWindowMs,
              maxRestartsPerWindow: this.#options.maxRestartsPerWindow,
            },
          },
        );
        this.#failure = error;
        this.#status = 'failed';
        this.#logger.error({ restarts: this.#restartTimes.length }, 'pi-host 崩溃循环，放弃');
        this.#resolveFatal(error);
        this.#options.onFatal?.(error);
        return;
      }

      const index = Math.min(this.#restarts, this.#options.backoffMs.length - 1);
      const delayMs = this.#options.backoffMs[index] ?? 0;
      this.#restarts += 1;
      this.#restartTimes.push(now);
      this.#status = 'restarting';
      this.#logger.warn({ restarts: this.#restarts, delayMs }, 'pi-host 重启（退避）');

      await this.#sleep(delayMs);
      if (this.#stopping) {
        return;
      }

      try {
        const info = await this.#spawnAndWait();
        this.#options.onRestart?.(info);
      } catch (error) {
        const appError = toAppError(error, { code: HOST_SUPERVISOR_ERROR_CODES.readyMissing, failureClass: 'unknown' });
        this.#logger.error(
          { code: appError.code, message: appError.message, restarts: this.#restarts },
          'pi-host 重启失败，继续按崩溃处理',
        );
        // 让循环回到顶部：这一轮按「又一次崩溃」计数，窗口到上限自然放弃。
        this.#notifyCrash();
      }
    }
  }
}
