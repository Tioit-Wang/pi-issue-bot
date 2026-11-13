/**
 * `triggers` 分区：别名 / **命中预览**。
 *
 * v0.3 的触发体系只剩 `aliases`（`enabled` / `users` / `merge_defaults` / `remove` 全删，
 * 「谁能 @」改由 `settings.agent.managers` 判）。事件面（`issues.opened` / `edited`）由代码固定，
 * 不再是项目配置项，所以这里只留「别名」一段可写配置 + 一个不写配置的预览。
 *
 * 命中预览是这个分区存在的理由：线上「@ 了但没触发」的排查成本极高（要看 webhook 投递、
 * 别名合并、代码区蒙版三层），所以这里把三层摊开，并用 tone 表达结论而不是一段纯文本。
 *
 * 判定不另写：别名合并与正文解析都用 `packages/contract/src/trigger.ts`（webhook 同一份）。
 */
import { useState } from 'react';
import { DEFAULT_TRIGGER_ALIASES } from '../../../../../packages/contract/src/index.ts';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { cn } from '../../lib/utils.ts';
import { ChipEditor, TextAreaField } from './form.tsx';
import type { SettingsSectionProps } from './section-props.ts';
import { acceptAlias, previewTrigger, resolveAliasesFor } from './trigger-preview.ts';

const PREVIEW_SAMPLE = '@issuebot /issue-triage 17 --deep';

/**
 * 别名 + 命中预览（原「触发」分区的全部内容）。
 *
 * 在事件绑定设置页里它是**折叠区**：这一页的高度要留给提示词编辑区（需求 3/4），
 * 常驻展开会把编辑区压到只剩两三行。折叠时只占一行，展开后仍按内容高度排，
 * 由外层 `main` 滚动——它不需要参与「编辑区内部滚」那条链。
 */
export function TriggerAdvanced({ state }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const triggers = draft.triggers;
  const effectiveAliases = resolveAliasesFor(triggers);
  const [previewBody, setPreviewBody] = useState(PREVIEW_SAMPLE);
  const [open, setOpen] = useState(false);

  const patchTriggers = (patch: (current: typeof triggers) => typeof triggers): void => {
    state.update((current) => ({ ...current, triggers: patch(current.triggers) }));
  };

  return (
    <details
      /* 受控：折叠态要能由「有没有未保存改动」这类外部原因打开时不用碰 DOM */
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className="shrink-0 rounded-md border border-border"
      data-testid="settings-triggers"
    >
      <summary className="cursor-pointer list-none px-2.5 py-1.5 text-xs text-muted-foreground select-none hover:text-foreground">
        别名与命中预览
        <span className="ml-1.5 text-2xs text-faint">
          （生效别名 {effectiveAliases.length === 0 ? '0 个' : effectiveAliases.map((alias) => `@${alias}`).join(' / ')}）
        </span>
      </summary>

      <div className="flex flex-col gap-3 border-t border-border px-2.5 py-2">
        <div className="flex flex-col gap-2">
          <ChipEditor
            id="triggers-aliases"
            label="额外别名（aliases，1–8 个）"
            values={triggers.aliases ?? []}
            onChange={(next) => {
              // 空数组在契约里非法（min 1）：清空 = 回落到「只用部署默认」
              patchTriggers((current) =>
                next.length === 0 ? { ...current, aliases: undefined } : { ...current, aliases: next },
              );
            }}
            accept={(raw) => acceptAlias(raw, triggers.aliases ?? [])}
            placeholder="@issuebot"
            hint="大小写不敏感，@ 可写可不写；保存时统一小写并去重"
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
            emptyText="（没有额外别名，只用部署默认）"
          />

          <div className="rounded-md bg-muted px-2.5 py-2">
            <p className="text-2xs text-faint">生效别名</p>
            <ul className="mt-1 flex flex-wrap gap-1" data-testid="triggers-effective-aliases">
              {effectiveAliases.length === 0 ? (
                <li className="text-xs text-danger-fg">（空：没有任何别名生效，评论面永远不会被 @ 触发）</li>
              ) : (
                effectiveAliases.map((alias) => (
                  <li key={alias}>
                    <span className="rounded-full bg-card px-2 py-0.5 font-mono text-xs text-foreground">@{alias}</span>
                  </li>
                ))
              )}
            </ul>
            <p className="mt-1 text-2xs text-faint">
              部署默认：{DEFAULT_TRIGGER_ALIASES.map((alias) => `@${alias}`).join(' / ')}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2" data-testid="triggers-preview">
          <TextAreaField
            id="triggers-preview-body"
            label="粘贴一段评论正文"
            value={previewBody}
            onChange={setPreviewBody}
            rows={5}
            mono
            placeholder="例如：@issuebot /issue-triage 17"
            hint="围栏代码块（```）与行内代码（`）里的 @ 不算触发。"
          />
          <PreviewResult body={previewBody} triggers={triggers} />
        </div>
      </div>
    </details>
  );
}

const KIND_LABEL: Record<string, string> = {
  mention: '命中别名（会交给 agent）',
  none: '只 @ 了一下（不建任务）',
};

/** 预览结果：结论 → 命中细节 → 被蒙版挡住的片段（顺序 = 排查顺序），全部用 tone 表达。 */
function PreviewResult({ body, triggers }: { body: string; triggers: SettingsSectionProps['state']['draft']['triggers'] }) {
  const preview = previewTrigger({ body, triggers });
  const { parse } = preview;
  const yes = preview.willTrigger;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-2.5 py-2" aria-live="polite">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge tone={yes ? 'success' : 'neutral'} dot data-testid="trigger-preview-verdict">
          {yes ? '会触发' : '不触发'}
        </Badge>
        <span className="min-w-0 text-xs leading-relaxed text-foreground" data-testid="trigger-preview-reason">
          {preview.reason}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[6.5rem_minmax(0,1fr)]">
        <dt className="text-2xs text-faint">命中别名</dt>
        <dd className={cn('min-w-0 font-mono break-all', parse.alias === null ? 'text-faint' : 'text-brand')} data-testid="trigger-preview-alias">
          {parse.alias === null ? '—（没命中）' : `@${parse.alias}`}
          {preview.hits.length > 1 ? <span className="ml-1 text-2xs text-faint">（另有 {preview.hits.length - 1} 处命中）</span> : null}
        </dd>

        <dt className="text-2xs text-faint">解析结果</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-1" data-testid="trigger-preview-kind">
          <Badge tone={parse.kind === 'none' ? 'neutral' : 'info'}>{KIND_LABEL[parse.kind] ?? parse.kind}</Badge>
          {parse.alias === null ? null : <span className="font-mono text-2xs text-muted-foreground">{`@${parse.alias}`}</span>}
        </dd>

      </dl>

      {preview.codeRegions.length === 0 ? (
        <p className="text-2xs text-faint" data-testid="trigger-preview-code">
          （没有代码区：正文里的 @ 全部参与判定）
        </p>
      ) : (
        <Alert tone="warn" role="status">
          <AlertDescription>
            被代码区蒙版挡住的片段（不算叫人；围栏块与行内代码里的 @ 永远不触发）：
          </AlertDescription>
          <ul className="mt-1 flex flex-col gap-1" data-testid="trigger-preview-code">
            {preview.codeRegions.map((region, index) => (
              <li key={`${String(index)}-${region.slice(0, 12)}`}>
                <pre className="max-h-24 overflow-auto rounded-sm bg-card px-2 py-1 text-2xs break-words whitespace-pre-wrap text-muted-foreground">
                  {region}
                </pre>
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}