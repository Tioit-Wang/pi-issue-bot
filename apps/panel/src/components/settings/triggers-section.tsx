/**
 * `triggers` 分区：别名 / 触发人 / 9 个事件面 / **命中预览**。
 *
 * 命中预览是这个分区存在的理由：线上「@ 了但没触发」的排查成本极高（要看 webhook 投递、
 * 别名合并、代码区蒙版三层），所以这里把三层摊开，并用 tone 表达结论而不是一段纯文本：
 * 会 / 不会触发 → 徽章；命中的别名 → 品牌色；被蒙版挡住的片段 → 告警面。
 *
 * 判定不另写：别名合并与正文解析都用 `packages/contract/src/trigger.ts`（webhook 同一份）。
 */
import { useState } from 'react';
import { DEFAULT_TRIGGER_ALIASES, type TriggerFaceMode, type TriggerFaces } from '../../../../../packages/contract/src/index.ts';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { Section } from '../Section.tsx';
import { cn } from '../../lib/utils.ts';
import { ChipEditor, Segmented, SwitchField, TextAreaField } from './form.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';
import { acceptAlias, acceptLogin, previewTrigger, resolveAliasesFor } from './trigger-preview.ts';

const FACE_META: ReadonlyArray<{ key: keyof TriggerFaces; label: string; meaning?: string }> = [
  { key: 'issue_opened', label: 'issue 新建', meaning: '自动 triage，零评论' },
  { key: 'issue_edited', label: 'issue 编辑' },
  { key: 'issue_reopened', label: 'issue 重新打开' },
  { key: 'issue_comment', label: 'issue / PR 评论', meaning: '唯一会产生最终回答的面' },
  { key: 'issue_comment_edited', label: '评论被编辑', meaning: '改错别字重跑 = 重复扣费，默认关' },
  { key: 'pr_review_comment', label: 'PR 行内 review 评论' },
  { key: 'pr_review_submitted', label: 'PR review 总评' },
  { key: 'pr_opened', label: 'PR 打开', meaning: 'PR opened（synchronize 同面）' },
  { key: 'body_mention', label: '正文里的 @', meaning: '正文里 @ 机器人（assign 场景）' },
];

const FACE_MODES: ReadonlyArray<{ value: TriggerFaceMode; label: string; title: string }> = [
  { value: 'off', label: '关', title: 'off：这个面完全不处理（连自动判定都不做）' },
  { value: 'mention', label: '必须 @', title: 'mention：正文里必须 @ 别名才处理' },
  { value: 'auto', label: '自动', title: 'auto：不看 @，事件一到就开工（自动通道 = 打标/判定，不评论）' },
];

const PREVIEW_SAMPLE = '@issuebot /issue-triage 17 --deep';

export function TriggersSection({ state }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const triggers = draft.triggers;
  const effectiveAliases = resolveAliasesFor(triggers);
  const [previewBody, setPreviewBody] = useState(PREVIEW_SAMPLE);
  const changed = countChangedPaths(state.base, draft).length;

  const usersIsEmpty = triggers.users !== 'all' && triggers.users.length === 0;
  const blockedReason = usersIsEmpty
    ? '触发人名单不能为空：要么选「所有人」，要么至少填一个 login（服务端会拒绝空数组）'
    : null;

  const patchTriggers = (patch: (current: typeof triggers) => typeof triggers): void => {
    state.update((current) => ({ ...current, triggers: patch(current.triggers) }));
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-triggers">
      <Section
        first
        title="别名"
        description="大小写不敏感，@ 可写可不写；保存时统一小写并去重"
      >
        <div className="flex flex-col gap-3">
          <SwitchField
            id="triggers-enabled"
            label="触发总开关（triggers.enabled）"
            description="关掉后本仓库任何触发都不生效 —— 包括 issue 新建这类自动面。比逐面关更粗暴，用于临时止血。"
            checked={triggers.enabled}
            onChange={(next) => {
              patchTriggers((current) => ({ ...current, enabled: next }));
            }}
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />

          <ChipEditor
            id="triggers-aliases"
            label="额外别名（aliases，1–8 个）"
            values={triggers.aliases ?? []}
            onChange={(next) => {
              // 空数组在契约里非法（min 1）：清空 = 回落到「只用部署默认」
              patchTriggers((current) => (next.length === 0 ? { ...current, aliases: undefined } : { ...current, aliases: next }));
            }}
            accept={(raw) => acceptAlias(raw, triggers.aliases ?? [])}
            placeholder="@issuebot"
            hint="写 @IssueBot 会存成 issuebot"
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
            emptyText="（没有额外别名，只用部署默认）"
          />

          <SwitchField
            id="triggers-merge-defaults"
            label="与部署默认别名并集（merge_defaults）"
            description="开：生效别名 = 部署默认 ∪ 上面的额外别名。关：只用上面那些（一个都没填时回落部署默认）。"
            checked={triggers.merge_defaults}
            onChange={(next) => {
              patchTriggers((current) => ({ ...current, merge_defaults: next }));
            }}
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />

          <ChipEditor
            id="triggers-remove"
            label="从并集里摘掉（remove，≤ 8 个）"
            values={triggers.remove}
            onChange={(next) => {
              patchTriggers((current) => ({ ...current, remove: next }));
            }}
            accept={(raw) => acceptAlias(raw, triggers.remove)}
            placeholder="@ibot"
            hint="部署默认名撞上真人用户名时用：摘掉后 @ibot 不再触发，但 @issuebot 仍然生效。"
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
            emptyText="（不摘掉任何别名）"
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
      </Section>

      <Section title="触发人" description="只约束提及类触发（@ 别名），不约束自动面">
        <div className="flex flex-col gap-2">
          <Segmented
            name="triggers-users-mode"
            ariaLabel="触发人范围"
            value={triggers.users === 'all' ? 'all' : 'list'}
            options={[
              { value: 'all', label: '所有人', title: 'all：任何人的 @ 都处理（仍受 author_association 与命令门禁约束）' },
              { value: 'list', label: '仅名单', title: '只处理这些 login 的 @（大小写不敏感）' },
            ]}
            onChange={(next) => {
              patchTriggers((current) =>
                next === 'all' ? { ...current, users: 'all' } : { ...current, users: current.users === 'all' ? [] : current.users },
              );
            }}
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />

          {triggers.users === 'all' ? null : (
            <ChipEditor
              id="triggers-users"
              label="login 名单（1–50 个）"
              values={triggers.users}
              onChange={(next) => {
                patchTriggers((current) => ({ ...current, users: next }));
              }}
              accept={(raw) => acceptLogin(raw, triggers.users === 'all' ? [] : triggers.users)}
              placeholder="octocat"
              hint="精确匹配 sender.login（大小写不敏感）。空名单是非法配置，保存会被服务端拒绝。"
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
              emptyText="（空名单 —— 保存会被拒绝，请至少加一个 login）"
            />
          )}
        </div>
      </Section>

      <Section title="事件面（9 个）">
        <div className="flex flex-col divide-y divide-border">
          {FACE_META.map((face) => (
            <div
              key={face.key}
              className="grid grid-cols-1 items-start gap-x-3 gap-y-1 py-1.5 md:grid-cols-[minmax(0,1fr)_auto]"
              data-testid={`triggers-face-${face.key}`}
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground">{face.label}</p>
                {face.meaning === undefined ? null : (
                  <p className="text-xs leading-relaxed text-muted-foreground">{face.meaning}</p>
                )}
              </div>
              <Segmented
                name={`triggers-face-${face.key}`}
                ariaLabel={`${face.label} 的触发方式`}
                value={triggers.faces[face.key]}
                options={FACE_MODES}
                onChange={(next) => {
                  patchTriggers((current) => ({ ...current, faces: { ...current.faces, [face.key]: next } }));
                }}
                disabled={readOnly}
                disabledReason="仓库已归档：只读"
              />
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="命中预览"
        description="跑的是上方草稿，不必先保存"
      >
        <div className="flex flex-col gap-2" data-testid="triggers-preview">
          <TextAreaField
            id="triggers-preview-body"
            label="粘贴一段评论正文"
            value={previewBody}
            onChange={setPreviewBody}
            rows={5}
            mono
            placeholder="例如：@issuebot /issue-triage 17"
            hint="围栏代码块（```）与行内代码（`）里的 @ 不算触发；粘贴原文即可，不需要去掉代码。"
          />
          <PreviewResult body={previewBody} triggers={triggers} />
          <p className="text-2xs leading-relaxed text-faint">
            预览不校验触发人名单（这里没有「谁在说话」），也不代表命令门禁 / 每小时配额放行。
          </p>
        </div>
      </Section>

      <SaveBar
        saveLabel="保存触发设置"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={blockedReason}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-triggers"
      />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  command: '命令',
  question: '提问',
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

        <dt className="text-2xs text-faint">命令 / 参数</dt>
        <dd className="min-w-0 font-mono break-all text-foreground">
          <span data-testid="trigger-preview-command">{parse.command ?? '—'}</span>
          {parse.args === null ? null : (
            <>
              <span className="ml-1 text-muted-foreground">参数：</span>
              <span data-testid="trigger-preview-args">{parse.args}</span>
            </>
          )}
        </dd>

        <dt className="text-2xs text-faint">提问正文</dt>
        <dd className="min-w-0 break-words text-foreground" data-testid="trigger-preview-question">
          {parse.question ?? '—'}
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