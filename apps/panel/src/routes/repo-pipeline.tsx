import { useMemo } from 'react';
import { Link } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Breadcrumb } from '../components/Breadcrumb.tsx';
import { Section } from '../components/Section.tsx';
import { groupByStage, pipelineMetrics, sessionHealth } from '../components/pipeline/aggregate.ts';
import { StageBoard } from '../components/pipeline/stage-board.tsx';
import { GateTable } from '../components/pipeline/gate-table.tsx';
import {
  PROMPT_KIND_LABEL,
  STAGE_PROMPT_KINDS,
  SYSTEM_CONSTANTS,
  promptPointerText,
} from '../components/pipeline/pipeline-constants.tsx';
import { formatDwell, PIPELINE_CLOSE_AFTER_HOURS, SESSION_MAX_TURNS } from '../components/pipeline/pipeline-status.ts';
import { Badge } from '../components/ui/badge.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { EMPTY, formatCount } from '../lib/format.ts';
import { useIssuesInfinite, useRepoSettings } from '../lib/queries.ts';
import { repoGitHubUrl, repoSettingsPath, useRepoRoute } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { NotFoundPage } from './not-found.tsx';
import { repoCrumbs } from './RepoPageFrame.tsx';

/**
 * 流水线（`/repos/:repo/pipeline`）—— 固定三段流水线的**只读视图**。
 *
 * 一屏回答四个问题（顺序即版面顺序）：
 *  ① 现在有多少 issue 在流水线里、有几个在等我、有几个卡住了；
 *  ② 每个 issue 卡在哪一段（阶段看板）；
 *  ③ 未 ready 时收到 `@` 会怎么处置（门禁表，§8 七行）；
 *  ④ 哪些数不是配置项（系统常量）、四个提示词指针指向哪一版、阶段 2 的会话健康。
 *
 * **数据来源只有既有读接口**（本切片不新增后端）：
 *  - 看板分组、指标计数、会话健康 = 客户端按 `GET /api/issues` 的 `pipeline` 字段聚合
 *    （口径见 `components/pipeline/aggregate.ts`，含「未入流水线」一组）；
 *  - 提示词指针 = `GET /api/repos/:owner/:name/settings` 的 `settings.pipeline.*_prompt_version`；
 *  - 拿不到的数（今日自动关闭 / 已归档会话）显示 `—` 并在 `title` 里写清缺哪个接口。
 *
 * 文案：没有副标题。范围靠 eyebrow（`当前仓库 · owner/name`）、口径靠列头/脚注的 `title`。
 */
const PAGE_LIMIT = 100;

export function RepoPipelinePage() {
  const { repo } = useRepoRoute();
  if (repo === null) return <NotFoundPage />;
  return <PipelineBody repo={repo} />;
}

function PipelineBody({ repo }: { repo: string }) {
  const settings = useRepoSettings(repo);
  const query = useMemo(() => ({ repo, limit: PAGE_LIMIT }), [repo]);
  const issues = useIssuesInfinite(query);

  const loaded = useMemo(() => issues.data?.pages.flatMap((page) => page.issues) ?? [], [issues.data]);
  const now = useMemo(() => Date.now(), [issues.data]);
  const groups = useMemo(() => groupByStage(loaded, now), [loaded, now]);
  const metrics = useMemo(() => pipelineMetrics(loaded, now), [loaded, now]);
  const health = useMemo(() => sessionHealth(loaded), [loaded]);

  const totalInBoard =
    groups.format.length + groups.classify.length + groups.agent.length + groups.closed.length;

  const settingsView = settings.data ?? null;
  const pipelineSettings = settingsView?.settings?.pipeline ?? null;
  const projectVersion = settingsView?.settings?.prompt.current_version ?? null;
  const settingsIssue =
    settings.isLoading === true
      ? '读取中…'
      : settings.error !== null && settings.error !== undefined
        ? '配置读取失败'
        : settingsView?.settingsValid === false
          ? '配置无效'
          : settingsView?.settings === null
            ? '没有配置'
            : null;

  const githubUrl = repoGitHubUrl(repo);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-1.5">
        <Breadcrumb testId="repo-breadcrumb" items={repoCrumbs(repo, [{ label: '流水线' }])} />
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="micro-label">
              当前仓库 · <span className="normal-case font-mono tracking-normal">{repo}</span>
            </p>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">流水线</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {issues.isFetching && !issues.isLoading ? (
              <span className="text-xs text-muted-foreground">刷新中…</span>
            ) : null}
            <Link
              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
              to={repoSettingsPath(repo, 'pipeline')}
              title="设置页的流水线分区：管理人员、四个提示词入口、系统常量"
              data-testid="pipeline-settings-link"
            >
              阶段配置
            </Link>
          </div>
        </div>
      </header>

      <AsyncSection
        isLoading={issues.isLoading}
        error={issues.error}
        isEmpty={loaded.length === 0}
        emptyText="当前仓库还没有 issue 记录"
        emptyAction={
          githubUrl === null ? undefined : (
            <a
              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-1')}
              href={`${githubUrl}/issues`}
              target="_blank"
              rel="noreferrer"
            >
              打开 GitHub
            </a>
          )
        }
        onRetry={() => {
          void issues.refetch();
        }}
        skeletonRows={8}
        testId="pipeline"
      >
        <div className="flex min-w-0 flex-col gap-5">
          <MetricStrip metrics={metrics} />

          <div className="grid min-w-0 gap-5 lg:grid-cols-[1.6fr_1fr]">
            {/* ── 左：阶段看板 + 门禁处置 ─────────────────────────────────── */}
            <div className="flex min-w-0 flex-col gap-5">
              <Section
                first
                title="阶段看板"
                count={totalInBoard}
                actions={
                  <span className="flex items-center gap-2 text-2xs text-faint">
                    <span title="计数只作用于已加载的行：/api/issues 是游标分页，没有 pipeline 维度的聚合参数">
                      {`已加载 ${formatCount(loaded.length)} 行 · 未入流水线 ${formatCount(metrics.noRow)}`}
                    </span>
                  </span>
                }
                footnote="列内按停留时长降序；一个 issue 同一时刻只在一列里。停留时长 = 现在 − coalesce(等补充时刻, 就绪时刻, 判旧时刻, 最后活动)"
              >
                <StageBoard groups={groups} now={now} repo={repo} />
              </Section>

              <Section
                title="门禁处置"
                actions={<span className="text-2xs text-faint">未 ready 时收到 @</span>}
                footnote="来源 docs/plan-fixed-pipeline.md §8：被拦的命令不建任务，只回一条轻量提示（每 issue 每小时 1 条）"
              >
                <GateTable />
              </Section>
            </div>

            {/* ── 右：常量 / 提示词指针 / 会话健康 ─────────────────────────── */}
            <aside className="flex min-w-0 flex-col gap-5">
              <Section
                first
                title="系统常量"
                actions={<Badge variant="outline" title="编译期常量：没有 API、也不在 repos.settings 里，面板不提供编辑">只读</Badge>}
                footnote="改常量需要发版：配置里没有这些开关"
              >
                <dl className="flex min-w-0 flex-col" data-testid="system-constants">
                  {SYSTEM_CONSTANTS.map((constant) => (
                    <div
                      key={constant.name}
                      className="flex min-w-0 flex-col gap-0.5 border-b border-border py-1.5 last:border-0"
                    >
                      <div className="flex min-w-0 items-baseline justify-between gap-2">
                        <dt className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={constant.name}>
                          {constant.name}
                        </dt>
                        <dd className="shrink-0 tabular text-xs text-foreground">
                          {constant.value}
                          <span className="ml-0.5 text-2xs text-faint">{constant.unit}</span>
                        </dd>
                      </div>
                      {constant.note === undefined ? null : (
                        <p className="min-w-0 text-2xs leading-relaxed text-faint">{constant.note}</p>
                      )}
                    </div>
                  ))}
                </dl>
              </Section>

              <Section
                title="阶段提示词"
                actions={
                  <Link
                    className="text-2xs text-muted-foreground underline underline-offset-2 transition-[color] duration-[var(--dur-fast)] ease-quint hover:text-foreground"
                    to={`${repoSettingsPath(repo, 'prompt')}#pipeline`}
                    data-testid="pipeline-prompt-link"
                  >
                    去配置
                  </Link>
                }
                footnote={
                  settingsIssue === null
                    ? 'v0 = 系统默认（回落到内置默认正文）；保存即新建版本'
                    : `指针读不到：${settingsIssue}`
                }
              >
                <dl className="flex min-w-0 flex-col" data-testid="prompt-pointers">
                  <PointerRow
                    kind="project"
                    name={PROMPT_KIND_LABEL.project}
                    version={projectVersion}
                    unavailable={settingsIssue !== null}
                  />
                  {STAGE_PROMPT_KINDS.map((kind) => (
                    <PointerRow
                      key={kind}
                      kind={kind}
                      name={PROMPT_KIND_LABEL[kind]}
                      version={pipelineSettings === null ? null : versionOfStage(kind, pipelineSettings)}
                      unavailable={settingsIssue !== null}
                    />
                  ))}
                </dl>
              </Section>

              <Section
                title="会话健康"
                footnote={`复用会话按 issue 计；轮换阈值 ${String(SESSION_MAX_TURNS)} 轮 / 7 天`}
              >
                <dl className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-1.5 text-xs" data-testid="session-health">
                  <HealthItem label="复用会话" value={`${formatCount(health.sessions)} 个`} />
                  <HealthItem
                    label="平均轮次"
                    value={health.avgTurns === null ? EMPTY : `${String(health.avgTurns)} 轮`}
                    title={health.avgTurns === null ? '还没有任何阶段 2 会话（pipeline.sessionId 全为空）' : undefined}
                  />
                  <HealthItem
                    label="接近轮换"
                    value={`${formatCount(health.nearRotation)} 个`}
                    title={`session_turns ≥ ${String(SESSION_MAX_TURNS - 5)} 的会话数（到 ${String(SESSION_MAX_TURNS)} 轮轮换）`}
                  />
                  <HealthItem
                    label="已归档"
                    value={EMPTY}
                    title="缺接口：没有会话归档的查询接口（tasks / issue_pipeline 都不返回 archive 记录），这一格不编数"
                  />
                </dl>
              </Section>
            </aside>
          </div>

          <div className="flex items-center justify-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="pipeline-load-more"
              disabled={issues.hasNextPage !== true || issues.isFetchingNextPage}
              onClick={() => {
                void issues.fetchNextPage();
              }}
            >
              {issues.hasNextPage === true
                ? issues.isFetchingNextPage
                  ? '加载中…'
                  : `加载更多（已加载 ${formatCount(loaded.length)} 个）`
                : `没有更多了（共 ${formatCount(loaded.length)} 个）`}
            </Button>
          </div>
        </div>
      </AsyncSection>
    </div>
  );
}

/** 四个指针：`project` 用 `settings.prompt.current_version`，其余用 `settings.pipeline.*_prompt_version`。 */
type PipelinePromptPointers = {
  format_prompt_version: number;
  classify_prompt_version: number;
  agent_prompt_version: number;
};

function versionOfStage(kind: (typeof STAGE_PROMPT_KINDS)[number], pipeline: PipelinePromptPointers): number {
  if (kind === 'format_check') return pipeline.format_prompt_version;
  if (kind === 'classify') return pipeline.classify_prompt_version;
  return pipeline.agent_prompt_version;
}

function PointerRow({
  kind,
  name,
  version,
  unavailable,
}: {
  kind: string;
  name: string;
  version: number | null;
  unavailable: boolean;
}) {
  const pointer = version === null ? null : promptPointerText(version);
  return (
    <div
      className="flex min-w-0 items-baseline justify-between gap-2 border-b border-border py-1.5 last:border-0"
      data-testid={`prompt-pointer-${kind}`}
    >
      <dt className="shrink-0 text-xs text-muted-foreground">{name}</dt>
      <dd
        className={cn('min-w-0 truncate font-mono text-xs', pointer?.project === true ? 'text-foreground' : 'text-faint')}
        title={
          unavailable
            ? '读不到仓库配置：GET /api/repos/:owner/:name/settings 失败或 settingsValid=false'
            : version === 0
              ? 'version=0：装配时回落到内置默认正文'
              : `settings.pipeline.${kind}_prompt_version`
        }
      >
        {pointer === null ? EMPTY : pointer.text}
      </dd>
    </div>
  );
}

function HealthItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-2xs text-faint">{label}</dt>
      <dd className="min-w-0 truncate tabular text-muted-foreground" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * 四格指标条：数字 `tabular` + 紧跟的**更小一号灰字单位**，下面只放口径。
 * 不是 KPI 卡（无底、无边框、无阴影）：一格一根 hairline 竖线，读起来是一行数而不是四张卡。
 */
function MetricStrip({ metrics }: { metrics: ReturnType<typeof pipelineMetrics> }) {
  const longest = metrics.awaitingLongestMs === null ? null : formatDwell(metrics.awaitingLongestMs);

  return (
    <dl
      className="grid min-w-0 grid-cols-2 divide-border sm:divide-x xl:grid-cols-4"
      data-testid="pipeline-metrics"
    >
      <Metric
        label="在流水线"
        testId="metric-in-pipeline"
        value={formatCount(metrics.inPipeline)}
        unit="个"
        caption="当前仓库"
        title="有 issue_pipeline 行且 stage ≠ closed 的 issue 数（客户端按 /api/issues 的 pipeline 字段聚合，只算已加载的行）"
      />
      <Metric
        label="待人补充"
        testId="metric-awaiting"
        value={formatCount(metrics.awaiting)}
        unit="个"
        caption={longest === null ? '最久 —' : `最久 ${longest}`}
        tone={metrics.awaiting > 0 ? 'warn' : undefined}
        title={`state = awaiting_info：format 等作者补充（满 ${String(PIPELINE_CLOSE_AFTER_HOURS)} 小时自动关），classify 等管理员（不进关闭扫描）`}
      />
      <Metric
        label="阻塞"
        testId="metric-blocked"
        value={formatCount(metrics.blocked)}
        unit="个"
        caption={metrics.blockedMaxFails === null ? '失败 —' : `失败 ${String(metrics.blockedMaxFails)}/5`}
        tone={metrics.blocked > 0 ? 'danger' : undefined}
        title="state = blocked：运行失败或信封不合法连续 2 次；圈里的分数是这些行里最大的格式失败次数（满分 5 次自动关）"
      />
      <Metric
        label="今日自动关闭"
        testId="metric-closed-today"
        value={EMPTY}
        unit="个"
        caption="口径缺失"
        title="缺接口：/api/issues 不返回「自动关闭」的时间点（issue_pipeline.closed_at 不在 API 投影里），所以这一格显示 — 而不是编一个数"
      />
    </dl>
  );
}

function Metric({
  label,
  value,
  unit,
  caption,
  tone,
  title,
  testId,
}: {
  label: string;
  value: string;
  unit: string;
  caption: string;
  tone?: 'warn' | 'danger';
  title: string;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 first:pl-0" title={title} data-testid={testId}>
      <dt className="micro-label">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-1">
        <span
          className={cn(
            'tabular text-xl leading-none font-semibold',
            tone === 'warn' ? 'text-warn-fg' : tone === 'danger' ? 'text-danger-fg' : 'text-foreground',
          )}
        >
          {value}
        </span>
        <span className="shrink-0 text-2xs text-faint">{unit}</span>
        <span className="min-w-0 truncate text-2xs text-faint">{caption}</span>
      </dd>
    </div>
  );
}

