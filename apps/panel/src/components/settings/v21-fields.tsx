/**
 * v2.1 设置分区的**局部**表单零件：多选（复选框组）。
 *
 * 为什么单独一个文件而不是加进 `form.tsx`：`form.tsx` 是 W3-I 的通用原语（文本 / 数字 / 文本域 /
 * 开关 / 分段单选 / chip 列表），里面**没有**多选，因为旧分区里根本不需要；而 v2.1 的三个分区
 * 一共要用三处多选（`issues.labeled` 的触发标签、评论闸门的 `allow_roles`、角色的作者关联七选）。
 * 放回 `form.tsx` 会让通用原语多出一个只有 v2.1 用的控件，所以留在 v2.1 自己的目录里。
 *
 * 视觉与 `form.tsx` 一致：`label` 与控件用 `id`/`htmlFor` 成对生成，提示与错误走
 * `aria-describedby`，禁用态一律带 `title` 说明原因；不新造颜色。
 *
 * 为什么是复选框组而不是 `ui/select.tsx`：三处候选都是**少而固定**的集合（最多 50 个），
 * 复选框让「现在选了哪几个」一眼可见，而原生 `<select multiple>` 在窄屏上几乎不可用
 * （需要按住 Ctrl）。所以这里用复选框，选项为空时明确写出「先去哪配候选」。
 */
import { cn } from '../../lib/utils.ts';

/** 一个可勾选项：`value` 是落库值，`label` 是给人看的文案。 */
export type CheckboxOption = {
  value: string;
  /** 展示文案；缺省显示 `value`。 */
  label?: string;
  /** 悬浮说明。 */
  title?: string;
};

export function CheckboxMultiSelect({
  id,
  label,
  values,
  options,
  onChange,
  hint,
  error = null,
  disabled = false,
  disabledReason,
  emptyText = '（没有可选项）',
  testId,
  columns = 2,
}: {
  id: string;
  label: string;
  /** 已选值（顺序 = 用户勾选顺序，不做排序：`allow_roles` 等字段语义上与顺序无关）。 */
  values: readonly string[];
  options: readonly CheckboxOption[];
  /** 勾选 / 取消后的完整值数组。 */
  onChange: (next: string[]) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  disabledReason?: string;
  /** 没有候选时显示的说明（写「先去哪配」而不是只说「空」）。 */
  emptyText?: string;
  testId?: string;
  /** 窄屏列数（宽屏按内容换行，不设上限）。 */
  columns?: 1 | 2;
}) {
  const describedBy = (() => {
    const ids: string[] = [];
    if (error !== null) ids.push(`${id}-error`);
    if (hint !== undefined) ids.push(`${id}-hint`);
    return ids.length === 0 ? undefined : ids.join(' ');
  })();

  const toggle = (value: string, checked: boolean): void => {
    onChange(checked ? [...values, value] : values.filter((candidate) => candidate !== value));
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId ?? id}>
      <span id={`${id}-label`} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>

      <div
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        aria-disabled={disabled ? true : undefined}
        data-disabled={disabled ? 'true' : 'false'}
        className={cn(
          'flex min-w-0 flex-wrap gap-x-3 gap-y-1 rounded-md border border-border px-2 py-1.5',
          disabled && 'opacity-60',
          columns === 1 && 'flex-col gap-y-1',
        )}
      >
        {options.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{emptyText}</p>
        ) : (
          options.map((option, index) => (
            <label
              key={option.value}
              htmlFor={`${id}-opt-${String(index)}`}
              title={disabled ? (disabledReason ?? '不可修改') : option.title}
              className={cn(
                'inline-flex items-center gap-1.5 text-sm text-foreground',
                disabled ? 'cursor-not-allowed' : 'cursor-pointer',
              )}
            >
              <input
                id={`${id}-opt-${String(index)}`}
                type="checkbox"
                value={option.value}
                checked={values.includes(option.value)}
                disabled={disabled}
                aria-invalid={error === null ? undefined : true}
                onChange={(event) => {
                  toggle(option.value, event.target.checked);
                }}
                className="size-3.5 accent-brand disabled:cursor-not-allowed"
              />
              <span className={cn('text-xs', option.label === undefined && 'font-mono')}>{option.label ?? option.value}</span>
            </label>
          ))
        )}
      </div>

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
  );
}
