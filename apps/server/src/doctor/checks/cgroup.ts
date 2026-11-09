/**
 * `cgroup`：`--memory` / `--cpus` **真的生效**（tech-plan §6.4 / §6.1，plan §8.5）。
 *
 * 这条检查存在的唯一理由：**不相信参数**。`docker run --memory 2g` 写在命令行里是意图，
 * cgroup 文件里读出来的数字才是事实。两者可能不一样，至少三种情况：
 *  - daemon 侧被覆盖（旧 API 客户端、compose 里另写了 `mem_limit`）；
 *  - 宿主没开 cgroup v2 的 memory controller，`--memory` 静默降级；
 *  - 引擎是 rootless / 特殊后端，配额落在别的层。
 *
 * 实现：用一个**小配额**（256 MiB / 1 CPU）起一次性容器，只在容器里 `cat` cgroup 文件。
 * 用真档位（2 GB）也行，但小配额更快且更容易看出「没生效」（没生效时读到的是宿主总量）。
 */
import { describeError } from '../deps.ts';
import type { CheckDefinition, CommandResult } from '../deps.ts';

/** 检查用的配额（不跟 §3.6 的任务档位混用：这里只验证「参数是否落地」）。 */
export const CGROUP_PROBE_MEMORY_BYTES = 256 * 1024 ** 2;
export const CGROUP_PROBE_CPUS = 1;

/** cgroup v2 优先，v1 兜底；输出形如 `mem=<值>` / `cpu2=<quota> <period>` / `cpu1q=<quota>`。 */
const CGROUP_SCRIPT = [
  'for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do',
  '  if [ -r "$f" ]; then echo "mem=$(cat "$f")"; break; fi;',
  'done',
  'for f in /sys/fs/cgroup/cpu.max; do',
  '  if [ -r "$f" ]; then echo "cpu2=$(cat "$f")"; fi;',
  'done',
  'if [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then echo "cpu1q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)"; fi;',
  'if [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then echo "cpu1p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"; fi;',
].join('\n');

export interface CgroupReadings {
  readonly memoryBytes: number | undefined;
  /** cgroup v2 的 `cpu.max`：`"<quota> <period>"`。 */
  readonly cpuMax: { readonly quota: number; readonly period: number } | undefined;
  /** cgroup v1：`cfs_quota_us` / `cfs_period_us`（任一缺失即 `undefined`）。 */
  readonly cpuCfs: { readonly quota: number; readonly period: number } | undefined;
}

/** 解析容器内打印的键值行；解析不出来就是 `undefined`（不猜默认值）。 */
export function parseCgroupOutput(stdout: string): CgroupReadings {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }
    values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }

  const memRaw = values.get('mem');
  const memoryBytes = memRaw === undefined ? undefined : Number.parseInt(memRaw, 10);

  const cpuParts = values.get('cpu2')?.split(/\s+/);
  const cpuQuota = cpuParts?.[0] === undefined ? undefined : Number.parseInt(cpuParts[0], 10);
  const cpuPeriod = cpuParts?.[1] === undefined ? undefined : Number.parseInt(cpuParts[1], 10);
  const cpuMax =
    cpuQuota === undefined || cpuPeriod === undefined || !Number.isFinite(cpuQuota) || !Number.isFinite(cpuPeriod)
      ? undefined
      : { quota: cpuQuota, period: cpuPeriod };

  const v1Quota = values.get('cpu1q');
  const v1Period = values.get('cpu1p');
  const parsedQuota = v1Quota === undefined ? undefined : Number.parseInt(v1Quota, 10);
  const parsedPeriod = v1Period === undefined ? undefined : Number.parseInt(v1Period, 10);
  const cpuCfs =
    parsedQuota === undefined || parsedPeriod === undefined || parsedQuota <= 0 || parsedPeriod <= 0
      ? undefined
      : { quota: parsedQuota, period: parsedPeriod };

  return {
    memoryBytes: memoryBytes !== undefined && Number.isFinite(memoryBytes) ? memoryBytes : undefined,
    cpuMax,
    cpuCfs,
  };
}

/** 实际被允许的 CPU 个数（v2 → quota/period；v1 → cfs_quota/cfs_period）。 */
export function effectiveCpus(readings: CgroupReadings): number | undefined {
  const source = readings.cpuMax ?? readings.cpuCfs;
  if (source === undefined) {
    return undefined;
  }
  if (!Number.isFinite(source.quota) || !Number.isFinite(source.period) || source.period <= 0) {
    return undefined;
  }
  return source.quota / source.period;
}

/** 允许 2% 的漂移：不同引擎对 cpu 配额的取整方式不同（但 1 → 4 这种量级差异挡得住）。 */
const CPU_TOLERANCE = 0.02;

export const cgroupCheck: CheckDefinition = {
  id: 'cgroup',
  title: '--memory / --cpus 真的生效（读 cgroup 值）',
  async run(ctx) {
    const args = [
      'run',
      '--rm',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=8m,noexec,nosuid',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '64',
      '--memory',
      String(CGROUP_PROBE_MEMORY_BYTES),
      // --memory-swap 同值 = 禁 swap（§6.1 的 `--memory-swap 2g`）
      '--memory-swap',
      String(CGROUP_PROBE_MEMORY_BYTES),
      '--cpus',
      String(CGROUP_PROBE_CPUS),
      ctx.image,
      'sh',
      '-c',
      CGROUP_SCRIPT,
    ];

    let result: CommandResult;
    try {
      result = await ctx.run('docker', args, { timeoutMs: 90_000 });
    } catch (error) {
      return {
        status: 'fail',
        detail: `起探针容器失败：${describeError(error)}`,
        fixHint: '先看 docker / image 两项',
      };
    }
    if (result.code !== 0) {
      const tail = `${result.stderr}\n${result.stdout}`
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-3)
        .join(' / ');
      return {
        status: 'fail',
        detail: `探针容器退出码 ${String(result.code)}（${tail}）`,
        fixHint: `镜像 ${ctx.image} 需要 sh 与 coreutils（images/node22.Dockerfile 已装）`,
      };
    }

    const readings = parseCgroupOutput(result.stdout);
    const cpus = effectiveCpus(readings);
    const problems: string[] = [];

    if (readings.memoryBytes === undefined) {
      problems.push('读不到内存上限（cgroup v1/v2 路径都不存在？）');
    } else if (readings.memoryBytes !== CGROUP_PROBE_MEMORY_BYTES) {
      problems.push(
        `--memory ${String(CGROUP_PROBE_MEMORY_BYTES)} 未生效，实际上限 ${String(readings.memoryBytes)}`,
      );
    }

    if (cpus === undefined) {
      problems.push('读不到 CPU 配额');
    } else if (Math.abs(cpus - CGROUP_PROBE_CPUS) > CGROUP_PROBE_CPUS * CPU_TOLERANCE) {
      problems.push(`--cpus ${String(CGROUP_PROBE_CPUS)} 未生效，实际 ${cpus.toFixed(2)} CPU`);
    }

    const observed =
      `memory=${readings.memoryBytes === undefined ? '?' : String(readings.memoryBytes)}` +
      `（请求 ${String(CGROUP_PROBE_MEMORY_BYTES)}）、` +
      `cpu=${cpus === undefined ? '?' : cpus.toFixed(2)}（请求 ${String(CGROUP_PROBE_CPUS)}）`;

    if (problems.length > 0) {
      return {
        status: 'fail',
        detail: `${problems.join('；')}；实测 ${observed}`,
        fixHint:
          '容器配额没落地：确认宿主内核开了 cgroup v2 的 memory/cpu controller（`cat /proc/self/cgroup`、' +
          '`stat -fc %T /sys/fs/cgroup`），并确认没有别的层（compose/daemon 默认值）覆盖 §6.1 的 HostConfig',
      };
    }
    return { status: 'ok', detail: `cgroup 实测与参数一致：${observed}` };
  },
};
