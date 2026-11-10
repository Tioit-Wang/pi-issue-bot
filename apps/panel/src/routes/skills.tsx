import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { Select } from '../components/ui/select.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.tsx';
import { ApiError } from '../lib/api.ts';
import { EMPTY, formatCount, formatTimeCell } from '../lib/format.ts';
import {
  useSkillDelete,
  useSkillDetail,
  useSkillPatch,
  useSkillUpload,
  useSkillVersions,
  useSkills,
} from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
/*
 * 技能的 DTO 直接取自契约本体：`lib/contract.ts` 还没有再导出技能这一组，而本次改动不允许碰它
 * （相对路径的取舍见 `lib/api.ts` 顶部同一段说明）。
 */
import type {
  SkillDetail,
  SkillFileMeta,
  SkillListItem,
  SkillSourceKind,
  SkillValidation,
  SkillVersion,
} from '../../../../packages/contract/src/index.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 技能页（R9；数据源 `GET /api/skills` 等，spec `docs/spec/skill-management.md` §6）。
 *
 * 这页是面板里**第一个有写操作**的页面，所以三件事必须自己说清楚：
 *
 *  1. **写操作不是「编辑内容」，而是「换一份内容」**：上传 zip = 新建/新版本（上传即生效，
 *     同 `name` 再传 = 版本 +1）；开关 = `PATCH {enabled}`；删除 = 软删（`source='upload'`
 *     才谈得上硬删，面板不提供）。正文编辑（`PATCH {body}`）留到后续，这一版只读展示。
 *  2. **开关不做乐观更新**：服务端是唯一事实源（同 `name` 的覆盖关系会影响实际生效的技能），
 *     点下去等 `PATCH` 回来再刷列表，失败就贴错误，不假装成功。
 *  3. **「被谁覆盖」必须看得见**（spec R6）：同名技能并存时，列表里给落选那份挂灰标，
 *     否则用户会以为「我传了新版本怎么没生效」。
 *
 * 视觉沿用 `/issues`：标题 + 说明 + 右侧操作、一行一条（10px 圆角 hover 底、无分隔线）、
 * 副信息 11px 灰字。详情用**行内展开**（不是右侧栏）：技能列表短、字段多，展开比侧栏
 * 更能保住「一行扫完」的读法，也避免窄屏上侧栏变成一大块。
 */

/** 只认识的筛选键：同步 URL 时**只动这几个**，其余原样保留（例如 MSW 的 `?mock=error`）。 */
const FILTER_KEYS = ['scope', 'source', 'enabled'] as const;

type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

/** 来源三值 → 中文（契约 `skillSourceSchema`：`builtin` / `repo-file` / `upload`）。 */
const SOURCE_LABEL: Record<SkillSourceKind, string> = {
  builtin: '内置',
  'repo-file': '仓库文件',
  upload: '面板上传',
};

/** 来源 → 徽章语义：内置最弱（描边）、仓库文件（次要）、面板上传最醒目（实心）。 */
const SOURCE_VARIANT: Record<SkillSourceKind, 'outline' | 'secondary' | 'default'> = {
  builtin: 'outline',
  'repo-file': 'secondary',
  upload: 'default',
};

/**
 * 上传失败 → 人话。
 *
 * spec §9 的错误码（`SKILL_ZIP_INVALID` 等）与 HTTP 层码（`bad-request` / `payload-too-large`
 * / `forbidden` / `conflict`）都认：服务端在哪一层拒绝，用户都要知道**为什么**、**怎么办**。
 */
const UPLOAD_ERROR_HINT: Record<string, string> = {
  'bad-request': 'zip 不合法或校验失败（必须含且只含一个 SKILL.md，frontmatter 要合规）',
  'payload-too-large': 'zip 超过 5 MB 上限',
  forbidden: '写操作被拒：缺 X-Pi-Bot-CSRF 头，或服务端 PI_BOT_PANEL_WRITE=off',
  conflict: '同名技能已存在于该作用域（先删除，或改用另一个名字）',
  'not-found': '技能不存在（可能已被别人删掉）',
  SKILL_ZIP_INVALID: 'zip 里必须**有且只有**一个 SKILL.md（允许一层包裹目录）',
  SKILL_ZIP_UNSAFE: 'zip 内含不安全路径 / 符号链接 / 超体积条目，已拒绝',
  SKILL_FRONTMATTER_INVALID: 'frontmatter 不符合技能契约（name / outputs / allowed-tools 等）',
  SKILL_NAME_CONFLICT: '同名技能已存在于该作用域',
  SKILL_WRITE_DISABLED: '面板写操作已关闭（PI_BOT_PANEL_WRITE=off）',
  SKILL_VERSION_NOT_FOUND: '指定的版本不存在',
};

/** `12_288` → `12 KB`；`1_258_291` → `1.2 MB`（列表里不显示长串字节数）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatCount(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(kb / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** 作用域：`global` → 全局；`repo` → `owner/name`（取不到时兜底成「仓库」）。 */
function scopeText(item: Pick<SkillListItem, 'scope' | 'repo'>): string {
  if (item.scope === 'repo') return item.repo ?? '仓库';
  return '全局';
}

/** frontmatter 的值 → 一行文本（数组用逗号、对象退化成 JSON，绝不显示 `[object Object]`）。 */
function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (Array.isArray(value)) {
    return value.length === 0
      ? EMPTY
      : value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** 写操作失败 → 一句话（带 HTTP 状态与错误码，便于对 spec §9 查表）。 */
function describeWriteError(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    const hint = UPLOAD_ERROR_HINT[error.code];
    return `${action}失败（HTTP ${String(error.status)} ${error.code}）：${hint ?? error.message}`;
  }
  if (error instanceof Error) return `${action}失败：${error.message}`;
  return `${action}失败：未知错误`;
}

function describeUploadError(error: unknown): string {
  if (error instanceof ApiError) {
    const hint = UPLOAD_ERROR_HINT[error.code];
    return `上传失败（HTTP ${String(error.status)} ${error.code}）：${hint ?? error.message}`;
  }
  if (error instanceof Error) return `上传失败：${error.message}`;
  return '上传失败：未知错误';
}

function readFilters(params: URLSearchParams): Filters {
  const value = (key: FilterKey): string => params.get(key) ?? '';
  return { scope: value('scope'), source: value('source'), enabled: value('enabled') };
}

export function SkillsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);

  const query = useMemo(() => {
    const next: { scope?: SkillListItem['scope']; source?: SkillSourceKind; enabled?: 'true' | 'false' } = {};
    if (filters.scope === 'global' || filters.scope === 'repo') next.scope = filters.scope;
    if (filters.source !== '') next.source = filters.source as SkillSourceKind;
    if (filters.enabled === 'true' || filters.enabled === 'false') next.enabled = filters.enabled;
    return next;
  }, [filters.scope, filters.source, filters.enabled]);

  const { data, error, isLoading, isFetching } = useSkills(query);
  const skills = useMemo(() => data?.skills ?? [], [data]);
  const anyFilter = FILTER_KEYS.some((key) => filters[key] !== '');

  /** 详情展开：一次只展开一条（列表短，没必要同时铺开多个正文）。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const patch = useSkillPatch();
  const remove = useSkillDelete();
  const upload = useSkillUpload();

  /** 正在被改的那一行（`PATCH` 的 variables），用来禁用那一行的开关，不锁整页。 */
  const togglingId = patch.isPending ? (patch.variables?.id ?? null) : null;
  const deletingId = remove.isPending ? (remove.variables ?? null) : null;

  const setFilter = (key: FilterKey, value: string): void => {
    // 复制一份再改：`?mock=error` 这类外部参数必须原样留着
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const clearFilters = (): void => {
    const next = new URLSearchParams(searchParams);
    for (const key of FILTER_KEYS) next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const toggleEnabled = (item: SkillListItem): void => {
    setNotice(null);
    patch.mutate(
      { id: item.id, patch: { enabled: !item.enabled } },
      { onError: (error) => { setNotice({ kind: 'error', text: describeWriteError(error, '切换启用状态') }); } },
    );
  };

  const deleteSkill = (item: SkillListItem): void => {
    const text = `删除技能 ${item.name}（${scopeText(item)}）？\n软删后列表里不再出现，磁盘内容按保留期清理。`;
    // jsdom 的 confirm 是 no-op，测试里用 spyOn 显式返回 true
    if (!window.confirm(text)) return;
    setNotice(null);
    remove.mutate(item.id, {
      onSuccess: () => {
        setExpandedId((current) => (current === item.id ? null : current));
        setNotice({ kind: 'ok', text: `已删除 ${item.name}` });
      },
      onError: (error) => { setNotice({ kind: 'error', text: describeWriteError(error, '删除') }); },
    });
  };

  const onPickFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // 清空 value：同一个文件再选一次也要触发 change
    event.target.value = '';
    if (file === undefined) return;

    setNotice(null);
    // 选完立刻传（上传即生效，spec D0）；不排队、不再确认
    upload.mutate(file, {
      onSuccess: (result) => {
        setNotice({ kind: 'ok', text: `已上传 ${result.skill.name}（v${formatCount(result.version)}）` });
      },
      onError: (error) => { setNotice({ kind: 'error', text: describeUploadError(error) }); },
    });
  };

  return (
    <PageShell
      title="技能"
      description="上传即生效；关掉即不可用 · 同名技能按「仓库 > 全局 > 仓库文件 > 内置」取高优先级"
      actions={
        <div className="flex items-center gap-2">
          {isFetching && !isLoading ? (
            <span className="text-xs text-muted-foreground" data-testid="skills-refreshing">
              刷新中…
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={!anyFilter}
            onClick={clearFilters}
            data-testid="skills-clear"
          >
            清除筛选
          </Button>
          <Button
            size="sm"
            disabled={upload.isPending}
            aria-busy={upload.isPending}
            onClick={() => {
              fileInputRef.current?.click();
            }}
            data-testid="skills-upload"
          >
            {upload.isPending ? '上传中…' : '上传 zip'}
          </Button>
          {/* 隐藏的真实 file input：accept 只约束选择器，真正的校验在服务端 */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            data-testid="skills-upload-input"
            onChange={onPickFile}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="skills-filters">
          <Select
            aria-label="作用域筛选"
            options={[
              { value: 'global', label: '全局' },
              { value: 'repo', label: '仓库' },
            ]}
            placeholder="全部作用域"
            value={filters.scope}
            onChange={(event) => {
              setFilter('scope', event.target.value);
            }}
          />
          <Select
            aria-label="来源筛选"
            options={[
              { value: 'builtin', label: '内置' },
              { value: 'repo-file', label: '仓库文件' },
              { value: 'upload', label: '面板上传' },
            ]}
            placeholder="全部来源"
            value={filters.source}
            onChange={(event) => {
              setFilter('source', event.target.value);
            }}
          />
          <Select
            aria-label="启停筛选"
            options={[
              { value: 'true', label: '仅启用' },
              { value: 'false', label: '仅停用' },
            ]}
            placeholder="全部状态"
            value={filters.enabled}
            onChange={(event) => {
              setFilter('enabled', event.target.value);
            }}
          />
          <span className="text-[11px] text-muted-foreground" data-testid="skills-count">
            共 {formatCount(skills.length)} 个
          </span>
        </div>

        {notice === null ? null : (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            data-testid={notice.kind === 'error' ? 'skills-notice-error' : 'skills-notice-ok'}
            className={cn(
              'px-1 text-[11px]',
              notice.kind === 'error' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
            )}
          >
            {notice.text}
          </p>
        )}
      </div>

      {/*
        空态自己画（不用 `AsyncSection` 的 `emptyText`）：筛选后为空需要**一个「清除筛选」按钮**，
        而 `emptyText` 只收字符串。四态锚点仍按约定：`skills-{loading,error,content}` + `skills-empty`。
      */}
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={false}
        testId="skills"
        skeleton={
          <div className="flex flex-col gap-1">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={`skills-skeleton-${String(index)}`} className="h-12 w-full rounded-[10px]" />
            ))}
          </div>
        }
      >
        {skills.length === 0 ? (
          <div
            data-testid="skills-empty"
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
          >
            {anyFilter ? (
              <>
                <p>没有符合条件的技能。</p>
                <Button variant="outline" size="sm" onClick={clearFilters} data-testid="skills-empty-clear">
                  清除筛选
                </Button>
              </>
            ) : (
              <>
                <p>还没有任何技能 —— 传一个含 SKILL.md 的 zip（≤ 5 MB）就会出现在这里。</p>
                <p className="text-[11px] text-muted-foreground/80">
                  同 `name` 再传一次就是新版本；关掉开关即对下一次任务不可用。
                </p>
              </>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-px" data-testid="skills-list">
            {skills.map((item) => (
              <SkillRow
                key={item.id}
                item={item}
                overrideName={
                  item.overriddenBy === null
                    ? null
                    : (skills.find((candidate) => candidate.id === item.overriddenBy)?.name ?? item.overriddenBy)
                }
                expanded={expandedId === item.id}
                toggling={togglingId === item.id}
                deleting={deletingId === item.id}
                onToggleDetail={() => {
                  setExpandedId((current) => (current === item.id ? null : item.id));
                }}
                onToggleEnabled={() => {
                  toggleEnabled(item);
                }}
                onDelete={() => {
                  deleteSkill(item);
                }}
              />
            ))}
          </ul>
        )}
      </AsyncSection>
    </PageShell>
  );
}

/** 一行 = 一个技能。三段：名字/描述/版本/大小/开关 / 来源·作用域·覆盖·时间 / （展开后）详情。 */
function SkillRow({
  item,
  overrideName,
  expanded,
  toggling,
  deleting,
  onToggleDetail,
  onToggleEnabled,
  onDelete,
}: {
  item: SkillListItem;
  /** 覆盖者名字（`overriddenBy` 是 id，页面负责回查）；`null` = 没被覆盖。 */
  overrideName: string | null;
  expanded: boolean;
  toggling: boolean;
  deleting: boolean;
  onToggleDetail: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const time = formatTimeCell(item.updatedAt);

  return (
    <li data-testid={`skill-item-${item.id}`} className="min-w-0">
      <div
        className={cn(
          'flex min-w-0 flex-col gap-0.5 rounded-[10px] px-2 py-1.5 transition-colors',
          expanded ? 'bg-foreground/[0.05]' : 'hover:bg-foreground/[0.05]',
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            className="flex shrink-0 items-center rounded-md py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={expanded}
            aria-label={`${expanded ? '收起' : '展开'} ${item.name} 详情`}
            data-testid={`skill-expand-${item.id}`}
            onClick={onToggleDetail}
          >
            <span aria-hidden="true" className="inline-block w-3 text-[9px]">
              {expanded ? '▾' : '▸'}
            </span>
          </button>

          <span className="shrink-0 font-mono text-[13px] text-foreground" data-testid="skill-row-name">
            {item.name}
          </span>

          <span
            className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
            title={item.description}
            data-testid="skill-row-description"
          >
            {item.description}
          </span>

          <span className="shrink-0 font-mono text-[11px] text-muted-foreground" data-testid="skill-row-version">
            v{formatCount(item.currentVersion)}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="skill-row-size">
            {formatBytes(item.sizeBytes)}
          </span>

          <EnabledSwitch item={item} pending={toggling} onToggle={onToggleEnabled} />

          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
            disabled={deleting}
            data-testid={`skill-delete-${item.id}`}
            onClick={onDelete}
          >
            {deleting ? '删除中…' : '删除'}
          </Button>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-[18px] text-[11px] text-muted-foreground">
          <Badge variant={SOURCE_VARIANT[item.source]} data-testid="skill-row-source">
            {SOURCE_LABEL[item.source]}
          </Badge>
          <span className="font-mono" data-testid="skill-row-scope">
            {scopeText(item)}
          </span>
          <span aria-hidden="true">·</span>
          <time className="text-muted-foreground/80" title={time.title} data-testid="skill-row-updated">
            {time.text}
          </time>
          {overrideName === null ? null : (
            <span
              className="rounded-full bg-muted px-1.5 py-px text-muted-foreground"
              title="同名的更高优先级技能正在生效；这一份不会被执行"
              data-testid="skill-row-overridden"
            >
              被 {overrideName} 覆盖
            </span>
          )}
          {item.enabled ? null : <span className="text-muted-foreground/80">已停用</span>}
        </div>
      </div>

      {expanded ? <SkillDetailPanel id={item.id} /> : null}
    </li>
  );
}

/** 真 `<button role="switch">`：键盘可聚焦、状态走 `aria-checked`（不是纯 CSS 假开关）。 */
function EnabledSwitch({
  item,
  pending,
  onToggle,
}: {
  item: SkillListItem;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={item.enabled}
      aria-label={`${item.name}（${scopeText(item)}）启用状态`}
      disabled={pending}
      data-testid={`skill-toggle-${item.id}`}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-4 w-[26px] shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        item.enabled ? 'bg-emerald-500/70' : 'bg-muted-foreground/30',
        pending && 'opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block size-3 rounded-full bg-white shadow transition-transform',
          item.enabled ? 'translate-x-[11px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}

/**
 * 详情：frontmatter 只读表格 + 正文只读（`<pre>`，保留换行、可滚动）+ 文件清单 +
 * 校验结果 + 版本列表。只在展开时才挂载，所以没展开的行不会发 `GET /api/skills/:id`。
 */
function SkillDetailPanel({ id }: { id: string }) {
  const detail = useSkillDetail(id);
  const versions = useSkillVersions(id);

  return (
    <div className="mb-1 ml-5 mr-2 mt-1" data-testid={`skill-detail-${id}`}>
      <AsyncSection
        isLoading={detail.isLoading}
        error={detail.error}
        isEmpty={false}
        testId="skill-detail"
        skeleton={<Skeleton className="h-28 w-full rounded-[10px]" />}
      >
        {detail.data === undefined ? null : (
          <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-card/60 px-3 py-2.5">
            <FrontmatterCard detail={detail.data} />
            <BodyCard body={detail.data.body} />
            <FilesCard files={detail.data.files} />
            <ValidationCard validation={detail.data.validation} />
            <VersionsCard
              currentVersion={detail.data.currentVersion}
              versions={versions.data?.versions}
              loading={versions.isLoading}
              error={versions.error}
            />
          </div>
        )}
      </AsyncSection>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <CardTitle className="text-[12px] text-muted-foreground">{children}</CardTitle>;
}

function FrontmatterCard({ detail }: { detail: SkillDetail }) {
  const entries = Object.entries(detail.frontmatter);
  return (
    <Card className="border-0 bg-transparent" data-testid="skill-detail-frontmatter">
      <CardHeader className="px-0 pt-0">
        <SectionTitle>frontmatter</SectionTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {entries.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">（没有 frontmatter）</p>
        ) : (
          <Table className="text-[11px]">
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className="h-6 px-1 font-normal text-muted-foreground">键</TableHead>
                <TableHead className="h-6 px-1 font-normal text-muted-foreground">值</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(([key, value]) => (
                <TableRow key={key} className="border-0 hover:bg-foreground/[0.03]">
                  <TableCell className="w-[9rem] px-1 py-1 font-mono whitespace-nowrap text-foreground/80">
                    {key}
                  </TableCell>
                  <TableCell className="px-1 py-1 break-words text-muted-foreground">
                    {formatFrontmatterValue(value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function BodyCard({ body }: { body: string }) {
  return (
    <Card className="border-0 bg-transparent">
      <CardHeader className="px-0 pt-0">
        <SectionTitle>正文（只读）</SectionTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <pre
          className="max-h-80 overflow-auto rounded-md bg-foreground/[0.04] p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground/80"
          data-testid="skill-detail-body"
        >
          {body === '' ? '（空正文）' : body}
        </pre>
      </CardContent>
    </Card>
  );
}

function FilesCard({ files }: { files: SkillFileMeta[] }) {
  return (
    <Card className="border-0 bg-transparent" data-testid="skill-detail-files">
      <CardHeader className="px-0 pt-0">
        <SectionTitle>文件清单</SectionTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {files.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">（没有附带文件）</p>
        ) : (
          <ul className="flex flex-col gap-px text-[11px]">
            {files.map((file) => (
              <li key={file.path} className="flex items-center justify-between gap-2 px-1 py-0.5">
                <span className="min-w-0 truncate font-mono text-foreground/80" title={file.sha256}>
                  {file.path}
                </span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(file.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** 校验结果：`ok` 绿、`errors` 红、`warnings` 黄（spec R1/R3 要能看出「有没有告警」）。 */
function ValidationCard({ validation }: { validation: SkillValidation }) {
  return (
    <Card className="border-0 bg-transparent" data-testid="skill-detail-validation">
      <CardHeader className="px-0 pt-0">
        <SectionTitle>校验</SectionTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-0 pb-0 text-[11px]">
        <div className="flex flex-wrap items-center gap-1">
          {validation.ok ? <Badge variant="success">校验通过</Badge> : <Badge variant="danger">校验失败</Badge>}
          <span className="text-muted-foreground">
            {formatCount(validation.errors.length)} 个错误 ·{' '}
            {formatCount(validation.warnings.length)} 个告警
          </span>
        </div>
        {validation.errors.map((message, index) => (
          <p key={`error-${String(index)}`} className="text-red-600 dark:text-red-400">
            ✕ {message}
          </p>
        ))}
        {validation.warnings.map((message, index) => (
          <p key={`warning-${String(index)}`} className="text-amber-600 dark:text-amber-400">
            ! {message}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

/** 版本列表：倒序（新 → 旧），当前版本打「当前」标；回滚不在这一版的范围（spec R9 的后续项）。 */
function VersionsCard({
  currentVersion,
  versions,
  loading,
  error,
}: {
  currentVersion: number;
  versions: SkillVersion[] | undefined;
  loading: boolean;
  error: unknown;
}) {
  return (
    <Card className="border-0 bg-transparent" data-testid="skill-detail-versions">
      <CardHeader className="px-0 pt-0">
        <SectionTitle>版本</SectionTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-px px-0 pb-0 text-[11px]">
        {error !== null && error !== undefined ? (
          <p className="text-destructive">版本列表读取失败（{describeWriteError(error, '读取版本')}）</p>
        ) : loading ? (
          <p className="text-muted-foreground">读取中…</p>
        ) : versions === undefined || versions.length === 0 ? (
          <p className="text-muted-foreground">（没有版本记录）</p>
        ) : (
          versions.map((version) => (
            <div
              key={version.version}
              className="flex items-center gap-2 px-1 py-0.5"
              data-testid="skill-version-row"
            >
              <span className="font-mono text-foreground/80">v{formatCount(version.version)}</span>
              {version.version === currentVersion ? (
                <Badge variant="outline" data-testid="skill-version-current">
                  当前
                </Badge>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {formatCount(version.files.length)} 个文件 ·{' '}
                {formatBytes(version.files.reduce((sum, file) => sum + file.bytes, 0))}
              </span>
              <time
                className="shrink-0 text-muted-foreground/80"
                title={formatTimeCell(version.createdAt).title}
              >
                {formatTimeCell(version.createdAt).text}
              </time>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
