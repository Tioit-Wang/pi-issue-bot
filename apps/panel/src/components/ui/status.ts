/**
 * **状态语义的唯一定义处**（D1 设计系统）。
 *
 * 规则：颜色只有四个语义档 + 中性 + 品牌。
 * 页面不得自造颜色（不写 `text-emerald-500`、不写 `bg-amber-500/15`），
 * 一律从这里取 tone，再由 `Badge` / `StatusDot` / `Alert` 翻译成类名。
 *
 * - `success` 成功 / 已应用 / 健康
 * - `warn`    降级 / dry-run / 待人回答 / 熔断
 * - `danger`  失败 / 超时 / 配置非法
 * - `info`    进行中 / 中性信息
 * - `neutral` 排队 / 跳过 / 停用 / 归档
 * - `brand`   青色强调（**只用于当前选区 / 焦点环 / 强调文字**；主操作是墨色 `primary`，不是它）
 */

export type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'info' | 'brand';

/** 徽章：低饱和底 + 同色系文字（底色由 `--*-bg` 与面混出 8~12%）。 */
export const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  success: 'bg-success-bg text-success-fg',
  warn: 'bg-warn-bg text-warn-fg',
  danger: 'bg-danger-bg text-danger-fg',
  info: 'bg-info-bg text-info-fg',
  brand: 'bg-brand-soft text-brand',
};

/** 状态点：实心圆点（尺寸由调用方给，默认 6px）。 */
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-neutral',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  brand: 'bg-brand',
};

/** 纯文字强调（表格里的数值、结论）。 */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-success-fg',
  warn: 'text-warn-fg',
  danger: 'text-danger-fg',
  info: 'text-info-fg',
  brand: 'text-brand',
};

/** 描边（Alert、卡片左缘的 2px 状态条）。 */
export const TONE_BORDER: Record<Tone, string> = {
  neutral: 'border-neutral',
  success: 'border-success',
  warn: 'border-warn',
  danger: 'border-danger',
  info: 'border-info',
  brand: 'border-brand',
};

/** 低饱和面（Alert 底色、选中行底色）。 */
export const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'bg-neutral-bg',
  success: 'bg-success-bg',
  warn: 'bg-warn-bg',
  danger: 'bg-danger-bg',
  info: 'bg-info-bg',
  brand: 'bg-brand-soft',
};

/**
 * 任务 / 动作 / 运行状态 → tone。
 *
 * 取值来自契约的 `taskStatusSchema` / `actionStatusSchema`；这里写全是为了
 * 「同一个状态在列表、详情、时间线里永远是同一个颜色」。
 */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'succeeded':
    case 'applied':
    case 'success':
    case 'ok':
    case 'valid':
    case 'allow':
      return 'success';
    case 'failed':
    case 'rejected':
    case 'timed-out':
    case 'timeout':
    case 'invalid':
    case 'deny':
      return 'danger';
    case 'running':
    case 'queued-executing':
    case 'dry-run':
      return 'warn';
    case 'pending':
    case 'in-flight':
      return 'info';
    case 'queued':
    case 'skipped':
    case 'cancelled':
    case 'interrupted':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** issue 的 GitHub 状态 → tone（`open` 是信息，`closed` 是中性，不是「成功」）。 */
export function issueStateTone(state: string): Tone {
  switch (state) {
    case 'open':
      return 'info';
    case 'closed':
      return 'neutral';
    default:
      return 'neutral';
  }
}
