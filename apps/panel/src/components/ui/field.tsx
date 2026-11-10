import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 表单字段：`label` + 控件 + 说明 + 错误，四者用 `aria-describedby` / `aria-invalid`
 * 绑在一起（读屏用户 focus 控件时能同时听到说明与错误）。
 *
 * 用法：把控件作为**唯一子节点**传进来，`Field` 负责把 id 与 aria 属性注入进去；
 * 控件需要支持 `id` / `aria-describedby` / `aria-invalid`（原生 input/select/textarea 都行）。
 */
export type FieldProps = {
  label: ReactNode;
  children: ReactElement<{
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }>;
  /** 一句话说明（格式、单位、影响）。 */
  hint?: ReactNode;
  /** 校验失败原因；给了就进入错误态（控件加红框 + `aria-invalid`）。 */
  error?: string | null;
  /** 右侧附加信息（字符计数、当前版本号）。 */
  aside?: ReactNode;
  /** 必填标记（只影响视觉，真正的 `required` 交给控件）。 */
  required?: boolean;
  className?: string;
};

export function Field({ label, children, hint, error, aside, required = false, className }: FieldProps) {
  const autoId = useId();
  const controlId = children.props.id ?? autoId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined || error === null ? null : errorId]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={controlId} className="text-xs font-medium text-foreground">
          {label}
          {required ? (
            <span aria-hidden className="ml-0.5 text-danger">
              *
            </span>
          ) : null}
        </label>
        {aside === undefined ? null : <span className="text-2xs text-faint tabular">{aside}</span>}
      </div>

      {cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error === undefined || error === null ? undefined : true,
      })}

      {hint === undefined ? null : (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p id={errorId} role="alert" className="text-xs leading-relaxed text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}