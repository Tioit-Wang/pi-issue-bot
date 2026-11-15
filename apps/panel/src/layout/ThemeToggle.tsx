import { Moon, Monitor, Sun } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { cycleThemeMode, useThemeMode, type ThemeMode } from './use-theme.ts';

/**
 * 主题切换（侧栏底部）：`跟随系统 → 浅色 → 深色` 三态循环。
 *
 * - `aria-label` 说明「当前是什么、点一下会变成什么」，读屏用户不必猜；
 * - 图标三态区分（显示器 / 太阳 / 月亮），不是同一个图标换色；
 * - 折叠成图标栏（`collapsible="icon"`）时按钮本身就已经只是图标，不需要额外适配。
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
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid="theme-toggle"
      data-mode={mode}
      aria-label={`${LABEL[mode]}，点击切换到${NEXT[mode]}`}
      title={`${LABEL[mode]} → ${NEXT[mode]}`}
      onClick={() => {
        cycleThemeMode();
      }}
      className={className}
    >
      <Icon aria-hidden className="size-4" strokeWidth={1.75} />
    </Button>
  );
}
