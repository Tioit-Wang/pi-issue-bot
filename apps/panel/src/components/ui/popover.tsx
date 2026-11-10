import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 锚定浮层的公共机制（`Popover` 与 `DropdownMenu` 共用，别各写一遍）。
 *
 * 行为契约：
 * - 触发器带 `aria-haspopup` + `aria-expanded` + `aria-controls`；
 * - 点面板外关闭（用 `pointerdown`，比 click 早一步，避免误触发下层的按钮）；
 * - `Esc` 关闭，并把焦点**还给**触发器；
 * - 打开时把焦点交给 `[data-autofocus]`，否则面板里第一个可聚焦元素。
 */
export function usePanel() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const preferred =
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.querySelector<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])');
    preferred?.focus();
  }, [open]);

  return { open, setOpen, close, rootRef, panelRef, triggerRef, panelId };
}

export type PopoverProps = {
  /** 触发器内容。 */
  label: ReactNode;
  triggerClassName?: string;
  /** 触发器只有图标时必须给（读屏文案）。 */
  triggerLabel?: string;
  panelClassName?: string;
  /** 面板语义：菜单用 `menu`，纯内容面板不传。 */
  role?: 'menu' | 'dialog';
  /** 面板上的键盘处理（菜单方向键等）。 */
  onPanelKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  placement?: 'bottom-start' | 'bottom-end';
  testId?: string;
  children: (close: (restoreFocus?: boolean) => void) => ReactNode;
};

/** 触发器 + 锚定面板（下拉、菜单、筛选器的底座）。 */
export function Popover({
  label,
  triggerClassName,
  triggerLabel,
  panelClassName,
  role,
  onPanelKeyDown,
  placement = 'bottom-start',
  testId,
  children,
}: PopoverProps) {
  const { open, setOpen, close, rootRef, panelRef, triggerRef, panelId } = usePanel();

  return (
    <div className="relative min-w-0" ref={rootRef} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup={role === 'menu' ? 'menu' : 'dialog'}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        {...(triggerLabel === undefined ? {} : { 'aria-label': triggerLabel })}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-left text-sm',
          'transition-[background-color,border-color] duration-[120ms] ease-out-quint',
          'hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          triggerClassName,
        )}
      >
        {label}
      </button>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          {...(role === undefined ? {} : { role })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
              return;
            }
            onPanelKeyDown?.(event);
          }}
          className={cn(
            'animate-pop-in absolute z-30 mt-1 flex max-h-96 flex-col overflow-hidden rounded-md',
            'border border-border bg-card shadow-overlay',
            placement === 'bottom-start' ? 'left-0' : 'right-0',
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}