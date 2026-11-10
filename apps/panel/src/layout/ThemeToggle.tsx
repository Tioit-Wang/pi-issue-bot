import { Moon, Monitor, Sun } from 'lucide-react';
import { cn } from '../lib/utils.ts';
import { cycleThemeMode, useThemeMode, type ThemeMode } from './use-theme.ts';

/**
 * 主题切换（顶栏右上角）：`跟随系统 → 浅色 → 深色` 三态循环。
 *
 * - `aria-label` 说明「当前是什么、点一下会变成什么」，读屏用户不必猜；
 * - 图标三态区分（显示器 / 太阳 / 月亮），不是同一个图标换色；
 * - 焦点环用全局品牌环，`prefers-reduced-motion` 下没有过渡。
 */
const LABEL: Record<ThemeMode, string> = {
  system: '主题：跟随系统',
  light: '主题：浅色',
  dark: '主题：深色',
};

const NEXT: Record<ThemeMode, string> = {
  system: '浅色',
  light: '深色',
  dark: '跟随系统',
};

export function ThemeToggle({ className }: { className?: string }) {
  const mode = useThemeMode();
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      data-mode={mode}
      aria-label={`${LABEL[mode]}，点击切换到${NEXT[mode]}`}
      title={`${LABEL[mode]} → ${NEXT[mode]}`}
      onClick={() => {
        cycleThemeMode();
      }}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground',
        'transition-colors duration-[120ms] ease-out-quint hover:bg-muted hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        className,
      )}
    >
      <Icon aria-hidden className="size-4" strokeWidth={1.75} />
    </button>
  );
}