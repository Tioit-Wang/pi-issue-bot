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
import { StatusBadge } from '../components/ui/status-badge.tsx';
import { TONE_BORDER } from '../components/ui/status.ts';
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
import { repoSettingsPath, useRepoRoute } from '../lib/repo-route.ts';
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
    /*
      面包屑由外壳统一画（`shell-breadcrumb`，`layout/AppLayout.tsx`）。这一页曾经自己画一条，
      结果是同一个位置出现两条内容相同的面包屑 —— 外壳重构后只留一处。
    */
    <div className={cn('flex min-w-0 flex-col gap-3', fillHeight && 'h-full min-h-0')}>
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
          /*
            左栏用全局令牌 `--rail-width`（280，与 Issue 队列 / 技能列表一致，`FR-7.4`）：
            自定义 `@utility w-rail` 在层叠里压过 `w-full`/`15rem` 这类写法（实机验证过），
            所以「设置页把栏收窄、把宽度让给表单」这条路走不通 —— 宽度只能从右侧九列表格那侧找，
            见 `labels-section.tsx` 的 `VOCAB_GRID`。
          */
          'grid min-w-0 gap-4 lg:grid-cols-[var(--rail-width)_minmax(0,1fr)] lg:gap-6',
          // `fillHeight`（事件绑定分区）要「自己不满就内部滚」，所以整条高度链必须通到底：
          // 1. 容器拿到 `flex-1` 的剩余高度；
          // 2. **行高也要显式撑满** —— grid 默认 `grid-template-rows: auto`，行高由内容决定，
          //    容器再有高度也不会分给行（2026-11-15 实机：外层 1064px、左栏只有 159px）；
          // 3. 子项用 `items-stretch` 拉满行高，且**不能加 `lg:sticky`** —— sticky 元素的高度
          //    恒等于自己的内容高度，一旦吸顶就再也接不到剩余空间。
          fillHeight
            ? 'min-h-0 flex-1 lg:grid-rows-[minmax(0,1fr)] lg:items-stretch'
            : 'lg:items-start',
        )}
      >
        {/* `fillHeight` 时这一层必须把行高传下去（`h-full`）：`Rail` 内部是 `flex-col` + `nav flex-1`，
            父级高度不确定时 `flex-1` 算不出剩余空间，左栏就只剩内容高度（实机 159px vs 行高 1064px）。
            同时不能再套 `lg:sticky` —— sticky 的高度恒等于内容高度。 */}
        <div className={cn('flex min-w-0 flex-col', fillHeight ? 'min-h-0 flex-1' : 'lg:sticky lg:top-14')}>
          <SettingsNav items={navItems} current={section} dirty={dirty} onNavigate={guardNavigate} />
        </div>

        {/*
          右栏宽度上限**按分区**给，不写死一个数：
          - 单列表单（通用 / 执行 / 事件绑定）用 720px：再宽一行字横跨 1400px，标签与控件的
            对应关系反而看不出来，企业级 admin 的常规做法就是「表单窄、两侧留白」；
          - 「标签」分区的词表是**九列表格**（name / 角色 / meaning / color / description /
            group / 自动对齐 / status / 移除）。塞进 720px 时每列只剩 ~70px，输入值全被截断、
            每行还要重复一遍字段标签（2026-11-16 实机复核），所以它单独放宽。
        */}
        <div
          className={cn(
            'flex w-full min-w-0 flex-col gap-3',
            section === 'labels' ? 'max-w-[1120px]' : 'max-w-[720px]',
            fillHeight && 'min-h-0 flex-1',
          )}
        >
          {pendingSection === null ? null : (
            <Alert className={cn('bg-card', TONE_BORDER.warn)} data-testid="repo-settings-dirty-guard">
              <AlertTitle className="flex flex-wrap items-center gap-1.5">
                <StatusBadge tone="warn">未保存</StatusBadge>
                当前分区有未保存的改动
              </AlertTitle>
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
    <Alert variant="destructive" data-testid="repo-settings-invalid">
      <AlertTitle className="flex flex-wrap items-center gap-1.5">
        <StatusBadge tone="danger">配置非法</StatusBadge>
        这个仓库的配置不合法（settings_valid = false）
      </AlertTitle>
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
            variant="destructive"
            size="sm"
            onClick={onRestore}
            disabled={pending}
            aria-busy={pending}
            title={pending ? '正在写入…' : '用 repoSettingsSchema 的默认值覆盖这个仓库的 settings'}
            data-testid="repo-settings-restore-defaults"
          >
            {pending ? '正在写入…' : '用部署默认覆盖（修复配置）'}
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