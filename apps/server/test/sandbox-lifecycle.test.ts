/**
 * 生命周期（plan §8.3 → tech-plan §6.3）的断言。
 *
 * 两件事必须用测试钉住，因为它们在代码里很容易被「顺手简化」掉：
 *   1. **销毁前先 inspect**：`State.OOMKilled` 只在容器对象还在时读得到，先销毁就永远判不出 `sandbox-oom`；
 *   2. **销毁时同时清端点**：socket 文件 + 代理映射表，否则 agent 下一条命令会打到不存在的容器上。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ContainerStateSnapshot, ExecStreamRequest, SandboxDocker } from '../src/sandbox/docker.ts';
import { ExecProxy } from '../src/sandbox/exec-proxy.ts';
import type { SandboxContainerSpec } from '../src/sandbox/hostconfig.ts';
import {
  DEFAULT_RETENTION_POLICY,
  classifyDestroyedState,
  collectStateBeforeDestroy,
  createLifecycleExecutor,
  planSweep,
  readDiskUsageRatio,
  retentionForOutcome,
} from '../src/sandbox/lifecycle.ts';
import type { TrackedContainer } from '../src/sandbox/lifecycle.ts';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

class FakeSandboxDocker implements SandboxDocker {
  readonly events: string[] = [];
  readonly destroyed: string[] = [];
  readonly execCalls: ExecStreamRequest[] = [];
  state: ContainerStateSnapshot = {
    containerId: 'c1',
    status: 'exited',
    running: false,
    exitCode: 0,
    oomKilled: false,
  };

  async ping(): Promise<void> {}

  async createContainer(_spec: SandboxContainerSpec): Promise<string> {
    return 'c1';
  }

  async inspectState(containerId: string): Promise<ContainerStateSnapshot> {
    this.events.push(`inspect:${containerId}`);
    return { ...this.state, containerId };
  }

  async execStream(request: ExecStreamRequest): Promise<{ exitCode: number }> {
    this.execCalls.push(request);
    return { exitCode: 0 };
  }

  async destroyContainer(containerId: string): Promise<void> {
    this.events.push(`destroy:${containerId}`);
    this.destroyed.push(containerId);
  }
}

function tracked(overrides: Partial<TrackedContainer> = {}): TrackedContainer {
  return {
    jobId: 'j1',
    containerId: 'c1',
    jobDir: '/srv/pi/jobs/j1',
    outcome: 'failure',
    finishedAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

describe('保留期矩阵（§6.3 的四行）', () => {
  it('成功：容器立即销毁，worktree 留 24h', () => {
    const decision = retentionForOutcome('success');
    expect(decision.container).toBe('destroy-now');
    expect(decision.containerKeepMs).toBe(0);
    expect(decision.worktreeKeepMs).toBe(24 * HOUR);
  });

  it('失败（非超时）：容器与 worktree 各留 1h 便于复现', () => {
    const decision = retentionForOutcome('failure');
    expect(decision.container).toBe('keep');
    expect(decision.containerKeepMs).toBe(HOUR);
    expect(decision.worktreeKeepMs).toBe(HOUR);
    expect(DEFAULT_RETENTION_POLICY.diskWatermark).toBe(0.85);
  });

  it.each(['timeout', 'cancelled', 'circuit-open'] as const)('%s：立即销毁，worktree 立即回收', (outcome) => {
    const decision = retentionForOutcome(outcome);
    expect(decision.container).toBe('destroy-now');
    expect(decision.worktreeKeepMs).toBe(0);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

describe('planSweep：保留期 + 磁盘水位', () => {
  it('保留期未到的失败容器保留，到点的销毁', () => {
    const fresh = tracked({ jobId: 'fresh', containerId: 'c-fresh', finishedAt: NOW - 5 * 60 * 1000 });
    const aged = tracked({ jobId: 'aged', containerId: 'c-aged', finishedAt: NOW - 2 * HOUR });
    const plan = planSweep({ now: NOW, diskUsageRatio: 0.5, containers: [fresh, aged] });
    expect(plan.watermarkExceeded).toBe(false);
    expect(plan.destroy.map((item) => item.container.containerId)).toEqual(['c-aged']);
    expect(plan.destroy[0]?.reason).toContain('保留期已到');
    expect(plan.keep.map((container) => container.containerId)).toEqual(['c-fresh']);
  });

  it('成功与超时的容器即使刚结束也立即销毁（容器侧）', () => {
    const plan = planSweep({
      now: NOW,
      diskUsageRatio: 0.1,
      containers: [
        tracked({ jobId: 's', containerId: 'c-ok', outcome: 'success', finishedAt: NOW }),
        tracked({ jobId: 't', containerId: 'c-to', outcome: 'timeout', finishedAt: NOW }),
      ],
    });
    expect(plan.destroy.map((item) => item.container.containerId).sort()).toEqual(['c-ok', 'c-to']);
  });

  it('磁盘 > 85%：清最旧的失败容器（每轮限量，不影响到期项）', () => {
    const older = tracked({ jobId: 'older', containerId: 'c-older', finishedAt: NOW - 50 * 60 * 1000 });
    const newer = tracked({ jobId: 'newer', containerId: 'c-newer', finishedAt: NOW - 1 * 60 * 1000 });
    const plan = planSweep({ now: NOW, diskUsageRatio: 0.9, containers: [newer, older] });
    expect(plan.watermarkExceeded).toBe(true);
    expect(plan.watermarkCleanup.map((item) => item.container.containerId)).toEqual(['c-older']);
    expect(plan.watermarkCleanup[0]?.reason).toContain('磁盘水位');
    expect(plan.keep.map((container) => container.containerId)).toEqual(['c-newer']);
  });

  it('85% 是「严格大于」：正好 0.85 不触发', () => {
    const plan = planSweep({ now: NOW, diskUsageRatio: 0.85, containers: [tracked()] });
    expect(plan.watermarkExceeded).toBe(false);
    expect(plan.watermarkCleanup).toHaveLength(0);
  });

  it('水位超限但没有失败容器时不会去动成功的 worktree 记录', () => {
    const plan = planSweep({
      now: NOW,
      diskUsageRatio: 0.99,
      containers: [tracked({ outcome: 'success', containerId: 'c-ok' })],
    });
    expect(plan.watermarkCleanup).toHaveLength(0);
  });
});

describe('销毁前 inspect（§3.6 / §6.3 的 (a)）', () => {
  it('OOM 优先于退出码：先看 OOMKilled 再判 exitCode', () => {
    expect(classifyDestroyedState({ ...fakeState(), oomKilled: true, exitCode: 137 })).toBe('sandbox-oom');
    expect(classifyDestroyedState({ ...fakeState(), oomKilled: false, exitCode: 137 })).toBe('sandbox-crash');
    expect(classifyDestroyedState({ ...fakeState(), oomKilled: false, exitCode: 0 })).toBeUndefined();
    expect(classifyDestroyedState(null)).toBeUndefined();
  });

  it('容器已不存在时返回 null（不抛，也不假装采到了）', async () => {
    const docker = new FakeSandboxDocker();
    docker.inspectState = async () => {
      const error = new Error('no such container');
      (error as Error & { code?: string }).code = 'CONTAINER_GONE';
      // collectStateBeforeDestroy 只认 SandboxError 的 code 字段
      const { SandboxError } = await import('../src/sandbox/errors.ts');
      throw new SandboxError('容器不存在', { code: 'CONTAINER_GONE' });
    };
    expect(await collectStateBeforeDestroy(docker, 'gone')).toBeNull();
  });

  it('dispose 先 inspect 再 destroy，并把 OOM 标记交给调用方', async () => {
    const docker = new FakeSandboxDocker();
    docker.state = { ...fakeState(), oomKilled: true, exitCode: 137, status: 'exited' };
    const executor = createLifecycleExecutor({ docker });

    const result = await executor.dispose({
      jobId: 'j1',
      containerId: 'c1',
      jobDir: '/srv/pi/jobs/j1',
      outcome: 'failure',
    });

    expect(docker.events).toEqual(['inspect:c1', 'destroy:c1']);
    expect(result.state?.oomKilled).toBe(true);
    expect(result.state?.exitCode).toBe(137);
    expect(result.failureClass).toBe('sandbox-oom');
    expect(result.retention.container).toBe('keep');
  });

  it('dispose 同时清掉 exec 端点（§6.3 的 (b)）', async () => {
    const docker = new FakeSandboxDocker();
    const proxy = new ExecProxy({ docker });
    const jobDir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'pi-lifecycle-'));
    const entry = await proxy.listen({ jobId: 'j-destroy', jobDir, containerId: 'c1' });
    const executor = createLifecycleExecutor({ docker, proxy });

    await executor.dispose({ jobId: 'j-destroy', containerId: 'c1', jobDir, outcome: 'timeout' });

    expect(proxy.size).toBe(0);
    await expect(stat(entry.endpointFile)).rejects.toThrow();
    expect(docker.events).toEqual(['inspect:c1', 'destroy:c1']);
    await rm(jobDir, { recursive: true, force: true });
  });
});

describe('sweep 执行器', () => {
  it('按计划销毁并采状态，保留的留在 kept 里', async () => {
    const docker = new FakeSandboxDocker();
    docker.state = { ...fakeState(), exitCode: 2, oomKilled: false };
    const executor = createLifecycleExecutor({ docker, clock: () => NOW });
    const fresh = tracked({ jobId: 'fresh', containerId: 'c-fresh' });
    const aged = tracked({ jobId: 'aged', containerId: 'c-aged', finishedAt: NOW - 2 * HOUR });

    const result = await executor.sweep({ containers: [fresh, aged], diskUsageRatio: 0.4 });

    expect(result.disposed.map((item) => item.containerId)).toEqual(['c-aged']);
    expect(result.disposed[0]?.state?.exitCode).toBe(2);
    expect(result.kept.map((item) => item.containerId)).toEqual(['c-fresh']);
    expect(docker.events).toEqual(['inspect:c-aged', 'destroy:c-aged']);
    expect(result.watermarkExceeded).toBe(false);
  });
});

describe('readDiskUsageRatio', () => {
  it('返回 0–1 之间的真实水位（statfs，而不是 docker df 的估算）', async () => {
    const ratio = await readDiskUsageRatio(process.cwd());
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });
});

function fakeState(): ContainerStateSnapshot {
  return {
    containerId: 'c1',
    status: 'exited',
    running: false,
    exitCode: 0,
    oomKilled: false,
  };
}
