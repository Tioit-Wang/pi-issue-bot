import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.ts';

/**
 * 对话框与右侧抽屉：**同一套焦点管理**，只是外壳不同。
 *
 * 为什么不用原生 `<dialog>` / `popover`：`showModal()` 在 jsdom 里不全、也无法精细控制
 * 入场动效；这里用 `createPortal` + 手写焦点陷阱，行为在两个环境里完全一致。
 *
 * 焦点约定（三件事，缺一都会让键盘用户卡住）：
 * 1. 打开时把焦点交给 `[data-autofocus]`，否则面板里第一个可聚焦元素；
 * 2. `Tab` / `Shift+Tab` 在面板内循环（首尾相接）；
 * 3. `Esc` 关闭，关闭后焦点**还给**打开它的那个元素。
 *
 * 其余：`aria-modal="true"` + `aria-labelledby/description`；背景点击关闭；
 * 打开时锁住 body 滚动。浮层是全站唯一允许用阴影的地方。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type ShellProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** 标题下的一句话说明（读屏也会读）。 */
  description?: ReactNode;
  children: ReactNode;
  /** 底部动作条（通常是 取消 + 主操作）。 */
  footer?: ReactNode;
  /** `data-testid` 前缀：`${testId}-panel` / `-overlay`。 */
  testId?: string;
};

/** 模态焦点管理：对话框、抽屉与命令面板共用（不各写一遍）。 */
export function useModalFocus(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    // 记住「来路」：打开前焦点在面板外的哪个元素上（关闭时还给它）。
    // 面板内的元素不算来路（否则会还给自己，焦点就丢了）。
    const active = document.activeElement;
    if (active instanceof HTMLElement && panel?.contains(active) !== true) {
      restoreRef.current = active;
    }
    const preferred =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (preferred ?? panel)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus();
    };
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (panel === null) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return { panelRef, onKeyDown };
}

export type DialogProps = ShellProps & {
  size?: 'sm' | 'md' | 'lg';
};

/** 居中对话框（确认、表单、技术细节）。 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  testId,
}: DialogProps) {
  const { panelRef, onKeyDown } = useModalFocus(open, onClose);
  const titleId = useId();
  const descriptionId = useId();
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={onKeyDown}
      data-testid={testId === undefined ? undefined : `${testId}-overlay`}
    >
      <button
        type="button"
        aria-label="关闭对话框"
        tabIndex={-1}
        onClick={onClose}
        className="animate-fade-in absolute inset-0 cursor-default bg-foreground/25"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        data-testid={testId === undefined ? 'dialog' : `${testId}-panel`}
        className={cn(
          'animate-pop-in relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl',
          'border border-border bg-card text-card-foreground shadow-overlay focus-visible:outline-none',
          size === 'sm' && 'max-w-sm',
          size === 'md' && 'max-w-lg',
          size === 'lg' && 'max-w-3xl',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <CloseButton onClose={onClose} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer === undefined ? null : (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

export type SheetProps = ShellProps & {
  /** 抽屉宽度档（右侧滑出）。 */
  width?: 'sm' | 'md' | 'lg';
};

/** 右侧抽屉：用于「不离开当前页面的次级任务」（预览、筛选、事件详情）。 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md',
  testId,
}: SheetProps) {
  const { panelRef, onKeyDown } = useModalFocus(open, onClose);
  const titleId = useId();
  const descriptionId = useId();
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onKeyDown={onKeyDown}
      data-testid={testId === undefined ? undefined : `${testId}-overlay`}
    >
      <button
        type="button"
        aria-label="关闭抽屉"
        tabIndex={-1}
        onClick={onClose}
        className="animate-fade-in absolute inset-0 cursor-default bg-foreground/20"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        data-testid={testId === undefined ? 'sheet' : `${testId}-panel`}
        className={cn(
          'animate-slide-in-right relative z-10 flex h-full w-full flex-col border-l border-border bg-card',
          'text-card-foreground shadow-overlay focus-visible:outline-none',
          width === 'sm' && 'max-w-sm',
          width === 'md' && 'max-w-md',
          width === 'lg' && 'max-w-2xl',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <CloseButton onClose={onClose} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer === undefined ? null : (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="关闭"
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground',
        'transition-colors duration-[120ms] ease-out-quint hover:bg-muted hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
      )}
    >
      <span aria-hidden className="text-sm leading-none">
        ✕
      </span>
    </button>
  );
}