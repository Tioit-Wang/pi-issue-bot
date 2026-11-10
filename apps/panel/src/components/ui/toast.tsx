import { useEffect, useSyncExternalStore } from 'react';
import { cn } from '../../lib/utils.ts';
import { TONE_BORDER, TONE_SURFACE, TONE_TEXT, type Tone } from './status.ts';

/**
 * 轻量提示条（Toast）：右下角，**最多 3 条**，可手动关闭，6s 自动消失。
 *
 * 为什么是模块级 store 而不是 Context Provider：`useToast()` 在页面深处被调用，
 * 测试里页面常常脱离外壳单独渲染（`renderWithProviders(<SystemPage />)`）；
 * 模块级 store 让「没有 Toaster 也不会抛错」成为默认行为，少一层必挂的 Provider。
 *
 * 无障碍：容器 `role="status"` + `aria-live="polite"`（不打断读屏当前朗读）；
 * 容器 `pointer-events-none`、单条 `pointer-events-auto` —— 不会挡住主操作；
 * 入场用 160ms 位移+淡入，reduced-motion 下由全局规则归零。
 *
 * 演示数据注意：提示内容永远来自真实动作结果，不要用它展示 fixture。
 */
export type ToastTone = Extract<Tone, 'info' | 'success' | 'warn' | 'danger'>;

export type ToastItem = {
  id: number;
  tone: ToastTone;
  title: string;
  /** 第二行：一句话说明（原因、数量）。 */
  description?: string;
};

const LIMIT = 3;
const LIFETIME = 6000;

let items: readonly ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setItems(next: readonly ToastItem[]): void {
  items = next.slice(-LIMIT);
  emit();
}

/** 推一条提示；超过 3 条时挤掉最旧的一条。 */
export function pushToast(toast: Omit<ToastItem, 'id'>): number {
  seq += 1;
  const id = seq;
  setItems([...items, { ...toast, id }]);
  return id;
}

/** 手动关闭 / 自动过期。 */
export function dismissToast(id: number): void {
  if (!items.some((item) => item.id === id)) return;
  setItems(items.filter((item) => item.id !== id));
}

/** 只给测试用：清空提示队列。 */
export function clearToasts(): void {
  setItems([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly ToastItem[] {
  return items;
}

const EMPTY: readonly ToastItem[] = [];

/** 当前提示列表（没有 Toaster 时也能读）。 */
export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** 页面里唯一的用法：`const toast = useToast(); toast.push({ tone: 'success', title: '已保存' })`。 */
export function useToast() {
  return {
    push: pushToast,
    dismiss: dismissToast,
  };
}

/** 右下角的提示容器（`AppLayout` 挂一处即可）。 */
export function Toaster() {
  const list = useToasts();

  useEffect(() => {
    if (list.length === 0) return;
    const timers = list.map((item) =>
      setTimeout(() => {
        dismissToast(item.id);
      }, LIFETIME),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [list]);

  if (list.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toaster"
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-72 flex-col gap-2"
    >
      {list.map((item) => (
        <div
          key={item.id}
          data-tone={item.tone}
          className={cn(
            'animate-slide-in-right pointer-events-auto flex items-start gap-2 rounded-md border border-border',
            'border-l-2 px-2.5 py-2 text-xs shadow-overlay',
            TONE_BORDER[item.tone],
            TONE_SURFACE[item.tone],
            TONE_TEXT[item.tone],
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">{item.title}</p>
            {item.description === undefined ? null : (
              <p className="mt-0.5 leading-relaxed opacity-90">{item.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              dismissToast(item.id);
            }}
            aria-label="关闭提示"
            className="-mt-0.5 shrink-0 rounded-sm px-1 text-xs opacity-70 transition-opacity duration-[120ms] hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}