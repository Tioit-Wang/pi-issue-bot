import { cn } from '../../lib/utils.ts';

/**
 * 技能启用开关（全局页与项目技能页共用）。
 *
 * 为什么不是 `ui/` 里的通用控件：这一枚开关的语义是「这条技能参不参与运行时解析」，
 * 写操作由父级发 `PATCH`（服务端是唯一事实源），所以它只负责「画 + 报状态」。
 *
 * 无障碍：真 `<button role="switch">`，状态走 `aria-checked`，名字由 `label` 给
 * （读屏要能听出是哪个技能、哪个作用域）；`pending` 时禁点但不改变宽度。
 * 动效只过渡背景色与位移，时长用 `--dur-fast`，reduced-motion 下由全局规则归零。
 */
export function EnabledSwitch({
  checked,
  pending,
  label,
  testId,
  onToggle,
}: {
  checked: boolean;
  pending: boolean;
  /** 可访问名（例如「/issue-format（acme/widgets）启用状态」）。 */
  label: string;
  testId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={pending}
      data-testid={testId}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-[background-color] duration-[var(--dur-fast)] ease-out-quint',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        checked ? 'bg-success' : 'bg-neutral/50',
        pending && 'opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block size-3 rounded-full bg-card shadow-sm transition-transform duration-[var(--dur-fast)] ease-out-quint',
          checked ? 'translate-x-[13px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
