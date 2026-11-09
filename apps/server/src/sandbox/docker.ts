/**
 * dockerode 的薄封装：**全机唯一**触达 `/var/run/docker.sock` 的代码就在这一层
 * （plan §8.4 红线 1 / tech-plan §3.3）。pi-host、shim、agent 都拿不到 docker API，
 * 它们能做的只有「请代理在某个 job 的容器里跑一条命令」。
 *
 * 这一层刻意做成一个**窄接口** `SandboxDocker`：
 *   - 代理、生命周期的单测注入假实现即可断言「发了什么请求」（不需要真 daemon）；
 *   - 换实现（比如以后换成 containerd 客户端）不用改上面两层。
 *
 * 平台差异（dev-plan §13.1）：Linux 是 unix socket `/var/run/docker.sock`，
 * Windows 是命名管道 `//./pipe/docker_engine`。地址一律可配置（`PI_BOT_DOCKER_SOCKET`）。
 */
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import Docker from 'dockerode';

import { SandboxError } from './errors.ts';
import type { SandboxContainerSpec } from './hostconfig.ts';
import { toContainerPath } from './paths.ts';

/** 容器状态快照：**销毁前**必须采一次（§3.6 / §6.3 的 `sandbox-oom` 判定全靠它）。 */
export interface ContainerStateSnapshot {
  readonly containerId: string;
  /** Docker 的 `State.Status`：`created` / `running` / `exited` / `dead` … */
  readonly status: string;
  readonly running: boolean;
  /** `State.ExitCode`；还在跑时为 0。 */
  readonly exitCode: number;
  /** `State.OOMKilled`：容器被 cgroup OOM 杀掉（包括 exec 进去的进程）。 */
  readonly oomKilled: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/** 一次流式 exec 的请求。`cmd` 由 `exec-plan.ts` 生成（含容器内 `timeout` 与 `PI_CMD_ID`）。 */
export interface ExecStreamRequest {
  readonly containerId: string;
  readonly cmd: readonly string[];
  readonly workdir: string;
  readonly env: readonly string[];
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
}

/** 沙箱层需要 docker 提供的全部能力（就这六个方法）。 */
export interface SandboxDocker {
  ping(): Promise<void>;
  createContainer(spec: SandboxContainerSpec): Promise<string>;
  inspectState(containerId: string): Promise<ContainerStateSnapshot>;
  execStream(request: ExecStreamRequest): Promise<{ exitCode: number }>;
  destroyContainer(containerId: string): Promise<void>;
}

/**
 * 默认 docker 监听地址。
 * 顺序：`PI_BOT_DOCKER_SOCKET` 显式覆盖 → Windows 命名管道 → Linux unix socket。
 * 显式覆盖是为了测试（Docker Desktop 有时暴露 `//./pipe/dockerDesktopLinuxEngine`）。
 */
export function resolveDockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.PI_BOT_DOCKER_SOCKET;
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  return platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

async function ignoreDockerStatus<T>(promise: Promise<T>, ignored: readonly number[]): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    const statusCode = statusCodeOf(error);
    if (statusCode !== undefined && ignored.includes(statusCode)) {
      return undefined;
    }
    throw error;
  }
}

export interface CreateSandboxDockerOptions {
  /** 已构造好的 dockerode 实例（测试注入）。 */
  readonly docker?: Docker;
  /** 覆盖 socket 路径 / 命名管道。 */
  readonly socketPath?: string;
  /** 覆盖 Host/Port（TCP 直连 daemon 时用）。 */
  readonly host?: string;
  readonly port?: number;
  /** exec.inspect 轮询的次数与间隔（退出码在流结束后才落定，需要短暂等待）。 */
  readonly inspectRetries?: number;
  readonly inspectIntervalMs?: number;
}

/**
 * 造一个 `SandboxDocker`。默认按平台选 socket；`docker` 参数只为测试注入，
 * 生产调用方只需要 `createSandboxDocker()`。
 */
export function createSandboxDocker(options: CreateSandboxDockerOptions = {}): SandboxDocker {
  const docker =
    options.docker ??
    (options.socketPath !== undefined || options.host !== undefined
      ? new Docker(
          options.host !== undefined
            ? { host: options.host, port: options.port ?? 2375 }
            : { socketPath: options.socketPath },
        )
      : new Docker({ socketPath: resolveDockerSocketPath() }));

  const inspectRetries = options.inspectRetries ?? 40;
  const inspectIntervalMs = options.inspectIntervalMs ?? 50;

  return {
    async ping(): Promise<void> {
      try {
        await docker.ping();
      } catch (cause) {
        throw new SandboxError('docker daemon 不可达（ping 失败）', {
          code: 'DOCKER_UNAVAILABLE',
          failureClass: 'sandbox',
          cause,
        });
      }
    },

    async createContainer(spec: SandboxContainerSpec): Promise<string> {
      const container = await docker.createContainer({
        name: spec.name,
        Image: spec.Image,
        Cmd: [...spec.Cmd],
        WorkingDir: spec.WorkingDir,
        User: spec.User,
        Env: [...spec.Env],
        Labels: { ...spec.Labels },
        Tty: spec.Tty,
        AttachStdout: spec.AttachStdout,
        AttachStderr: spec.AttachStderr,
        HostConfig: spec.HostConfig,
      });
      await container.start();
      return container.id;
    },

    async inspectState(containerId: string): Promise<ContainerStateSnapshot> {
      let info;
      try {
        info = await docker.getContainer(containerId).inspect();
      } catch (cause) {
        if (statusCodeOf(cause) === 404) {
          throw new SandboxError(`容器不存在：${containerId}`, {
            code: 'CONTAINER_GONE',
            failureClass: 'sandbox-crash',
            details: { containerId },
            cause,
          });
        }
        throw cause;
      }
      return {
        containerId,
        status: info.State.Status,
        running: info.State.Running,
        exitCode: info.State.ExitCode,
        oomKilled: info.State.OOMKilled,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
      };
    },

    async execStream(request: ExecStreamRequest): Promise<{ exitCode: number }> {
      const container = docker.getContainer(request.containerId);
      const exec = await container.exec({
        Cmd: [...request.cmd],
        WorkingDir: toContainerPath(request.workdir),
        Env: [...request.env],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: false, stdin: false });
      const stdout = new WritableSink(request.onStdout);
      const stderr = new WritableSink(request.onStderr);
      docker.modem.demuxStream(stream, stdout.stream, stderr.stream);
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.on('end', () => resolve());
        stream.on('close', () => resolve());
      });
      // stdout/stderr 里的最后一段可能还在 Writable 的队列里，等一次 flush 再收尾。
      await Promise.all([stdout.drained(), stderr.drained()]);

      // 流结束 ≠ 退出码已落定：inspect 可能短暂报 Running=true，轮询几次。
      for (let attempt = 0; attempt < inspectRetries; attempt += 1) {
        const info = await exec.inspect();
        if (!info.Running && typeof info.ExitCode === 'number') {
          return { exitCode: info.ExitCode };
        }
        await delay(inspectIntervalMs);
      }
      throw new SandboxError('exec 结束后拿不到退出码（inspect 一直是 Running）', {
        code: 'EXEC_FAILED',
        details: { containerId: request.containerId },
      });
    },

    async destroyContainer(containerId: string): Promise<void> {
      const container = docker.getContainer(containerId);
      // kill 与 remove 都忽略「已经没了 / 已经停了」：销毁路径必须幂等，
      // 否则一次重放会把「销毁失败」当成真实故障（超时任务的处置就卡住了）。
      await ignoreDockerStatus(container.kill(), [304, 404, 409]);
      await ignoreDockerStatus(container.remove({ force: true }), [404]);
    },
  };
}
/** 把 dockerode 的 demux 目标包成一个会跟踪「写完没」的 Writable。 */
class WritableSink {
  readonly #stream: Writable;

  constructor(sink: (chunk: Buffer) => void) {
    this.#stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        sink(chunk);
        callback();
      },
    });
  }

  /** dockerode 的 `demuxStream` 要求真正的 Writable，这里把内部流暴露出去。 */
  get stream(): Writable {
    return this.#stream;
  }

  /** 等 Writable 把队列里的最后一段写完（demux 的 `end` 早于 write 回调）。 */
  drained(): Promise<void> {
    return new Promise((resolve) => {
      this.#stream.end(resolve);
    });
  }
}

