/**
 * `pipeline` 分区：固定流水线的**项目级可配项只有 3 类**（`docs/plan-fixed-pipeline.md` §1.5 Q2 / §4.5）。
 *
 * 这个页面刻意做得很窄，因为它要传达的核心事实就是「这里没什么可调的」：
 *  1. **管理人员**：唯一真正需要项目自己填的东西（`/pipeline next|prev` 的权限来源，
 *     也是「分类判不出来时等谁回话」的名单）；空 = 保存被服务端 400 拒，所以按钮先禁用；
 *  2. **四个提示词入口**：正文不在这一页编辑（一页一个编辑器，避免八个 textarea），
 *     这里只给「现在用的是哪一版 / 上限多少 / 还能存多少」，点进去跳提示词分区的对应 tab；
 *  3. **系统常量只读**：阈值全部收归代码（Q2，改常量走发布）；等宽 + tabular，右上角「只读」，
 *     解释放 `title`/`sr-only`，版面只留「名字 + 值」。
 *
 * 另外一行 `warn`：`pipelineLabelCoverage()` 有缺角色（需求 / 缺陷）时提示一次并给去标签分区的链接。
 * 只提示不阻塞 —— 与服务端「放宽不报 400」的策略一致。
 */
import { useQueries } from '@tanstack/react-query';
import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router';
import type { RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { pipelineLabelCoverage } from '../../../../../packages/contract/src/index.ts';
import type { SettingsSectionKey } from '../../layout/nav.ts';
import { formatCount } from '../../lib/format.ts';
import { repoSettingsPath } from '../../lib/repo-route.ts';
import { cn } from '../../lib/utils.ts';
import { Section } from '../Section.tsx';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { PROMPT_KIND_META, promptKindHash, promptVersionLabel } from './prompt-kinds.tsx';
import { SaveBar } from './save-bar.tsx';
import type { SettingsSectionProps } from './section-props.ts';
import { countChangedPaths } from './settings-chrome.tsx';
import { promptSummaryQuery } from './use-prompt.ts';

/** 与契约同一条 login 规则（`repo-config.ts` 的 `LOGIN_RE`），面板先挡一次好过等服务端 400。 */
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const MANAGERS_MAX = 20;

/**
 * 系统常量（只读）。
 *
 * 数字来源（不要在这里「顺手调一下」）：
 *  - `PIPELINE_FORMAT_MAX_FAILS` / `PIPELINE_CLOSE_AFTER_HOURS` / `recheckCooldownSeconds` /
 *    `sessionMaxTurns` / `sessionMaxAgeDays` → `apps/server/src/config/pipeline-constants.ts`
 *  - `PROMPT_LIMITS.body` → `apps/server/src/skills/prompt.ts`
 *  - 「连续 2 次 → blocked」是流程规则（`workflows/pipeline-*`），不是常量。
 */
const READ_ONLY_CONSTANTS: readonly { name: string; value: string; note: string }[] = [
  { name: 'PIPELINE_FORMAT_MAX_FAILS', value: '5 次', note: '格式检查累计 5 次不通过自动关 issue（通过不计数）' },
  { name: 'PIPELINE_CLOSE_AFTER_HOURS', value: '48 小时', note: '只扫「等用户补充」的 issue；等管理员不在此列' },
  { name: '运行失败连续次数', value: '2 次 → blocked', note: '运行失败或信封不合法连续 2 次即停在 blocked，等管理员' },
  { name: 'SESSION_MAX_TURNS', value: '30', note: '一个会话到 30 轮即轮换（新会话 + 摘要）' },
  { name: 'SESSION_MAX_AGE', value: '7 天', note: '会话存活超过 7 天即轮换' },
  { name: 'PROMPT_LIMITS.body', value: '4 000 字符', note: 'issue 正文进提示词时的截断长度' },
  { name: '评论冷却', value: '120 秒', note: '同一阶段两次重跑的最小间隔（评论补充优先，不受此限）' },
];

const ROLE_LABEL: Record<'requirement' | 'defect', string> = { requirement: '需求', defect: '缺陷' };

export function PipelineSection({ state, onNavigate }: SettingsSectionProps) {
  const { draft, readOnly, repo } = state;
  const pipeline = draft.pipeline;
  const changed = countChangedPaths(state.base, draft).length;

  const missingRoles = pipelineLabelCoverage(draft).missingRoles;
  const managersEmpty = pipeline.managers.length === 0;

  /** 四个 kind 的指针状态：只读，不与提示词分区共用编辑器状态。 */
  const promptViews = useQueries({
    queries: PROMPT_KIND_META.map((meta) => promptSummaryQuery(repo, meta.kind)),
  });

  const patchPipeline = (patch: (current: RepoSettings['pipeline']) => RepoSettings['pipeline']): void => {
    state.update((current) => ({ ...current, pipeline: patch(current.pipeline) }));
  };

  /** 分区内链接：先问一句「有未保存改动」，拦下时调用方不要再导航。 */
  const leaveTo = (event: MouseEvent<HTMLAnchorElement>, key: SettingsSectionKey): void => {
    onNavigate?.(event, key);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-pipeline">
      {missingRoles.length === 0 ? null : (
        <Alert tone="warn" role="status" data-testid="pipeline-label-coverage">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>缺少标签角色：{missingRoles.map((role) => ROLE_LABEL[role]).join('、')}</span>
            <Link
              to={repoSettingsPath(repo, 'labels')}
              onClick={(event) => {
                leaveTo(event, 'labels');
              }}
              title="分类结论要靠这里的角色找标签；服务端不会因此拒收（只提示）"
              className="text-xs font-medium text-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              data-testid="pipeline-label-coverage-link"
            >
              去标签分区
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Section first title="管理人员" count={pipeline.managers.length}>
        <ManagersChips
          values={pipeline.managers}
          disabled={readOnly}
          disabledReason="仓库已归档：只读"
          error={managersEmpty ? '流水线需要至少一个管理人员' : null}
          onChange={(next) => {
            patchPipeline((current) => ({ ...current, managers: next }));
          }}
        />
      </Section>

      <Section
        title="提示词"
        footnote="项目版本整体覆盖内置默认；正文在「提示词」分区编辑"
        actions={<span className="tabular text-2xs text-faint">4 条版本线</span>}
      >
        <ul className="flex flex-col">
          {PROMPT_KIND_META.map((meta, index) => {
            const view = promptViews[index]?.data;
            const limit = view?.limit ?? meta.limit;
            const activeVersion = view?.activeVersion ?? view?.version ?? 0;
            const isSystemDefault = view?.isSystemDefault ?? activeVersion === 0;
            const available =
              view?.availableChars ??
              (meta.stage ? Math.max(0, limit - (view?.body.length ?? 0)) : (view?.budget.available ?? 0));
            return (
              <li key={meta.kind} className="border-b border-border last:border-b-0">
                <Link
                  to={{ pathname: repoSettingsPath(repo, 'prompt'), hash: promptKindHash(meta.kind) }}
                  onClick={(event) => {
                    leaveTo(event, 'prompt');
                  }}
                  data-testid={`pipeline-prompt-${meta.kind}`}
                  title={`打开「${meta.label}」提示词编辑器`}
                  style={{ minHeight: 'var(--row-height)' }}
                  className={cn(
                    'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1',
                    'transition-[background-color,color] duration-[120ms] ease-out-quint hover:bg-muted',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                  )}
                >
                  <span className="w-16 shrink-0 text-xs text-foreground">{meta.label}</span>
                  <span
                    className={cn('font-mono text-xs', isSystemDefault ? 'text-muted-foreground' : 'text-foreground')}
                    data-testid={`pipeline-prompt-${meta.kind}-version`}
                  >
                    {view === undefined ? '读取中…' : promptVersionLabel(activeVersion, isSystemDefault, meta.stage)}
                  </span>
                  <span className="ml-auto shrink-0 tabular text-2xs text-faint">上限 {formatCount(limit)}</span>
                  <span className="shrink-0 tabular text-2xs text-faint">可用 {formatCount(Math.max(0, available))}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="系统常量"
        actions={
          <Badge variant="outline" title="面板只读展示：改常量需要发版">
            只读
          </Badge>
        }
        footnote="改常量需要发版（apps/server/src/config/pipeline-constants.ts）"
      >
        <dl className="flex flex-col">
          {READ_ONLY_CONSTANTS.map((constant) => (
            <div
              key={constant.name}
              data-testid={`pipeline-constant-${constant.name}`}
              title={constant.note}
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 border-b border-border py-1 last:border-b-0"
              style={{ minHeight: 'var(--row-height)' }}
            >
              <dt className="shrink-0 font-mono text-xs text-muted-foreground">{constant.name}</dt>
              <dd className="ml-auto shrink-0 font-mono text-xs tabular text-foreground">{constant.value}</dd>
              <span className="sr-only">{constant.note}</span>
            </div>
          ))}
        </dl>
      </Section>

      <SaveBar
        saveLabel="保存流水线设置"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={managersEmpty ? '流水线需要至少一个管理人员' : null}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-pipeline"
      />
    </div>
  );
}

/* ── 管理人员 chips ───────────────────────────────────────────────────────── */

/**
 * 管理人员输入：回车 / 逗号添加，输入框为空时退格删最后一个，去重（大小写不敏感），每个 chip 可移除。
 *
 * 为什么不用 `form.tsx` 的 `ChipEditor`：那个只吃回车、且由调用方决定去重口径；这里的三条
 * 交互（逗号成批、退格回删、大小写不敏感去重）是**这个字段特有**的，塞进通用件会让另一个
 * 调用点（标签白名单）莫名其妙也获得退格回删。
 */
function ManagersChips({
  values,
  onChange,
  disabled,
  disabledReason,
  error,
}: {
  values: readonly string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  disabledReason: string;
  error: string | null;
}) {
  const [text, setText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const commit = (raws: readonly string[]): void => {
    const next = [...values];
    let rejected: string | null = null;
    for (const raw of raws) {
      const login = raw.trim().replace(/^@+/u, '');
      if (login === '') continue;
      if (!LOGIN_RE.test(login)) {
        rejected = `「${login}」不是合法 GitHub login（1–39 位字母、数字或连字符）`;
        continue;
      }
      if (next.some((entry) => entry.toLowerCase() === login.toLowerCase())) {
        rejected = `「${login}」已经在名单里`;
        continue;
      }
      if (next.length >= MANAGERS_MAX) {
        rejected = `最多 ${String(MANAGERS_MAX)} 个管理人员`;
        break;
      }
      next.push(login);
    }
    setInputError(rejected);
    if (next.length !== values.length) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit([text]);
      setText('');
      return;
    }
    if (event.key === 'Backspace' && text === '' && values.length > 0 && !disabled) {
      event.preventDefault();
      onChange(values.slice(0, -1));
    }
  };

  const shownError = inputError ?? error;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor="pipeline-managers" className="text-xs font-medium text-muted-foreground">
        管理人员（GitHub login）
      </label>

      <ul className="flex min-h-6 flex-wrap items-center gap-1" data-testid="pipeline-managers-chips">
        {values.length === 0 ? (
          <li className="text-xs text-muted-foreground">（空：服务端会拒收，先加一个管理员）</li>
        ) : null}
        {values.map((entry) => (
          <li key={entry}>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
              {entry}
              <button
                type="button"
                aria-label={`移除 ${entry}`}
                disabled={disabled}
                title={disabled ? disabledReason : `移除 ${entry}`}
                onClick={() => {
                  onChange(values.filter((candidate) => candidate !== entry));
                }}
                className="rounded-full px-1 py-0.5 leading-none text-muted-foreground transition-[color] duration-[120ms] ease-out-quint hover:text-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-1">
        <input
          id="pipeline-managers"
          type="text"
          value={text}
          disabled={disabled}
          spellCheck={false}
          placeholder="octocat"
          title={disabled ? disabledReason : '回车或逗号添加；输入框为空时退格删最后一个'}
          aria-invalid={shownError === null ? undefined : true}
          aria-describedby={shownError === null ? 'pipeline-managers-hint' : 'pipeline-managers-error'}
          onChange={(event) => {
            const raw = event.target.value;
            setInputError(null);
            if (!raw.includes(',')) {
              setText(raw);
              return;
            }
            // 逗号 = 批量提交（粘贴一串 login 时最常用）
            setText('');
            commit(raw.split(','));
          }}
          onKeyDown={onKeyDown}
          className={cn(
            'h-[var(--control-sm)] w-full max-w-56 min-w-0 rounded-md border bg-card px-2 font-mono text-sm text-foreground',
            'transition-[border-color,background-color] duration-[120ms] ease-out-quint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
            'disabled:cursor-not-allowed disabled:opacity-60',
            shownError === null ? 'border-input' : 'border-danger',
          )}
        />
        <button
          type="button"
          onClick={() => {
            commit([text]);
            setText('');
          }}
          disabled={disabled || text.trim() === ''}
          title={disabled ? disabledReason : '加入名单（回车同效）'}
          data-testid="pipeline-managers-add"
          className="h-[var(--control-sm)] shrink-0 rounded-md border border-border px-2 text-xs text-foreground transition-[background-color,color,border-color] duration-[120ms] ease-out-quint hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          添加
        </button>
      </div>

      <div aria-live="polite">
        {shownError === null ? (
          <p id="pipeline-managers-hint" className="text-2xs leading-relaxed text-muted-foreground">
            回车或逗号添加 · 退格删最后一个 · 大小写不敏感去重
          </p>
        ) : (
          <p id="pipeline-managers-error" className="text-xs text-danger-fg" role="alert">
            {shownError}
          </p>
        )}
      </div>
    </div>
  );
}
