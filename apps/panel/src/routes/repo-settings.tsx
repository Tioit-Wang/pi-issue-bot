/**
 * 仓库设置 `/repos/:repo/settings/:section`（8 分区：v0.3 的 general / labels / triggers / limits
 * + v2.1 的 events / comment / catalog / execution）。
 *
 * 这一页面向的问题只有一个：**「我要把某个仓库调对」**。所以信息组织是
 * 「左二级导航（每项一句话现状） + 右侧连续分区表单 + 吸底保存条」，
 * 而不是五张平行的卡片：用户要知道「现在什么状态、改这些会影响什么、还有哪一区没动」。
 *
 * 三件事仍然由原草稿层保证（`use-settings-draft.ts`，本次只换信息组织与视觉）：
 *  - 每个分区独立保存（PUT 的 body 是整份 settings）；
 *  - 有未保存改动时切分区先拦一次，不当场丢掉；
 *  - 服务端是唯一事实源（不做乐观更新，失败一个字都不改草稿）。
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { Alert, AlertTitle } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Breadcrumb } from '../components/Breadcrumb.tsx';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { GeneralSection } from '../components/settings/general-section.tsx';
import { LabelsSection } from '../components/settings/labels-section.tsx';
import { V21AgentSection } from '../components/settings/v21-agent-section.tsx';
import { V21EventsSection } from '../components/settings/v21-events-section.tsx';
import type { SettingsSectionProps } from '../components/settings/section-props.ts';
import { IssueList } from '../components/settings/save-bar.tsx';
import { SettingsNav, SettingsStatusBar, sectionSummary } from '../components/settings/settings-chrome.tsx';
import { useRepoStatus } from '../components/settings/use-repo-status.ts';
import { useRestoreDefaults, useSettingsDraft } from '../components/settings/use-settings-draft.ts';
import { DEFAULT_REPO_SETTINGS } from '../../../../packages/contract/src/index.ts';
import { repoSettingsPath, repoWorkspacePath, useRepoRoute } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { normalizeSettingsSection, SETTINGS_SECTIONS, type SettingsSectionKey } from '../layout/nav.ts';
import { NotFoundPage } from './not-found.tsx';

/** 分区 key → 组件（四项，与左栏一致）。 */
const SECTION_COMPONENTS: Record<SettingsSectionKey, (props: SettingsSectionProps) => React.ReactElement> = {
  general: GeneralSection,
  events: V21EventsSection,
  labels: LabelsSection,
  execution: V21AgentSection,
};

/** 分区 key → 中文标签（面包屑与标题用）。 */
function sectionLabel(section: SettingsSectionKey): string {
  return SETTINGS_SECTIONS.find((item) => item.key === section)?.label ?? section;
}

/**
 * hash → 分区（`#pipeline`、`#prompt/classify`）。
 *
 * 路径段已经决定了分区，hash 是**深链接**：从别处（流水线分区的提示词入口、文档）
 * 指到某个分区/某个 tab 时，URL 里带得下，刷新也不丢。hash 与路径不一致时按 hash 走。
 */
function sectionFromHash(hash: string): SettingsSectionKey | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  const head = text.split('/')[0] ?? '';
  return normalizeSettingsSection(head);
}

export function RepoSettingsPage() {
  const { repo } = useRepoRoute();
  const params = useParams();
  const section = params['section'];

  if (repo === null) return <NotFoundPage />;
  if (section === undefined) return <Navigate replace to={repoSettingsPath(repo, 'general')} />;
  // 旧分区 key（comment / catalog / triggers / limits）跳转到合并后的分区，老书签不 404
  const resolved = normalizeSettingsSection(section);
  if (resolved === null) return <NotFoundPage />;
  if (resolved !== section) return <Navigate replace to={repoSettingsPath(repo, resolved)} />;

  return <SettingsBody repo={repo} section={resolved} />;
}

function SettingsBody({ repo, section }: { repo: string; section: SettingsSectionKey }) {
  const navigate = useNavigate();
  const location = useLocation();
  const result = useSettingsDraft(repo);
  const status = useRepoStatus(repo);
  const restore = useRestoreDefaults(repo);

  /** 提示词分区有第二份草稿（正文），脏状态由它报上来。 */
  const [sectionDirty, setSectionDirty] = useState(false);
  /** 有未保存改动时点了另一个分区：先停在这里问一句，而不是静默丢改动。 */
  const [pendingSection, setPendingSection] = useState<SettingsSectionKey | null>(null);

  const draft = result.kind === 'ready' ? result.state.draft : null;
  const dirty = result.kind === 'ready' && (result.state.dirty || sectionDirty);

  // 切分区 = 换草稿（草稿只在当前分区挂载期间存在），所以脏标记要跟着清掉
  useEffect(() => {
    setSectionDirty(false);
    setPendingSection(null);
  }, [section]);

  // 关标签页 / 刷新时的兜底（浏览器只会问「确定离开吗」）
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);

  const guardNavigate = (event: MouseEvent<HTMLAnchorElement>, key: SettingsSectionKey): void => {
    if (!dirty) return;
    event.preventDefault();
    setPendingSection(key);
  };

  /** 分区**内部**的跨区链接（流水线 → 提示词 tab、角色提示 → 标签）：同一套拦截，返回是否已拦下。 */
  const guardSectionLink = (event: MouseEvent<HTMLAnchorElement>, key: SettingsSectionKey): boolean => {
    if (!dirty) return false;
    guardNavigate(event, key);
    return true;
  };

  // hash 深链接（`#pipeline` / `#prompt/classify`）与路径段不一致时，按 hash 走一次（replace，不堆历史）
  const hashSection = sectionFromHash(location.hash);
  if (hashSection !== null && hashSection !== section) {
    return <Navigate replace to={`${repoSettingsPath(repo, hashSection)}${location.hash}`} />;
  }

  const Section = SECTION_COMPONENTS[section];

  const response =
    result.kind === 'ready' ? result.state.response : result.kind === 'invalid' ? result.response : null;
  const enabled = result.kind === 'ready' ? result.state.draft.enabled : (response?.enabled ?? false);
  const dryRun = result.kind === 'ready' ? result.state.draft.dry_run : (response?.dryRun ?? false);

  const navItems = SETTINGS_SECTIONS.map((item) => ({
    key: item.key,
    label: item.label,
    summary: draft === null ? '—' : sectionSummary(item.key, draft),
    href: repoSettingsPath(repo, item.key),
  }));

  /*
    只有「事件绑定设置」分区锁高度（它要求整页无滚动条、只有编辑区内部滚动）；
    其它分区内容长，仍按正常文档流由 `main` 滚。用条件类而不是给所有分区加 `h-full`——
    后者会让「标签 / 执行」这类长表单被裁掉且无法滚动。
  */
  const fillHeight = section === 'events';

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', fillHeight && 'h-full min-h-0')}>
      <Breadcrumb
        testId="repo-breadcrumb"
        items={[
          { label: '全部项目', to: '/' },
          { label: repo, to: repoWorkspacePath(repo) },
          { label: '设置', to: repoSettingsPath(repo) },
          { label: sectionLabel(section) },
        ]}
      />

      <PageHeader
        title={`设置 · ${sectionLabel(section)}`}
        badges={
          response === null ? (
            <span className="text-xs text-faint" data-testid="repo-settings-status-placeholder">
              {repo}
            </span>
          ) : (
            <SettingsStatusBar
              repo={repo}
              enabled={enabled}
              dryRun={dryRun}
              settingsValid={response.settingsValid}
              archivedAt={response.archivedAt}
              lastSavedAt={status.row?.settingsUpdatedAt ?? null}
              lastSavedLoading={status.isLoading}
            />
          )
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigate('/system');
            }}
            title="到系统页看这个仓库的 doctor 检查与队列"
          >
            打开系统页
          </Button>
        }
      />

      {/*
        grid 这一层必须参与高度链（`flex-1 min-h-0` + `items-start` 换成 `items-stretch`）：
        它本来是「行高由内容决定」的网格，子项拿到的是 auto 高度，于是下面所有 `flex-1`
        都算不出剩余空间——表现就是「编辑区不会随窗口变大」，这条链必须一路通到底。
      */}
      <div
        className={cn(
          'grid min-w-0 gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6',
          fillHeight ? 'min-h-0 flex-1 lg:items-stretch' : 'lg:items-start',
        )}
      >
        <div className="min-w-0 lg:sticky lg:top-14">
          <SettingsNav items={navItems} current={section} dirty={dirty} onNavigate={guardNavigate} />
        </div>

        <div className={cn('flex min-w-0 flex-col gap-3', fillHeight && 'min-h-0 flex-1')}>
          {pendingSection === null ? null : (
            <Alert tone="warn" data-testid="repo-settings-dirty-guard">
              <AlertTitle>当前分区有未保存的改动</AlertTitle>
              <div className="px-0.5 text-xs leading-relaxed">
                <p>「{sectionLabel(section)}」的改动还没保存。离开这一页会丢掉它们（服务端仍是上一份配置）。</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    data-testid="repo-settings-dirty-discard"
                    onClick={() => {
                      if (result.kind === 'ready') result.state.reset();
                      setSectionDirty(false);
                      const target = pendingSection;
                      setPendingSection(null);
                      void navigate(repoSettingsPath(repo, target));
                    }}
                  >
                    放弃改动并前往
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="repo-settings-dirty-stay"
                    onClick={() => {
                      setPendingSection(null);
                    }}
                  >
                    留在本页
                  </Button>
                </div>
              </div>
            </Alert>
          )}

          <AsyncSection
            isLoading={result.kind === 'loading'}
            error={result.kind === 'error' ? result.error : null}
            isEmpty={false}
            fill={fillHeight}
            testId="repo-settings"
            skeleton={
              <div className="flex flex-col gap-3">
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-40 w-full rounded-lg" />
              </div>
            }
          >
            {result.kind === 'invalid' ? (
              <InvalidSettings
                repo={repo}
                settingsError={result.response.settingsError}
                pending={restore.pending}
                failure={restore.failure}
                onRestore={() => {
                  restore.restore(DEFAULT_REPO_SETTINGS);
                }}
              />
            ) : result.kind === 'ready' ? (
              <div className={cn(fillHeight && 'flex min-h-0 flex-1 flex-col')} data-testid="repo-settings-section">
                <Section state={result.state} onDirtyChange={setSectionDirty} onNavigate={guardSectionLink} />
              </div>
            ) : null}
          </AsyncSection>
        </div>
      </div>
    </div>
  );
}

/**
 * `settingsValid=false`（`settings` 为 `null`）时的唯一出路：用**部署默认**覆盖。
 *
 * 不在这里渲染分区的原因：库里那份配置通不过 schema，硬套默认值去渲染表单会让「看到的值」
 * 和「库里存的值」错位；而只读展示原文的价值也有限（`settingsError` 已给出第一条路径化原因）。
 */
function InvalidSettings({
  repo,
  settingsError,
  pending,
  failure,
  onRestore,
}: {
  repo: string;
  settingsError: string | null;
  pending: boolean;
  failure: { message: string; issues: readonly { path: string | null; message: string }[] } | null;
  onRestore: () => void;
}) {
  return (
    <Alert tone="danger" data-testid="repo-settings-invalid">
      <AlertTitle>这个仓库的配置不合法（settings_valid = false）</AlertTitle>
      <div className="px-0.5 text-xs leading-relaxed">
        <p>
          {repo} 的 repos.settings 通不过 repoSettingsSchema，所以 webhook 会忽略它的事件（不会用默认值硬跑）。
          服务端保留的是最后一次合法配置。
        </p>
        {settingsError === null ? null : <p className="mt-1 font-mono text-2xs break-all">{settingsError}</p>}
        <p className="mt-2 text-2xs">
          用部署默认（repoSettingsSchema.parse({})，含 dry_run=true / enabled=true 与默认触发、标签、限额）覆盖即可恢复。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="danger"
            size="sm"
            onClick={onRestore}
            loading={pending}
            title={pending ? '正在写入…' : '用 repoSettingsSchema 的默认值覆盖这个仓库的 settings'}
            data-testid="repo-settings-restore-defaults"
          >
            用部署默认覆盖（修复配置）
          </Button>
          <span className="text-2xs">历史数据（feedback / label_decisions）不受影响，仓库行也不动。</span>
        </div>
        {failure === null ? null : (
          <div role="alert" className="mt-2 rounded-md border border-danger/40 px-2 py-1.5">
            <p className="font-medium">{failure.message}</p>
            <IssueList issues={failure.issues} testId="repo-settings-restore-issues" />
          </div>
        )}
      </div>
    </Alert>
  );
}