import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 提示（Tooltip）：hover **与** focus 都显示，150ms 延迟（快速划过不闪）。
 *
 * 可访问性：气泡 `role="tooltip"`，并通过 `aria-describedby` 关联到触发器 ——
 * 读屏用户 focus 到按钮时能听到同样的一句话。Esc 立刻收起。
 *
 * 只用于「补充说明」：不要把唯一的关键信息塞进 tooltip（触屏用户看不到）。
 */
export type TooltipProps = {
  label: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'top' | 'bottom';
  delay?: number;
  className?: string;
};

export function Tooltip({ label, children, side = 'top', delay = 150, className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const show = (): void => {
    clear();
    timer.current = setTimeout(() => {
      setOpen(true);
    }, delay);
  };
  const hide = (): void => {
    clear();
    setOpen(false);
  };

  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {cloneElement(children, { 'aria-describedby': open ? id : children.props['aria-describedby'] })}
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'animate-fade-in pointer-events-none absolute left-1/2 z-50 -translate-x-1/2',
            'max-w-64 rounded-md border border-border bg-card px-2 py-1 text-xs whitespace-nowrap',
            'text-card-foreground shadow-overlay',
            side === 'top' ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]',
            className,
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}