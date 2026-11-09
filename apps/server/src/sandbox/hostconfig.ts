/**
 * 容器规格映射：plan §8.1 → dockerode，逐条对齐 tech-plan §6.1 的表。
 *
 * 全部是**纯函数**，不碰 docker、不读环境：输入 job 目录与档位，输出可直接交给
 * `docker.createContainer()` 的对象。这样「规格是否逐条落地」可以靠单测逐字段断言，
 * 不需要起容器（真容器断言在 `test/sandbox-docker.test.ts`）。
 *
 * 三处对 plan §8.1 的**有意偏离**，都在 tech-plan 里有裁定：
 *   - **`/work` 作废**（E1，§4.5）：改用身份挂载 `Binds = ["<job>:<job>:rw"]` + `WorkingDir = <job>`，
 *     容器内 `pwd` 与宿主路径一致（代理的 `-w <cwd>` 才能成立）。本文件里**不允许出现 `/work`**。
 *   - **内存分档**（§3.6）：`--memory 2g` 统一值会让 `pnpm build` / `cargo build` 被 OOM kill，
 *     按任务类型分 2 GB / 4 GB，并配套 `NODE_OPTIONS=--max-old-space-size=<上限×0.6>`。
 *   - **不加 `--rm`**（`AutoRemove: false`）：§6.3 要求销毁前先 `inspect` 采 `State.OOMKilled`，
 *     `--rm` 会抢在 inspect 之前把容器对象删掉，`sandbox-oom` 就永远判不出来。
 */
import type { HostConfig } from 'dockerode';

import { toBindSource, toContainerPath } from './paths.ts';

/** 内存档位（tech-plan §3.6）。 */
export type SandboxMemoryTier = 'triage' | 'build';

/** 判定类 2 GB / `/review-pr` 类 4 GB。 */
export const MEMORY_TIER_BYTES: Readonly<Record<SandboxMemoryTier, number>> = Object.freeze({
  triage: 2 * 1024 ** 3,
  build: 4 * 1024 ** 3,
});

/** 依赖缓存卷：只读挂载，镜像里 `/cache` 不能写（§6.1）。 */
export const DEFAULT_CACHE_VOLUME = 'pi-dep-cache';
/** 专用 bridge 网络（§6.2），不是 `internal`，所以能出公网。 */
export const DEFAULT_NETWORK_MODE = 'pi-jobs';
/** tmpfs 参数按 §6.1 的字面量。 */
export const DEFAULT_TMPFS = Object.freeze({ '/tmp': 'rw,size=512m,noexec,nosuid' });
/** `--pids-limit 512`。 */
export const DEFAULT_PIDS_LIMIT = 512;
/** `--cpus 2` → NanoCpus。 */
export const DEFAULT_NANO_CPUS = 2e9;
/** `--user 1001:1001`。 */
export const DEFAULT_USER = '1001:1001';
/** `--ulimit nofile=4096`。 */
export const DEFAULT_NOFILE = 4096;

export interface SandboxContainerInput {
  /** 短 id，落在 `tasks.id` 上；容器名 `pi-job-<jobId>`（§6.1）。 */
  readonly jobId: string;
  /** 宿主的 job 目录（worktree 根）。身份挂载下容器内路径与之相同。 */
  readonly jobDir: string;
  /** worker 镜像，如 `pi-worker:node22`。 */
  readonly image: string;
  /** 内存档位，默认 `triage`（2 GB）。 */
  readonly memoryTier?: SandboxMemoryTier;
  /** 显式内存上限（字节），优先于档位；测试与特殊任务用。 */
  readonly memoryBytes?: number;
  /** 网络模式，默认 `pi-jobs`；高风险任务可显式传 `none`（§6.2 加固档）。 */
  readonly networkMode?: string;
  /** 缓存卷名，默认 `pi-dep-cache`。 */
  readonly cacheVolume?: string;
  /** 覆盖 NanoCpus（测试用）。 */
  readonly nanoCpus?: number;
  /** 覆盖 PidsLimit（测试用）。 */
  readonly pidsLimit?: number;
  /** 覆盖 User（测试用；生产恒为 `1001:1001`）。 */
  readonly user?: string;
}

/** 档位 / 显式值 → 实际内存上限字节数。 */
export function resolveMemoryBytes(input: SandboxContainerInput): number {
  if (input.memoryBytes !== undefined) {
    if (!Number.isInteger(input.memoryBytes) || input.memoryBytes < 64 * 1024 * 1024) {
      throw new RangeError(`memoryBytes 非法：${String(input.memoryBytes)}（至少 64 MiB）`);
    }
    return input.memoryBytes;
  }
  return MEMORY_TIER_BYTES[input.memoryTier ?? 'triage'];
}

/**
 * §3.6 的配套：`NODE_OPTIONS=--max-old-space-size=<上限×0.6>`（MB，向下取整）。
 * 让 Node 在撞到 cgroup 上限之前先自己 GC 失败退出，报错信息可读，而不是容器无声消失。
 */
export function nodeOptionsFor(memoryBytes: number, factor = 0.6): string {
  const megabytes = Math.max(64, Math.floor((memoryBytes / 1024 ** 2) * factor));
  return `--max-old-space-size=${megabytes}`;
}

/** 容器名：`pi-job-<jobId>`，**不由 worktree 路径推导**（F1，§4.5）。 */
export function containerNameFor(jobId: string): string {
  return `pi-job-${jobId}`;
}

/**
 * 逐行映射 §6.1 的 HostConfig。
 *
 * 表里 `Cmd` / `WorkingDir` 两行在 Docker API 里属于**容器级**参数（不是 HostConfig 的字段），
 * 所以它们由 `buildContainerCreateOptions()` 落到 `ContainerCreateOptions` 上；
 * 单测会同时断言两处，`/work` 的缺席断言扫的是整个 create options。
 */
export function buildHostConfig(input: SandboxContainerInput): HostConfig {
  const memoryBytes = resolveMemoryBytes(input);
  return {
    // --read-only
    ReadonlyRootfs: true,
    // --tmpfs /tmp:rw,size=512m,noexec,nosuid
    Tmpfs: { ...DEFAULT_TMPFS },
    // --cap-drop ALL
    CapDrop: ['ALL'],
    // --security-opt no-new-privileges
    SecurityOpt: ['no-new-privileges'],
    // --pids-limit 512
    PidsLimit: input.pidsLimit ?? DEFAULT_PIDS_LIMIT,
    // --memory <档位> --memory-swap 同值（禁 swap）
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    // --cpus 2
    NanoCpus: input.nanoCpus ?? DEFAULT_NANO_CPUS,
    // --user 1001:1001 是容器级 `User`（Docker API 里不属于 HostConfig，见 buildContainerCreateOptions）
    // --ulimit nofile=4096
    Ulimits: [{ Name: 'nofile', Soft: DEFAULT_NOFILE, Hard: DEFAULT_NOFILE }],
    // --init
    Init: true,
    // 身份挂载（§4.5 E1）：源与目标都是 job 目录，**不再是 /work**
    Binds: [
      `${toBindSource(input.jobDir)}:${toContainerPath(input.jobDir)}:rw`,
      `${input.cacheVolume ?? DEFAULT_CACHE_VOLUME}:/cache:ro`,
    ],
    // 常驻空转，按需 docker exec（§6.1）
    NetworkMode: input.networkMode ?? DEFAULT_NETWORK_MODE,
    // 生命周期自己管销毁（§6.3 要求销毁前 inspect），不能让 --rm 抢跑
    AutoRemove: false,
    // 日志上限：容器日志不带出宿主，但没有上限会吃满磁盘（§7.6 的水位清理只清容器，不清日志）
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
  };
}

/** 完整的容器创建参数（HostConfig + 容器级字段）。 */
export interface SandboxContainerSpec {
  readonly name: string;
  readonly Image: string;
  readonly Cmd: string[];
  readonly WorkingDir: string;
  /** `--user`：Docker API 把它放在容器级配置（不是 HostConfig），所以映射落在这里。 */
  readonly User: string;
  readonly Env: string[];
  readonly Labels: Record<string, string>;
  readonly Tty: boolean;
  readonly AttachStdout: boolean;
  readonly AttachStderr: boolean;
  readonly HostConfig: HostConfig;
}

/** 组装 `docker.createContainer()` 的完整参数。 */
export function buildContainerCreateOptions(input: SandboxContainerInput): SandboxContainerSpec {
  const memoryBytes = resolveMemoryBytes(input);
  return {
    name: containerNameFor(input.jobId),
    Image: input.image,
    // sleep infinity：容器常驻，命令全部走 exec 代理（§6.1）
    Cmd: ['sleep', 'infinity'],
    // 身份挂载：容器内工作目录 = 宿主 job 目录（§4.5）
    WorkingDir: toContainerPath(input.jobDir),
    // --user 1001:1001（§6.1）
    User: input.user ?? DEFAULT_USER,
    // 镜像定义的环境 + §3.6 的 Node 堆上限；**不含任何凭证**
    Env: [
      `NODE_OPTIONS=${nodeOptionsFor(memoryBytes)}`,
      'HOME=/home/pi',
      'CI=true',
      'TERM=dumb',
    ],
    // 标签用于水位清理时反查 job（§6.3 / §7.6）
    Labels: {
      'pi-bot.job-id': input.jobId,
      'pi-bot.role': 'worker',
      'pi-bot.memory-bytes': String(memoryBytes),
    },
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: buildHostConfig(input),
  };
}
