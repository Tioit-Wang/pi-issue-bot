/**
 * **真容器验收**（本机 Docker 29.4.0 + Linux 容器，dev-plan §13.1 / E11：有环境就必须真跑）。
 *
 * 覆盖 plan §8.1 / §8.4 红线 3 与 tech-plan §4.5 / §6.1 / §6.3 的每一条「必须在容器里才成立」的断言：
 *   - 身份挂载：容器内 `pwd` 等于宿主 job 路径（`/work` 已作废，E1）；
 *   - 能力全砍：只读根 fs、`/tmp` tmpfs（noexec）、`/cache` 只读、非 root、内存上限真的生效；
 *   - `timeout -s KILL` 真的把命令杀掉（F3：超时下沉进容器）；
 *   - OOM：`inspect` 的 `State.OOMKilled === true`（§3.6 / §6.3）；
 *   - exec 代理端到端：真容器 + 真代理 + 真 client/shim，跑 `pwd` / `echo ok`，越界 cwd 退 3。
 *
 * daemon 不可用时整组 skip（不会假装跑过）。
 * 平台差异：Windows 上容器内路径由 `toContainerPath` 映射（`C:\a\b` → `/c/a/b`），
 * 断言的是「宿主路径与容器内路径一一对应」这个不变式，生产 Linux 上就是字面相等。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSandboxDocker, resolveDockerSocketPath } from '../src/sandbox/docker.ts';
import type { SandboxDocker } from '../src/sandbox/docker.ts';
import { ExecProxy } from '../src/sandbox/exec-proxy.ts';
import { buildExecPlan } from '../src/sandbox/exec-plan.ts';
import { buildContainerCreateOptions } from '../src/sandbox/hostconfig.ts';
import { classifyDestroyedState, collectStateBeforeDestroy } from '../src/sandbox/lifecycle.ts';
import { toContainerPath } from '../src/sandbox/paths.ts';

const IMAGE = 'pi-worker:node22';
const NETWORK = 'pi-jobs';
const CLIENT = path.join(import.meta.dirname, '..', 'src', 'sandbox', 'exec-client.mjs');
const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const SHIM = path.join(REPO_ROOT, 'scripts', 'sandbox-bash');
const IS_WINDOWS = process.platform === 'win32';

const dockerClient = new Docker({ socketPath: resolveDockerSocketPath() });

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(command: string, args: readonly string[], timeoutMs = 300_000): Promise<CliResult> {
  return new Promise(( resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** daemon 可达性（不可用则整组 skip）。 */
let daemonUp = false;
let daemonError = '';
try {
  await dockerClient.ping();
  daemonUp = true;
} catch (error) {
  daemonError = error instanceof Error ? error.message : String(error);
}

/** 镜像可用性：缺了就地构建（也顺带验证 `images/node22.Dockerfile` 真能构建）。 */
let imageReady = false;
let imageNote = '';
let networkMode = 'bridge';

const sandbox: SandboxDocker = createSandboxDocker({ docker: dockerClient });
const created: string[] = [];
const proxies: ExecProxy[] = [];
let tmpRoot = '';
let jobCounter = 0;

async function newJobDir(label: string): Promise<string> {
  jobCounter += 1;
  const dir = path.join(tmpRoot, `${label}-${jobCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 直接用 docker adapter 在容器里跑一条命令（不经过代理，用于验规格本身）。 */
async function execRaw(
  containerId: string,
  cmd: readonly string[],
  workdir: string,
  env: readonly string[] = [],
): Promise<ExecResult> {
  let stdout = '';
  let stderr = '';
  const result = await sandbox.execStream({
    containerId,
    cmd,
    workdir,
    env,
    onStdout: (chunk) => {
      stdout += chunk.toString('utf8');
    },
    onStderr: (chunk) => {
      stderr += chunk.toString('utf8');
    },
  });
  return { exitCode: result.exitCode, stdout, stderr };
}

/** 起一个按 §6.1 规格的容器（内存用小值，OOM 才跑得快；档位映射由单测覆盖）。 */
async function startSandbox(jobDir: string, overrides: { memoryBytes?: number } = {}): Promise<string> {
  const spec = buildContainerCreateOptions({
    jobId: `docker-${jobCounter}-${Date.now().toString(36)}`,
    jobDir,
    image: IMAGE,
    memoryBytes: overrides.memoryBytes ?? 512 * 1024 ** 2,
    networkMode,
  });
  const containerId = await sandbox.createContainer(spec);
  created.push(containerId);
  return containerId;
}

function runClient(args: readonly string[]): Promise<CliResult> {
  return runCli(process.execPath, [CLIENT, ...args], 60_000);
}

/** Git Bash（Windows）或 /bin/sh：跑真 shim 需要 POSIX shell。 */
function findShell(): string | undefined {
  if (!IS_WINDOWS) {
    return existsSync('/bin/sh') ? '/bin/sh' : undefined;
  }
  return [
    process.env.PI_BOT_TEST_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].find((candidate) => candidate !== undefined && existsSync(candidate));
}

const SHELL = findShell();

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-docker-'));
  if (!daemonUp) {
    return;
  }
  // 镜像：缺了就地构建（构建产物落在本机 docker，不入库）
  const inspectImage = await runCli('docker', ['image', 'inspect', IMAGE], 30_000).catch(() => undefined);
  if (inspectImage?.code === 0) {
    imageReady = true;
    imageNote = `${IMAGE} 已存在`;
  } else {
    const build = await runCli(
      'docker',
      ['build', '-t', IMAGE, '-f', path.join('images', 'node22.Dockerfile'), 'images'],
      600_000,
    ).catch((error: unknown) => ({ code: 1, stdout: '', stderr: String(error) }));
    imageReady = build.code === 0;
    imageNote = imageReady ? `已构建 ${IMAGE}` : `构建失败：${build.stderr.slice(-300)}`;
  }
  // 网络：按 deploy/docker-network.md 创建 `pi-jobs`（幂等）
  const inspectNetwork = await runCli('docker', ['network', 'inspect', NETWORK], 30_000).catch(() => undefined);
  if (inspectNetwork?.code === 0) {
    networkMode = NETWORK;
  } else {
    const create = await runCli(
      'docker',
      ['network', 'create', '--driver', 'bridge', '--subnet', '172.31.240.0/24', '--gateway', '172.31.240.1', NETWORK],
      60_000,
    ).catch(() => undefined);
    networkMode = create?.code === 0 ? NETWORK : 'bridge';
  }
});

afterAll(async () => {
  while (proxies.length > 0) {
    await proxies.pop()?.destroyAll();
  }
  for (const containerId of created) {
    await sandbox.destroyContainer(containerId).catch(() => undefined);
  }
  if (tmpRoot.length > 0) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

describe.skipIf(!daemonUp)('真容器：身份挂载与能力全砍', () => {
  it('前提：daemon 可达 + 镜像可用', () => {
    expect(daemonUp).toBe(true);
    expect(imageReady, imageNote).toBe(true);
  });

  it('容器内 pwd 等于宿主 job 路径（§4.5 身份挂载，/work 作废）', async () => {
    const jobDir = await newJobDir('identity');
    const containerId = await startSandbox(jobDir);
    const expected = toContainerPath(jobDir);
    const pwd = await execRaw(containerId, ['bash', '-lc', 'pwd -P'], expected);
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toBe(expected);

    // 同一批文件：容器里写的，宿主上就在同一个相对路径
    await execRaw(containerId, ['bash', '-lc', 'echo hello-from-container > proof.txt'], expected);
    const onHost = await readFile(path.join(jobDir, 'proof.txt'), 'utf8');
    expect(onHost.trim()).toBe('hello-from-container');
  });

  it('只读根文件系统 + /tmp 是 tmpfs(noexec) + /cache 只读', async () => {
    const jobDir = await newJobDir('readonly');
    const containerId = await startSandbox(jobDir);
    const workdir = toContainerPath(jobDir);

    const touchRoot = await execRaw(containerId, ['bash', '-lc', 'touch /x'], workdir);
    expect(touchRoot.exitCode).not.toBe(0);
    expect(`${touchRoot.stdout}${touchRoot.stderr}`).toMatch(/read-only file system/i);

    const rootMount = await execRaw(containerId, ['bash', '-lc', "awk '$2==\"/\" {print $4}' /proc/mounts"], workdir);
    expect(rootMount.stdout).toMatch(/\bro\b/);

    const tmpMount = await execRaw(containerId, ['bash', '-lc', "awk '$2==\"/tmp\" {print $4}' /proc/mounts"], workdir);
    expect(tmpMount.stdout).toMatch(/noexec/);
    expect(tmpMount.stdout).toMatch(/\bsize=524288k\b/);

    const writeTmp = await execRaw(containerId, ['bash', '-lc', 'touch /tmp/ok && echo tmp-ok'], workdir);
    expect(writeTmp.stdout).toContain('tmp-ok');

    const writeCache = await execRaw(containerId, ['bash', '-lc', 'touch /cache/x'], workdir);
    expect(writeCache.exitCode).not.toBe(0);
  });

  it('非 root（uid 1001）+ 私有 cgroup 命名空间', async () => {
    const jobDir = await newJobDir('identity-user');
    const containerId = await startSandbox(jobDir);
    const workdir = toContainerPath(jobDir);

    const id = await execRaw(containerId, ['bash', '-lc', 'id -u'], workdir);
    expect(id.stdout.trim()).toBe('1001');

    const cgroup = await execRaw(containerId, ['bash', '-lc', 'cat /proc/1/cgroup'], workdir);
    // cgroup v2 + private cgroupns：容器内看到的是自己的根
    expect(cgroup.stdout.trim()).toBe('0::/');
  });

  it('内存上限真的生效（读 cgroup，而不是相信参数）', async () => {
    const jobDir = await newJobDir('memory');
    const limit = 512 * 1024 ** 2;
    const containerId = await startSandbox(jobDir, { memoryBytes: limit });
    const workdir = toContainerPath(jobDir);

    const max = await execRaw(containerId, ['bash', '-lc', 'cat /sys/fs/cgroup/memory.max'], workdir);
    expect(Number(max.stdout.trim())).toBe(limit);

    // --cpus 2 同样在 cgroup 里可查
    const cpu = await execRaw(containerId, ['bash', '-lc', 'cat /sys/fs/cgroup/cpu.max'], workdir);
    expect(cpu.stdout.trim()).toBe('200000 100000');
  });
});

describe.skipIf(!daemonUp)('真容器：超时与 OOM', () => {
  it('timeout -s KILL 1 把 sleep 60 杀掉，命令 5 秒内返回且非 0（F3）', async () => {
    const jobDir = await newJobDir('timeout');
    const containerId = await startSandbox(jobDir);
    const workdir = toContainerPath(jobDir);

    const plan = buildExecPlan({ argv: ['bash', '-lc', 'sleep 60'], workdir, timeoutMs: 1000 });
    const startedAt = Date.now();
    const result = await execRaw(containerId, plan.cmd, plan.workdir, plan.env);
    const elapsed = Date.now() - startedAt;

    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });

  it('OOM：node 申请超限内存 → 销毁前 inspect 采到 State.OOMKilled === true', async () => {
    const jobDir = await newJobDir('oom');
    const containerId = await startSandbox(jobDir, { memoryBytes: 256 * 1024 ** 2 });
    const workdir = toContainerPath(jobDir);

    const hog = await execRaw(
      containerId,
      ['bash', '-lc', 'node -e "const a=[];for(;;)a.push(Buffer.alloc(10*1024*1024,1))"'],
      workdir,
    );
    // 被 cgroup 杀掉 → 137（SIGKILL）
    expect(hog.exitCode).toBe(137);

    // 关键顺序（§6.3 的 (a)）：容器还在时才读得到 OOMKilled；
    // OOM 事件在 daemon 侧是异步落定的，这里轮询到稳定（最多 5s），而不是赌一次 inspect。
    let state = await collectStateBeforeDestroy(sandbox, containerId);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && state !== null && !state.oomKilled) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await sandbox.inspectState(containerId);
    }
    expect(state).not.toBeNull();
    expect(state?.oomKilled).toBe(true);
    expect(classifyDestroyedState(state)).toBe('sandbox-oom');
  });
});

describe.skipIf(!daemonUp)('真容器 + 真代理 + 真客户端（§4.5 端到端）', () => {
  it('客户端的 pwd / echo ok 真的在容器里执行，退出码原样回传', async () => {
    const jobDir = await newJobDir('proxy-e2e');
    const containerId = await startSandbox(jobDir);
    const workdir = toContainerPath(jobDir);
    const proxy = new ExecProxy({ docker: sandbox });
    proxies.push(proxy);
    const entry = await proxy.listen({ jobId: 'proxy-e2e', jobDir, containerId });

    const pwd = await runClient([entry.endpointFile, jobDir, 'bash', '-lc', 'pwd -P']);
    expect(pwd.code).toBe(0);
    expect(pwd.stdout.trim()).toBe(workdir);

    const echo = await runClient([entry.endpointFile, jobDir, 'bash', '-lc', 'echo ok']);
    expect(echo.code).toBe(0);
    expect(echo.stdout.trim()).toBe('ok');

    // 退出码穿透：容器里 exit 42 → client 退 42
    const fail = await runClient([entry.endpointFile, jobDir, 'bash', '-lc', 'exit 42']);
    expect(fail.code).toBe(42);

    // 容器内身份仍是 1001（不是宿主 uid）
    const whoami = await runClient([entry.endpointFile, jobDir, 'bash', '-lc', 'id -u']);
    expect(whoami.stdout.trim()).toBe('1001');
  });

  it('越界 cwd → CWD_OUTSIDE_JOB 退 3，容器内没有任何命令被执行', async () => {
    const jobDir = await newJobDir('proxy-outside');
    const containerId = await startSandbox(jobDir);
    const proxy = new ExecProxy({ docker: sandbox });
    proxies.push(proxy);
    const entry = await proxy.listen({ jobId: 'proxy-outside', jobDir, containerId });

    const marker = path.join(jobDir, 'should-not-exist.txt');
    const result = await runClient([entry.endpointFile, tmpRoot, 'bash', '-lc', `touch ${toContainerPath(marker)}`]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('CWD_OUTSIDE_JOB');
    await expect(stat(marker)).rejects.toThrow();
  });

  it.skipIf(SHELL === undefined)('真 shim（POSIX shell）从 job 子目录上溯命中端点并进容器', async () => {
    const jobDir = await newJobDir('shared-shim');
    const deep = path.join(jobDir, 'src', 'nested');
    await mkdir(deep, { recursive: true });
    const containerId = await startSandbox(jobDir);
    const proxy = new ExecProxy({ docker: sandbox });
    proxies.push(proxy);
    await proxy.listen({ jobId: 'shared-shim', jobDir, containerId });

    const wrapper = path.join(tmpRoot, 'exec-client.sh');
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${CLIENT}" "$@"\n`, 'utf8');

    const result = await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(SHELL!, [SHIM, '-lc', 'pwd -P; echo ok'], {
        cwd: deep,
        env: { ...process.env, PI_BOT_EXEC_CLIENT: wrapper },
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

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines[0]).toBe(`${toContainerPath(jobDir)}/src/nested`);
    expect(lines[1]).toBe('ok');
  });
});

describe.skipIf(daemonUp)('daemon 不可用', () => {
  it('整组真容器用例被跳过（这里只记录原因，避免「假装跑过」）', () => {
    expect(daemonError.length).toBeGreaterThan(0);
  });
});
