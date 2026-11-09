/**
 * `socket-ownership`：pi-host 进程树的 `/proc/<pid>/fd` 里**没有** `docker.sock`
 * （tech-plan §6.4 第十一项 / §3.3 的落地方式）。
 *
 * 这一条把「socket 只在 bot」从约定变成检查（§3.3 v1.1 补充的那句话）：
 * docker socket 等价于宿主 root（plan §8.4 红线 1），它只应出现在**一个**进程里——bot。
 * agent 侧（pi-host → host-core → shim → Bash）能做的只有「请代理在某个容器里跑一条命令」，
 * 路径是 `.pi-bot/exec.sock`，不是 docker socket。
 *
 * 实现细节（都影响结论的可信度，所以写清楚）：
 *  - 只扫 cmdline 里带 `pi-host` / `host-core` 的进程：bot 自己**必须**持有 socket，
 *    把它算进去会让这条检查永远 fail。
 *  - 扫到 `/proc` 不存在（macOS / Windows）或无权读 fd → `warn` 并说明原因，不假装通过。
 *  - 发现 violation → `fail`：那意味着容器边界可以被绕开（镜像可被替换的运行时拿着宿主 root）。
 */
import { describeError } from '../deps.ts';
import type { CheckDefinition, DoctorProc } from '../deps.ts';

/** pi-host 进程树的 cmdline 特征。 */
export const HOST_PROCESS_MARKER = /pi-host|host-core|pi_host/;

/** 扫多少 pid 就放弃（容器宿主上进程数可能上万；`/proc` 是逐目录读的，会慢）。 */
export const MAX_PIDS = 4096;

/** fd 目标是否指向 docker socket（Linux `/var/run/docker.sock`；Docker Desktop 也可能映射成同名文件）。 */
export function isDockerSocketTarget(target: string): boolean {
  return target.includes('docker.sock') || target.endsWith('/docker.sock');
}

export interface SocketViolation {
  readonly pid: number;
  readonly fd: string;
  readonly target: string;
}

export interface SocketOwnershipScan {
  /** 扫到的 pid 目录数。 */
  readonly scannedPids: number;
  /** 其中被判定为 pi-host 进程树的进程（pid + cmdline）。 */
  readonly hostProcesses: readonly { readonly pid: number; readonly cmdline: string }[];
  readonly violations: readonly SocketViolation[];
}

/**
 * 扫 `/proc`。所有 I/O 走注入的 `proc`（单测给一张假表就能复现「pi-host 拿着 socket」）。
 * 读不到 fd / cmdline 的进程直接跳过：那通常是权限（别的用户的进程）或刚退出，
 * 把它们当成 violation 会产生噪音，而噪音会让这条检查被关掉。
 */
export async function scanSocketOwnership(
  proc: DoctorProc,
  options: { readonly maxPids?: number } = {},
): Promise<SocketOwnershipScan> {
  const entries = await proc.readdir('/proc');
  const maxPids = options.maxPids ?? MAX_PIDS;
  const pids = entries
    .filter((name) => /^\d+$/.test(name))
    .map((name) => Number.parseInt(name, 10))
    .slice(0, maxPids);

  const hostProcesses: { pid: number; cmdline: string }[] = [];
  const violations: SocketViolation[] = [];

  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = await proc.readFile(`/proc/${String(pid)}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    // cmdline 里参数用 NUL 分隔；归一成空格便于展示与匹配
    const normalized = cmdline.replace(/\0/g, ' ').trim();
    if (!HOST_PROCESS_MARKER.test(normalized)) {
      continue;
    }
    hostProcesses.push({ pid, cmdline: normalized });

    let fds: string[];
    try {
      fds = await proc.readdir(`/proc/${String(pid)}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = await proc.readlink(`/proc/${String(pid)}/fd/${fd}`);
      } catch {
        continue;
      }
      if (isDockerSocketTarget(target)) {
        violations.push({ pid, fd, target });
      }
    }
  }

  return { scannedPids: pids.length, hostProcesses, violations };
}

export const socketOwnershipCheck: CheckDefinition = {
  id: 'socket-ownership',
  title: 'pi-host 进程树不持有 docker.sock',
  async run(ctx) {
    if (ctx.platform === 'win32') {
      return {
        status: 'warn',
        detail:
          'Windows 没有 /proc：无法断言 pi-host 进程树未持有 docker.sock' +
          '（本机 docker 端点是命名管道 //./pipe/docker_engine，不是可 readlink 的 fd）',
        fixHint: '在目标 Linux 机上重跑 `pi-bot doctor`；这条检查是 §3.3「socket 只在 bot」的证明',
      };
    }

    let scan: SocketOwnershipScan;
    try {
      scan = await scanSocketOwnership(ctx.proc);
    } catch (error) {
      return {
        status: 'warn',
        detail: `扫 /proc 失败（${describeError(error)}）：无法断言 socket 归属`,
        fixHint: '确认在 Linux 上运行，且 bot 以能读 /proc/<pid>/fd 的用户（pi）启动',
      };
    }

    if (scan.violations.length > 0) {
      const first = scan.violations[0];
      return {
        status: 'fail',
        detail:
          `pi-host 进程树持有 docker.sock（${String(scan.violations.length)} 处）：` +
          `${first === undefined ? '' : `pid ${String(first.pid)} fd ${first.fd} → ${first.target}`}`,
        fixHint:
          '把 docker.sock 从 pi-host/shim 的环境里撤掉，命令只走 exec 代理（tech-plan §4.5）；' +
          '这不是配置问题而是边界被绕过（plan §8.4 红线 1）',
      };
    }

    const hostNote =
      scan.hostProcesses.length === 0
        ? '未发现运行中的 pi-host 进程（不违反，但也说明该进程树此刻没在跑）'
        : `pi-host 进程树 ${String(scan.hostProcesses.length)} 个（pid ${scan.hostProcesses.map((item) => String(item.pid)).join('、')}）`;
    return {
      status: 'ok',
      detail: `扫 ${String(scan.scannedPids)} 个进程：${hostNote}，fd 里没有 docker.sock`,
    };
  },
};
