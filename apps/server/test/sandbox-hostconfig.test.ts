/**
 * HostConfig 映射的逐字段断言（tech-plan §6.1 的表逐行对）。
 *
 * 这一层是纯函数，所以「规格是否落地」不靠起容器、靠对字段；
 * 真容器断言（`pwd` / 只读根 / memory.max / OOM）在 `sandbox-docker.test.ts`。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_CACHE_VOLUME,
  DEFAULT_NETWORK_MODE,
  DEFAULT_NANO_CPUS,
  DEFAULT_NOFILE,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_USER,
  MEMORY_TIER_BYTES,
  buildContainerCreateOptions,
  buildHostConfig,
  containerNameFor,
  nodeOptionsFor,
  resolveMemoryBytes,
} from '../src/sandbox/hostconfig.ts';
import { toContainerPath } from '../src/sandbox/paths.ts';

const GIB = 1024 ** 3;
let jobDir = '';

beforeAll(async () => {
  jobDir = await mkdtemp(path.join(os.tmpdir(), 'pi-sandbox-hc-'));
});

afterAll(async () => {
  await rm(jobDir, { recursive: true, force: true });
});

function baseInput() {
  return { jobId: 'job123', jobDir, image: 'pi-worker:node22' } as const;
}

describe('buildHostConfig：§6.1 逐行映射', () => {
  it('能力全砍：只读根、tmpfs、cap-drop、no-new-privileges、pids、cpus、init', () => {
    const host = buildHostConfig(baseInput());
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Tmpfs).toEqual({ '/tmp': 'rw,size=512m,noexec,nosuid' });
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.SecurityOpt).toEqual(['no-new-privileges']);
    expect(host.PidsLimit).toBe(DEFAULT_PIDS_LIMIT);
    expect(host.PidsLimit).toBe(512);
    expect(host.NanoCpus).toBe(DEFAULT_NANO_CPUS);
    expect(host.NanoCpus).toBe(2e9);
    expect(host.Init).toBe(true);
    expect(host.Ulimits).toEqual([{ Name: 'nofile', Soft: DEFAULT_NOFILE, Hard: DEFAULT_NOFILE }]);
  });

  it('内存按档：判定类 2 GiB、build 类 4 GiB，MemorySwap 必须同值（禁 swap）', () => {
    const triage = buildHostConfig(baseInput());
    expect(triage.Memory).toBe(2 * GIB);
    expect(triage.MemorySwap).toBe(2 * GIB);
    expect(MEMORY_TIER_BYTES.triage).toBe(2 * GIB);

    const build = buildHostConfig({ ...baseInput(), memoryTier: 'build' });
    expect(build.Memory).toBe(4 * GIB);
    expect(build.MemorySwap).toBe(4 * GIB);
    expect(MEMORY_TIER_BYTES.build).toBe(4 * GIB);

    // 显式值优先于档位（真容器测试用小内存，见 sandbox-docker.test.ts）
    const explicit = buildHostConfig({ ...baseInput(), memoryBytes: 256 * 1024 ** 2 });
    expect(explicit.Memory).toBe(256 * 1024 ** 2);
    expect(explicit.MemorySwap).toBe(256 * 1024 ** 2);
  });

  it('身份挂载：Binds 的源与目标都是 job 目录，缓存卷只读', () => {
    const host = buildHostConfig(baseInput());
    const containerJob = toContainerPath(jobDir);
    expect(host.Binds).toEqual([`${jobDir.replace(/\\/g, '/')}:${containerJob}:rw`, `${DEFAULT_CACHE_VOLUME}:/cache:ro`]);
    expect(host.NetworkMode).toBe(DEFAULT_NETWORK_MODE);
    // §6.3 要求销毁前 inspect 采 OOMKilled：AutoRemove 会抢跑，必须关掉
    expect(host.AutoRemove).toBe(false);
  });

  it('非法内存值直接报错，不静默兜底', () => {
    expect(() => resolveMemoryBytes({ ...baseInput(), memoryBytes: 1024 })).toThrow(RangeError);
  });
});

describe('buildContainerCreateOptions：容器级字段', () => {
  it('名字、Cmd、WorkingDir、User、NODE_OPTIONS 全部按规范', () => {
    const spec = buildContainerCreateOptions(baseInput());
    expect(spec.name).toBe(containerNameFor('job123'));
    expect(spec.name).toBe('pi-job-job123');
    expect(spec.Image).toBe('pi-worker:node22');
    expect(spec.Cmd).toEqual(['sleep', 'infinity']);
    expect(spec.WorkingDir).toBe(toContainerPath(jobDir));
    expect(spec.User).toBe(DEFAULT_USER);
    expect(spec.User).toBe('1001:1001');
    expect(spec.Tty).toBe(false);
    // §3.6：NODE_OPTIONS 取上限 × 0.6
    expect(spec.Env).toContain(`NODE_OPTIONS=${nodeOptionsFor(2 * GIB)}`);
    expect(nodeOptionsFor(2 * GIB)).toBe('--max-old-space-size=1228');
    expect(nodeOptionsFor(4 * GIB)).toBe('--max-old-space-size=2457');
    expect(spec.Labels['pi-bot.job-id']).toBe('job123');
  });

  it('产物里不出现 /work（plan §8.1 的写法已作废，tech-plan §4.5 E1）', () => {
    const serialized = JSON.stringify(buildContainerCreateOptions(baseInput()));
    expect(serialized).not.toContain('/work');
    expect(serialized).not.toContain('\\/work');
  });

  it('高风险任务可切 --network=none 加固档', () => {
    const spec = buildContainerCreateOptions({ ...baseInput(), networkMode: 'none' });
    expect(spec.HostConfig.NetworkMode).toBe('none');
    expect(spec.HostConfig.NetworkMode).not.toBe(DEFAULT_NETWORK_MODE);
  });
});
