/**
 * 设置页表单的**装配层**（不是第二套原语）。
 *
 * 这里只做三件事，并且都必须由 `components/ui/*` 的官方组件承担：
 *  1. 把「标签 + 控件 + 说明 + 错误」按官方 `Field` 家族的标准形状拼起来
 *     （`Field` / `FieldLabel` / `FieldDescription` / `FieldError`）；
 *  2. 控件一律用官方 `Input` / `Textarea` / `Switch` / `ToggleGroup` / `Checkbox` / `Button`，
 *     页面里不再出现手写 `border`/`focus-visible` 的控件类名；
 *  3. 保住设置页需要的**行为**：`label` 与控件的 `htmlFor`/`id` 成对生成（30 多个字段手写 id
 *     一定会漏）、提示与错误挂到 `aria-describedby`、禁用态一律带 `title` 说明原因
 *     （不是让人对着灰按钮猜）。
 *
 * 为什么保留这一层而不是让每个分区直接写 `<Field>`：`id` 与 `aria-describedby` 的配对、
 * 数字框的「输入中间态」、文本域占位符的「插入到光标处」都是**跨分区同一条规则**，
 * 复制到 5 个文件就是 5 处真相。所以这一层只转发，不定义颜色与尺寸。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field.tsx';
import { Input } from '../ui/input.tsx';
import { Switch } from '../ui/switch.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.tsx';

/** 控件要挂的 `aria-describedby`（提示 + 错误，可能都有）。 */
function describedBy(id: string, hint?: string, error?: string | null): string | undefined {
  const ids: string[] = [];
  if (error !== null && error !== undefined) ids.push(`${id}-error`);
  if (hint !== undefined) ids.push(`${id}-hint`);
  return ids.length === 0 ? undefined : ids.join(' ');
}

/** 一段「标签 + 控件 + 说明 + 错误」：官方 `Field` 的标准纵向排版。 */
function FieldShell({
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
  const invalid = error !== null && error !== undefined;
  return (
    <Field data-invalid={invalid ? true : undefined} className={cn('min-w-0', className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint === undefined ? null : <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      {invalid ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
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
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(mono && 'font-mono')}
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
    </FieldShell>
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
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className="font-mono"
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
    </FieldShell>
  );
}

/** 一个「点一下插入到光标处」的片段（模板占位符）。 */
export type TextAreaToken = {
  /** 插入到文本里的名字（不带花括号），如 `issue.title`。 */
  readonly name: string;
  /** 悬浮说明：这些名字本身看不出含义，得有一句人话。 */
  readonly description?: string;
};

/**
 * 真 `<textarea>`（等宽可选），行数由调用方给，避免每处手写 rows。
 *
 * `tokens` 是一排快捷插入按钮（模板占位符用）：点击后在**光标处**插入 `{{name}}`
 * 并把光标挪到插入文本之后，可以连续点。为什么不是「追加到末尾」：
 * 改模板时人是在句子中间补占位符的，追加到末尾等于每次都要手工搬位置。
 * 为什么不用 `document.execCommand('insertText')`：它已被废弃，在受控 textarea 上
 * 还会和 React 的 value 覆盖打架；这里改成「自己算出新字符串 → 交给 onChange」，
 * 光标位置在提交后由 effect 恢复（受控值要等 React 提交完才落到 DOM 上）。
 */
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
  tokens,
  fill = false,
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
  /** 快捷插入按钮（模板占位符）。不给就不渲染这一排。 */
  tokens?: readonly TextAreaToken[] | undefined;
  /**
   * 撑满父容器的高度（父级必须是 flex 纵向且给了高度）。
   *
   * 用在「编辑区占满剩余空间、内容多了只在框内滚动」的场景：不撑满的话，
   * textarea 的 rows 固定，页面本身会出现滚动条，而需求要求整页不滚。
   */
  fill?: boolean;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  /** 插入后要落到的光标位置；`null` = 没有待恢复的位置。 */
  const [caret, setCaret] = useState<number | null>(null);

  useEffect(() => {
    if (caret === null) return;
    const element = ref.current;
    setCaret(null);
    if (element === null) return;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [caret]);

  const insertToken = (name: string): void => {
    const element = ref.current;
    const token = `{{${name}}}`;
    /*
      未聚焦过（`selectionStart === null`）时插到末尾：
      那是「还没动过这个框」的情形，末尾就是人接下来要写的地方。
    */
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`);
    setCaret(start + token.length);
  };

  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={cn(fill && 'min-h-0 flex-1')}>
      <Textarea
        id={id}
        ref={ref}
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
          'resize-y leading-relaxed break-words',
          mono && 'font-mono text-xs',
          /*
            `fill` 时高度由 flex 决定（`min-h-0` + `flex-1`），且**框内自己滚**：
            这是「整页不出现滚动条、只有编辑区滚」的落点。
            `resize-none` 是因为拖拽改变高度会把上面的约束打回原形。
          */
          fill && 'min-h-24 flex-1 resize-none overflow-y-auto',
        )}
      />
      {tokens === undefined || tokens.length === 0 ? null : (
        <div
          className="flex flex-wrap items-center gap-1"
          data-testid={`${id}-tokens`}
          role="group"
          aria-label="快捷插入占位符"
        >
          <span className="text-2xs text-faint">插入占位符</span>
          {tokens.map((token) => (
            <Button
              key={token.name}
              type="button"
              variant="outline"
              size="xs"
              disabled={disabled}
              title={disabled ? disabledReason : (token.description ?? token.name)}
              aria-label={`插入占位符 ${token.name}`}
              /* 按下时不抢焦点：否则 textarea 的选区在点击生效前就被清掉了。 */
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                insertToken(token.name);
              }}
              className="font-mono text-2xs"
            >
              {`{{${token.name}}}`}
            </Button>
          ))}
        </div>
      )}
      {footer}
    </FieldShell>
  );
}

/**
 * 开关：官方 `Switch`（Radix，`role="switch"` + `aria-checked`，键盘空格可切）。
 * 名字走 `aria-labelledby` 指向 `FieldLabel`，说明走 `aria-describedby`；
 * 禁用时 `title` 说明原因。
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
  const blocked = disabled || pending;
  return (
    <Field
      orientation="horizontal"
      data-disabled={blocked ? true : undefined}
      className="items-center justify-between gap-3 py-1"
    >
      <div className="min-w-0">
        <FieldLabel id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </FieldLabel>
        {description === undefined ? null : (
          <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={blocked}
        title={disabled ? disabledReason : undefined}
        aria-labelledby={`${id}-label`}
        aria-describedby={description === undefined ? undefined : `${id}-description`}
        onCheckedChange={onChange}
      />
    </Field>
  );
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** 悬浮说明（`title`）：三态的含义写在这里，不占版面。 */
  title?: string;
};

/**
 * 分段单选：官方 `ToggleGroup type="single"`。
 *
 * 为什么是它而不是 `ui/radio-group.tsx`：Radix 的单选组把每个选项画成一个**圆点 + 标签**，
 * 而这一组是「三态小开关条」，要的是「按钮长相 + radio 语义」。Radix 的 single ToggleGroup
 * 正是这个组合（`role="radiogroup"` + 子项 `role="radio"` + `aria-checked`），
 * 键盘方向键与空格都是现成的；自己写 `<input type="radio" class="sr-only">` 才是第二套原语。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  disabledReason,
}: {
  /** 保留字段：调用方仍在传（同一批单选的命名），语义已由 `ariaLabel` 承担。 */
  name: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      variant="outline"
      size="sm"
      className={cn('w-fit shrink-0', disabled && 'opacity-60')}
      onValueChange={(next) => {
        // single 组允许「再点一次取消」，但三态这里没有「空」：取消视为无操作
        if (next === '') return;
        const picked = options.find((option) => option.value === next);
        if (picked !== undefined) onChange(picked.value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          title={disabled ? disabledReason : option.title}
          className="text-xs"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
    <Field data-invalid={error === null ? undefined : true} className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>

      <ul className="flex min-h-6 flex-wrap items-center gap-1" data-testid={`${id}-chips`}>
        {values.length === 0 ? <li className="text-xs text-muted-foreground">{emptyText}</li> : null}
        {values.map((entry) => (
          <li key={entry}>
            <Badge variant="secondary" className={cn('gap-1 pr-0.5', mono && 'font-mono')}>
              {entry}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`移除 ${entry}`}
                disabled={disabled}
                title={disabled ? disabledReason : `移除 ${entry}`}
                onClick={() => {
                  onChange(values.filter((candidate) => candidate !== entry));
                }}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </Badge>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-1">
        <Input
          id={id}
          type="text"
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          title={disabled ? disabledReason : undefined}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={describedBy(id, hint, error)}
          className={cn('max-w-56', mono && 'font-mono')}
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
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={commit}
          disabled={disabled || text.trim() === ''}
          title={disabled ? disabledReason : '加入列表（回车同效）'}
        >
          添加
        </Button>
      </div>

      <div aria-live="polite" className="flex flex-col gap-1">
        {error === null ? null : <FieldError id={`${id}-error`}>{error}</FieldError>}
        {hint === undefined ? null : <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      </div>
    </Field>
  );
}

/** 一行说明（键 → 值），设置页里用来展示「只读元数据」。 */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Field orientation="horizontal" className="items-baseline gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-sm break-all text-foreground">{children}</span>
    </Field>
  );
}
