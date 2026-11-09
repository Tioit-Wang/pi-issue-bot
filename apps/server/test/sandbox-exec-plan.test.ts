/**
 * 命令计划的断言（tech-plan §4.5 / §4.7 + dev-plan §11 E6）。
 *
 * 三条不能让步的形状：
 *   1. `timeout -s KILL <n>` 是 `docker exec` 的**参数**（超时下沉进容器，F3）；
 *   2. `# PI_CMD_ID=<uuid>` 写在**命令行里**（`pkill -f` 只读 cmdline，E6）；
 *   3. `argv` 原样作为 `bash -lc` 的单个参数，没有任何字符串拼接。
 */
import { describe, expect, it } from 'vitest';

import {
  CMD_MARKER_PREFIX,
  EXEC_TIMEOUT_BUILD_MS,
  EXEC_TIMEOUT_DEFAULT_MS,
  buildExecPlan,
  buildFallbackKillPlan,
  classifyTimeoutMs,
} from '../src/sandbox/exec-plan.ts';

const CMD_ID = '11111111-2222-3333-4444-555555555555';

describe('buildExecPlan', () => {
  it('形状固定：timeout -s KILL <n> bash -lc "<cmd>\\n# PI_CMD_ID=<uuid>"', () => {
    const plan = buildExecPlan({
      argv: ['bash', '-lc', 'pnpm test'],
      workdir: '/srv/pi/jobs/j1',
      timeoutMs: 300_000,
      cmdId: CMD_ID,
    });
    expect(plan.cmd).toEqual([
      'timeout',
      '-s',
      'KILL',
      '300',
      'bash',
      '-lc',
      `pnpm test\n# ${CMD_MARKER_PREFIX}${CMD_ID}`,
    ]);
    // 兜底标记必须真的出现在命令行里（E6 的核心）
    expect(plan.cmd.join('\u0000')).toContain(`${CMD_MARKER_PREFIX}${CMD_ID}`);
    expect(plan.workdir).toBe('/srv/pi/jobs/j1');
    // env 只用于辅助，不是兜底手段
    expect(plan.env).toEqual([`${CMD_MARKER_PREFIX}${CMD_ID}`]);
    expect(plan.timeoutSeconds).toBe(300);
  });

  it('秒数向上取整且至少 1 秒', () => {
    expect(buildExecPlan({ argv: ['-lc', 'true'], workdir: '/j', timeoutMs: 1, cmdId: CMD_ID }).cmd[3]).toBe('1');
    expect(buildExecPlan({ argv: ['-lc', 'true'], workdir: '/j', timeoutMs: 1500, cmdId: CMD_ID }).cmd[3]).toBe('2');
  });

  it('不自动生成 cmdId 时用 uuid（每次不同）', () => {
    const first = buildExecPlan({ argv: ['-lc', 'true'], workdir: '/j', timeoutMs: 1000 });
    const second = buildExecPlan({ argv: ['-lc', 'true'], workdir: '/j', timeoutMs: 1000 });
    expect(first.cmdId).not.toBe(second.cmdId);
    expect(first.cmdId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('空命令 / 非法超时直接报错，不生成一个「空跑」的计划', () => {
    expect(() => buildExecPlan({ argv: ['bash', '-lc', '   '], workdir: '/j', timeoutMs: 1000 })).toThrow(
      /最后一项为空/,
    );
    expect(() => buildExecPlan({ argv: [], workdir: '/j', timeoutMs: 1000 })).toThrow(/最后一项为空/);
    expect(() => buildExecPlan({ argv: ['-lc', 'true'], workdir: '/j', timeoutMs: 0 })).toThrow(/timeoutMs 非法/);
  });

  it('命令文本原样保留（不解释元字符、不做转义）', () => {
    const tricky = `echo "$(date)" && ls -1 | wc -l; echo '\\n done'`;
    const plan = buildExecPlan({ argv: ['-lc', tricky], workdir: '/j', timeoutMs: 1000, cmdId: CMD_ID });
    expect(plan.cmd[6]?.startsWith(tricky)).toBe(true);
    expect(plan.cmd).toHaveLength(7);
  });
});

describe('classifyTimeoutMs：120s / 300s 分档', () => {
  it('install / build / test 类给 300s', () => {
    expect(classifyTimeoutMs(['bash', '-lc', 'pnpm install'])).toBe(EXEC_TIMEOUT_BUILD_MS);
    expect(classifyTimeoutMs(['bash', '-lc', 'npm ci'])).toBe(EXEC_TIMEOUT_BUILD_MS);
    expect(classifyTimeoutMs(['bash', '-lc', 'pnpm build'])).toBe(EXEC_TIMEOUT_BUILD_MS);
    expect(classifyTimeoutMs(['bash', '-lc', 'cargo build --release'])).toBe(EXEC_TIMEOUT_BUILD_MS);
    expect(classifyTimeoutMs(['bash', '-lc', 'vitest run'])).toBe(EXEC_TIMEOUT_BUILD_MS);
  });

  it('普通命令给 120s', () => {
    expect(classifyTimeoutMs(['bash', '-lc', 'pwd'])).toBe(EXEC_TIMEOUT_DEFAULT_MS);
    expect(classifyTimeoutMs(['bash', '-lc', 'git status'])).toBe(EXEC_TIMEOUT_DEFAULT_MS);
    expect(classifyTimeoutMs([])).toBe(EXEC_TIMEOUT_DEFAULT_MS);
  });

  it('可注入覆盖值（测试不想等 120s）', () => {
    expect(classifyTimeoutMs(['-lc', 'pnpm build'], { buildMs: 5, defaultMs: 1 })).toBe(5);
    expect(classifyTimeoutMs(['-lc', 'pwd'], { buildMs: 5, defaultMs: 1 })).toBe(1);
  });
});

describe('buildFallbackKillPlan：宿主侧兜底（§4.7）', () => {
  it('匹配串是唯一的 PI_CMD_ID=<uuid>，不是模糊的 pnpm', () => {
    const plan = buildFallbackKillPlan({ cmdId: CMD_ID });
    expect(plan.cmd).toEqual(['pkill', '-KILL', '-f', `${CMD_MARKER_PREFIX}${CMD_ID}`]);
    expect(plan.cmd.join(' ')).not.toMatch(/\bpnpm\b/);
  });

  it('空 cmdId 报错（模糊匹配会杀别的命令）', () => {
    expect(() => buildFallbackKillPlan({ cmdId: '  ' })).toThrow(/不能为空/);
  });
});
