/**
 * 项目技能页（`/repos/:repo/skills`）——「这个项目实际会用到哪些技能」。
 *
 * 技能**只属于项目**（没有全局技能这一层），所以这一页就是技能的唯一入口：
 * 列表（本项目自己的技能 + 三个引擎内置技能）、启用开关、文件树编辑器、导入 zip。
 *
 * 两个入口，各自管一类事：
 *  - 点技能名 / 「编辑」→ **模态框**（左文件树、右纯文本；可改任一 markdown，可传 zip 覆盖本技能）；
 *  - 页面右上「导入技能 zip」→ 一个 zip 里的**多个技能目录**批量导入（新建或覆盖），逐条报结果。
 *
 * 两条不做的诚实：
 *  - 不做 Markdown 预览（`innerHTML` 渲染技能正文会变成 XSS 面），只给等宽文本域；
 *  - 不做乐观更新：`currentVersion` 由服务端决定，猜错就得回滚两次。
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Section } from '../components/Section.tsx';
import { EnabledSwitch } from '../components/skills/enabled-switch.tsx';
import { SkillEditorModal } from '../components/skills/skill-editor-modal.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { useToast } from '../components/ui/toast.tsx';
import { ApiError } from '../lib/api.ts';
import { formatCount } from '../lib/format.ts';
import { useSkillImport, useSkillPatch, useSkills } from '../lib/queries.ts';
import { useRepoRoute } from '../lib/repo-route.ts';
import {
  SOURCE_LABEL,
  SOURCE_TONE,
  describeSkillWriteError,
  isBuiltinSkillName,
  sortProjectSkills,
} from '../lib/skill-text.ts';
import { cn } from '../lib/utils.ts';
import type { SkillImportResponse, SkillListItem } from '../../../../packages/contract/src/index.ts';
import { NotFoundPage } from './not-found.tsx';
import { RepoPageFrame } from './RepoPageFrame.tsx';

export function RepoSkillsPage() {
  const { repo } = useRepoRoute();
  if (repo === null) return <NotFoundPage />;

  return (
    <RepoPageFrame repo={repo} crumb="技能">
      <RepoSkillsBody repo={repo} />
    </RepoPageFrame>
  );
}

/** 导入结果的摘要：`新建 2 个，覆盖 1 个，跳过 1 个`（计数与逐条原因都要能看到）。 */
function importSummary(result: SkillImportResponse): string {
  const created = result.imported.filter((item) => item.created).length;
  const overwritten = result.imported.length - created;
  if (result.imported.length === 0) {
    return `没有导入任何技能：${formatCount(result.errors.length)} 个目录被跳过`;
  }
  const parts = [`新建 ${formatCount(created)} 个`, `覆盖 ${formatCount(overwritten)} 个`];
  if (result.errors.length > 0) parts.push(`跳过 ${formatCount(result.errors.length)} 个`);
  return `导入完成：${parts.join('，')}`;
}

/**
 * 导入失败 → 显示服务端原文（`zip 解析失败：不是合法的 zip…`）。
 *
 * 这里**不用** `describeSkillWriteError`：它把 `bad-request` 翻成通用提示，
 * 而导入失败的具体原因（哪个目录、哪条规则）全在服务端 `message` 里。
 */
function importErrorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return '未知错误';
}

function RepoSkillsBody({ repo }: { repo: string }) {
  const toast = useToast();
  /** 本项目的技能（`?repo=owner/name`）。 */
  const project = useSkills({ repo });
  /** 三个内置技能是引擎自带的（`source=builtin`），单独取一次再并进列表。 */
  const builtin = useSkills({ repo, source: 'builtin' });

  const projectRows = useMemo(() => project.data?.skills ?? [], [project.data]);
  const builtinRows = useMemo(
    () => (builtin.data?.skills ?? []).filter((item) => isBuiltinSkillName(item.name)),
    [builtin.data],
  );

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return sortProjectSkills(
      [...builtinRows, ...projectRows].filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }),
    );
  }, [builtinRows, projectRows]);

  const overrideNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of rows) map.set(item.id, item.name);
    return map;
  }, [rows]);

  const patch = useSkillPatch();
  const importSkills = useSkillImport();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<SkillImportResponse | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  /**
   * 弹窗读的是**列表里的当前行**（不是打开时的那份快照）：
   * 保存成功会失效 `['skills']`，行一刷新，弹窗顶部的版本号就跟着变。
   */
  const editingItem = editingId === null ? null : (rows.find((item) => item.id === editingId) ?? null);
  const togglingId = patch.isPending ? (patch.variables?.id ?? null) : null;

  const toggleEnabled = (item: SkillListItem): void => {
    patch.mutate(
      { id: item.id, patch: { enabled: !item.enabled } },
      {
        onError: (caught) => {
          toast.push({ tone: 'danger', title: '切换启用状态失败', description: describeSkillWriteError(caught, '切换') });
        },
      },
    );
  };

  const onPickFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setImportResult(null);
    setImportError(null);
    // 技能只属于项目：`repo` 必填，导入一定落在当前项目
    importSkills.mutate(
      { file, repo },
      {
        onSuccess: (result) => {
          setImportResult(result);
        },
        onError: (caught) => {
          setImportError(importErrorMessage(caught));
        },
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PageHeader
        title="技能"
        description="同名技能按「本项目 > 内置」取高优先级"
        actions={
          <div className="flex items-center gap-1.5">
            {project.isFetching && !project.isLoading ? (
              <span className="text-2xs text-faint" data-testid="repo-skills-refreshing">
                刷新中…
              </span>
            ) : null}
            <Button
              size="sm"
              loading={importSkills.isPending}
              title="导入一个 zip（原始二进制，≤ 5 MB）：zip 里每个含 SKILL.md 的目录算一个技能，同名即覆盖成新版本"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              data-testid="repo-skills-import"
            >
              导入技能 zip
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              data-testid="repo-skills-import-input"
              onChange={onPickFile}
            />
          </div>
        }
      />

      {/* 导入结果：行内提示，逐条列出成功项与错误原因（只报个数字等于让用户自己猜） */}
      {importResult === null && importError === null ? null : (
        <div className="flex min-w-0 flex-col gap-0.5" data-testid="repo-skills-import-result">
          {importError === null ? null : (
            <p role="alert" className="text-xs leading-relaxed break-words text-danger-fg" data-testid="repo-skills-import-error">
              导入失败：{importError}
            </p>
          )}
          {importResult === null ? null : (
            <>
              <p
                role="status"
                className={cn(
                  'text-xs',
                  importResult.imported.length === 0 ? 'text-warn-fg' : 'text-success-fg',
                )}
                data-testid="repo-skills-import-summary"
              >
                {importSummary(importResult)}
              </p>
              {importResult.imported.map((item) => (
                <p key={item.id} className="text-xs text-muted-foreground" data-testid="repo-skills-import-item">
                  <span className="font-mono text-foreground">{item.name}</span>
                  {` v${formatCount(item.version)} · ${item.created ? '新建' : '覆盖'}`}
                </p>
              ))}
              {importResult.errors.map((message, index) => (
                <p
                  key={`import-error-${String(index)}`}
                  className="text-xs leading-relaxed break-words text-danger-fg"
                  data-testid="repo-skills-import-error-item"
                >
                  ✕ {message}
                </p>
              ))}
              {importResult.warnings.map((message, index) => (
                <p
                  key={`import-warning-${String(index)}`}
                  className="text-xs leading-relaxed break-words text-warn-fg"
                  data-testid="repo-skills-import-warning"
                >
                  ! {message}
                </p>
              ))}
            </>
          )}
        </div>
      )}

      <Section
        first
        title="本项目技能"
        count={rows.length}
        footnote="内置技能对所有项目生效；同名的本项目技能优先。"
      >
        <AsyncSection
          isLoading={project.isLoading || builtin.isLoading}
          error={project.error ?? builtin.error}
          isEmpty={false}
          testId="repo-skills"
          onRetry={() => {
            void project.refetch();
            void builtin.refetch();
          }}
          skeleton={
            <div className="flex flex-col gap-1">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={`repo-skills-skeleton-${String(index)}`} className="h-9 w-full rounded-md" />
              ))}
            </div>
          }
        >
          {projectRows.length === 0 ? (
            // 空态是一句话，不是空卡片：下面紧跟的三个内置技能已经说明了「其实有人在干活」
            <p
              className="text-xs leading-relaxed text-muted-foreground"
              data-testid="repo-skills-empty"
            >
              {builtinRows.length === 0
                ? '本项目还没有自定义技能。'
                : `本项目还没有自定义技能，下面 ${formatCount(builtinRows.length)} 个内置技能已在生效。`}
            </p>
          ) : null}

          {rows.length === 0 ? null : (
            <ul className="flex flex-col divide-y divide-border" data-testid="repo-skills-list">
              {rows.map((item, index) => {
                const overrideId = item.overriddenBy;
                const overrideName =
                  overrideId === null ? null : (overrideNames.get(overrideId) ?? overrideId);
                const editing = editingId === item.id;

                return (
                  <li
                    key={item.id}
                    data-testid={`repo-skill-item-${item.id}`}
                    className={cn('stagger-row flex min-w-0 flex-col')}
                    style={{ animationDelay: `${String(Math.min(index, 8) * 20)}ms` }}
                  >
                    <div className="grid min-w-0 grid-cols-1 items-center gap-x-3 gap-y-1 py-1.5 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(item.id);
                          }}
                          aria-expanded={editing}
                          aria-label={`打开 ${item.name} 的编辑器`}
                          data-testid={`repo-skill-open-${item.id}`}
                          className={cn(
                            'min-w-0 truncate rounded-sm font-mono text-sm text-foreground',
                            'underline-offset-2 transition-colors duration-[var(--dur-fast)] ease-out-quint',
                            'hover:text-brand hover:underline',
                            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                          )}
                          title={`编辑 ${item.name}（文件树 + 文本编辑器）`}
                        >
                          <span className="font-mono" data-testid="repo-skill-row-name">
                            {item.name}
                          </span>
                        </button>
                        <Badge tone={SOURCE_TONE[item.source]} data-testid="repo-skill-row-source">
                          {SOURCE_LABEL[item.source]}
                        </Badge>
                      </span>

                      <span
                        className="min-w-0 truncate text-xs text-muted-foreground"
                        title={item.description}
                        data-testid="repo-skill-row-description"
                      >
                        {item.description}
                      </span>

                      <span className="flex min-w-0 items-center justify-end gap-1.5">
                        <span
                          className="tabular text-2xs text-faint"
                          title="当前版本"
                          data-testid="repo-skill-row-version"
                        >
                          v{formatCount(item.currentVersion)}
                        </span>
                        {overrideName === null ? null : (
                          <span
                            className="whitespace-nowrap rounded-full bg-muted px-1.5 py-px text-2xs text-muted-foreground"
                            title={`同名的「${overrideName}」本项目版优先级更高，这一份（内置）不会被执行`}
                            data-testid="repo-skill-row-overridden"
                          >
                            已被本项目覆盖
                          </span>
                        )}
                        {item.enabled ? null : <span className="text-2xs text-faint">已停用</span>}
                        <EnabledSwitch
                          checked={item.enabled}
                          pending={togglingId === item.id}
                          label={`${item.name} 启用状态`}
                          testId={`repo-skill-toggle-${item.id}`}
                          onToggle={() => {
                            toggleEnabled(item);
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={editing}
                          data-testid={`repo-skill-edit-${item.id}`}
                          onClick={() => {
                            setEditingId(item.id);
                          }}
                        >
                          编辑
                        </Button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </AsyncSection>
      </Section>

      {/* 只在选定时挂载：不打开就不请求 `/files` */}
      {editingItem === null ? null : (
        <SkillEditorModal
          item={editingItem}
          onClose={() => {
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}
