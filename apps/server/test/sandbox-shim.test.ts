/**
 * shim（`scripts/sandbox-bash`）的断言：**它不碰 docker**，只负责「我在哪」。
 *
 * 它跑在 pi-host 的进程树里（host-core 用 `PI_DESKTOP_BASH` 指到它），
 * 所以任何 docker 调用都会让 plan §8.4 红线 1 变成一句口号（tech-plan §4.5 F1）。
 *
 * 这里用**真的 shim + 真的 exec-client + 真的端点**（docker 是假实现）跑通整条链路，
 * 覆盖 E7 的两条退出码：`NO_EXEC_ENDPOINT` 退 2、`CWD_OUTSIDE_JOB` 退 3。
 * 真容器在 `sandbox-docker.test.ts`。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ContainerStateSnapshot, ExecStreamRequest, SandboxDocker } from '../src/sandbox/docker.ts';
import { ExecProxy } from '../src/sandbox/exec-proxy.ts';
import type { SandboxContainerSpec } from '../src/sandbox/hostconfig.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const SHIM = path.join(REPO_ROOT, 'scripts', 'sandbox-bash');
const CLIENT = path.join(import.meta.dirname, '..', 'src', 'sandbox', 'exec-client.mjs');
const IS_WINDOWS = process.platform === 'win32';

/** 找 POSIX shell：Windows 上是 Git Bash（WSL 的 `System32\bash.exe` 不行，那里没有 `/c/...`）。 */
function findShell(): string | undefined {
  if (!IS_WINDOWS) {
    return existsSync('/bin/sh') ? '/bin/sh' : undefined;
  }
  const candidates = [
    process.env.PI_BOT_TEST_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}

const SHELL = findShell();

class FakeSandboxDocker implements SandboxDocker {
  readonly execCalls: ExecStreamRequest[] = [];
  stdout = Buffer.from('shim-ok\n');
  exitCode = 0;
  state: ContainerStateSnapshot = {
    containerId: 'fake',
    status: 'running',
    running: true,
    exitCode: 0,
    oomKilled: false,
  };

  async ping(): Promise<void> {}

  async createContainer(_spec: SandboxContainerSpec): Promise<string> {
    return 'fake';
  }

  async inspectState(containerId: string): Promise<ContainerStateSnapshot> {
    return { ...this.state, containerId };
  }

  async execStream(request: ExecStreamRequest): Promise<{ exitCode: number }> {
    this.execCalls.push(request);
    request.onStdout(this.stdout);
    return { exitCode: this.exitCode };
  }

  async destroyContainer(_containerId: string): Promise<void> {}
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 用一个 shell wrapper 顶替生产上的 `/usr/local/lib/pi-bot/exec-client`（那是编译/安装产物）。 */
async function makeClientWrapper(dir: string): Promise<string> {
  const wrapper = path.join(dir, 'exec-client.sh');
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${CLIENT}" "$@"\n`,
    'utf8',
  );
  if (!IS_WINDOWS) {
    await chmod(wrapper, 0o755);
  }
  return wrapper;
}

function runShim(shell: string, args: readonly string[], options: { cwd: string; env?: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [SHIM, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

let tmpRoot = '';
let wrapper = '';
const proxies: ExecProxy[] = [];

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-shim-'));
  wrapper = await makeClientWrapper(tmpRoot);
});

afterAll(async () => {
  while (proxies.length > 0) {
    await proxies.pop()?.destroyAll();
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('shim 源码本身（静态断言）', () => {
  it('没有任何 docker 调用（红线 1：socket 只在 bot）', async () => {
    const source = await readFile(SHIM, 'utf8');
    expect(source).not.toMatch(/\bdocker\s+(exec|run|ps|inspect|kill|rm|create|start)\b/);
    expect(source).not.toMatch(/DOCKER_HOST|docker\.sock/);
  });

  it('按 §4.5 找 `<job>/.pi-bot/exec.sock`，上溯 4 层，找不到退 2', async () => {
    const source = await readFile(SHIM, 'utf8');
    expect(source).toContain('/.pi-bot/exec.sock');
    expect(source).toContain('-S');
    expect(source).toContain('NO_EXEC_ENDPOINT');
    expect(source).toMatch(/exit 2/);
    expect(source).toContain('-le 4');
  });

  it('shim 与 client 都是「独立可执行」形态（不 import TS）', async () => {
    const shimSource = await readFile(SHIM, 'utf8');
    expect(shimSource.startsWith('#!/bin/sh')).toBe(true);
    const clientSource = await readFile(CLIENT, 'utf8');
    expect(clientSource.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(clientSource).not.toMatch(/\.ts['"]/);
  });
});

describe.skipIf(SHELL === undefined)('shim 真跑（POSIX shell）', () => {
  it('找不到端点 → 打印 NO_EXEC_ENDPOINT 并退 2（不静默回落到宿主执行）', async () => {
    const empty = path.join(tmpRoot, 'no-endpoint');
    await mkdir(empty, { recursive: true });
    const result = await runShim(SHELL!, ['-lc', 'echo host-leak'], {
      cwd: empty,
      env: { PI_BOT_EXEC_CLIENT: wrapper },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('NO_EXEC_ENDPOINT');
    // 命令**没有**在宿主上执行
    expect(result.stdout).toBe('');
  });

  it('从深层子目录上溯命中端点，命令交给代理而不是本地执行', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = new ExecProxy({ docker });
    proxies.push(proxy);
    const jobDir = path.join(tmpRoot, 'job-shim');
    const deep = path.join(jobDir, 'a', 'b');
    await mkdir(deep, { recursive: true });
    const entry = await proxy.listen({ jobId: 'job-shim', jobDir, containerId: 'container-shim' });

    const result = await runShim(SHELL!, ['-lc', 'echo from-agent'], {
      cwd: deep,
      env: { PI_BOT_EXEC_CLIENT: wrapper },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('shim-ok\n');
    expect(docker.execCalls).toHaveLength(1);
    const cmd = docker.execCalls[0]!.cmd;
    expect(cmd.slice(0, 6)).toEqual(['timeout', '-s', 'KILL', '120', 'bash', '-lc']);
    expect(cmd[6]).toContain('echo from-agent');
    // 端点文件承载了监听地址（Windows 命名管道靠它定位）
    expect(await readFile(entry.endpointFile, 'utf8')).toBe(`${entry.address.canonical}\n`);
  });

  it('上溯超过 4 层不命中 → 退 2（就近原则的边界）', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = new ExecProxy({ docker });
    proxies.push(proxy);
    const jobDir = path.join(tmpRoot, 'job-deep');
    const deep = path.join(jobDir, 'l1', 'l2', 'l3', 'l4', 'l5', 'l6');
    await mkdir(deep, { recursive: true });
    await proxy.listen({ jobId: 'job-deep', jobDir, containerId: 'c1' });

    const result = await runShim(SHELL!, ['-lc', 'echo too-deep'], {
      cwd: deep,
      env: { PI_BOT_EXEC_CLIENT: wrapper },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('NO_EXEC_ENDPOINT');
    expect(docker.execCalls).toHaveLength(0);
  });
});
