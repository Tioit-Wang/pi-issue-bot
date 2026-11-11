/**
 * `prompt` 分区：**四条互不干扰的版本线**（`docs/plan-fixed-pipeline.md` §4.4 / V15）。
 *
 * 四件事决定了这一页的组织：
 *
 * 1. **kind 是子视图，进 hash**（`#prompt/classify`）：刷新不丢、能贴给别人；分区本身仍是
 *    路径段（`/settings/prompt`），所以 hash 只放 kind。
 * 2. **保存语义两套**（界面上刻意分开）：`settings.prompt.enabled` 走吸底保存条（PUT settings），
 *    正文走 `PUT …/prompt?kind=`（保存即**新建版本**）。别让人以为改正文就顺带存了开关。
 * 3. **项目版本整体覆盖内置默认**（Q1）：内置默认只读展示 + 「另存为项目版本」，不拼接默认。
 * 4. **`agent` 会挤占 P1 预算**（V18）：所以每个 tab 都有层序预览，agent 单独标出对 P1 的影响。
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { PromptKind } from '../../../../../packages/contract/src/index.ts';
import { formatCount, formatTimeCell } from '../../lib/format.ts';
import { cn } from '../../lib/utils.ts';
import { AsyncSection } from '../AsyncSection.tsx';
import { Section } from '../Section.tsx';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Tabs } from '../ui/tabs.tsx';
import { SwitchField, TextField } from './form.tsx';
import {
  PROMPT_KIND_META,
  isPromptKind,
  parsePromptHash,
  promptKindHash,
  promptKindMeta,
  promptKindPlaceholders,
  promptVersionLabel,
  promptWriteReason,
} from './prompt-kinds.tsx';
import { PromptLayersPreview } from './prompt-layers-preview.tsx';
import { PromptPreviewDrawer } from './prompt-preview-drawer.tsx';
import { IssueList, SaveBar } from './save-bar.tsx';
import type { SettingsSectionProps } from './section-props.ts';
import { countChangedPaths } from './settings-chrome.tsx';
import { usePromptResource } from './use-prompt.ts';

/** 一版正文的本地草稿：`versionKey` 变了（保存成功 / 别人改了）就自动作废。 */
type StoredBody = { versionKey: string; body: string; note: string };

const EMPTY_TAB_DIRTY: Partial<Record<PromptKind, boolean>> = {};

export function PromptSection({ state, onDirtyChange }: SettingsSectionProps) {
  const { draft, readOnly, repo } = state;
  const location = useLocation();
  const navigate = useNavigate();
  const kind = parsePromptHash(location.hash) ?? 'project';

  /** 四个 tab 各自的正文草稿：切 tab 不该把刚打的字丢掉。 */
  const [stored, setStored] = useState<Partial<Record<PromptKind, StoredBody>>>({});
  const [tabDirty, setTabDirty] = useState<Partial<Record<PromptKind, boolean>>>(EMPTY_TAB_DIRTY);

  /**
   * project tab 的预算读数要出现在**吸底保存条**上（那条只管「开关」那一份保存），
   * 所以由面板上报、这里存一份；值没变就不 setState（避免渲染回环）。
   */
  const [projectBudget, setProjectBudget] = useState<{ remaining: number; available: number } | null>(null);

  const reportBudget = (next: { remaining: number; available: number } | null): void => {
    setProjectBudget((current) =>
      current === null && next === null
        ? current
        : current !== null && next !== null && current.remaining === next.remaining && current.available === next.available
          ? current
          : next,
    );
  };

  const anyTabDirty = Object.values(tabDirty).some(Boolean);
  useEffect(() => {
    onDirtyChange?.(state.dirty || anyTabDirty);
  }, [onDirtyChange, state.dirty, anyTabDirty]);

  const selectKind = (next: string): void => {
    if (!isPromptKind(next)) return;
    // `replace`：切 tab 不是「新页面」，不该在后退键里堆一串历史
    void navigate({ hash: promptKindHash(next) }, { replace: true });
  };

  const changed = countChangedPaths(state.base, draft).length;

  const panels = PROMPT_KIND_META.map((meta) => ({
    key: meta.kind,
    label: meta.label,
    content: (
      <PromptKindPanel
        key={meta.kind}
        repo={repo}
        kind={meta.kind}
        readOnly={readOnly}
        stored={stored[meta.kind] ?? null}
        onStored={(next) => {
          setStored((current) => ({ ...current, [meta.kind]: next }));
        }}
        onBodyDirty={(dirty) => {
          setTabDirty((current) => (current[meta.kind] === dirty ? current : { ...current, [meta.kind]: dirty }));
        }}
        onBudget={meta.kind === 'project' ? reportBudget : undefined}
        p1Enabled={draft.prompt.enabled}
        onP1EnabledChange={(next) => {
          state.update((current) => ({ ...current, prompt: { ...current.prompt, enabled: next } }));
        }}
      />
    ),
  }));

  return (
    <div className="flex flex-col gap-6" data-testid="settings-prompt">
      <Tabs label="提示词种类" items={panels} value={kind} onValueChange={selectKind} />

      <SaveBar
        saveLabel="保存提示词开关"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        budget={projectBudget}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-prompt"
      />
    </div>
  );
}

/* ── 一个 kind 的面板 ─────────────────────────────────────────────────────── */

function PromptKindPanel({
  repo,
  kind,
  readOnly,
  stored,
  onStored,
  onBodyDirty,
  onBudget,
  p1Enabled,
  onP1EnabledChange,
}: {
  repo: string;
  kind: PromptKind;
  readOnly: boolean;
  stored: StoredBody | null;
  onStored: (next: StoredBody) => void;
  onBodyDirty: (dirty: boolean) => void;
  /** 只有 project tab 传：把「还能存多少」报到吸底保存条上。 */
  onBudget?: ((budget: { remaining: number; available: number } | null) => void) | undefined;
  p1Enabled: boolean;
  onP1EnabledChange: (next: boolean) => void;
}) {
  const meta = promptKindMeta(kind);
  const resource = usePromptResource(repo, kind);
  const data = resource.query.data;

  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const limit = data?.limit ?? meta.limit;
  const activeVersion = data?.activeVersion ?? data?.version ?? 0;
  const isSystemDefault = data?.isSystemDefault ?? activeVersion === 0;
  const availableChars =
    data?.availableChars ??
    (kind === 'project' ? (data?.budget.available ?? 0) : Math.max(0, limit - (data?.body.length ?? 0)));

  const versionKey = data === undefined ? 'none' : String(activeVersion);
  const local = stored !== null && stored.versionKey === versionKey ? stored : null;
  const dataBody = data?.body ?? '';
  const body = local === null ? dataBody : local.body;
  const note = local === null ? '' : local.note;
  const bodyDirty = data !== undefined && body !== dataBody;
  const bodyChars = body.length;

  useEffect(() => {
    onBodyDirty(bodyDirty);
  }, [bodyDirty, onBodyDirty]);

  // 预算读数（只有 project tab 需要）：吸底保存条显示「还能存多少」
  useEffect(() => {
    if (onBudget === undefined) return;
    onBudget(data === undefined ? null : { remaining: availableChars - bodyChars, available: availableChars });
  }, [onBudget, data, availableChars, bodyChars]);

  const setBody = (next: string): void => {
    onStored({ versionKey, body: next, note });
  };
  const setNote = (next: string): void => {
    onStored({ versionKey, body, note: next });
  };

  const lines = body === '' ? 1 : body.split('\n').length;
  const overBudget = kind === 'project' && data !== undefined && bodyChars > availableChars;
  const overLimit = bodyChars > limit;
  const systemDefault = data?.systemDefault ?? '';
  const hasProjectVersion = activeVersion > 0 && (data?.present ?? false);

  const saveBlockedReason =
    data === undefined
      ? '正文还没读到'
      : body.trim() === ''
        ? '正文不能为空（服务端 body 至少 1 个字符）'
        : overLimit
          ? `超出上限：上限 ${formatCount(limit)} 字符，当前 ${formatCount(bodyChars)} 字符（服务端会拒绝保存）`
          : overBudget
            ? `超出预算：可用 ${formatCount(availableChars)} 字符，当前 ${formatCount(bodyChars)} 字符（服务端会拒绝保存）`
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

  const saveErrorReason = promptWriteReason(resource.saveError, kind);

  return (
    <div className="flex flex-col gap-5" data-testid={`prompt-panel-${kind}`}>
      {/* 顶部一行事实：当前是项目版本还是系统默认 / 上限 / 还能存多少 */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground" data-testid="prompt-kind-version">
            {data === undefined ? '读取中…' : promptVersionLabel(activeVersion, isSystemDefault, meta.stage)}
          </span>
          {isSystemDefault ? (
            <Badge tone="neutral">未覆盖</Badge>
          ) : (
            <Badge tone="info" title="项目版本整体覆盖内置默认，不与默认模板拼接（Q1）">
              整体覆盖
            </Badge>
          )}
        </span>
        <span className="tabular text-xs text-muted-foreground" data-testid="prompt-kind-limit">
          上限 {formatCount(limit)} 字符
        </span>
        <span
          className={cn(
            'tabular text-xs',
            overLimit || overBudget ? 'font-medium text-danger-fg' : 'text-muted-foreground',
          )}
          data-testid="prompt-kind-available"
        >
          可用 {formatCount(Math.max(0, availableChars))}
        </span>
        {kind === 'agent' ? (
          <span
            className="text-2xs text-faint"
            title="Agent 段落在 baseChars 里：写多长就扣掉 P1 多少额度（§16.3.1 / V18）"
          >
            计入 baseChars
          </span>
        ) : null}
      </div>

      <Section first title="正文">
        <AsyncSection
          isLoading={resource.query.isLoading}
          error={resource.query.error}
          isEmpty={false}
          testId="prompt-body"
          skeleton={<div className="h-40 w-full rounded-md bg-muted" />}
        >
          {data === undefined ? null : (
            <div className="flex flex-col gap-2">
              {kind === 'project' ? (
                <SwitchField
                  id={`prompt-enabled-${kind}`}
                  label="把 P1 注入提示词（prompt.enabled）"
                  checked={p1Enabled}
                  onChange={onP1EnabledChange}
                  disabled={readOnly}
                  disabledReason="仓库已归档：只读"
                />
              ) : null}

              {kind === 'project' && !p1Enabled ? (
                <Alert tone="warn">
                  <AlertDescription>
                    P1 当前未启用（prompt.enabled=false）：正文能编辑、能存版本，但不会进上下文。
                  </AlertDescription>
                </Alert>
              ) : null}
              {data.present || activeVersion === 0 ? null : (
                <Alert tone="danger">
                  <AlertDescription>
                    settings 指着 v{formatCount(activeVersion)}，但库里没有这一行（可能被手删过）：先存一版正文修复。
                  </AlertDescription>
                </Alert>
              )}

              {systemDefault === '' ? null : (
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      系统默认（只读 · {formatCount(systemDefault.length)} 字符）
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={readOnly || resource.save.isPending}
                      title="整体覆盖：保存后成为新的项目版本，内置默认不再拼接"
                      data-testid="prompt-save-as-project"
                      onClick={() => {
                        resource.save.mutate({ body: systemDefault, note: '另存内置默认' });
                      }}
                    >
                      另存为项目版本
                    </Button>
                  </div>
                  <pre
                    data-testid="prompt-system-default"
                    className="max-h-40 overflow-auto rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
                  >
                    {systemDefault}
                  </pre>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-1">
                <label htmlFor={`prompt-body-editor-${kind}`} className="text-xs font-medium text-foreground">
                  正文（等宽，保存为新版本）
                </label>
                <span
                  className={cn('tabular text-2xs', overLimit ? 'font-medium text-danger-fg' : 'text-faint')}
                  data-testid="prompt-body-count"
                >
                  {formatCount(bodyChars)} 字符 · {formatCount(lines)} 行 · 上限 {formatCount(limit)}
                </span>
              </div>

              <div
                className={cn(
                  'flex min-w-0 overflow-hidden rounded-md border bg-card',
                  'transition-[border-color] duration-[120ms] ease-out-quint focus-within:border-brand',
                  overLimit || overBudget ? 'border-danger' : 'border-input',
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
                  id={`prompt-body-editor-${kind}`}
                  ref={textareaRef}
                  rows={14}
                  value={body}
                  spellCheck={false}
                  disabled={readOnly}
                  title={readOnly ? '仓库已归档：只读' : undefined}
                  aria-describedby={`prompt-body-hint-${kind}`}
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
                {promptKindPlaceholders(kind).map((token) => (
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
              <p id={`prompt-body-hint-${kind}`} className="text-xs leading-relaxed text-muted-foreground">
                装配层不做变量替换：占位符原样进 system prompt。
              </p>

              {kind === 'project' ? (
                <BudgetBar
                  available={availableChars}
                  requested={data.budget.requested}
                  draftChars={bodyChars}
                  overBudget={overBudget}
                  budgetChars={data.budget.budgetChars}
                  p1Cap={data.budget.p1Cap}
                  otherLayersChars={data.budget.otherLayersChars}
                  source={data.budget.source}
                  lastAssembly={data.lastAssembly === null ? null : data.lastAssembly.totalChars}
                />
              ) : null}

              <PromptLayersPreview
                kind={kind}
                stage={meta.stage}
                layers={data.layers ?? null}
                stats={data.preview.stats}
                budget={data.budget}
                availableChars={availableChars}
                limit={limit}
                overLimit={overLimit || overBudget}
                testId={`prompt-layers-${kind}`}
              />

              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="w-72 max-w-full">
                  <TextField
                    id={`prompt-note-${kind}`}
                    label="版本备注（可选，≤ 500 字）"
                    value={note}
                    onChange={setNote}
                    placeholder="这次改了什么，例如「补一条提交信息规范」"
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="prompt-restore"
                    disabled={readOnly || !hasProjectVersion}
                    title={
                      readOnly
                        ? '仓库已归档：只读'
                        : hasProjectVersion
                          ? '指针回 v0：回到系统默认（历史版本保留）'
                          : '已经是系统默认（指针 v0）'
                    }
                    onClick={() => {
                      setConfirmRestore(true);
                    }}
                  >
                    恢复默认
                  </Button>
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
              </div>

              {confirmRestore ? (
                <div
                  role="group"
                  aria-label="确认恢复默认"
                  data-testid="prompt-restore-confirm"
                  className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-bg px-2 py-1 text-xs text-warn-fg"
                >
                  <span>恢复默认会把指针回 v0（{meta.label} 改用内置默认），历史版本保留。</span>
                  <Button
                    size="sm"
                    disabled={resource.restore.isPending}
                    data-testid="prompt-restore-confirm-yes"
                    onClick={() => {
                      resource.restore.mutate();
                      setConfirmRestore(false);
                    }}
                  >
                    {resource.restore.isPending ? '恢复中…' : '确认恢复'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="prompt-restore-cancel"
                    onClick={() => {
                      setConfirmRestore(false);
                    }}
                  >
                    取消
                  </Button>
                </div>
              ) : null}

              <div aria-live="polite" className="flex flex-col gap-1">
                {resource.save.isSuccess && !bodyDirty ? (
                  <p className="text-xs text-success-fg" data-testid="prompt-save-ok">
                    已保存为 v{formatCount(activeVersion)}（字符 {formatCount(dataBody.length)}）
                  </p>
                ) : null}
                {resource.restore.isSuccess && isSystemDefault ? (
                  <p className="text-xs text-success-fg" data-testid="prompt-restore-ok">
                    已恢复默认（指针 v0，历史版本保留）
                  </p>
                ) : null}
                {resource.saveError === null ? null : (
                  <div
                    role="alert"
                    data-testid="prompt-save-error"
                    className="rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs text-danger-fg"
                  >
                    <p className="font-medium">{saveErrorReason ?? resource.saveFailure?.message}</p>
                    <IssueList issues={resource.saveFailure?.issues ?? []} testId="prompt-save-issues" />
                    {resource.saveFailure?.budget === null || resource.saveFailure?.budget === undefined ? null : (
                      <p className="mt-1 text-2xs">
                        预算：可用 {formatCount(resource.saveFailure.budget.available)} 字符 / 请求{' '}
                        {formatCount(resource.saveFailure.budget.requested)} 字符
                      </p>
                    )}
                  </div>
                )}
                {resource.restoreError === null ? null : (
                  <div
                    role="alert"
                    data-testid="prompt-restore-error"
                    className="rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs text-danger-fg"
                  >
                    <p className="font-medium">{resource.restoreFailure?.message}</p>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
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
              </div>

              <PromptPreviewDrawer
                open={previewOpen}
                onClose={() => {
                  setPreviewOpen(false);
                }}
                preview={data.preview}
                repo={repo}
                version={activeVersion}
              />
            </div>
          )}
        </AsyncSection>
      </Section>

      <Section title="版本">
        <div className="flex flex-col gap-1">
          {data === undefined ? (
            <p className="text-xs text-muted-foreground">（正文还没读到）</p>
          ) : data.versions.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有项目版本：存一版正文就会出现在这里（v1 起）。</p>
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
                    style={{ minHeight: 'var(--row-height)' }}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm text-foreground">v{formatCount(version.version)}</span>
                      {version.current ? <Badge tone="success">当前</Badge> : null}
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={version.note ?? ''}>
                        {version.note === null || version.note === '' ? '（没有备注）' : version.note}
                      </span>
                      <span className="shrink-0 tabular text-2xs text-faint">{formatCount(version.chars)} 字符</span>
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
                          确认回滚到 v{formatCount(version.version)}？会以该版正文新建 v
                          {formatCount(activeVersion + 1)}，历史都留着。
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
            {resource.rollbackError === null ? null : (
              <div
                role="alert"
                data-testid="prompt-rollback-error"
                className="rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs text-danger-fg"
              >
                <p className="font-medium">{resource.rollbackFailure?.message}</p>
                <IssueList issues={resource.rollbackFailure?.issues ?? []} testId="prompt-rollback-issues" />
              </div>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

/** 预算条：`available` 是「这一版还能占多少」，`requested` 是服务端看到的当前正文长度。 */
function BudgetBar({
  available,
  requested,
  draftChars,
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
  overBudget: boolean;
  budgetChars: number;
  p1Cap: number;
  otherLayersChars: number;
  source: 'last-assembly' | 'conservative-estimate';
  lastAssembly: number | null;
}) {
  const usedPct = available <= 0 ? 100 : Math.min(100, Math.round((draftChars / available) * 100));
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
        总预算 {formatCount(budgetChars)} 字符 · P1 软上限 {formatCount(p1Cap)} · 其它层已占{' '}
        {formatCount(otherLayersChars)} · 口径 {source === 'last-assembly' ? '上一次真实装配' : '保守估算'}
        {lastAssembly === null ? '' : ` · 上次装配合计 ${formatCount(lastAssembly)} 字符`}
        {overBudget ? ' · 当前正文已超可用额度，保存被禁用' : ''}
      </p>
      <p className="text-2xs text-faint">
        服务端看到的当前正文长度 {formatCount(requested)} 字符（与画布值一致时才表示都同步了）。
      </p>
    </div>
  );
}
