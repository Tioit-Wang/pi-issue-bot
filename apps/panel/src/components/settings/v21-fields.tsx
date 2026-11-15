/**
 * v2.1 设置分区的**局部**表单零件：多选（复选框组）。
 *
 * 为什么单独一个文件而不是加进 `form.tsx`：`form.tsx` 拆 `Segmented` 与
 * `ChipEditor` 之外的通用原语里**没有**多选，而 v2.1 的三个分区一共要用三处
 * （`issues.labeled` 的触发标签、评论闸门的 `allow_roles`、角色的作者关联七选）。
 * 放回 `form.tsx` 会让通用装配层多出一个只有 v2.1 用的控件。
 *
 * 用的是官方 `Field` + `Checkbox` + `FieldLabel`（每一项都是「方框 + 可点标签」），
 * 外面那层 `Field` 承担 `role="group"` / `aria-disabled` / `data-disabled`，
 * 所以禁用态读屏与测试都看得到（不是只把不透明度调低）。
 *
 * 为什么是复选框组而不是 `ui/select.tsx`：三处候选都是**少而固定**的集合（最多 50 个），
 * 复选框让「现在选了哪几个」一眼可见，而 Radix 下拉在窄屏上点开一次只能看一屏。
 */
import { cn } from '../../lib/utils.ts';
import { Checkbox } from '../ui/checkbox.tsx';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../ui/field.tsx';

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
    <Field data-testid={testId ?? id} data-invalid={error === null ? undefined : true} className="min-w-0">
      <FieldLabel id={`${id}-label`} className="text-xs font-medium text-muted-foreground">
        {label}
      </FieldLabel>

      {/*
        `role="group"` / `data-disabled` 挂在这一层（而不是外面那个 `Field`）：
        外层本身就是 group，`within(容器).getByRole('group')` 只查后代，
        所以「这一组现在是不是禁用」必须落在一个**可被指到的内层**上。
      */}
      <FieldGroup
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        aria-disabled={disabled ? true : undefined}
        data-disabled={disabled ? 'true' : 'false'}
        className={cn(
          'gap-x-3 gap-y-1 rounded-md border border-border px-2 py-1.5',
          columns === 1 ? 'flex-col gap-y-1' : 'flex-row flex-wrap',
          disabled && 'opacity-60',
        )}
      >
        {options.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{emptyText}</p>
        ) : (
          options.map((option, index) => {
            const optionId = `${id}-opt-${String(index)}`;
            return (
              <Field
                key={option.value}
                orientation="horizontal"
                className="w-auto items-center gap-1.5"
                title={disabled ? (disabledReason ?? '不可修改') : option.title}
              >
                <Checkbox
                  id={optionId}
                  value={option.value}
                  checked={values.includes(option.value)}
                  disabled={disabled}
                  aria-invalid={error === null ? undefined : true}
                  onCheckedChange={(checked) => {
                    toggle(option.value, checked === true);
                  }}
                />
                <FieldLabel
                  htmlFor={optionId}
                  className={cn('text-xs font-normal', option.label === undefined && 'font-mono')}
                >
                  {option.label ?? option.value}
                </FieldLabel>
              </Field>
            );
          })
        )}
      </FieldGroup>

      {error === null ? null : <FieldError id={`${id}-error`}>{error}</FieldError>}
      {hint === undefined ? null : <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
    </Field>
  );
}
