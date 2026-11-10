import { useSyncExternalStore } from 'react';

/**
 * 主题：**双通道**。
 *
 * - 默认 `system`：不写 `data-theme`，由 CSS 的 `@media (prefers-color-scheme: dark)` 接管；
 * - `light` / `dark`：在 `<html>` 上写 `data-theme="light|dark"`，覆盖系统偏好；
 * - 记忆：`localStorage['pi-panel:theme']`；读不出来（隐私模式）就退回 `system`。
 *
 * 为什么是模块级 store 而不是 Context：`ThemeToggle` 在顶栏、`AppLayout` 在路由树里，
 * 而测试会单独渲染页面（没有 Provider）。模块级 store 让「没有 Provider 也能工作」成立。
 */
export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'pi-panel:theme';

const listeners = new Set<() => void>();

function isMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readStored(): ThemeMode {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isMode(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

let mode: ThemeMode = readStored();

function systemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 把当前模式写到 `<html data-theme>`（`system` 时删掉属性，交回媒体查询）。 */
function apply(next: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (next === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', next);
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** 切换 / 设置主题模式（写存储 + 立即生效）。 */
export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 存储不可用：本次会话仍然生效，只是刷新后回到跟随系统
  }
  apply(next);
  emit();
}

/** `system → light → dark → system`（顶栏按钮按这个顺序循环）。 */
export function cycleThemeMode(): ThemeMode {
  const order: readonly ThemeMode[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(mode) + 1) % order.length] ?? 'system';
  setThemeMode(next);
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      emit();
    };
    media.addEventListener('change', onChange);
    return () => {
      listeners.delete(listener);
      media.removeEventListener('change', onChange);
    };
  }
  return () => {
    listeners.delete(listener);
  };
}

/** 当前模式（`system` / `light` / `dark`）。 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    subscribe,
    () => mode,
    () => 'system' as ThemeMode,
  );
}

/** 解析后的实际主题（顶栏图标、图表配色需要它）。 */
export function useResolvedTheme(): ResolvedTheme {
  const current = useThemeMode();
  if (current !== 'system') return current;
  return systemDark() ? 'dark' : 'light';
}

// 模块加载时应用一次：避免首帧闪一下浅色（有 `data-theme=dark` 时更明显）
apply(mode);