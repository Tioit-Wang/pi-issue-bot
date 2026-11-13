/**
 * 分区保存条（吸底）：回答三件事 —— **改了什么、能不能存、存了没有**。
 *
 * 四态齐在一次：
 *  - `idle`：没有改动 → 按钮 `disabled` 且 `title` 写明原因（不是「灰着让人猜」）；
 *  - `saving`：`aria-busy` + 文案变「保存中…」，宽度不变；
 *  - `saved`：`role="status"` 播报，不自作多情地弹 toast；
 *  - `error`：`role="alert"` + 字段路径清单（`details.issues`）+ 预算数字。
 *
 * 为什么吸底（`sticky bottom-0`）：设置页一屏能塞下 5~8 组字段，保存按钮如果跟在最后，
 * 改到第 2 组时它就滚出视野了；吸底让它始终在拇指/视线落点，同时不遮挡内容（背景 95% + blur）。
 */
import { Button } from '../ui/button.tsx';
import { cn } from '../../lib/utils.ts';
import type { SaveIssue, WriteFailure } from './failures.ts';
import type { SaveStatus } from './use-settings-draft.ts';
import { formatCount } from '../../lib/format.ts';

/** 字段路径 + 原因（路径等宽显示：`labels.max_per_issue: 不能大于 20`）。 */
export function IssueList({ issues, testId }: { issues: readonly SaveIssue[]; testId?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5" data-testid={testId ?? 'settings-issues'}>
      {issues.map((issue, index) => (
        <li key={`${issue.path ?? 'issue'}-${String(index)}`} className="text-xs leading-relaxed">
          {issue.path === null ? null : (
            <code className="mr-1 rounded-xs bg-foreground/10 px-1 py-px text-2xs">{issue.path}</code>
          )}
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function SaveBar({
  saveLabel,
  dirty,
  status,
  failure,
  readOnly,
  readOnlyReason,
  blockedReason,
  changed,
  budget = null,
  onSave,
  onReset,
  testId = 'settings',
}: {
  saveLabel: string;
  dirty: boolean;
  status: SaveStatus;
  failure: WriteFailure | null;
  readOnly: boolean;
  readOnlyReason?: string;
  /** 表单本身有本地错误时（例如别名为空），保存按钮禁用并说明原因。 */
  blockedReason?: string | null;
  /** 改了哪几项（`countChangedPaths().length`）。 */
  changed: number;
  /** 提示词分区的预算剩余；`null` = 这一区不涉及预算。 */
  budget?: { remaining: number; available: number } | null;
  onSave: () => void;
  onReset: () => void;
  testId?: string;
}) {
  const saving = status === 'saving';
  const disabledReason =
    readOnly
      ? (readOnlyReason ?? '仓库已归档：只读')
      : blockedReason !== undefined && blockedReason !== null
        ? blockedReason
        : !dirty
          ? '没有未保存的改动'
          : null;
  const disabled = disabledReason !== null || saving;

  const statusText: string =
    status === 'saving'
      ? '保存中…'
      : status === 'saved'
        ? '已保存：页面显示的是落库后的值'
        : status === 'error'
          ? (failure?.message ?? '保存失败')
          : dirty
            ? '与服务端不一致'
            : '与服务端一致';

  /*
    负外边距（原来的 `-mx-2`）是给「内容有左右内边距」的页面用的，让分隔线贴齐视口边缘；
    但在事件绑定设置页它会比容器宽 8px，配合 `overflow-y:auto` 的 `main` 就是一条横向
    滚动条——与「整页不得出现滚动条」直接冲突。所以这里不再用负外边距。
  */
  return (
    <div
      data-testid={`${testId}-savebar`}
      className="sticky bottom-0 z-10 mt-1 flex min-w-0 flex-col gap-1.5 border-t border-border bg-background/95 pt-2 pb-2 backdrop-blur"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <Button
          size="sm"
          onClick={onSave}
          disabled={disabled}
          aria-busy={saving}
          title={disabledReason ?? `${saveLabel}（写入 repos.settings）`}
          data-testid={`${testId}-save`}
        >
          {saving ? '保存中…' : saveLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={!dirty || saving}
          title={dirty ? '丢弃本地改动，回到服务端那一份' : '没有改动可撤销'}
          data-testid={`${testId}-reset`}
        >
          放弃改动
        </Button>

        <span
          role="status"
          aria-live="polite"
          data-testid={`${testId}-save-status`}
          className={cn(
            'text-xs',
            status === 'error' && 'font-medium text-danger-fg',
            status === 'saved' && 'text-success-fg',
            status === 'saving' && 'text-muted-foreground',
            status === 'idle' && (dirty ? 'text-warn-fg' : 'text-faint'),
          )}
        >
          {statusText}
        </span>

        <span className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {dirty ? (
            <span className="text-xs text-muted-foreground" data-testid={`${testId}-changed`}>
              改了 {formatCount(changed)} 项
            </span>
          ) : null}
          {budget === null ? null : (
            <span
              className={cn('tabular text-xs', budget.remaining < 0 ? 'font-medium text-danger-fg' : 'text-muted-foreground')}
              data-testid={`${testId}-budget`}
              title={`P1 可用额度 ${formatCount(budget.available)} 字符（服务端预演）`}
            >
              {budget.remaining < 0
                ? `超出预算 ${formatCount(-budget.remaining)} 字符`
                : `预算剩余 ${formatCount(budget.remaining)} 字符`}
            </span>
          )}
        </span>
      </div>

      <div aria-live="polite">
        {status === 'error' && failure !== null ? (
          <div
            role="alert"
            data-testid={`${testId}-save-error`}
            className="rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs text-danger-fg"
          >
            <p className="font-medium">{failure.message}</p>
            <IssueList issues={failure.issues} testId={`${testId}-save-issues`} />
            {failure.budget === null ? null : (
              <p className="mt-1 text-2xs">
                预算：可用 {formatCount(failure.budget.available)} 字符 / 请求 {formatCount(failure.budget.requested)} 字符
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}