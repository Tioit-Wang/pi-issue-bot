/**
 * 依赖注入口（tech-plan §6.4 的「每项一个可注入函数」）。
 *
 * 为什么把 docker / fs / 进程表 / 命令执行全部收进一个结构：
 *  - **可测**：单测要能造「daemon 连不上」「磁盘只剩 3 GB」「镜像不存在」这些**失配路径**，
 *    真去删镜像或塞满盘既慢又脏；假实现只替换被调用的那几个方法。
 *  - **可读**：一项检查能被问「你凭什么看到这个结论」——看它用了 `ctx` 的哪个字段就够。
 *  - **真跑优先**：默认值全是真实实现（真 dockerod、真 `node:fs`、真 `/proc`、真 spawn），
 *    注入只是为了测试与目标机差异，不是为了「假装验证过」。
 *
 * 平台差异（dev-plan §13.1）在这里集中处理：`platform` 由调用方覆盖，
 * 这样「Windows 上该 warn 而不是崩」这类分支可以被单测逐条打中。
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../../../../packages/shared/src/index.ts';
import { defaultMigrationsDir } from '../config/env.ts';
import type { EnvLike } from '../config/env.ts';
import type { SqlExecutor } from '../db/index.ts';
import { createSandboxDocker } from '../sandbox/docker.ts';
import type { SandboxDocker } from '../sandbox/docker.ts';
import { DEFAULT_NETWORK_MODE } from '../sandbox/hostconfig.ts';
import type { CheckOutcome } from './types.ts';

/** `ctx.fs` 需要的能力（只是 `node:fs/promises` 的一个子集，签名收窄到实际用法）。 */
export interface DoctorFs {
  access(target: string, mode?: number): Promise<void>;
  /** 读文本；文件不存在要抛错（调用方按 `ENOENT` 判）。 */
  readFile(target: string, encoding: 'utf8'): Promise<string>;
  /** 读字节；**文件不存在返回 `undefined`**（`verifyPin` 需要这个语义）。 */
  readBytes(target: string): Promise<Uint8Array | undefined>;
  readdir(target: string): Promise<string[]>;
  stat(target: string): Promise<{ readonly mode: number; readonly size: number }>;
  mkdir(target: string, mode?: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(target: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  writeFile(target: string, data: string, mode?: number): Promise<void>;
  /** 可用空间（字节）。`statfs` 的 `bavail * bsize` 才是「非 root 能写多少」。 */
  freeBytes(target: string): Promise<number>;
}

/** 一条外部命令的结果。`code` 为 `-1` 表示进程根本没起来（ENOENT/EACCES）。 */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly timeoutMs?: number;
}

/** 命令执行面：docker CLI、nft 等都走它（不经过 shell，参数按数组传）。 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** `/proc` 的只读视图（`socket-ownership` 用；单测注入假表）。 */
export interface DoctorProc {
  readdir(target: string): Promise<string[]>;
  readFile(target: string, encoding: 'utf8'): Promise<string>;
  readlink(target: string): Promise<string>;
}

/** pi-host 的 `connection/ping`（真实实现要 bundle + RACP 客户端；本机没有 bundle 时留空 → warn）。 */
export type HostPing = () => Promise<{ readonly hostVersion: string }>;

/** 可注入的依赖集合。全部可省略，省略即用真实实现。 */
export interface DoctorDeps {
  readonly env?: EnvLike;
  readonly logger?: Logger;
  /** 覆盖平台判断（Windows / Linux 分支的单测）。 */
  readonly platform?: NodeJS.Platform;
  /** 仓库根（`deploy/`、`migrations/`、`scripts/`、`vendor/` 都在它下面）。 */
  readonly repoRoot?: string;
  /** 数据目录：磁盘水位检查的对象（`PI_BOT_DATA_DIR`）。 */
  readonly dataDir?: string;
  /** `migrations/` 目录（默认由 `config/env.ts` 的 `defaultMigrationsDir()` 给出）。 */
  readonly migrationsDir?: string;
  /** worker 镜像名（`PI_BOT_WORKER_IMAGE`，默认 `pi-worker:node22`）。 */
  readonly image?: string;
  /** 沙箱网络名（`PI_BOT_SANDBOX_NETWORK`，默认 §6.2 的 `pi-jobs`）。 */
  readonly network?: string;
  /** 磁盘下限（字节；默认 20 GB，§6.4）。 */
  readonly diskMinFreeBytes?: number;
  /** `vendor/pi-host/<version>/`（`PI_BOT_BUNDLE_DIR`；不给就在 `vendor/pi-host` 下找）。 */
  readonly bundleDir?: string;
  /** pi-host 的 `connection/ping`；不注入 → `host` 项降级为 warn。 */
  readonly hostPing?: HostPing;
  /** `doctor --allow-host-version-mismatch`：只放宽协商版本，哈希永不放松（§2.2 第 4 条）。 */
  readonly allowHostVersionMismatch?: boolean;
  /** 时钟（时间戳与耗时；单测固定它）。 */
  readonly now?: () => Date;
  /** 时钟（毫秒）；默认 `Date.now`。 */
  readonly elapsed?: () => number;
  readonly fs?: DoctorFs;
  readonly run?: CommandRunner;
  readonly proc?: DoctorProc;
  readonly docker?: SandboxDocker;
  /** 已建好的连接池（`runDoctor` 自建时不需要传）。 */
  readonly pool?: SqlExecutor;
  /** 执行 `exec-roundtrip` 往返用的假 docker（默认内置一个回显假实现）。 */
  readonly roundtripDocker?: SandboxDocker;
}

/** 解析后的依赖：所有字段都有值。 */
export interface ResolvedDeps {
  readonly env: EnvLike;
  readonly logger: Logger;
  readonly platform: NodeJS.Platform;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly migrationsDir: string;
  readonly image: string;
  readonly network: string;
  readonly diskMinFreeBytes: number;
  readonly bundleDir: string | undefined;
  readonly hostPing: HostPing | undefined;
  readonly allowHostVersionMismatch: boolean;
  readonly now: () => Date;
  readonly elapsed: () => number;
  readonly fs: DoctorFs;
  readonly run: CommandRunner;
  readonly proc: DoctorProc;
  readonly docker: SandboxDocker;
  readonly pool: SqlExecutor | undefined;
  readonly roundtripDocker: SandboxDocker | undefined;
}

/** 检查函数的入参就是解析后的依赖（再加几个派生路径，省得每项自己拼）。 */
export interface CheckContext extends ResolvedDeps {
  /** `<repoRoot>/vendor/pi-host`（即使不存在也给路径，好写进 detail）。 */
  readonly vendorDir: string;
  /** `<repoRoot>/deploy/nftables.conf`。 */
  readonly nftablesConf: string;
  /** `<repoRoot>/scripts/sandbox-bash`。 */
  readonly shimPath: string;
}

/** 一项检查：id + 标题 + `run`（`durationMs` 由 `runDoctor` 补，检查自己不算时间）。 */
export interface CheckDefinition {
  readonly id: string;
  readonly title: string;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

/** 20 GB：§6.4 / §3.5 的磁盘下限。 */
export const DEFAULT_DISK_MIN_FREE_BYTES = 20 * 1024 ** 3;

/** 仓库根：本文件在 `apps/server/src/doctor/`，向上四级。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const silentLogger: Logger = {
  level: 'silent',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** 真实 `node:fs/promises` 实现。 */
export const realFs: DoctorFs = {
  access: async (target, mode) => {
    await access(target, mode);
  },
  readFile: (target, encoding) => readFile(target, encoding),
  readBytes: async (target) => {
    try {
      const bytes = await readFile(target);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  },
  readdir: (target) => readdir(target),
  stat: async (target) => {
    const info = await stat(target);
    return { mode: info.mode, size: info.size };
  },
  mkdir: async (target, mode) => {
    await mkdir(target, { recursive: true, ...(mode === undefined ? {} : { mode }) });
  },
  mkdtemp: (prefix) => mkdtemp(prefix),
  rm: async (target) => {
    await rm(target, { recursive: true, force: true });
  },
  chmod: async (target, mode) => {
    await chmod(target, mode);
  },
  writeFile: async (target, data, mode) => {
    await writeFile(target, data, mode === undefined ? {} : { mode });
  },
  freeBytes: async (target) => {
    const info = await statfs(target);
    return Number(info.bavail) * Number(info.bsize);
  },
};

/** 真实 `/proc` 视图。 */
export const realProc: DoctorProc = {
  readdir: (target) => readdir(target),
  readFile: (target, encoding) => readFile(target, encoding),
  readlink: (target) => readlink(target),
};

/** 真实命令执行：不走 shell（参数数组），超时直接 kill。 */
export const realCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      if (!settled) {
        stderr += `\n[doctor] 命令超时（${String(timeoutMs)}ms）：${command}`;
        child.kill();
      }
    }, timeoutMs);
    timer.unref?.();

    const finish = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      stderr += `${error.code ?? 'ERROR'}: ${error.message}`;
      finish(-1);
    });
    child.on('close', (code) => {
      finish(code ?? -1);
    });
  });

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 把「可能缺项的依赖」补齐成 `ResolvedDeps`。
 *
 * 默认值的取向：**宁可真跑、不 pretend**。`platform` 只影响分支判定，
 * `docker` 默认就是真的 `createSandboxDocker()`（构造它不连 daemon，`ping()` 才连）。
 */
export function resolveDeps(deps: DoctorDeps = {}): CheckContext {
  const env = deps.env ?? (process.env as EnvLike);
  // path.resolve：`fileURLToPath(new URL('../../../../'))` 会留一个尾部分隔符，报告里会显示成 `…\pi-issue-bot\`
  const repoRoot = path.resolve(deps.repoRoot ?? REPO_ROOT);
  const diskMinGb = positiveInt(env['PI_BOT_DISK_MIN_GB']);
  const migrationsDir = nonEmpty(env['PI_BOT_MIGRATIONS_DIR']) ?? deps.migrationsDir ?? defaultMigrationsDir();
  const vendorDir = path.join(repoRoot, 'vendor', 'pi-host');
  return {
    env,
    logger: deps.logger ?? silentLogger,
    platform: deps.platform ?? process.platform,
    repoRoot,
    dataDir: deps.dataDir ?? nonEmpty(env['PI_BOT_DATA_DIR']) ?? repoRoot,
    migrationsDir,
    image: deps.image ?? nonEmpty(env['PI_BOT_WORKER_IMAGE']) ?? 'pi-worker:node22',
    network: deps.network ?? nonEmpty(env['PI_BOT_SANDBOX_NETWORK']) ?? DEFAULT_NETWORK_MODE,
    diskMinFreeBytes:
      deps.diskMinFreeBytes ?? (diskMinGb === undefined ? DEFAULT_DISK_MIN_FREE_BYTES : diskMinGb * 1024 ** 3),
    bundleDir: deps.bundleDir ?? nonEmpty(env['PI_BOT_BUNDLE_DIR']),
    hostPing: deps.hostPing,
    allowHostVersionMismatch: deps.allowHostVersionMismatch ?? false,
    now: deps.now ?? ((): Date => new Date()),
    elapsed: deps.elapsed ?? Date.now,
    fs: deps.fs ?? realFs,
    run: deps.run ?? realCommandRunner,
    proc: deps.proc ?? realProc,
    docker: deps.docker ?? createSandboxDocker(),
    pool: deps.pool,
    roundtripDocker: deps.roundtripDocker,
    vendorDir,
    nftablesConf: path.join(repoRoot, 'deploy', 'nftables.conf'),
    shimPath: path.join(repoRoot, 'scripts', 'sandbox-bash'),
  };
}
export const X_OK = fsConstants.X_OK;

/** 把错误压成一行人能看的字符串（`doctor` 的 detail 不允许多行噪声）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

/** 字节 → 「X.X GB」，报告里统一用 GB 说磁盘。 */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}
