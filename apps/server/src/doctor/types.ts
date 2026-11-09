/**
 * `pi-bot doctor` 的三态语义与报告形状（tech-plan §6.4 / plan §8.5）。
 *
 * 三条口径（文档里是散文，这里是可执行的定义）：
 *  1. **三态**：`ok` / `warn` / `fail`。没有第四态，也不允许「跳过」——
 *     跳过会让「没验证」长得像「验证通过」，而 preflight 的全部价值就在于区分这两件事。
 *  2. **聚合**：整份报告的 `worst` 取最严重的一项（`ok < warn < fail`）。
 *  3. **退出码**：任一 `fail` → 非零；只有 `warn` → 0（§6.4 最后一段）。
 *     `warn` 是「降级但能跑」，`fail` 是「拒绝启动」。
 *
 * 为什么 doctor 用自己的非零码而不是复用 CLI 的 `EXIT_FAILURE`：
 * CLI 已占 0（成功）/1（用法）/2（NOT_IMPLEMENTED）/3（执行失败），
 * 而「预检不通过」是第四类语义（配置没错、程序没崩，是环境不合格），
 * 运维脚本要能把它和「跑挂了」分开处理，所以单独给 4。
 */

/** 单项检查的结论。 */
export type CheckStatus = 'ok' | 'warn' | 'fail';

/** 三态的全集（遍历与校验用；顺序即严重度升序）。 */
export const CHECK_STATUSES: readonly CheckStatus[] = Object.freeze(['ok', 'warn', 'fail']);

/** 严重度权重：聚合 `worst` 时取最大值。 */
export const STATUS_SEVERITY: Readonly<Record<CheckStatus, number>> = Object.freeze({
  ok: 0,
  warn: 1,
  fail: 2,
});

/** 一项检查的最终结果（报告里的一行）。 */
export interface DoctorCheck {
  /** 稳定的机器可读 id（`docker` / `canary-network` / `exec-roundtrip` …），脚本按它断言。 */
  readonly id: string;
  /** 人读标题（表格第二列）。 */
  readonly title: string;
  readonly status: CheckStatus;
  /** 观察到的事实：不是「通过了」，而是「看到了什么」。 */
  readonly detail: string;
  /** 修复提示（非 ok 时给，人/脚本照着做就能修）。 */
  readonly fixHint?: string;
  /** 该项耗时（毫秒）。单项不设超时，靠各检查自己的命令超时兜住。 */
  readonly durationMs: number;
}

/** 一份完整报告。时间用 ISO 字符串：`--json` 输出与日志都能直接塞。 */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly startedAt: string;
  readonly finishedAt: string;
  /** 聚合结论 = 最严重的一项。 */
  readonly worst: CheckStatus;
}

/**
 * `runDoctor()` 的返回值 = 报告 + 退出码。
 *
 * 为什么要多带一个 `exitCode`：CLI 的 `runDelegated()`（由 W2-G 接线，本 session 不改它）
 * 只认 `outcome.exitCode`，没有它就一律按 0 退出——那会让 `pi-bot doctor` 在
 * `fail` 时也返回 0，「不通过拒绝启动」（§6.4）就形同虚设。
 */
export interface DoctorOutcome extends DoctorReport {
  readonly exitCode: number;
}

/** 一切正常：可以启动。 */
export const DOCTOR_EXIT_OK = 0;
/** 预检不通过（任一 `fail`）。注意它与 CLI 的 1/2/3 语义不同，见文件头。 */
export const DOCTOR_EXIT_PREFLIGHT_FAILED = 4;

/** 单项检查的原始返回：状态 + 观察到的事实 + 修复提示（`durationMs` 由调度器补）。 */
export interface CheckOutcome {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fixHint?: string;
}

/** 两项严重度比较：返回更严重的那一项（同值时返回 `left`）。 */
export function worstOf(left: CheckStatus, right: CheckStatus): CheckStatus {
  return STATUS_SEVERITY[right] > STATUS_SEVERITY[left] ? right : left;
}

/** 报告的聚合结论；空报告视为 `ok`（没有检查就没有坏消息，但不能当成「验证过」——由调用方保证 CHECKS 非空）。 */
export function worstStatusOf(checks: readonly DoctorCheck[]): CheckStatus {
  let worst: CheckStatus = 'ok';
  for (const check of checks) {
    worst = worstOf(worst, check.status);
  }
  return worst;
}

/**
 * 退出码约定（§6.4）：任一 `fail` → 非零；只有 `warn` → 0。
 *
 * 有意写成「只看 `fail`」而不是「非 ok 即失败」：`warn` 是降级运行
 * （例如本机没有 `vendor/pi-host` bundle、Windows 上没有 nftables），
 * 那种环境下拒绝启动只会逼人加 `-` 前缀绕过检查，反而没人看报告。
 */
export function exitCodeOf(report: DoctorReport): number {
  const failed = report.checks.some((check) => check.status === 'fail');
  return failed ? DOCTOR_EXIT_PREFLIGHT_FAILED : DOCTOR_EXIT_OK;
}
