/**
 * `prompt` 分区：P1 正文编辑 + 预算预演 + 版本回滚 + 最终 prompt 预览。
 *
 * 这个分区有**两份互不相干的保存**，界面上刻意分开，别让人以为改正文就顺带存了开关：
 *  1. `settings.prompt`（enabled / current_version）→ 走 `PUT .../settings`（吸底保存条）；
 *  2. 正文 → 走 `PUT .../prompt`（保存即**新建版本**，不覆盖旧版），超预算 400。
 *
 * 编辑器：等宽 + 行号 + 与 textarea 同步滚动。行号不是装饰：预算与 diff 都按字符/行说话，
 * 报错时能直接对上是哪一行。
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Section } from '../Section.tsx';
import { AsyncSection } from '../AsyncSection.tsx';
import { formatCount, formatTimeCell } from '../../lib/format.ts';
import { cn } from '../../lib/utils.ts';
import { SwitchField, TextField } from './form.tsx';
import { IssueList, SaveBar } from './save-bar.tsx';
import { PromptPreviewDrawer } from './prompt-preview-drawer.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';
import { usePromptResource } from './use-prompt.ts';

/** 正文里可以手动插入的上下文占位符（**不做替换**，只是写作提示）。 */
const PLACEHOLDER_CHIPS = ['{{repo}}', '{{default_branch}}', '{{labels}}', '{{triggers}}'] as const;

type BodyDraft = { key: string; body: string; note: string };

export function PromptSection({ state, onDirtyChange }: SettingsSectionProps) {
  const { draft, readOnly, repo } = state;
  const resource = usePromptResource(repo);
  const data = resource.query.data;

  const [stored, setStored] = useState<BodyDraft | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const key = data === undefined ? `${repo}:none` : `${repo}:${String(data.version)}`;
  const body = stored !== null && stored.key === key ? stored.body : (data?.body ?? '');
  const note = stored !== null && stored.key === key ? stored.note : '';
  const bodyDirty = data !== undefined && body !== data.body;

  const setBody = (next: string): void => {
    setStored({ key, body: next, note });
  };
  const setNote = (next: string): void => {
    setStored({ key, body, note: next });
  };

  useEffect(() => {
    onDirtyChange?.(state.dirty || bodyDirty);
  }, [onDirtyChange, state.dirty, bodyDirty]);

  const available = data?.budget.available ?? 0;
  const bodyChars = body.length;
  const overBudget = data !== undefined && bodyChars > available;
  const lines = body === '' ? 1 : body.split('\n').length;
  const usedPct = available <= 0 ? 100 : Math.min(100, Math.round((bodyChars / available) * 100));
  const changed = countChangedPaths(state.base, draft).length;

  const saveBlockedReason =
    data === undefined
      ? '正文还没读到'
      : body.trim() === ''
        ? '正文不能为空（服务端 body 至少 1 个字符）'
        : overBudget
          ? `超出预算：可用 ${formatCount(available)} 字符，当前 ${formatCount(bodyChars)} 字符（服务端会拒绝保存）`
          : !bodyDirty
            ? '没有改动（与服务端当前版本一致）'
            : undefined;

  const insertPlaceholder = (token: string): void => {
    const element = textareaRef.current;
    if (element === null) {
      setBody(`${body}${token}`);
      return;
    }
    const start = element.selectionStart ?? body.length;
    const end = element.selectionEnd ?? start;
    setBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    requestAnimationFrame(() => {
      element.focus();
      const caret = start + token.length;
      element.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-prompt">
      <Section
        first
        title="这一层要不要进上下文"
        description="装配位置：head 之后、AGENTS.md 之前"
      >
        <div className="flex flex-col gap-2">
          <SwitchField
            id="prompt-enabled"
            label="把 P1 注入提示词（prompt.enabled）"
            description="关掉后这一层不进上下文，但版本历史保留；重新打开即恢复当前版本。"
            checked={draft.prompt.enabled}
            onChange={(next) => {
              state.update((current) => ({ ...current, prompt: { ...current.prompt, enabled: next } }));
            }}
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />
          <p className="text-xs text-muted-foreground">
            当前启用版本：<span className="font-mono text-foreground">v{formatCount(draft.prompt.current_version)}</span>
            {data === undefined ? null : (
              <span className="ml-2 text-faint">
                （服务端视图：v{formatCount(data.version)}
                {data.present ? '' : ' · 库里没有这一版'}）
              </span>
            )}
          </p>
        </div>
      </Section>

      <Section
        title="正文"
        description="保存 = 新建版本（不覆盖旧版），历史永久保留"
        actions={
          <Button
            variant="secondary"
            size="sm"
            data-testid="prompt-preview-open"
            onClick={() => {
              setPreviewOpen(true);
            }}
            title="显示装配后的 system prompt 全文（含逐层字符数与被丢弃/未参与的层）"
          >
            预览最终 system prompt
          </Button>
        }
      >
        <AsyncSection
          isLoading={resource.query.isLoading}
          error={resource.query.error}
          isEmpty={false}
          testId="prompt-body"
          skeleton={<div className="h-40 w-full rounded-md bg-muted" />}
        >
          {data === undefined ? null : (
            <div className="flex flex-col gap-2">
              {data.enabled ? null : (
                <Alert tone="warn">
                  <AlertDescription>
                    P1 当前未启用（prompt.enabled=false）：正文能编辑、能存版本，但不会进上下文。
                  </AlertDescription>
                </Alert>
              )}
              {data.present ? null : (
                <Alert tone="danger">
                  <AlertDescription>
                    settings 指着 v{formatCount(data.version)}，但库里没有这一行（可能被手删过）：先存一版正文修复。
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center justify-between gap-1">
                <label htmlFor="prompt-body-editor" className="text-xs font-medium text-foreground">
                  正文（等宽，保存为新版本）
                </label>
                <span className="text-2xs text-faint tabular" data-testid="prompt-body-count">
                  {formatCount(bodyChars)} 字符 · {formatCount(lines)} 行
                </span>
              </div>

              <div
                className={cn(
                  'flex min-w-0 overflow-hidden rounded-md border bg-card',
                  'transition-[border-color] duration-[120ms] ease-out-quint focus-within:border-brand',
                  overBudget ? 'border-danger' : 'border-input',
                )}
              >
                <div
                  ref={gutterRef}
                  aria-hidden
                  className="max-h-[22rem] shrink-0 overflow-hidden border-r border-border bg-muted px-1.5 py-1.5 text-right font-mono text-2xs leading-relaxed text-faint select-none"
                >
                  {Array.from({ length: lines }, (_, index) => (
                    <div key={`ln-${String(index + 1)}`}>{index + 1}</div>
                  ))}
                </div>
                <textarea
                  id="prompt-body-editor"
                  ref={textareaRef}
                  rows={14}
                  value={body}
                  spellCheck={false}
                  disabled={readOnly}
                  title={readOnly ? '仓库已归档：只读' : undefined}
                  aria-describedby="prompt-body-hint"
                  onChange={(event) => {
                    setBody(event.target.value);
                  }}
                  onScroll={(event) => {
                    if (gutterRef.current !== null) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                  }}
                  className="max-h-[22rem] min-h-40 min-w-0 flex-1 resize-y bg-transparent px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <span className="text-2xs text-faint">插入占位符：</span>
                {PLACEHOLDER_CHIPS.map((token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() => {
                      insertPlaceholder(token);
                    }}
                    disabled={readOnly}
                    title="面板不做替换：这个占位符会原样发给模型（写作提示用）"
                    data-testid={`prompt-chip-${token.replace(/[{}]/gu, '')}`}
                    className="rounded-full bg-muted px-2 py-0.5 font-mono text-2xs text-foreground transition-[background-color,color] duration-[120ms] ease-out-quint hover:bg-card hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {token}
                  </button>
                ))}
              </div>
              <p id="prompt-body-hint" className="text-xs leading-relaxed text-muted-foreground">
                装配层不做变量替换：占位符原样进 system prompt；标签词表与触发别名自动注入。
              </p>

              <BudgetBar
                available={available}
                requested={data.budget.requested}
                draftChars={bodyChars}
                usedPct={usedPct}
                overBudget={overBudget}
                budgetChars={data.budget.budgetChars}
                p1Cap={data.budget.p1Cap}
                otherLayersChars={data.budget.otherLayersChars}
                source={data.budget.source}
                lastAssembly={data.lastAssembly === null ? null : data.lastAssembly.totalChars}
              />

              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="w-72 max-w-full">
                  <TextField
                    id="prompt-note"
                    label="版本备注（可选，≤ 500 字）"
                    value={note}
                    onChange={setNote}
                    placeholder="这次改了什么，例如「补一条提交信息规范」"
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    resource.save.mutate({ body, note: note.trim() === '' ? undefined : note.trim() });
                  }}
                  disabled={saveBlockedReason !== undefined || resource.save.isPending}
                  aria-busy={resource.save.isPending}
                  title={saveBlockedReason ?? '保存为新版本（PUT /prompt）'}
                  data-testid="prompt-save"
                >
                  {resource.save.isPending ? '保存中…' : '保存为新版本'}
                </Button>
              </div>

              <div aria-live="polite" className="flex flex-col gap-1">
                {resource.save.isSuccess && !bodyDirty ? (
                  <p className="text-xs text-success-fg" data-testid="prompt-save-ok">
                    已保存为 v{formatCount(data.version)}（字符 {formatCount(data.body.length)}）
                  </p>
                ) : null}
                {resource.saveFailure === null ? null : (
                  <div role="alert" data-testid="prompt-save-error" className="rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs text-danger-fg">
                    <p className="font-medium">{resource.saveFailure.message}</p>
                    <IssueList issues={resource.saveFailure.issues} testId="prompt-save-issues" />
                    {resource.saveFailure.budget === null ? null : (
                      <p className="mt-1 text-2xs">
                        预算：可用 {formatCount(resource.saveFailure.budget.available)} 字符 / 请求{' '}
                        {formatCount(resource.saveFailure.budget.requested)} 字符
                      </p>
                    )}
                  </div>
                )}
              </div>

              <PromptPreviewDrawer
                open={previewOpen}
                onClose={() => {
                  setPreviewOpen(false);
                }}
                preview={data.preview}
                repo={repo}
                version={data.version}
              />
            </div>
          )}
        </AsyncSection>
      </Section>

      <Section
        title="版本"
        description="回滚 = 以旧版正文新建版本，版本号只会往上走"
      >
        <div className="flex flex-col gap-1">
          {data === undefined ? (
            <p className="text-xs text-muted-foreground">（正文还没读到）</p>
          ) : data.versions.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有任何版本：存一版正文就会出现在这里（v1 起）。</p>
          ) : (
            [...data.versions]
              .sort((left, right) => right.version - left.version)
              .map((version) => {
                const time = formatTimeCell(version.createdAt);
                const confirming = confirmVersion === version.version;
                return (
                  <div
                    key={version.version}
                    className="flex min-w-0 flex-col gap-1 rounded-md px-1.5 py-1 transition-colors duration-[120ms] ease-out-quint hover:bg-muted"
                    data-testid={`prompt-version-${String(version.version)}`}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm text-foreground">v{formatCount(version.version)}</span>
                      {version.current ? <Badge tone="success">当前</Badge> : null}
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={version.note ?? ''}>
                        {version.note === null || version.note === '' ? '（没有备注）' : version.note}
                      </span>
                      <span className="shrink-0 text-2xs text-faint tabular">{formatCount(version.chars)} 字符</span>
                      <time className="shrink-0 text-2xs text-faint" title={time.title}>
                        {time.text}
                      </time>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={version.current || readOnly || resource.rollback.isPending}
                        title={
                          readOnly
                            ? '仓库已归档：只读'
                            : version.current
                              ? '已经是当前版本'
                              : `以 v${String(version.version)} 的正文新建一个版本`
                        }
                        data-testid={`prompt-rollback-${String(version.version)}`}
                        onClick={() => {
                          setConfirmVersion(version.version);
                        }}
                      >
                        回滚
                      </Button>
                    </div>

                    {confirming ? (
                      <div
                        role="group"
                        aria-label={`确认回滚到 v${String(version.version)}`}
                        data-testid={`prompt-rollback-confirm-${String(version.version)}`}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-bg px-2 py-1 text-xs text-warn-fg"
                      >
                        <span>
                          确认回滚到 v{formatCount(version.version)}？会以该版正文新建 v{formatCount(data.version + 1)}，历史都留着。
                        </span>
                        <Button
                          size="sm"
                          disabled={resource.rollback.isPending}
                          data-testid={`prompt-rollback-confirm-yes-${String(version.version)}`}
                          onClick={() => {
                            resource.rollback.mutate(version.version);
                            setConfirmVersion(null);
                          }}
                        >
                          {resource.rollback.isPending ? '回滚中…' : '确认回滚'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`prompt-rollback-cancel-${String(version.version)}`}
                          onClick={() => {
                            setConfirmVersion(null);
                          }}
                        >
                          取消
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })
          )}

          <div aria-live="polite">
            {resource.rollbackFailure === null ? null : (
              <div role="alert" data-testid="prompt-rollback-error" className="rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs text-danger-fg">
                <p className="font-medium">{resource.rollbackFailure.message}</p>
                <IssueList issues={resource.rollbackFailure.issues} testId="prompt-rollback-issues" />
              </div>
            )}
          </div>
        </div>
      </Section>

      <SaveBar
        saveLabel="保存提示词开关"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        budget={data === undefined ? null : { remaining: available - bodyChars, available }}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-prompt"
      />
    </div>
  );
}

/** 预算条：`available` 是「这一版还能占多少」，`requested` 是服务端看到的当前正文长度。 */
function BudgetBar({
  available,
  requested,
  draftChars,
  usedPct,
  overBudget,
  budgetChars,
  p1Cap,
  otherLayersChars,
  source,
  lastAssembly,
}: {
  available: number;
  requested: number;
  draftChars: number;
  usedPct: number;
  overBudget: boolean;
  budgetChars: number;
  p1Cap: number;
  otherLayersChars: number;
  source: 'last-assembly' | 'conservative-estimate';
  lastAssembly: number | null;
}) {
  return (
    <div
      data-testid="prompt-budget"
      className={cn(
        'flex flex-col gap-1 rounded-md border px-2.5 py-2',
        overBudget ? 'border-danger/40 bg-danger-bg' : 'border-border bg-muted/40',
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <span className="text-2xs text-faint">P1 预算（保存期预演，超了服务端直接拒）</span>
        <span
          className={cn('tabular text-xs', overBudget ? 'font-medium text-danger-fg' : 'text-foreground')}
          data-testid="prompt-budget-numbers"
        >
          {formatCount(draftChars)} / {formatCount(available)} 字符
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label="P1 预算占用"
        aria-valuenow={Math.min(100, usedPct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-[220ms] ease-out-quint',
            overBudget ? 'bg-danger' : 'bg-success',
          )}
          style={{ width: `${String(usedPct)}%` }}
        />
      </div>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        总预算 {formatCount(budgetChars)} 字符 · P1 软上限 {formatCount(p1Cap)} · 其它层已占 {formatCount(otherLayersChars)} · 口径{' '}
        {source === 'last-assembly' ? '上一次真实装配' : '保守估算'}
        {lastAssembly === null ? '' : ` · 上次装配合计 ${formatCount(lastAssembly)} 字符`}
        {overBudget ? ' · 当前正文已超可用额度，保存被禁用' : ''}
      </p>
      <p className="text-2xs text-faint">服务端看到的当前正文长度 {formatCount(requested)} 字符（与画布值一致时才表示都同步了）。</p>
    </div>
  );
}