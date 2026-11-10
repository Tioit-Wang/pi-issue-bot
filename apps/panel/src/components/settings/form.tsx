/**
 * 设置页（W3-I）的表单原语。
 *
 * 为什么单独一组、而不是直接用 `components/ui/*`：设置页是**唯一**大量出现的密集表单
 * （其余页面是只读表格），需要的东西恰好是 shadcn 原语里没有的：
 *  - `label` 与控件的 `htmlFor`/`id` 必须成对生成（方案里要求「label 与控件关联」，
 *    手写 30 个 `id` 一定会漏），所以每个控件自带 `Field` 外壳；
 *  - 错误与提示用 `aria-describedby` 一起挂到控件上，错误在 `aria-live` 区域里播报；
 *  - 禁用态一律带 `title`，说明「为什么不能改」而不是让人对着灰按钮猜。
 *
 * 视觉沿用现有令牌（`--radius`、`--border`、`--ring`、11/12px 字号），不新造颜色：
 * 开关、分段控件的选中态用 `bg-card` + 细边框，与左栏导航的选中态同一套读法。
 * 动效只保留 `transition-colors`（状态色变化），没有位移/缩放，`motion-reduce` 下无需额外分支。
 */
import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

/** 输入控件的基础类：与 `components/ui/select.tsx` 的 12px 密度对齐（设置页比列表更密）。 */
export const controlClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm text-foreground outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger';

/** 一段「标签 + 控件 + 提示/错误」的组合容器（不直接使用，见下面各个 `*Field`）。 */
function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {error === null || error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-danger-fg" role="alert">
          {error}
        </p>
      )}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** 控件要挂的 `aria-describedby`（提示 + 错误，可能都有）。 */
function describedBy(id: string, hint?: string, error?: string | null): string | undefined {
  const ids: string[] = [];
  if (error !== null && error !== undefined) ids.push(`${id}-error`);
  if (hint !== undefined) ids.push(`${id}-hint`);
  return ids.length === 0 ? undefined : ids.join(' ');
}

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  mono = false,
  disabled = false,
  disabledReason,
  onBlur,
  onEnter,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** 失焦提交（改名类输入用：逐键提交会把中间态写进 settings）。 */
  onBlur?: () => void;
  /** 回车提交（与失焦同一件事，键盘用户的等价动作）。 */
  onEnter?: () => void;
  type?: 'text' | 'url';
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        type={type}
        className={cn(controlClass, mono && 'font-mono')}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || onEnter === undefined) return;
          event.preventDefault();
          onEnter();
        }}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

/**
 * 数字输入。空串 = `undefined`（可选字段），非法输入不写进状态但保留在输入框里
 * （受控值回落成空会让「想输 10 却先输 1」变得不可用）。
 */
export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  hint,
  error,
  disabled = false,
  disabledReason,
}: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  min: number;
  max: number;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const [seen, setSeen] = useState(value);
  // 外部值变了（撤销改动 / 服务端回写）时同步一次：不在 render 里 setState
  if (seen !== value) {
    setSeen(value);
    setText(value === undefined ? '' : String(value));
  }

  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        className={cn(controlClass, 'font-mono')}
        value={text}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw.trim() === '') {
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </Field>
  );
}

/** 真 `<textarea>`（等宽可选），行数由调用方给，避免每处手写 rows。 */
export function TextAreaField({
  id,
  label,
  value,
  onChange,
  rows = 6,
  hint,
  error,
  placeholder,
  mono = false,
  disabled = false,
  disabledReason,
  footer,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  footer?: ReactNode;
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        spellCheck={false}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(
          controlClass,
          'h-auto resize-y py-1.5 leading-relaxed break-words',
          mono && 'font-mono text-xs',
        )}
      />
      {footer}
    </Field>
  );
}

/**
 * 开关（`role="switch"`，不是纯 CSS 假开关）：键盘可聚焦、状态进 `aria-checked`。
 * 标签与说明在左侧，用 `aria-labelledby` / `aria-describedby` 关联到按钮上。
 */
export function SwitchField({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
  disabledReason,
  pending = false,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm font-medium text-foreground">
          {label}
        </p>
        {description === undefined ? null : (
          <p id={`${id}-description`} className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description === undefined ? undefined : `${id}-description`}
        disabled={disabled || pending}
        title={disabled ? disabledReason : undefined}
        onClick={() => {
          onChange(!checked);
        }}
        className={cn(
          'relative mt-0.5 inline-flex h-4 w-[26px] shrink-0 items-center rounded-full transition-colors',
          'focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          checked ? 'bg-success' : 'bg-neutral/50',
          (disabled || pending) && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'block size-3 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[11px]' : 'translate-x-[2px]',
          )}
        />
      </button>
    </div>
  );
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** 悬浮说明（`title`）：三态的含义写在这里，不占版面。 */
  title?: string;
};

/** 分段单选（原生 `radio` 藏在 label 里 → 方向键/空格/Tab 全部免费拿到）。 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  disabledReason,
}: {
  name: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex shrink-0 rounded-md border border-border bg-muted p-px', disabled && 'opacity-60')}
    >
      {options.map((option) => (
        <label
          key={option.value}
          title={disabled ? disabledReason : option.title}
          className={cn(
            'cursor-pointer rounded-[5px] px-2 py-0.5 text-xs whitespace-nowrap transition-colors',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand',
            option.value === value
              ? 'bg-card font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
            disabled && 'cursor-not-allowed',
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={disabled}
            onChange={() => {
              onChange(option.value);
            }}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/**
 * 字符串列表编辑器（别名 / 触发人名单 / 标签白名单共用）。
 *
 * 规则统一在这里：输入先交给 `accept()`（归一化 + 校验 + 去重），返回错误就贴在输入框下，
 * 成功就追加到列表末尾并清空输入。回车与「添加」按钮等价（键盘用户不必去够鼠标）。
 */
export function ChipEditor({
  id,
  label,
  values,
  onChange,
  accept,
  placeholder,
  hint,
  disabled = false,
  disabledReason,
  emptyText = '（空）',
  mono = true,
}: {
  id: string;
  label: string;
  values: readonly string[];
  onChange: (next: string[]) => void;
  /** 返回 `{ value }` 表示可加入，返回 `{ error }` 表示拒绝（归一化也在这里做）。 */
  accept: (raw: string) => { value: string } | { error: string };
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
  emptyText?: string;
  mono?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (): void => {
    const raw = text.trim();
    if (raw === '') return;
    const result = accept(raw);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setText('');
    if (!values.includes(result.value)) onChange([...values, result.value]);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>

      <ul className="flex min-h-6 flex-wrap items-center gap-1" data-testid={`${id}-chips`}>
        {values.length === 0 ? <li className="text-xs text-muted-foreground">{emptyText}</li> : null}
        {values.map((entry) => (
          <li key={entry}>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground',
                mono && 'font-mono',
              )}
            >
              {entry}
              <button
                type="button"
                aria-label={`移除 ${entry}`}
                disabled={disabled}
                title={disabled ? disabledReason : `移除 ${entry}`}
                onClick={() => {
                  onChange(values.filter((candidate) => candidate !== entry));
                }}
                className="rounded-full px-0.5 text-muted-foreground transition-colors hover:text-danger-fg focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-1">
        <input
          id={id}
          type="text"
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          title={disabled ? disabledReason : undefined}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? (hint === undefined ? undefined : `${id}-hint`) : `${id}-error`}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // 提交型回车：不要触发外层 form / 默认行为
            event.preventDefault();
            commit();
          }}
          className={cn(controlClass, 'max-w-56', mono && 'font-mono')}
        />
        <button
          type="button"
          onClick={commit}
          disabled={disabled || text.trim() === ''}
          title={disabled ? disabledReason : '加入列表（回车同效）'}
          className="h-8 shrink-0 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          添加
        </button>
      </div>

      <div aria-live="polite">
        {error === null ? null : (
          <p id={`${id}-error`} className="text-xs text-danger-fg" role="alert">
            {error}
          </p>
        )}
        {hint === undefined ? null : (
          <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

/** 一行说明（键 → 值），设置页里用来展示「只读元数据」。 */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-sm">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-foreground">{children}</span>
    </div>
  );
}
