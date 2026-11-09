/**
 * 路径工具：宿主路径 ↔ 容器路径 ↔ 客户端路径。
 *
 * 唯一不变式来自 tech-plan §4.5 的**身份挂载**：容器启动时 `-v <job>:<job> -w <job>`，
 * 宿主路径与容器路径完全相同，于是
 *   - agent 的 `Read`/`Write`/`Edit`（宿主进程，走宿主路径）与
 *   - agent 的 `Bash`（容器内，走容器路径）
 * 看到的是同一批文件的同一批路径，代理里的 `-w <cwd>` 天然合法。
 *
 * **生产（Linux）**：本模块是恒等映射，`toContainerPath(p) === p`。
 *
 * **开发验收（Windows + Docker Desktop）**：宿主 NTFS 路径不是 POSIX 路径，`C:\a\b` 无法原样
 * 当作容器内绝对路径去挂载（Docker 要求容器侧路径是 POSIX 绝对路径）。所以本机验证时用一条
 * **确定、可逆**的映射 `C:\a\b` → `/c/a/b`，把「宿主侧看到的路径」与「容器内执行的路径」
 * 这层一一对应关系（不变式的实质）保住；差异只是多了一个 `C:` → `/c` 的前缀规范化。
 * 生产路径不受影响，也不需要任何条件分支之外的配置。
 */
import path from 'node:path';

import { SandboxError } from './errors.ts';

export const IS_WINDOWS = process.platform === 'win32';

/** 宿主绝对路径 → 容器内绝对路径（身份挂载下恒等；Windows 开发机折成 `/c/...`）。 */
export function toContainerPath(hostPath: string): string {
  if (!IS_WINDOWS) {
    return hostPath;
  }
  const normalized = hostPath.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(\/|$)/.exec(normalized);
  if (drive) {
    const letter = drive[1]?.toLowerCase() ?? '';
    const rest = normalized.slice(2).replace(/^\/+/, '');
    return rest.length === 0 ? `/${letter}` : `/${letter}/${rest}`;
  }
  if (normalized.startsWith('//')) {
    // UNC（`\\server\share\...`）：Docker Desktop 不支持把 UNC 挂到 Linux 容器，
    // 这里明确报错而不是给一个「看起来能用」的路径（沙箱路径错一位就是跑错目录）。
    throw new SandboxError(`不支持 UNC 路径作为 job 目录：${hostPath}`, {
      code: 'BAD_REQUEST',
      details: { hostPath },
    });
  }
  return normalized;
}

/**
 * exec-client 报上来的 `cwd` → 宿主原生路径。
 *
 * 生产上 shim 的 `pwd -P` 已经是容器的 POSIX 绝对路径，恒等返回；
 * Windows 上 shim 跑在 Git Bash 里，`pwd -P` 会给出 `/c/Users/...` 这种 MSYS 形式，
 * 这里折回 `C:\Users\...` 才能和 job_dir 比较。
 */
export function toHostPath(clientPath: string): string {
  if (!IS_WINDOWS) {
    return clientPath;
  }
  const match = /^\/([A-Za-z])(\/.*)?$/.exec(clientPath.replace(/\\/g, '/'));
  if (match) {
    const letter = (match[1] ?? '').toUpperCase();
    const rest = (match[2] ?? '/').replace(/\//g, '\\');
    return `${letter}:${rest}`;
  }
  return clientPath.replace(/\//g, '\\');
}

/** Docker bind 的**源**：Docker Desktop 喜欢正斜杠，Linux 上原样透传。 */
export function toBindSource(hostPath: string): string {
  return IS_WINDOWS ? hostPath.replace(/\\/g, '/') : hostPath;
}

/** `child` 是否在 `parent` 之内（含相等）。走 `path.relative`，Windows 上大小写不敏感。 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') {
    return true;
  }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** `<jobDir>/.pi-bot`：端点目录（父目录 `0700`，见 §4.5）。 */
export function endpointDir(jobDir: string): string {
  return path.join(jobDir, '.pi-bot');
}

/** 规范端点里 unix socket 的文件名（§4.5 的固定位置）。 */
export const EXEC_SOCKET_FILENAME = 'exec.sock';

/** 端点描述文件名：Windows 命名管道无法用 `-S` 判断，用它承载「监听地址」（见 exec-proxy.ts）。 */
export const EXEC_ENDPOINT_FILENAME = 'exec.endpoint';
