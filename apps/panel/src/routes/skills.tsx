/**
 * 技能（`/api/skills`；详情与版本按需取；写操作 spec §6）——**对象列表 + 抽屉详情**。
 *
 * 为什么从卡片墙改成一行一个对象：技能本质是「一条命令的实现」，用户要比较的是
 * 来源 / 输出 / 超时 / 启停这几个字段；卡片把同类字段拆散，十张卡片就没法横向比。
 * 详情（frontmatter / 正文 / 文件 / 校验 / 版本）字段多且长，放进右侧 `Sheet`，
 * 列表因此能保持一行一条的扫描节奏。
 *
 * 两条诚实标注：
 *  - `outputs` / `timeoutMs` 不在 `/api/skills` 的行里，这里按 `name` 从 `/api/system` 的
 *    能力清单 join 过来（对不上就显示 `—`，不编）；
 *  - 开关不做乐观更新：服务端是唯一事实源（同名覆盖关系会影响实际生效的技能）。
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { Section } from '../components/Section.tsx';
import { EnabledSwitch } from '../components/skills/enabled-switch.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, Sheet } from '../components/ui/dialog.tsx';
import { Select } from '../components/ui/select.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import {
  SOURCE_LABEL,
  SOURCE_TONE,
  describeSkillWriteError,
} from '../lib/skill-text.ts';
import { EMPTY, formatCount, formatDuration, formatTimeCell } from '../lib/format.ts';
import {
  useSkillDelete,
  useSkillDetail,
  useSkillPatch,
  useSkillUpload,
  useSkillVersions,
  useSkills,
  useSystem,
} from '../lib/queries.ts';
import { repoSkillsPath } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import type {
  SkillDetail,
  SkillFileMeta,
  SkillListItem,
  SkillSourceKind,
  SkillValidation,
  SkillVersion,
} from '../../../../packages/contract/src/index.ts';

const FILTER_KEYS = ['scope', 'source', 'enabled'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatCount(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(kb / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

function scopeText(item: Pick<SkillListItem, 'scope' | 'repo'>): string {
  return item.scope === 'repo' ? (item.repo ?? '仓库') : '全局';
}

function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (Array.isArray(value)) {
    return value.length === 0 ? EMPTY : value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function readFilters(params: URLSearchParams): Record<FilterKey, string> {
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

  /** 能力清单：只用来补 outputs / timeoutMs（技能接口不带这两项）。 */
  const system = useSystem();
  const capabilities = useMemo(() => {
    const map = new Map<string, { outputs: string[]; timeoutMs: number | null }>();
    for (const skill of system.data?.skills ?? []) map.set(skill.name, { outputs: skill.outputs, timeoutMs: skill.timeoutMs });
    return map;
  }, [system.data]);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillListItem | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const patch = useSkillPatch();
  const remove = useSkillDelete();
  const upload = useSkillUpload();

  const togglingId = patch.isPending ? (patch.variables?.id ?? null) : null;

  const setFilter = (key: FilterKey, value: string): void => {
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
      {
        onError: (caught) => {
          setNotice({ kind: 'error', text: describeSkillWriteError(caught, '切换启用状态') });
        },
      },
    );
  };

  const confirmDelete = (): void => {
    const item = deleteTarget;
    if (item === null) return;
    setDeleteTarget(null);
    setNotice(null);
    remove.mutate(item.id, {
      onSuccess: () => {
        setDetailId((current) => (current === item.id ? null : current));
        setNotice({ kind: 'ok', text: `已删除 ${item.name}` });
      },
      onError: (caught) => {
        setNotice({ kind: 'error', text: describeSkillWriteError(caught, '删除') });
      },
    });
  };

  const onPickFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setNotice(null);
    upload.mutate({ file }, {
      onSuccess: (result) => {
        setNotice({ kind: 'ok', text: `已上传 ${result.skill.name}（v${formatCount(result.version)}）` });
      },
      onError: (caught) => {
        setNotice({ kind: 'error', text: describeSkillWriteError(caught, '上传') });
      },
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="技能"
        description="同名技能按「仓库 > 全局 > 仓库文件 > 内置」取高优先级"
        actions={
          <div className="flex items-center gap-1.5">
            {isFetching && !isLoading ? (
              <span className="text-2xs text-faint" data-testid="skills-refreshing">
                刷新中…
              </span>
            ) : null}
            <Button variant="ghost" size="sm" disabled={!anyFilter} onClick={clearFilters} data-testid="skills-clear">
              清除筛选
            </Button>
            <Button
              size="sm"
              loading={upload.isPending}
              onClick={() => {
                fileInputRef.current?.click();
              }}
              title="上传 zip（原始二进制，≤ 5 MB）：同 name 再传一次就是新版本"
              data-testid="skills-upload"
            >
              上传 zip
            </Button>
            <input ref={fileInputRef} type="file" accept=".zip,application/zip" hidden data-testid="skills-upload-input" onChange={onPickFile} />
          </div>
        }
      />

      <Toolbar meta={<span data-testid="skills-count">共 {formatCount(skills.length)} 个</span>}>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="skills-filters">
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
        </span>
      </Toolbar>

      {notice === null ? null : (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-testid={notice.kind === 'error' ? 'skills-notice-error' : 'skills-notice-ok'}
          className={cn('text-xs', notice.kind === 'error' ? 'text-danger-fg' : 'text-success-fg')}
        >
          {notice.text}
        </p>
      )}

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={false}
        testId="skills"
        skeleton={
          <div className="flex flex-col gap-1">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={`skills-skeleton-${String(index)}`} className="h-10 w-full rounded-md" />
            ))}
          </div>
        }
      >
        {skills.length === 0 ? (
          <div
            data-testid="skills-empty"
            className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-sm"
          >
            {anyFilter ? (
              <>
                <p className="text-foreground">没有符合条件的技能。</p>
                <Button variant="secondary" size="sm" onClick={clearFilters} data-testid="skills-empty-clear">
                  清除筛选
                </Button>
              </>
            ) : (
              <>
                <p className="text-foreground">还没有任何技能 —— 传一个含 SKILL.md 的 zip（≤ 5 MB）就会出现在这里。</p>
                <p className="text-xs text-muted-foreground">同 name 再传一次就是新版本</p>
              </>
            )}
          </div>
        ) : (
          <Section first title="技能清单">
            <ul className="flex flex-col divide-y divide-border" data-testid="skills-list">
              {skills.map((item, index) => (
                <SkillRow
                  key={item.id}
                  item={item}
                  index={index}
                  capability={capabilities.get(item.name) ?? null}
                  overrideName={
                    item.overriddenBy === null
                      ? null
                      : (skills.find((candidate) => candidate.id === item.overriddenBy)?.name ?? item.overriddenBy)
                  }
                  toggling={togglingId === item.id}
                  onOpenDetail={() => {
                    setDetailId(item.id);
                  }}
                  onToggleEnabled={() => {
                    toggleEnabled(item);
                  }}
                  onDelete={() => {
                    setDeleteTarget(item);
                  }}
                />
              ))}
            </ul>
            <p className="mt-1.5 text-2xs text-faint">
              输出与超时来自 /api/system 能力清单；对不上的显示 —
            </p>
          </Section>
        )}
      </AsyncSection>

      <Sheet
        open={detailId !== null}
        onClose={() => {
          setDetailId(null);
        }}
        width="lg"
        testId="skill-detail"
        title="技能详情"
      >
        {detailId === null ? null : <SkillDetailBody id={detailId} />}
      </Sheet>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          setDeleteTarget(null);
        }}
        size="sm"
        title={`删除 ${deleteTarget?.name ?? ''}？`}
        description={deleteTarget === null ? undefined : `${scopeText(deleteTarget)} · 软删后列表里不再出现，磁盘内容按保留期清理。`}
        testId="skill-delete-confirm"
        footer={
          <>
            <Button variant="secondary" size="sm" data-testid="skill-delete-confirm-cancel" onClick={() => { setDeleteTarget(null); }}>
              取消
            </Button>
            <Button variant="danger" size="sm" data-testid="skill-delete-confirm-yes" onClick={confirmDelete}>
              删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">同名的其它作用域技能不会受影响：它可能因此重新生效（优先级见页面说明）。</p>
      </Dialog>
    </div>
  );
}

function SkillRow({
  item,
  index,
  capability,
  overrideName,
  toggling,
  onOpenDetail,
  onToggleEnabled,
  onDelete,
}: {
  item: SkillListItem;
  index: number;
  capability: { outputs: string[]; timeoutMs: number | null } | null;
  overrideName: string | null;
  toggling: boolean;
  onOpenDetail: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const time = formatTimeCell(item.updatedAt);

  return (
    <li
      data-testid={`skill-item-${item.id}`}
      className={cn('stagger-row grid min-w-0 grid-cols-1 items-center gap-x-3 gap-y-0.5 py-1.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]')}
      style={{ animationDelay: `${String(Math.min(index, 8) * 20)}ms` }}
    >
      <div className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenDetail}
            data-testid={`skill-expand-${item.id}`}
            aria-label={`打开 ${item.name} 的详情`}
            className="min-w-0 truncate rounded-sm font-mono text-sm text-foreground underline-offset-2 hover:text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <span className="font-mono" data-testid="skill-row-name">{item.name}</span>
          </button>
          <Badge tone={SOURCE_TONE[item.source]} data-testid="skill-row-source">
            {SOURCE_LABEL[item.source]}
          </Badge>
          <span className="truncate font-mono text-2xs text-faint" data-testid="skill-row-scope">
            {scopeText(item)}
          </span>
          {item.scope === 'repo' && item.repo !== null ? (
            <Link
              to={repoSkillsPath(item.repo)}
              className="shrink-0 text-2xs text-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              title={`打开 ${item.repo} 的项目技能页（这个项目自己的覆盖版在那里改）`}
              data-testid="skill-row-repo-link"
            >
              去所属项目
            </Link>
          ) : null}
          {overrideName === null ? null : (
            <span
              className="rounded-full bg-muted px-1.5 py-px text-2xs text-muted-foreground"
              title="同名的更高优先级技能正在生效；这一份不会被执行"
              data-testid="skill-row-overridden"
            >
              被 {overrideName} 覆盖
            </span>
          )}
        </span>
        <span className="mt-0.5 block min-w-0 truncate text-xs text-muted-foreground" title={item.description} data-testid="skill-row-description">
          {item.description}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-faint">
        <span data-testid="skill-row-outputs" title="允许的写回类型（/api/system 能力清单）">
          {capability === null ? EMPTY : capability.outputs.length === 0 ? '—' : capability.outputs.join(' · ')}
        </span>
        <span className="tabular" data-testid="skill-row-timeout" title="单任务超时（已截断到 30m 上限）">
          {capability === null || capability.timeoutMs === null ? EMPTY : formatDuration(capability.timeoutMs)}
        </span>
        <span className="tabular" data-testid="skill-row-version">
          v{formatCount(item.currentVersion)}
        </span>
        <span data-testid="skill-row-size">{formatBytes(item.sizeBytes)}</span>
        <time className="text-faint" title={time.title} data-testid="skill-row-updated">
          {time.text}
        </time>
      </div>

      <div className="flex items-center justify-end gap-1.5">
        {item.enabled ? null : <span className="text-2xs text-faint">已停用</span>}
        <EnabledSwitch
          checked={item.enabled}
          pending={toggling}
          label={`${item.name}（${scopeText(item)}）启用状态`}
          testId={`skill-toggle-${item.id}`}
          onToggle={onToggleEnabled}
        />
        <Button
          variant="ghost"
          size="sm"
          data-testid={`skill-delete-${item.id}`}
          onClick={onDelete}
          className="text-muted-foreground hover:text-danger-fg"
        >
          删除
        </Button>
      </div>
    </li>
  );
}

/** 详情：frontmatter / 正文 / 文件 / 校验 / 版本。只在抽屉打开时挂载，未打开不发请求。 */
function SkillDetailBody({ id }: { id: string }) {
  const detail = useSkillDetail(id);
  const versions = useSkillVersions(id);

  return (
    <div className="flex flex-col gap-3" data-testid={`skill-detail-${id}`}>
      <AsyncSection
        isLoading={detail.isLoading}
        error={detail.error}
        isEmpty={false}
        testId="skill-detail"
        skeleton={<Skeleton className="h-40 w-full rounded-md" />}
      >
        {detail.data === undefined ? null : (
          <>
            <FrontmatterBlock detail={detail.data} />
            <BodyBlock body={detail.data.body} />
            <FilesBlock files={detail.data.files} />
            <ValidationBlock validation={detail.data.validation} />
            <VersionsBlock
              currentVersion={detail.data.currentVersion}
              versions={versions.data?.versions}
              loading={versions.isLoading}
              error={versions.error}
            />
          </>
        )}
      </AsyncSection>
    </div>
  );
}

function BlockTitle({ children }: { children: string }) {
  return <p className="micro-label">{children}</p>;
}

function FrontmatterBlock({ detail }: { detail: SkillDetail }) {
  const entries = Object.entries(detail.frontmatter);
  return (
    <section data-testid="skill-detail-frontmatter">
      <BlockTitle>frontmatter</BlockTitle>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">（没有 frontmatter）</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">键</TableHead>
              <TableHead>值</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map(([key, value]) => (
              <TableRow key={key}>
                <TableCell className="font-mono text-2xs text-foreground">{key}</TableCell>
                <TableCell className="text-xs break-words text-muted-foreground">{formatFrontmatterValue(value)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function BodyBlock({ body }: { body: string }) {
  return (
    <section>
      <BlockTitle>正文（只读）</BlockTitle>
      <pre
        className="max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground"
        data-testid="skill-detail-body"
      >
        {body === '' ? '（空正文）' : body}
      </pre>
    </section>
  );
}

function FilesBlock({ files }: { files: SkillFileMeta[] }) {
  return (
    <section data-testid="skill-detail-files">
      <BlockTitle>文件清单</BlockTitle>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">（没有附带文件）</p>
      ) : (
        <ul className="flex flex-col gap-0.5 text-xs">
          {files.map((file) => (
            <li key={file.path} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-foreground" title={file.sha256}>
                {file.path}
              </span>
              <span className="tabular shrink-0 text-2xs text-faint">{formatBytes(file.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ValidationBlock({ validation }: { validation: SkillValidation }) {
  return (
    <section data-testid="skill-detail-validation" className="flex flex-col gap-1">
      <BlockTitle>校验</BlockTitle>
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone={validation.ok ? 'success' : 'danger'}>{validation.ok ? '校验通过' : '校验失败'}</Badge>
        <span className="text-muted-foreground">
          {formatCount(validation.errors.length)} 个错误 · {formatCount(validation.warnings.length)} 个告警
        </span>
      </p>
      {validation.errors.map((message, index) => (
        <p key={`error-${String(index)}`} className="text-xs text-danger-fg">
          ✕ {message}
        </p>
      ))}
      {validation.warnings.map((message, index) => (
        <p key={`warning-${String(index)}`} className="text-xs text-warn-fg">
          ! {message}
        </p>
      ))}
    </section>
  );
}

function VersionsBlock({
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
    <section data-testid="skill-detail-versions" className="flex flex-col gap-1">
      <BlockTitle>版本</BlockTitle>
      {error !== null && error !== undefined ? (
        <p className="text-xs text-danger-fg">版本列表读取失败（{describeSkillWriteError(error, '读取版本')}）</p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">读取中…</p>
      ) : versions === undefined || versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">（没有版本记录）</p>
      ) : (
        versions.map((version) => (
          <div key={version.version} className="flex items-center gap-2 text-xs" data-testid="skill-version-row">
            <span className="font-mono text-foreground">v{formatCount(version.version)}</span>
            {version.version === currentVersion ? (
              <Badge tone="success" data-testid="skill-version-current">
                当前
              </Badge>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {formatCount(version.files.length)} 个文件 · {formatBytes(version.files.reduce((sum, file) => sum + file.bytes, 0))}
            </span>
            <time className="shrink-0 text-2xs text-faint" title={formatTimeCell(version.createdAt).title}>
              {formatTimeCell(version.createdAt).text}
            </time>
          </div>
        ))
      )}
    </section>
  );
}