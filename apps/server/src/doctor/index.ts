/**
 * `pi-bot doctor`：启动前预检（tech-plan §6.4 / plan §8.5）。
 *
 * 结构：
 *  - `CHECKS` 是**顺序即报告顺序**的检查清单，每项来自 `checks/*.ts` 的一个函数；
 *  - `runDoctor()` 逐项跑、计时、聚合三态、算退出码，并自己把报告打出去（CLI 只打印「完成」）；
 *  - `formatReport()` 人读表格，`formatReportJson()` 给 `--json`（给脚本/CI 用）。
 *
 * 两个不可动摇的口径：
 *  1. **一项检查抛错不会让整份报告消失**：异常被记为该项 `fail`，其余项照跑。
 *     预检的价值在于「一次告诉你全部问题」，而不是遇到第一个坑就停。
 *  2. **退出码由报告算出**（`exitCodeOf`）：任一 `fail` → 非零；只有 `warn` → 0。
 *     CLI 的 `runDelegated()` 只读 `outcome.exitCode`，所以返回值必须是 `DoctorOutcome`。
 *
 * 注入点全是可选的（`DoctorDeps`），默认即真实实现：真 docker、真 `node:fs`、真 `/proc`、
 * 真 spawn、真 PG 池。单测只替换需要制造失配的那几个字段。
 */
import { createPool } from '../db/index.ts';
import { canaryNetworkCheck } from './checks/canary-network.ts';
import { cgroupCheck } from './checks/cgroup.ts';
import { dockerCheck } from './checks/docker.ts';
import { diskCheck } from './checks/disk.ts';
import { execRoundtripCheck } from './checks/exec-roundtrip.ts';
import { hostCheck } from './checks/host.ts';
import { imageCheck } from './checks/image.ts';
import { nftablesCheck } from './checks/nftables.ts';
import { pinCheck } from './checks/pin.ts';
import { postgresCheck } from './checks/postgres.ts';
import { shellCheck } from './checks/shell.ts';
import { socketOwnershipCheck } from './checks/socket-ownership.ts';
import { describeError, resolveDeps } from './deps.ts';
import type { CheckContext, CheckDefinition, DoctorDeps } from './deps.ts';
import {
  CHECK_STATUSES,
  DOCTOR_EXIT_OK,
  DOCTOR_EXIT_PREFLIGHT_FAILED,
  STATUS_SEVERITY,
  exitCodeOf,
  worstOf,
  worstStatusOf,
} from './types.ts';
import type { CheckOutcome, CheckStatus, DoctorCheck, DoctorOutcome, DoctorReport } from './types.ts';

/**
 * 检查清单。顺序有讲究：便宜且是前置条件的放前面（daemon、磁盘），
 * 依赖它们的放后面（镜像 → 金丝雀 → cgroup），最后是「链路自检」与「归属断言」。
 */
export const CHECKS: readonly CheckDefinition[] = Object.freeze([
  dockerCheck,
  diskCheck,
  imageCheck,
  canaryNetworkCheck,
  cgroupCheck,
  postgresCheck,
  pinCheck,
  hostCheck,
  shellCheck,
  execRoundtripCheck,
  socketOwnershipCheck,
  nftablesCheck,
]);

/** 报告的输出通道（默认写 stdout；单测注入收集器）。 */
export interface DoctorIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const processIo: DoctorIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/** `runDoctor()` 的入参：`DoctorDeps` + CLI 传进来的那几个字段 + 输出格式。 */
export interface DoctorOptions extends DoctorDeps {
  /** `PI_BOT_DATABASE_URL`；给了就自建连接池（只读查询用），并在结束时关掉。 */
  readonly databaseUrl?: string | undefined;
  /** `--json`：输出机器可读报告。不传时看 `process.argv`（CLI 不转发参数）。 */
  readonly json?: boolean;
  readonly io?: DoctorIo;
  /** 覆盖检查清单（单测用；默认 `CHECKS`）。 */
  readonly checks?: readonly CheckDefinition[];
}

/** 单项检查的兜底：任何异常都变成 `fail`，并带上「这是 doctor 自己出问题」的判据。 */
async function runCheck(check: CheckDefinition, ctx: CheckContext): Promise<DoctorCheck> {
  const started = ctx.elapsed();
  try {
    const outcome: CheckOutcome = await check.run(ctx);
    return {
      id: check.id,
      title: check.title,
      status: outcome.status,
      detail: outcome.detail,
      ...(outcome.fixHint === undefined ? {} : { fixHint: outcome.fixHint }),
      durationMs: Math.max(0, Math.round(ctx.elapsed() - started)),
    };
  } catch (error) {
    return {
      id: check.id,
      title: check.title,
      status: 'fail',
      detail: `检查自身抛错：${describeError(error)}`,
      fixHint: '这是 doctor 的缺陷（预期所有检查都返回三态而不是抛错），请带着这条 detail 报 issue',
      durationMs: Math.max(0, Math.round(ctx.elapsed() - started)),
    };
  }
}

/** 一列的显示宽度：CJK 字符按 2 列算，否则中文表格会错位。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右补空格。 */
function padRight(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

/** 人读表格：每项 id + 状态 + 耗时 + 结论；非 ok 的另外列出修复提示。 */
export function formatReport(report: DoctorReport): string {
  const header = ['状态', '检查项', '耗时', '结论'];
  const durations = report.checks.map((check) => `${String(check.durationMs)}ms`);
  const widths = [
    Math.max(displayWidth(header[0] ?? ''), ...report.checks.map((check) => displayWidth(check.status))),
    Math.max(displayWidth(header[1] ?? ''), ...report.checks.map((check) => displayWidth(check.id))),
    Math.max(displayWidth(header[2] ?? ''), ...durations.map((value) => displayWidth(value))),
  ];
  const line = (cells: readonly string[]): string =>
    [
      padRight(cells[0] ?? '', widths[0] ?? 0),
      padRight(cells[1] ?? '', widths[1] ?? 0),
      padRight(cells[2] ?? '', widths[2] ?? 0),
      cells[3] ?? '',
    ].join('  ');

  const lines: string[] = [];
  lines.push('pi-bot doctor —— 启动前预检');
  lines.push(`开始 ${report.startedAt}  ·  结束 ${report.finishedAt}`);
  lines.push('');
  lines.push(line(header));
  lines.push(
    `${'-'.repeat(widths[0] ?? 2)}  ${'-'.repeat(widths[1] ?? 2)}  ${'-'.repeat(widths[2] ?? 2)}  ${'-'.repeat(20)}`,
  );
  for (const [index, check] of report.checks.entries()) {
    lines.push(line([check.status, check.id, durations[index] ?? '', check.detail]));
  }

  const problems = report.checks.filter((check) => check.status !== 'ok');
  if (problems.length > 0) {
    lines.push('');
    lines.push('需要处理：');
    for (const check of problems) {
      lines.push(`  [${check.status}] ${check.id}：${check.detail}`);
      if (check.fixHint !== undefined) {
        lines.push(`    修复：${check.fixHint}`);
      }
    }
  }

  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const warned = report.checks.filter((check) => check.status === 'warn').length;
  const passed = report.checks.length - failed - warned;
  lines.push('');
  lines.push(
    `结论：${String(passed)} ok / ${String(warned)} warn / ${String(failed)} fail  →  ` +
      `worst=${report.worst}，退出码 ${String(exitCodeOf(report))}` +
      '（任一 fail 即非零；只有 warn 时为 0）',
  );
  return `${lines.join('\n')}\n`;
}

/** `--json`：给脚本/CI 的输出（含 exitCode，省得调用方再算一遍）。 */
export function formatReportJson(report: DoctorReport): string {
  return `${JSON.stringify({ ...report, exitCode: exitCodeOf(report) }, null, 2)}\n`;
}

/** 严重度的数字形式（排序/展示用；避免各处重复 `STATUS_SEVERITY`）。 */
export function severityOf(status: CheckStatus): number {
  return STATUS_SEVERITY[status];
}

/**
 * 跑一遍预检。**自己负责输出**：CLI 的 `runDelegated()` 只在成功后打印一行「完成」，
 * 报告必须由这里给出，否则 `pi-bot doctor` 会「什么也没说就退了个码」。
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorOutcome> {
  const io = options.io ?? processIo;
  const asJson = (): boolean => options.json ?? process.argv.includes('--json');

  // PG 连接池：给了 DSN 且调用方没提供池时自建，并在 finally 里关掉（doctor 不能留下连接）
  const ownPool =
    options.pool === undefined && options.databaseUrl !== undefined && options.databaseUrl.trim() !== ''
      ? createPool({
          connectionString: options.databaseUrl,
          max: 2,
          applicationName: 'pi-bot-doctor',
          connectionTimeoutMillis: 5_000,
        })
      : undefined;

  const ctx = resolveDeps({
    ...options,
    ...(ownPool === undefined ? {} : { pool: ownPool }),
  });

  const startedAt = ctx.now().toISOString();
  try {
    const checks: DoctorCheck[] = [];
    for (const check of options.checks ?? CHECKS) {
      const result = await runCheck(check, ctx);
      checks.push(result);
      // debug 而不是 info：报告本身是给人看的表格，逐项 info 日志会把 stdin/stdout 弄成日志流
      ctx.logger.debug(
        { check: result.id, status: result.status, durationMs: result.durationMs },
        'doctor 检查完成',
      );
    }

    const report: DoctorReport = {
      checks,
      startedAt,
      finishedAt: ctx.now().toISOString(),
      worst: worstStatusOf(checks),
    };
    const outcome: DoctorOutcome = { ...report, exitCode: exitCodeOf(report) };

    io.out(asJson() ? formatReportJson(report) : formatReport(report));
    if (outcome.exitCode !== DOCTOR_EXIT_OK) {
      ctx.logger.warn(
        { exitCode: outcome.exitCode, worst: outcome.worst },
        'doctor 预检未通过（按 §6.4：不通过拒绝启动）',
      );
    }
    return outcome;
  } finally {
    if (ownPool !== undefined) {
      await ownPool.end().catch(() => undefined);
    }
  }
}

/* ── 对外导出（`cli.ts` 的动态 import 点只需要 `runDoctor`，其余是给脚本/单测的） ── */

export { CHECK_STATUSES, DOCTOR_EXIT_OK, DOCTOR_EXIT_PREFLIGHT_FAILED, STATUS_SEVERITY };
export { exitCodeOf, resolveDeps, worstOf, worstStatusOf };
export type { CheckOutcome, CheckContext, CheckDefinition, CheckStatus };
export type { DoctorCheck, DoctorDeps, DoctorOutcome, DoctorReport };
