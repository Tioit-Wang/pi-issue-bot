import { Switch } from '../ui/switch.tsx';

/**
 * 技能启用开关（项目技能页与技能详情共用）。
 *
 * 为什么不是 `ui/` 里的通用控件：这一枚开关的语义是「这条技能参不参与运行时解析」，
 * 写操作由父级发 `PATCH`（服务端是唯一事实源），所以它只负责「画 + 报状态」。
 *
 * 现在它只是官方 `Switch` 的**语义包装**：`role="switch"` / `aria-checked` /
 * 键盘空格 / 焦点环都由 Radix 承担，本组件只补两件产品语义 ——
 * 可访问名（`label`：读屏要听出是哪个技能、哪个作用域）与 pending 时禁点。
 */
export function EnabledSwitch({
  checked,
  pending,
  label,
  testId,
  onToggle,
}: {
  checked: boolean;
  pending: boolean;
  /** 可访问名（例如「/issue-format（acme/widgets）启用状态」）。 */
  label: string;
  testId: string;
  onToggle: () => void;
}) {
  return (
    <Switch
      checked={checked}
      disabled={pending}
      aria-label={label}
      aria-busy={pending}
      data-testid={testId}
      onCheckedChange={() => {
        onToggle();
      }}
    />
  );
}
