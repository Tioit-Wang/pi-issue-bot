/**
 * `shell`：`PI_DESKTOP_BASH` 指向的 shim 存在且可执行（tech-plan §6.4 / §4.5）。
 *
 * 这条检查守的是「agent 的 `Bash` 到底跑到哪儿」这条链的第一环：
 * host-core 把 `bash -lc <cmd>` 交给 `PI_DESKTOP_BASH` 指向的脚本（默认 `scripts/sandbox-bash`），
 * 脚本再找 `.pi-bot/exec.sock` → exec-client → 代理。**shim 不可执行 = 命令落回宿主**，
 * 而 plan §8.4 红线就是「命令必须在容器里」。所以它缺失算 `fail`，不是 warn。
 *
 * 平台差异：Windows 没有 POSIX 的 exec 位，`access(X_OK)` 只等价于「存在且可读」；
 * 因此额外核对首行是 `#!` + 某个 `sh`，这是 Windows 上唯一能证明「它是个 sh 脚本」的静态证据。
 */
import { X_OK, describeError } from '../deps.ts';
import type { CheckDefinition } from '../deps.ts';

/** shim 的首行必须是 sh 家族的 shebang。 */
export function isShShebang(firstLine: string): boolean {
  return /^#!.*\b(sh|bash|dash)\b/.test(firstLine.trim());
}

export const shellCheck: CheckDefinition = {
  id: 'shell',
  title: 'PI_DESKTOP_BASH 指向的 shim 可执行',
  async run(ctx) {
    const configured = ctx.env['PI_DESKTOP_BASH']?.trim();
    const shim = configured !== undefined && configured.length > 0 ? configured : ctx.shimPath;
    const source = configured !== undefined && configured.length > 0 ? 'PI_DESKTOP_BASH' : '默认（仓库内 scripts/sandbox-bash）';

    try {
      await ctx.fs.access(shim, X_OK);
    } catch (error) {
      return {
        status: 'fail',
        detail: `${source} 指向的 ${shim} 不可用：${describeError(error)}`,
        fixHint:
          '把 scripts/sandbox-bash 装上并 chmod 0755（或以 PI_DESKTOP_BASH 显式指过去）；' +
          'shim 不可用会让 agent 的命令绕过容器（plan §8.4 红线）',
      };
    }

    let firstLine: string;
    try {
      firstLine = (await ctx.fs.readFile(shim, 'utf8')).split('\n', 1).join('');
    } catch (error) {
      return {
        status: 'fail',
        detail: `${shim} 可执行但读不出来：${describeError(error)}`,
        fixHint: '确认文件权限（可读）与编码；shim 必须是纯文本 sh 脚本',
      };
    }

    const execBitNote = ctx.platform === 'win32' ? '（Windows 无 exec 位语义，按存在+可读判定）' : '';
    if (!isShShebang(firstLine)) {
      return {
        status: 'warn',
        detail: `${shim} 存在，但首行不是 sh 的 shebang：${JSON.stringify(firstLine.slice(0, 40))}${execBitNote}`,
        fixHint: 'shim 必须是 `#!/bin/sh` 开头的脚本（tech-plan §4.5 的 ≈25 行 sh）',
      };
    }
    return {
      status: 'ok',
      detail: `${source} → ${shim} 可执行，shebang=${JSON.stringify(firstLine.trim())}${execBitNote}`,
    };
  },
};
