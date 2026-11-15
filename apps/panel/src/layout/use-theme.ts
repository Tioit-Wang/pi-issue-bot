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

/**
 * 把当前模式写到 `<html>`：`data-theme` 给本项目的令牌层，`class="dark"` 给 shadcn 官方组件。
 *
 * 为什么两个都要写：官方组件的深色修正走 Tailwind 的 `dark:` 变体，而 `dark:` 在本底座里被
 * 定义成 `.dark` 祖先（`index.css` 的 `@custom-variant dark (&:is(.dark *))`）。只写
 * `data-theme` 的话，36 个官方组件里所有 `dark:` 类（输入框底、页签激活态、开关轨道…）
 * 在深色下全部失效，而本项目自己的令牌（`[data-theme='dark']` 选择器）却生效 ——
 * 结果是「一半深色」。所以两个通道必须一起翻。
 *
 * `system` 模式不写 `data-theme`（交回 `prefers-color-scheme` 媒体查询），但仍然按解析结果
 * 翻 `.dark`：`dark:` 变体没有「跟随系统」这条通道。
 */
function apply(next: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (next === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', next);
  const dark = next === 'system' ? systemDark() : next === 'dark';
  root.classList.toggle('dark', dark);
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
      // 系统偏好变了：`system` 模式下要重新翻一次 `.dark`，否则只有本项目令牌跟着变，
      // 官方组件的 `dark:` 类还停在旧值（同一屏两种深色）。
      apply(mode);
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