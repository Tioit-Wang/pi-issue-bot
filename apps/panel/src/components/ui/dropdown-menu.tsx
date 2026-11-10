import {
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/utils.ts';
import { Popover } from './popover.tsx';

/**
 * 下拉菜单（`Popover` + 菜单键盘语义）。
 *
 * 键盘：`↑` / `↓` / `Home` / `End` 在项之间移动并循环；输入可打印字符做 **typeahead**
 * （跳到以该字开头的第一个项，1s 内连续输入拼成一个前缀）；`Esc` 关闭并把焦点还给触发器；
 * 点面板外关闭。原生 `Tab` 仍然可用（不做焦点陷阱：菜单不是模态）。
 *
 * 为什么不是 radix：本仓库不允许新增依赖（见 `select.tsx` 同一说明）。
 */
const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]),a[href],button:not([disabled]),input:not([disabled])';

export type DropdownMenuProps = {
  /** 触发器内容（图标 + 文本由调用方决定）。 */
  label: ReactNode;
  triggerClassName?: string;
  panelClassName?: string;
  /** 给 `aria-label`：触发器只有图标时必须给。 */
  triggerLabel?: string;
  placement?: 'bottom-start' | 'bottom-end';
  testId?: string;
  children: (close: (restoreFocus?: boolean) => void) => ReactNode;
};

export function DropdownMenu({
  label,
  triggerClassName,
  panelClassName,
  triggerLabel,
  placement = 'bottom-start',
  testId,
  children,
}: DropdownMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const panel = panelRef.current;
    if (panel === null) return;

    // 焦点在输入框里时**不接管键盘**：面板里可能有搜索框（仓库切换器），
    // 方向键要移动光标、字符要进输入框，不能被 typeahead 抢走。
    const target = event.target as HTMLElement | null;
    if (
      target !== null &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

    if (!keys.includes(event.key) && !printable) return;

    const items = Array.from(panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    if (items.length === 0) return;

    if (printable) {
      const now = Date.now();
      const buffer = now - typed.current.at > 1000 ? event.key : typed.current.text + event.key;
      typed.current = { text: buffer, at: now };
      const needle = buffer.toLowerCase();
      const hit = items.find((item) => (item.textContent ?? '').trim().toLowerCase().startsWith(needle));
      if (hit === undefined) return;
      event.preventDefault();
      hit.focus();
      return;
    }

    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : current <= 0
              ? last
              : current - 1;
    items[next]?.focus();
  };

  return (
    <Popover
      label={label}
      triggerClassName={triggerClassName}
      triggerLabel={triggerLabel}
      panelClassName={panelClassName}
      role="menu"
      placement={placement}
      testId={testId}
      onPanelKeyDown={onKeyDown}
    >
      {(close) => (
        <div ref={panelRef} className="flex min-h-0 flex-1 flex-col" data-menu-panel="">
          {children(close)}
        </div>
      )}
    </Popover>
  );
}

/**
 * 菜单项：统一的行高（28px）、hover 底色与键盘焦点环。
 * 需要 `aria-current` / `data-testid` 时直接透传原生属性。
 */
export function MenuItem({
  className,
  active = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-active={active ? '' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
        'transition-colors duration-[120ms] ease-out-quint',
        'hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand',
        active ? 'bg-brand-soft font-medium text-foreground' : 'text-foreground',
        className,
      )}
      {...props}
    />
  );
}