/**
 * exec 代理：bot 进程里的 unix socket / 命名管道服务端，**全机唯一**能触达 docker 的代码路径。
 *
 * 三层结构（tech-plan §4.5）：
 *
 *   host-core ──spawn──▶ shim（`scripts/sandbox-bash`，不碰 docker）
 *                            │ 从 `$PWD` 上溯 ≤4 层找 `.pi-bot/exec.sock`
 *                            ▼
 *                        exec-client（Node，80 行）
 *                            │ 一帧 `{argv, cwd, clientPid}`
 *                            ▼
 *                        **本文件**：按 socket 路径查「job → 容器」映射 → `docker exec`
 *                            │ NDJSON：`{stream,data(base64)}` … `{exitCode}` / `{error}`
 *
 * 为什么映射在 bot 内存里而不是由路径推导容器名：`pwd -P` 在 agent `cd` 之后会变，
 * 由路径推导容器名会指向错误的容器（F1）。「这个 job 对应哪个容器」本来只有 bot 知道。
 *
 * 五条能力边界（同一节 E3，全部在代码里可验证）：
 *   1. 只接受 `{argv, cwd, clientPid}`：白名单校验，多一个键就 `BAD_REQUEST`；
 *   2. `argv` 直接交给 `docker exec`，**不做字符串拼接**；
 *   3. **不透传 env**（容器内只有镜像定义的环境 + 兜底标记 `PI_CMD_ID`）；
 *   4. 不接受容器名参数，按 socket 路径查表；
 *   5. 单条命令超时（容器内 `timeout` + 宿主看门狗）+ 输出上限 1 MB。
 */
import { chmod, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type { SandboxDocker } from './docker.ts';
import { SandboxError, toSandboxError } from './errors.ts';
import {
  buildExecPlan,
  classifyTimeoutMs,
  EXEC_TIMEOUT_BUILD_MS,
  EXEC_TIMEOUT_DEFAULT_MS,
} from './exec-plan.ts';
import {
  endpointDir,
  EXEC_ENDPOINT_FILENAME,
  EXEC_SOCKET_FILENAME,
  isPathInside,
  toContainerPath,
  toHostPath,
} from './paths.ts';
import type { ExecResponseFrame } from './protocol.ts';
import {
  createFrameDecoder,
  createOutputBudget,
  encodeFrame,
  EXEC_OUTPUT_LIMIT_BYTES,
  parseExecRequest,
} from './protocol.ts';
import { NULL_LOGGER } from './types.ts';
import type { SandboxLogger } from './types.ts';

/** 监听地址的两种形态：生产 Linux 是 unix socket，Windows 是命名管道（dev-plan §13.1）。 */
export type EndpointKind = 'unix' | 'pipe';

/** 规范化后的监听地址：`unix:/abs/exec.sock` 或 `pipe:\\.\pipe\pi-bot-<jobId>`。 */
export interface ParsedListenAddress {
  readonly kind: EndpointKind;
  /** unix：socket 文件路径；pipe：命名管道全名。 */
  readonly path: string;
  /** 规范化字符串，映射表的键。 */
  readonly canonical: string;
}

/**
 * 默认监听地址（§4.5 的「位置」规定）：
 *   - POSIX：`<job_dir>/.pi-bot/exec.sock`
 *   - Windows：`\\.\pipe\pi-bot-<jobId>`（本机 AF_UNIX 不可用，实测 `listen` 报 EACCES）
 */
export function defaultListenAddress(
  jobId: string,
  jobDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return `pipe:\\\\.\\pipe\\pi-bot-${jobId}`;
  }
  return `unix:${path.posix.join(endpointDir(jobDir).replace(/\\/g, '/'), EXEC_SOCKET_FILENAME)}`;
}

/** 解析地址字符串；不认识的形态直接报错（绝不「猜一个默认」）。 */
export function parseListenAddress(raw: string): ParsedListenAddress {
  const value = raw.trim();
  if (value.startsWith('unix:')) {
    const socketPath = value.slice('unix:'.length);
    if (!path.isAbsolute(socketPath)) {
      throw new SandboxError(`unix 端点必须是绝对路径：${raw}`, { code: 'BAD_REQUEST' });
    }
    return { kind: 'unix', path: socketPath, canonical: `unix:${socketPath}` };
  }
  if (value.startsWith('pipe:')) {
    const pipePath = value.slice('pipe:'.length);
    if (pipePath.length === 0) {
      throw new SandboxError(`命名管道端点为空：${raw}`, { code: 'BAD_REQUEST' });
    }
    return { kind: 'pipe', path: pipePath, canonical: `pipe:${pipePath}` };
  }
  throw new SandboxError(`无法识别的端点地址：${raw}（应以 unix: 或 pipe: 开头）`, {
    code: 'BAD_REQUEST',
  });
}

/** 一个 job 的端点表项：代理查表后据此决定「进哪个容器、在哪个目录跑」。 */
export interface JobEndpoint {
  readonly jobId: string;
  readonly jobDir: string;
  readonly containerId: string;
  readonly address: ParsedListenAddress;
  /** `<job_dir>/.pi-bot/exec.sock`（pipe 端点时为空）。 */
  readonly socketPath?: string;
  /** `<job_dir>/.pi-bot/exec.endpoint`：承载监听地址，供 Windows 命名管道定位。 */
  readonly endpointFile: string;
}

export interface ListenInput {
  readonly jobId: string;
  readonly jobDir: string;
  readonly containerId: string;
  /** 覆盖默认地址（测试注入 / Docker Desktop 特殊路径）。 */
  readonly address?: string;
}

export interface ExecProxyOptions {
  readonly docker: SandboxDocker;
  readonly logger?: SandboxLogger;
  /** 覆盖平台判断（单测断言两种地址形态）。 */
  readonly platform?: NodeJS.Platform;
  readonly outputLimitBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly buildTimeoutMs?: number;
  /** 宿主看门狗：容器内 `timeout` 之外的兜底（默认 = 命令超时 + 15s）。 */
  readonly watchdogGraceMs?: number;
}

const SOCKET_FILE_MODE = 0o600;
const SOCKET_DIR_MODE = 0o700;

/** 忽略 ENOENT：销毁路径必须幂等（重放一次不该报错）。 */
async function unlinkQuietly(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export class ExecProxy {
  readonly #docker: SandboxDocker;
  readonly #logger: SandboxLogger;
  readonly #platform: NodeJS.Platform;
  readonly #outputLimitBytes: number;
  readonly #defaultTimeoutMs: number;
  readonly #buildTimeoutMs: number;
  readonly #watchdogGraceMs: number;
  /** `Map<规范化地址, {jobId, jobDir, containerId}>`——§4.5 规定的那张表。 */
  readonly #endpoints = new Map<string, JobEndpoint>();
  readonly #servers = new Map<string, net.Server>();
  #closed = false;

  constructor(options: ExecProxyOptions) {
    this.#docker = options.docker;
    this.#logger = options.logger ?? NULL_LOGGER;
    this.#platform = options.platform ?? process.platform;
    this.#outputLimitBytes = options.outputLimitBytes ?? EXEC_OUTPUT_LIMIT_BYTES;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? EXEC_TIMEOUT_DEFAULT_MS;
    this.#buildTimeoutMs = options.buildTimeoutMs ?? EXEC_TIMEOUT_BUILD_MS;
    this.#watchdogGraceMs = options.watchdogGraceMs ?? 15_000;
  }

  /** 当前登记的端点数（测试与水位的健康检查用）。 */
  get size(): number {
    return this.#endpoints.size;
  }

  /** 按地址（或 `.pi-bot/exec.endpoint` 里的原文）取表项。 */
  get(address: string): JobEndpoint | undefined {
    return this.#endpoints.get(address) ?? this.#endpoints.get(this.#tryCanonical(address));
  }

  /** 按 jobId 取表项（生命周期销毁时用）。 */
  findByJobId(jobId: string): JobEndpoint | undefined {
    for (const entry of this.#endpoints.values()) {
      if (entry.jobId === jobId) {
        return entry;
      }
    }
    return undefined;
  }

  list(): JobEndpoint[] {
    return [...this.#endpoints.values()];
  }

  #tryCanonical(address: string): string {
    try {
      return parseListenAddress(address).canonical;
    } catch {
      return address;
    }
  }

  /**
   * 为一个 job 开始监听。返回同时给出规范化地址与端点文件路径，
   * 调用方（容器创建流程）只需要把 jobId / jobDir / containerId 传进来。
   */
  async listen(input: ListenInput): Promise<JobEndpoint> {
    if (this.#closed) {
      throw new SandboxError('exec 代理已销毁，不能再监听新端点', { code: 'EXEC_FAILED' });
    }
    const address = parseListenAddress(
      input.address ?? defaultListenAddress(input.jobId, input.jobDir, this.#platform),
    );
    if (this.#endpoints.has(address.canonical)) {
      throw new SandboxError(`端点已在监听：${address.canonical}`, {
        code: 'BAD_REQUEST',
        details: { jobId: input.jobId },
      });
    }

    const dir = endpointDir(input.jobDir);
    await mkdir(dir, { recursive: true, mode: SOCKET_DIR_MODE });
    // mkdir 的 mode 受 umask 影响，显式再 chmod 一次（§4.5：父目录 0700）
    await chmod(dir, SOCKET_DIR_MODE).catch(() => undefined);

    const endpointFile = path.join(dir, EXEC_ENDPOINT_FILENAME);
    const server = net.createServer();
    const socketPath = address.kind === 'unix' ? address.path : undefined;

    const entry: JobEndpoint = {
      jobId: input.jobId,
      jobDir: input.jobDir,
      containerId: input.containerId,
      address,
      ...(socketPath !== undefined ? { socketPath } : {}),
      endpointFile,
    };

    server.on('connection', (socket) => {
      this.#handleConnection(entry, socket);
    });
    server.on('error', (error) => {
      this.#logger.error({ jobId: entry.jobId, address: address.canonical, err: error }, 'exec 端点错误');
    });

    if (address.kind === 'unix') {
      // 上一轮崩溃可能留下一个死 socket 文件，listen 会报 EADDRINUSE
      await unlinkQuietly(address.path);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address.path, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await chmod(address.path, SOCKET_FILE_MODE).catch(() => undefined);
    } else {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address.path, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    }

    await writeFile(endpointFile, `${address.canonical}\n`, { mode: SOCKET_FILE_MODE });
    this.#endpoints.set(address.canonical, entry);
    this.#servers.set(address.canonical, server);
    this.#logger.info(
      { jobId: entry.jobId, containerId: entry.containerId, address: address.canonical },
      'exec 端点已监听',
    );
    return entry;
  }

  /** 销毁某个 job 的端点：关 server、unlink socket / 端点文件、删映射（§6.3 的两个必做动作之一）。 */
  async destroy(target: string | { jobId: string }): Promise<void> {
    const entry = typeof target === 'string' ? this.get(target) : this.findByJobId(target.jobId);
    if (entry === undefined) {
      return;
    }
    const server = this.#servers.get(entry.address.canonical);
    this.#servers.delete(entry.address.canonical);
    this.#endpoints.delete(entry.address.canonical);
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    if (entry.socketPath !== undefined) {
      await unlinkQuietly(entry.socketPath);
    }
    await unlinkQuietly(entry.endpointFile);
    this.#logger.info({ jobId: entry.jobId }, 'exec 端点已销毁');
  }

  /** 退出时收干净（bot 停机路径）。 */
  async destroyAll(): Promise<void> {
    this.#closed = true;
    for (const entry of [...this.#endpoints.values()]) {
      await this.destroy(entry.address.canonical);
    }
  }

  #handleConnection(entry: JobEndpoint, socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.on('error', () => {
      // 客户端提前断开（agent 打断命令）不是错误，忽略即可
    });
    const decode = createFrameDecoder();
    let started = false;
    socket.on('data', (chunk: Buffer) => {
      if (started) {
        return;
      }
      let frames: unknown[];
      try {
        frames = decode(chunk);
      } catch (error) {
        const normalized = toSandboxError(error, { code: 'BAD_REQUEST' });
        this.#writeFrame(socket, { error: { code: normalized.code, message: normalized.message } });
        socket.end();
        return;
      }
      const first = frames[0];
      if (first === undefined) {
        return;
      }
      started = true;
      void this.#execute(entry, first, socket);
    });
  }

  /** 一条请求的完整生命周期：校验 → 解析 cwd → 组装计划 → 流式回传 → 末帧。 */
  async #execute(entry: JobEndpoint, rawRequest: unknown, socket: net.Socket): Promise<void> {
    const budget = createOutputBudget(this.#outputLimitBytes);
    let watchdog: NodeJS.Timeout | undefined;
    try {
      const request = parseExecRequest(rawRequest);
      const workdir = await this.#resolveWorkdir(entry, request.cwd);
      const timeoutMs = classifyTimeoutMs(request.argv, {
        defaultMs: this.#defaultTimeoutMs,
        buildMs: this.#buildTimeoutMs,
      });
      const plan = buildExecPlan({ argv: request.argv, workdir, timeoutMs });

      const aborted = new Error('watchdog');
      const guard = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          reject(
            new SandboxError(
              `宿主看门狗触发：容器内 timeout（${plan.timeoutSeconds}s）没有生效`,
              { code: 'EXEC_TIMEOUT', details: { cmdId: plan.cmdId, containerId: entry.containerId } },
            ),
          );
        }, timeoutMs + this.#watchdogGraceMs);
        // 不要因为这道看门狗把进程留住（bot 退出时不该被定时器拖住）
        watchdog.unref?.();
        socket.once('close', () => {
          reject(aborted);
        });
      });

      const run = this.#docker.execStream({
        containerId: entry.containerId,
        cmd: plan.cmd,
        workdir: plan.workdir,
        env: plan.env,
        onStdout: (chunk) => this.#writeData(socket, budget, 'stdout', chunk),
        onStderr: (chunk) => this.#writeData(socket, budget, 'stderr', chunk),
      });

      const result = await Promise.race([run, guard]);
      const truncated = budget.truncated;
      this.#writeFrame(
        socket,
        truncated ? { exitCode: result.exitCode, truncated } : { exitCode: result.exitCode },
      );
    } catch (error) {
      const normalized = toSandboxError(error, { code: 'EXEC_FAILED' });
      this.#logger.warn(
        { jobId: entry.jobId, code: normalized.code, msg: normalized.message },
        'exec 请求失败',
      );
      this.#writeFrame(socket, { error: { code: normalized.code, message: normalized.message } });
    } finally {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
      socket.end();
    }
  }

  /**
   * `cwd` 校验（dev-plan §11 E7 的裁定）：解析后必须落在该 job 的 job_dir 之内，
   * 否则报 `CWD_OUTSIDE_JOB`（客户端退 3）。**绝不静默回退到 job_dir**——
   * 「悄悄换个目录执行」比失败更危险：写回闸门的「编辑路径」判定会因此失真。
   */
  async #resolveWorkdir(entry: JobEndpoint, clientCwd: string): Promise<string> {
    const hostCwd = toHostPath(clientCwd);
    const absolute = path.isAbsolute(hostCwd) ? hostCwd : path.resolve(entry.jobDir, hostCwd);
    let realJob: string;
    let realCwd: string;
    try {
      realJob = await realpath(entry.jobDir);
    } catch {
      realJob = path.resolve(entry.jobDir);
    }
    try {
      realCwd = await realpath(absolute);
    } catch (cause) {
      // 目录不存在 / 权限不足：它不可能「在 job 内」，按越界处理（同一退出码，语义更保守）
      throw new SandboxError(`cwd 无法解析：${clientCwd}`, {
        code: 'CWD_OUTSIDE_JOB',
        details: { clientCwd, jobDir: entry.jobDir },
        cause,
      });
    }
    if (!isPathInside(realJob, realCwd)) {
      throw new SandboxError(`cwd 不在该 job 的目录内：${clientCwd}`, {
        code: 'CWD_OUTSIDE_JOB',
        details: { clientCwd, jobDir: entry.jobDir, resolved: realCwd },
      });
    }
    // 容器内路径由 job 的容器路径 + 相对段拼出，保证与身份挂载的挂载点一致
    const relative = path.relative(realJob, realCwd);
    const containerJobDir = toContainerPath(entry.jobDir);
    if (relative.length === 0) {
      return containerJobDir;
    }
    return path.posix.join(containerJobDir.replace(/\\/g, '/'), relative.replace(/\\/g, '/'));
  }

  #writeData(
    socket: net.Socket,
    budget: ReturnType<typeof createOutputBudget>,
    stream: 'stdout' | 'stderr',
    chunk: Buffer,
  ): void {
    const allowed = budget.take(chunk.byteLength);
    if (allowed === 0) {
      return;
    }
    const slice = allowed === chunk.byteLength ? chunk : chunk.subarray(0, allowed);
    this.#writeFrame(socket, { stream, data: slice.toString('base64') });
  }

  #writeFrame(socket: net.Socket, frame: ExecResponseFrame): void {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }
    socket.write(encodeFrame(frame));
  }
}
