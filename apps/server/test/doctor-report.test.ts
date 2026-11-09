/**
 * `doctor` 的报告契约（tech-plan §6.4 的三态与退出码）。
 *
 * 不碰 docker / PG：这一组只测「聚合、退出码、渲染、单项异常兜底」这几条**纯逻辑**，
 * 真实的 daemon 与数据库在 `doctor-real.test.ts` 里跑。
 */
import { describe, expect, it } from 'vitest';

import {
  CHECKS,
  DOCTOR_EXIT_OK,
  DOCTOR_EXIT_PREFLIGHT_FAILED,
  exitCodeOf,
  formatReport,
  formatReportJson,
  runDoctor,
  worstOf,
  worstStatusOf,
} from '../src/doctor/index.ts';
import type { CheckDefinition, DoctorCheck, DoctorIo, DoctorReport } from '../src/doctor/index.ts';

function check(id: string, status: DoctorCheck['status'], extra: Partial<DoctorCheck> = {}): DoctorCheck {
  return { id, title: `标题 ${id}`, status, detail: `${id} 的观察结果`, durationMs: 3, ...extra };
}

function reportOf(checks: readonly DoctorCheck[]): DoctorReport {
  return {
    checks,
    startedAt: '2026-06-01T00:00:00.000Z',
    finishedAt: '2026-06-01T00:00:01.000Z',
    worst: worstStatusOf(checks),
  };
}

function collectIo(): { readonly io: DoctorIo; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
    out,
    err,
  };
}

/** 假检查：不依赖任何 ctx，直接给结论（用来测聚合与渲染）。 */
function fakeCheck(id: string, status: DoctorCheck['status'], fixHint?: string): CheckDefinition {
  return {
    id,
    title: `标题 ${id}`,
    run: async () => ({
      status,
      detail: `${id} 的观察结果`,
      ...(fixHint === undefined ? {} : { fixHint }),
    }),
  };
}

describe('三态聚合', () => {
  it('空报告视为 ok（没有检查就没有坏消息）', () => {
    expect(worstStatusOf([])).toBe('ok');
  });

  it('ok < warn < fail：取最严重的一项', () => {
    expect(worstStatusOf([check('a', 'ok'), check('b', 'warn')])).toBe('warn');
    expect(worstStatusOf([check('a', 'warn'), check('b', 'fail'), check('c', 'ok')])).toBe('fail');
    expect(worstOf('ok', 'warn')).toBe('warn');
    expect(worstOf('fail', 'warn')).toBe('fail');
    expect(worstOf('warn', 'warn')).toBe('warn');
  });
});

describe('退出码约定（§6.4：任一 fail 非零；只有 warn 为 0）', () => {
  it('全 ok → 0', () => {
    expect(exitCodeOf(reportOf([check('a', 'ok')]))).toBe(DOCTOR_EXIT_OK);
  });

  it('只有 warn → 0', () => {
    expect(exitCodeOf(reportOf([check('a', 'warn'), check('b', 'ok')]))).toBe(DOCTOR_EXIT_OK);
  });

  it('任一 fail → 非零（预检专用码 4，与 CLI 的 1/2/3 区分开）', () => {
    expect(exitCodeOf(reportOf([check('a', 'warn'), check('b', 'fail')]))).toBe(
      DOCTOR_EXIT_PREFLIGHT_FAILED,
    );
    expect(DOCTOR_EXIT_PREFLIGHT_FAILED).toBe(4);
  });
});

describe('formatReport', () => {
  it('每一项的 id 与状态都出现在输出里', () => {
    const report = reportOf([
      check('docker', 'ok'),
      check('canary-network', 'fail', { fixHint: 'apply deploy/nftables.conf' }),
      check('pin', 'warn', { fixHint: '重新 vendored' }),
    ]);
    const text = formatReport(report);
    for (const entry of report.checks) {
      expect(text).toContain(entry.id);
      expect(text).toContain(entry.status);
      expect(text).toContain(entry.detail);
    }
    // 非 ok 的项要带修复提示
    expect(text).toContain('apply deploy/nftables.conf');
    expect(text).toContain('重新 vendored');
    // 结论行要能直接读退出码
    expect(text).toContain('1 ok / 1 warn / 1 fail');
    expect(text).toContain(`退出码 ${String(DOCTOR_EXIT_PREFLIGHT_FAILED)}`);
  });

  it('全 ok 时不出现「需要处理」段', () => {
    const text = formatReport(reportOf([check('docker', 'ok'), check('disk', 'ok')]));
    expect(text).not.toContain('需要处理');
    expect(text).toContain('2 ok / 0 warn / 0 fail');
  });
});

describe('formatReportJson', () => {
  it('可被解析，且带 exitCode（脚本不必自己再算）', () => {
    const parsed: unknown = JSON.parse(formatReportJson(reportOf([check('a', 'fail')])));
    expect(parsed).toMatchObject({ worst: 'fail', exitCode: DOCTOR_EXIT_PREFLIGHT_FAILED });
    const record = parsed as { checks: readonly { id: string }[] };
    expect(record.checks.map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('runDoctor', () => {
  const base = {
    env: {},
    platform: 'linux' as NodeJS.Platform,
    repoRoot: '/repo',
    now: () => new Date('2026-06-01T00:00:00.000Z'),
    json: false,
  };

  it('聚合结论与退出码一致，并把报告写到注入的 io', async () => {
    const { io, out } = collectIo();
    const outcome = await runDoctor({
      ...base,
      io,
      checks: [fakeCheck('alpha', 'ok'), fakeCheck('beta', 'warn', '修一下')],
    });
    expect(outcome.checks.map((entry) => entry.id)).toEqual(['alpha', 'beta']);
    expect(outcome.worst).toBe('warn');
    expect(outcome.exitCode).toBe(DOCTOR_EXIT_OK);
    expect(outcome.startedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(out.join('')).toContain('beta');
    expect(out.join('')).toContain('修一下');
    for (const entry of outcome.checks) {
      expect(typeof entry.durationMs).toBe('number');
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('任一 fail → exitCode 非零（CLI 的 runDelegated 只读这个字段）', async () => {
    const { io } = collectIo();
    const outcome = await runDoctor({ ...base, io, checks: [fakeCheck('a', 'ok'), fakeCheck('b', 'fail')] });
    expect(outcome.exitCode).toBe(DOCTOR_EXIT_PREFLIGHT_FAILED);
  });

  it('单项抛错 → 记为该项 fail，其余检查照跑', async () => {
    const { io, out } = collectIo();
    const exploding: CheckDefinition = {
      id: 'boom',
      title: '会抛错的一项',
      run: async () => {
        throw new Error('内部炸了');
      },
    };
    const outcome = await runDoctor({ ...base, io, checks: [exploding, fakeCheck('after', 'ok')] });
    expect(outcome.checks).toHaveLength(2);
    expect(outcome.checks[0]?.status).toBe('fail');
    expect(outcome.checks[0]?.detail).toContain('内部炸了');
    expect(outcome.checks[1]?.status).toBe('ok');
    expect(outcome.exitCode).toBe(DOCTOR_EXIT_PREFLIGHT_FAILED);
    expect(out.join('')).toContain('boom');
  });

  it('json 模式输出可解析的 JSON（含 exitCode）', async () => {
    const { io, out } = collectIo();
    await runDoctor({ ...base, io, json: true, checks: [fakeCheck('a', 'warn')] });
    const parsed: unknown = JSON.parse(out.join(''));
    expect(parsed).toMatchObject({ worst: 'warn', exitCode: DOCTOR_EXIT_OK });
  });

  it('CHECKS 清单：13 项且 id 唯一（cli 按 id 断言/排障）', () => {
    expect(CHECKS).toHaveLength(13);
    const ids = CHECKS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'docker',
      'disk',
      'image',
      'canary-network',
      'cgroup',
      'postgres',
      'pin',
      'host',
      'model-endpoint',
      'shell',
      'exec-roundtrip',
      'socket-ownership',
      'nftables',
    ]);
    for (const entry of CHECKS) {
      expect(typeof entry.run).toBe('function');
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });
});
