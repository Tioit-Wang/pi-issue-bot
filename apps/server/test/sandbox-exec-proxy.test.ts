/**
 * exec 代理的端到端断言：真 socket / 真命名管道 + 真 exec-client，docker 用假实现。
 *
 * 为什么不在这里起真容器：这一层要验的是**代理自己的边界**（查表、cwd 校验、协议白名单、
 * 输出上限、销毁清理），用假 docker 才能精确断言「代理到底发了什么 `docker exec` 参数」。
 * 真容器验收在 `sandbox-docker.test.ts`。
 *
 * 平台差异（dev-plan §13.1）：Linux 用 `<job>/.pi-bot/exec.sock`，Windows 用命名管道
 * `\\.\pipe\pi-bot-<jobId>`（本机 AF_UNIX 不可用，实测 `listen` 报 EACCES）。
 * 两种形态都由 `defaultListenAddress` 决定，测试按本机平台跑真实那一种。
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ContainerStateSnapshot, ExecStreamRequest, SandboxDocker } from '../src/sandbox/docker.ts';
import { ExecProxy, defaultListenAddress, parseListenAddress } from '../src/sandbox/exec-proxy.ts';
import type { SandboxContainerSpec } from '../src/sandbox/hostconfig.ts';
import { toContainerPath } from '../src/sandbox/paths.ts';

const CLIENT = path.join(import.meta.dirname, '..', 'src', 'sandbox', 'exec-client.mjs');
const IS_WINDOWS = process.platform === 'win32';

/** 记录型假 docker：断言「代理发了什么」，不碰 daemon。 */
class FakeSandboxDocker implements SandboxDocker {
  readonly execCalls: ExecStreamRequest[] = [];
  readonly destroyed: string[] = [];
  readonly events: string[] = [];
  stdout: Buffer = Buffer.alloc(0);
  stderr: Buffer = Buffer.alloc(0);
  exitCode = 0;
  state: ContainerStateSnapshot = {
    containerId: 'fake-container',
    status: 'running',
    running: true,
    exitCode: 0,
    oomKilled: false,
  };

  async ping(): Promise<void> {
    this.events.push('ping');
  }

  async createContainer(_spec: SandboxContainerSpec): Promise<string> {
    this.events.push('create');
    return 'fake-container';
  }

  async inspectState(containerId: string): Promise<ContainerStateSnapshot> {
    this.events.push('inspect');
    return { ...this.state, containerId };
  }

  async execStream(request: ExecStreamRequest): Promise<{ exitCode: number }> {
    this.events.push('exec');
    this.execCalls.push(request);
    if (this.stdout.byteLength > 0) {
      request.onStdout(this.stdout);
    }
    if (this.stderr.byteLength > 0) {
      request.onStderr(this.stderr);
    }
    return { exitCode: this.exitCode };
  }

  async destroyContainer(containerId: string): Promise<void> {
    this.events.push('destroy');
    this.destroyed.push(containerId);
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runClient(args: readonly string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, ...args], {
      cwd,
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

/** 直接往端点上打一帧（绕过 client 的白名单，用来验代理的校验）。 */
function rawRequest(endpoint: string, payload: unknown): Promise<{ frames: unknown[]; err?: string }> {
  const parsed = parseListenAddress(endpoint);
  return new Promise((resolve) => {
    const socket = net.connect(parsed.path);
    const frames: unknown[] = [];
    let buffer = '';
    socket.on('error', (error) => {
      resolve({ frames, err: String(error.message) });
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.length > 0) {
          frames.push(JSON.parse(line));
        }
      }
    });
    socket.on('close', () => {
      resolve({ frames });
    });
  });
}

async function reachable(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

let tmpRoot = '';
const proxies: ExecProxy[] = [];

async function newJobDir(name: string): Promise<string> {
  const dir = await reachable(path.join(tmpRoot, name));
  return dir;
}

function newProxy(docker: SandboxDocker, overrides: Partial<ConstructorParameters<typeof ExecProxy>[0]> = {}): ExecProxy {
  const proxy = new ExecProxy({ docker, ...overrides });
  proxies.push(proxy);
  return proxy;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-exec-proxy-'));
});

afterEach(async () => {
  while (proxies.length > 0) {
    const proxy = proxies.pop();
    await proxy?.destroyAll();
  }
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('监听地址（§4.5 的「位置」规定）', () => {
  it('默认地址按平台取值：POSIX unix socket / Windows 命名管道', () => {
    const posix = defaultListenAddress('j1', '/srv/pi/jobs/j1', 'linux');
    expect(posix).toBe(`unix:${path.posix.join('/srv/pi/jobs/j1', '.pi-bot', 'exec.sock')}`);
    const win = defaultListenAddress('j1', 'C:\\pi\\jobs\\j1', 'win32');
    expect(win).toBe('pipe:\\\\.\\pipe\\pi-bot-j1');
    expect(parseListenAddress(win).kind).toBe('pipe');
    expect(parseListenAddress(posix).kind).toBe('unix');
  });

  it('拒绝相对路径与无法识别的形态（不猜默认值）', () => {
    expect(() => parseListenAddress('unix:relative/exec.sock')).toThrow(/绝对路径/);
    expect(() => parseListenAddress('tcp:127.0.0.1:9000')).toThrow(/无法识别/);
    expect(() => parseListenAddress('pipe:')).toThrow(/为空/);
  });

  it('本机真实监听：unix socket 0600 + 父目录 0700 / 命名管道可连', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('perm-job');
    const entry = await proxy.listen({ jobId: 'perm-job', jobDir, containerId: 'fake-container' });

    expect(entry.address.kind).toBe(IS_WINDOWS ? 'pipe' : 'unix');
    expect(await readFile(entry.endpointFile, 'utf8')).toBe(`${entry.address.canonical}\n`);

    if (!IS_WINDOWS) {
      const socketStat = await stat(entry.socketPath as string);
      expect(socketStat.mode & 0o777).toBe(0o600);
      const dirStat = await stat(path.join(jobDir, '.pi-bot'));
      expect(dirStat.mode & 0o777).toBe(0o700);
    }
  });
});

describe('端到端：客户端 → 代理 → docker exec 参数', () => {
  it('回传 stdout / stderr / exitCode，且 docker exec 参数形状正确', async () => {
    const docker = new FakeSandboxDocker();
    docker.stdout = Buffer.from('ok\n');
    docker.stderr = Buffer.from('warn\n');
    docker.exitCode = 7;
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('e2e-job');
    const entry = await proxy.listen({ jobId: 'e2e-job', jobDir, containerId: 'container-abc' });

    const result = await runClient([entry.endpointFile, jobDir, 'bash', '-lc', 'echo ok']);
    expect(result.code).toBe(7);
    expect(result.stdout).toBe('ok\n');
    expect(result.stderr).toBe('warn\n');

    expect(docker.execCalls).toHaveLength(1);
    const call = docker.execCalls[0]!;
    // E6：标记必须写进命令行；F3：timeout 是 docker exec 的参数
    expect(call.cmd.slice(0, 6)).toEqual(['timeout', '-s', 'KILL', '120', 'bash', '-lc']);
    expect(call.cmd[6]).toContain('echo ok');
    expect(call.cmd[6]).toMatch(/\n# PI_CMD_ID=[0-9a-f-]{36}$/);
    expect(call.workdir).toBe(toContainerPath(jobDir));
    // 不透传 env：只有代理自己注入的兜底标记
    expect(call.env).toHaveLength(1);
    expect(call.env[0]).toBe(call.cmd[6]?.match(/PI_CMD_ID=([0-9a-f-]{36})/)?.[0]);
    expect(call.containerId).toBe('container-abc');
  });

  it('install / build 类命令拿到 300s（超时分档）', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('build-job');
    const entry = await proxy.listen({ jobId: 'build-job', jobDir, containerId: 'c1' });
    await runClient([entry.endpointFile, jobDir, 'bash', '-lc', 'pnpm install']);
    expect(docker.execCalls[0]?.cmd[3]).toBe('300');
  });

  it('子目录 cwd 命中同一端点，-w 用容器内子目录', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('sub-job');
    const sub = await reachable(path.join(jobDir, 'packages', 'app'));
    const entry = await proxy.listen({ jobId: 'sub-job', jobDir, containerId: 'c1' });

    const result = await runClient([entry.endpointFile, sub, 'bash', '-lc', 'pwd']);
    expect(result.code).toBe(0);
    expect(docker.execCalls[0]?.workdir).toBe(
      path.posix.join(toContainerPath(jobDir), 'packages', 'app'),
    );
  });
});

describe('cwd 越界（dev-plan §11 E7：报错退 3，禁止静默回退）', () => {
  it('job 目录之外的 cwd → CWD_OUTSIDE_JOB 且退出码 3', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('outside-job');
    const entry = await proxy.listen({ jobId: 'outside-job', jobDir, containerId: 'c1' });

    const result = await runClient([entry.endpointFile, tmpRoot, 'bash', '-lc', 'pwd']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('CWD_OUTSIDE_JOB');
    // 关键：**没有**退化成「在 job_dir 里跑一遍」
    expect(docker.execCalls).toHaveLength(0);
  });

  it('不存在的 cwd 同样退 3（不当作 job_dir 处理）', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('missing-job');
    const entry = await proxy.listen({ jobId: 'missing-job', jobDir, containerId: 'c1' });
    const result = await runClient([entry.endpointFile, path.join(jobDir, 'nope'), 'bash', '-lc', 'pwd']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('CWD_OUTSIDE_JOB');
    expect(docker.execCalls).toHaveLength(0);
  });

  it('../../ 逃逸也被 realpath 挡住', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('escape-job');
    const entry = await proxy.listen({ jobId: 'escape-job', jobDir, containerId: 'c1' });
    const escaped = path.join(jobDir, '..', '..');
    const result = await runClient([entry.endpointFile, escaped, 'bash', '-lc', 'pwd']);
    expect(result.code).toBe(3);
  });
});

describe('协议白名单（不接受 shell 字符串 / 容器名 / env）', () => {
  it('多一个键就 BAD_REQUEST，且不执行任何命令', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('badreq-job');
    const entry = await proxy.listen({ jobId: 'badreq-job', jobDir, containerId: 'c1' });

    const { frames } = await rawRequest(entry.address.canonical, {
      argv: ['bash', '-lc', 'pwd'],
      cwd: jobDir,
      env: { GITHUB_TOKEN: 'leak' },
    });
    expect(frames).toContainEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'BAD_REQUEST' }) }),
    );
    expect(docker.execCalls).toHaveLength(0);
  });
});

describe('输出上限（§4.5：stdout/stderr 合计 1 MB，超出截断并标 truncated）', () => {
  it('超出上限后只转发上限字节，末帧带 truncated', async () => {
    const docker = new FakeSandboxDocker();
    docker.stdout = Buffer.alloc(4096, 0x41);
    const proxy = newProxy(docker, { outputLimitBytes: 1024 });
    const jobDir = await newJobDir('truncate-job');
    const entry = await proxy.listen({ jobId: 'truncate-job', jobDir, containerId: 'c1' });

    const result = await runClient([entry.endpointFile, jobDir, 'bash', '-lc', 'yes A']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1024);
    expect(result.stderr).toContain('truncated');

    const { frames } = await rawRequest(entry.address.canonical, {
      argv: ['bash', '-lc', 'yes A'],
      cwd: jobDir,
    });
    const last = frames.at(-1);
    expect(last).toEqual(expect.objectContaining({ exitCode: 0, truncated: true }));
  });
});

describe('销毁：unlink socket / 端点文件 + 删映射（§6.3 的 (b)）', () => {
  it('destroy 之后端点目录干净，映射表清空', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('destroy-job');
    const entry = await proxy.listen({ jobId: 'destroy-job', jobDir, containerId: 'c1' });
    expect(proxy.size).toBe(1);

    await proxy.destroy({ jobId: 'destroy-job' });
    expect(proxy.size).toBe(0);
    expect(proxy.findByJobId('destroy-job')).toBeUndefined();
    await expect(stat(entry.endpointFile)).rejects.toThrow();
    if (entry.socketPath !== undefined) {
      await expect(stat(entry.socketPath)).rejects.toThrow();
    }
  });

  it('同一端点重复 listen 报错（不静默覆盖映射）', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = newProxy(docker);
    const jobDir = await newJobDir('dup-job');
    await proxy.listen({ jobId: 'dup-job', jobDir, containerId: 'c1' });
    await expect(proxy.listen({ jobId: 'dup-job', jobDir, containerId: 'c2' })).rejects.toThrow(/已在监听/);
  });
});

describe('代理里没有任何「按容器名 / 按 shell 字符串」的入口', () => {
  it('源码里不出现 docker CLI 调用（只有 dockerode 客户端调用）', async () => {
    const source = await readFile(
      path.join(import.meta.dirname, '..', 'src', 'sandbox', 'exec-proxy.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/['"`]docker['"`]/);
    expect(source).not.toMatch(/from 'node:child_process'|require\('node:child_process'\)/);
    expect(source).not.toMatch(/shell\s*:\s*true/);
  });
});

describe('workspace 清理', () => {
  it('测试用 wrapper 目录可写（前置条件）', async () => {
    const dir = await newJobDir('write-check');
    await writeFile(path.join(dir, 'probe.txt'), 'ok', 'utf8');
    expect(await readFile(path.join(dir, 'probe.txt'), 'utf8')).toBe('ok');
  });
});
