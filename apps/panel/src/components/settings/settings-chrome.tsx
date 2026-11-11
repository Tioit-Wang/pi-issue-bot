/**
 * 设置页的「外壳零件」：左侧二级导航、顶部状态条、草稿摘要。
 *
 * 三个都是纯展示/纯计算，不含取数（取数在 `use-settings-draft.ts` / `use-repo-status.ts`），
 * 所以可以单独渲染、单独推理。
 *
 * 摘要口径：导航每项的第二行回答「这一区现在是什么状态」，全部由**草稿**算出
 * （不读服务端第二遍）。同一套值也用在状态条上，避免两处各算一遍后对不上。
 */
import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router';
import type { RepoSettings } from '../../../../../packages/contract/src/index.ts';
import type { SettingsSectionKey } from '../../layout/nav.ts';
import { StatusDot } from '../ui/badge.tsx';
import { cn } from '../../lib/utils.ts';
import { formatCount, formatRelativeTime } from '../../lib/format.ts';
import { resolveAliasesFor } from './trigger-preview.ts';

/* ── 草稿摘要 ─────────────────────────────────────────────────────────────── */

/** 数组与原始值都按「一个叶子」算：改一个别名不该报「改了 3 处」。 */
function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

/** 草稿里「改了哪几项」（按最深的容器计数，数组算一项）。 */
export function countChangedPaths(base: unknown, draft: unknown): string[] {
  if (sameValue(base, draft)) return [];
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  if (!isPlainObject(base) || !isPlainObject(draft)) return ['.'];

  const changed: string[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
    const left = base[key];
    const right = draft[key];
    if (sameValue(left, right)) continue;
    const nested = countChangedPaths(left, right);
    if (nested.length === 1 && nested[0] === '.') changed.push(key);
    else if (nested.length === 0) changed.push(key);
    else changed.push(...nested.map((path) => `${key}.${path}`));
  }
  return changed;
}

/** 一项摘要 = 一个短句（导航第二行）。 */
export function sectionSummary(section: SettingsSectionKey, draft: RepoSettings): string {
  switch (section) {
    case 'general':
      return `${draft.enabled ? '启用' : '停用'} · ${draft.dry_run ? '干跑' : '真写'}`;
    case 'triggers': {
      const aliases = resolveAliasesFor(draft.triggers);
      const users = draft.triggers.users === 'all' ? 'all' : `${formatCount(draft.triggers.users.length)} 人`;
      return `${formatCount(aliases.length)} 个别名 · 触发人 ${users}`;
    }
    case 'labels': {
      const mapped = Object.keys(draft.labels.map).length;
      return `词表 ${formatCount(draft.labels.vocabulary.length)} · 映射 ${formatCount(mapped)} 条`;
    }
    case 'limits':
      return `评论 ${formatCount(draft.limits.max_comments_per_hour)}/h · 任务 ${formatCount(draft.limits.max_task_minutes)}m`;
    case 'pipeline': {
      // 「项目级只剩 3 类可配项」：管理人员 + 4 条提示词版本线（project 走 settings.prompt）
      const overridden =
        (draft.prompt.current_version === 0 ? 0 : 1) +
        (draft.pipeline.format_prompt_version === 0 ? 0 : 1) +
        (draft.pipeline.classify_prompt_version === 0 ? 0 : 1) +
        (draft.pipeline.agent_prompt_version === 0 ? 0 : 1);
      return `管理员 ${formatCount(draft.pipeline.managers.length)} · 项目版 ${formatCount(overridden)}/4`;
    }
    case 'prompt':
      return `v${formatCount(draft.prompt.current_version)} · ${draft.prompt.enabled ? '注入' : '关闭'}`;
  }
}

/* ── 顶部状态条 ───────────────────────────────────────────────────────────── */

/**
 * 仓库名 + 三个 tone 点（启用 / 干跑 / 配置合法）+ 最后一次保存。
 *
 * 三个点各自独立：`停用` 与 `干跑` 是两个开关，`配置合法` 是另一件事（schema 能不能解析）。
 * 所以不用一个「总体状态」把三件事揉在一起 —— 三件事同时不成立时用户要知道是哪几件。
 */
export function SettingsStatusBar({
  repo,
  enabled,
  dryRun,
  settingsValid,
  archivedAt,
  lastSavedAt,
  lastSavedLoading,
}: {
  repo: string;
  enabled: boolean;
  dryRun: boolean;
  settingsValid: boolean;
  archivedAt: string | null;
  lastSavedAt: string | null;
  lastSavedLoading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="repo-settings-status">
      <span className="font-mono text-sm text-foreground" data-testid="repo-settings-status-repo">
        {repo}
      </span>

      <StateItem
        tone={enabled ? 'success' : 'neutral'}
        label={enabled ? '启用' : '停用'}
        hint={enabled ? '该仓库的事件会被处理' : '任何 webhook 事件都不处理（仓库行保留）'}
        testId="repo-settings-status-enabled"
      />
      <StateItem
        tone={dryRun ? 'warn' : 'success'}
        label={dryRun ? '干跑' : '真写'}
        hint={dryRun ? '只产出信封与审计，不写 GitHub' : '会真的评论 / 打标 / 推分支'}
        testId="repo-settings-status-dryrun"
      />
      <StateItem
        tone={settingsValid ? 'success' : 'danger'}
        label={settingsValid ? '配置合法' : '配置非法'}
        hint={settingsValid ? 'repos.settings 通过 schema' : '通不过 schema：webhook 会忽略该仓库'}
        testId="repo-settings-status-valid"
      />
      {archivedAt === null ? null : (
        <StateItem tone="neutral" label="已归档" hint={`归档于 ${archivedAt}`} testId="repo-settings-status-archived" />
      )}

      <span className="text-xs text-faint" data-testid="repo-settings-status-saved">
        {lastSavedLoading ? '读取保存时间…' : lastSavedAt === null ? '从未保存过' : `最后一次保存 ${formatRelativeTime(lastSavedAt)}`}
      </span>
    </div>
  );
}

function StateItem({
  tone,
  label,
  hint,
  testId,
}: {
  tone: 'success' | 'warn' | 'danger' | 'neutral';
  label: string;
  hint: string;
  testId: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={hint} data-testid={testId} data-tone={tone}>
      <StatusDot tone={tone} label={label} />
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/* ── 左侧二级导航 ─────────────────────────────────────────────────────────── */

export type SettingsNavItem = { key: SettingsSectionKey; label: string; summary: string; href: string };

/**
 * 二级导航：宽屏竖排（当前项 = 品牌左条 + 8% 底），窄屏变横向滚动条。
 *
 * 为什么是 `<nav>` + 链接而不是 `Tabs`：每一项是**地址**（能贴给别人、刷新不丢），
 * `Tabs` 是同一页面里的视图切换。键盘用方向键在项间移动（与左栏同一套读法），
 * 有未保存改动时由调用方拦下导航。
 */
export function SettingsNav({
  items,
  current,
  dirty,
  onNavigate,
}: {
  items: readonly SettingsNavItem[];
  current: SettingsSectionKey;
  dirty: boolean;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, key: SettingsSectionKey) => void;
}) {
  const refs = useRef<Array<HTMLAnchorElement | null>>([]);

  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.key === current);
    const next = items[(index + step + items.length) % items.length];
    if (next === undefined) return;
    refs.current[items.indexOf(next)]?.focus();
  };

  return (
    <div
      onKeyDown={move}
      className={cn(
        'min-w-0',
        // 窄屏：一条横向滚动条，不换行、不裁切内容（且不产生整页横向滚条）
        '-mx-1 flex gap-1 overflow-x-auto px-1 pb-1',
        'lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0',
      )}
    >
      <nav aria-label="设置分区" className="flex min-w-0 gap-1 lg:w-full lg:flex-col lg:gap-0.5">
        {items.map((item, index) => {
          const active = item.key === current;
          return (
            <Link
              key={item.key}
              ref={(node) => {
                refs.current[index] = node;
              }}
              to={item.href}
              data-section-key={item.key}
              data-testid={`repo-settings-tab-${item.key}`}
              aria-current={active ? 'page' : undefined}
              onClick={(event) => {
                onNavigate(event, item.key);
              }}
              className={cn(
                'group min-w-40 shrink-0 rounded-md px-2 py-1.5 lg:min-w-0 lg:shrink',
                'transition-[background-color,color,border-color] duration-[120ms] ease-out-quint',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                active
                  ? 'bg-brand-soft lg:border-l-2 lg:border-brand lg:pl-[6px]'
                  : 'hover:bg-muted lg:border-l-2 lg:border-transparent lg:pl-[6px]',
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className={cn('text-sm font-medium', active ? 'text-brand' : 'text-foreground')}>{item.label}</span>
                {active && dirty ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-2xs text-warn-fg" title="有未保存改动">
                    <span aria-hidden className="size-1.5 rounded-full bg-warn" />
                    未保存
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block truncate text-2xs text-faint" title={item.summary} aria-hidden="true">
                {item.summary}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
