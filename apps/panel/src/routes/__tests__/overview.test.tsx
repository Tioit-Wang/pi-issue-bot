import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { overviewMock } from '../../mocks/handlers/overview.ts';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { forgetLastRepo, rememberLastRepo } from '../../lib/repo-route.ts';
import type { IssueListItem, TaskListItem } from '../../lib/contract.ts';
import { OverviewPage } from '../overview.tsx';

/**
 * 全局工作台首页（`/`）—— 断言**信息架构**而不是像素：
 *
 * ① `home-todo`：失败 / 超时·停滞 / 待人回答 / 配置非法四类对象行，按紧急度排序，
 *    就地动作（看详情 / 重跑禁用 + title / 打开 GitHub），空态是一句事实 + 一个动作；
 * ② `home-timeline`：`/api/audit` 的连续时间轴，按天分组；
 * ③ `home-repos`：对象列表（不是卡片网格），标出启用 / dry-run / 配置非法 + 最近活动；
 * ④ `home-trend-chart`：全页唯一的图，图例可点隐藏，窗口切换写进 URL（`?window=7d`）；
 * ⑤ `home-actions`：「暂停全部」缺写接口必须禁用，导出审计是真链接。
 */
const server = setupServer(...createHandlers());

const NOW = Date.now();
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function failedTask(): TaskListItem {
  return {
    id: 't-fail-1',
    repo: 'acme/widgets',
    source: 'command',
    command: '/review-pr',
    targetKind: 'pr',
    targetNumber: 42,
    headSha: 'abcdef1234567890',
    status: 'failed',
    failureClass: 'timeout',
    outcome: 'failed',
    actorLogin: 'alice',
    queuedAt: minutesAgo(40),
    startedAt: minutesAgo(39),
    endedAt: minutesAgo(12),
    durationMs: 1_620_000,
    costUsd: 0.0123,
    dryRun: false,
  };
}

function issueRow(overrides: Partial<IssueListItem>): IssueListItem {
  return {
    repo: 'acme/widgets',
    kind: 'issue',
    number: 17,
    title: "EACCES: permission denied, open '/var/run/app.sock'",
    url: 'https://github.com/acme/widgets/issues/17',
    state: 'open',
    stateStale: false,
    lastActivityAt: minutesAgo(30),
    humanTurns: 1,
    autoTurns: 0,
    botTurns: 1,
    lastReplyAt: null,
    lastActorLogin: 'alice',
    lastActorKind: 'human',
    awaitingReply: false,
    labels: ['bug'],
    outcomes: { succeeded: 1 },
    lastPreview: '机器人结论',
    reactionState: null,
    labelDecisions: null,
    feedback: [],
    ...overrides,
  };
}

function auditRow(id: string, at: string) {
  return {
    id,
    at,
    repo: 'acme/widgets',
    taskId: 't-fail-1',
    runId: null,
    actor: { login: 'alice', association: 'MEMBER' },
    command: '/review-pr',
    target: { kind: 'issue', number: 17, ref: null },
    intent: 'comment',
    status: 'applied',
    headSha: null,
    externalRef: null,
    approval: null,
    revertedAt: null,
    revertKind: null,
    dryRun: false,
  };
}

function stubRepos(): void {
  server.use(
    http.get('/api/repos', () =>
      HttpResponse.json({
        items: [
          {
            repo: 'acme/widgets',
            enabled: true,
            dryRun: true,
            settingsValid: true,
            settingsError: null,
            settingsUpdatedAt: null,
            source: 'installation',
            installationId: '1',
            archivedAt: null,
            updatedAt: null,
          },
          {
            repo: 'other/lib',
            enabled: false,
            dryRun: false,
            settingsValid: false,
            settingsError: 'labels 词表为空',
            settingsUpdatedAt: null,
            source: 'manual',
            installationId: null,
            archivedAt: null,
            updatedAt: null,
          },
        ],
      }),
    ),
  );
}

function stubTasks(items: readonly TaskListItem[]): void {
  server.use(
    http.get('/api/tasks', () =>
      HttpResponse.json({ items, hasMore: false, nextCursor: null, totalEstimate: items.length }),
    ),
  );
}

/** `/api/issues`：`awaiting=true` 与 `status=running` 各返回一条，其余为空。 */
function stubIssues(awaiting: IssueListItem | null, stalled: IssueListItem | null): void {
  server.use(
    http.get('/api/issues', ({ request }) => {
      const url = new URL(request.url);
      let issues: IssueListItem[] = [];
      if (url.searchParams.get('awaiting') === 'true' && awaiting !== null) issues = [awaiting];
      if (url.searchParams.get('status') === 'running' && stalled !== null) issues = [stalled];
      return HttpResponse.json({
        generatedAt: new Date(NOW).toISOString(),
        issues,
        hasMore: false,
        nextCursor: null,
      });
    }),
  );
}

function stubAudit(): void {
  const today = new Date(NOW).toISOString();
  const yesterday = new Date(NOW - 86_400_000).toISOString();
  server.use(
    http.get('/api/audit', () =>
      HttpResponse.json({
        generatedAt: today,
        items: [auditRow('a-1', today), auditRow('a-2', yesterday)],
        hasMore: false,
        nextCursor: null,
        truncated: false,
        exportLimit: 50_000,
      }),
    ),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

function renderHome(route = '/') {
  return renderWithProviders(
    <>
      <OverviewPage />
      <LocationProbe />
    </>,
    { route },
  );
}

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
  forgetLastRepo();
});
beforeEach(() => {
  stubRepos();
  stubTasks([failedTask()]);
  stubIssues(
    issueRow({ number: 18, title: '待人回答：部署脚本能改吗', awaitingReply: true }),
    // 进行中但 2 小时没动 → 停滞
    issueRow({ number: 19, title: '停滞的会话', lastActivityAt: minutesAgo(120), outcomes: { running: 1 } }),
  );
  stubAudit();
});

describe('/ 全局工作台', () => {
  it('五个区块都在：待办 / 最近活动 / 仓库 / 趋势 / 快捷', async () => {
    renderHome();

    expect(await screen.findByTestId('home-todo-content')).toBeTruthy();
    for (const testId of ['home-timeline-content', 'home-repos-content', 'home-trend-chart', 'home-actions']) {
      expect(await screen.findByTestId(testId)).toBeTruthy();
    }
    // h1 是「工作台」，不是「总览」
    expect(screen.getByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();
  });

  it('① 待办队列按紧急度排序：失败 > 停滞 > 待人回答 > 配置非法', async () => {
    renderHome();

    const list = await screen.findByTestId('home-todo-list');
    const rows = [...list.children] as HTMLElement[];
    expect(rows.length).toBe(4);
    expect(rows[0]?.getAttribute('data-testid')).toBe('home-todo-task-t-fail-1');
    // 单行结构（D4）：原因进徽章，全文进行的 `title`
    expect(rows[0]?.textContent).toContain('timeout');
    expect(rows[0]?.querySelector('a')?.getAttribute('title') ?? '').toContain('timeout');
    // 停滞（lastActivityAt 2 小时前）排在待人回答之前
    expect(rows[1]?.textContent).toContain('停滞');
    expect(rows[1]?.querySelector('a')?.getAttribute('title') ?? '').toContain('没有新活动');
    expect(rows[2]?.textContent).toContain('待人回答：部署脚本能改吗');
    expect(rows[2]?.textContent).toContain('待人回答');
    expect(rows[3]?.textContent).toContain('配置非法');
    expect(rows[3]?.textContent).toContain('other/lib');

    // 每行都是 32px 的单行（高度不随内容增长）
    for (const row of rows) {
      expect(row.className).toContain('h-8');
      expect(row.querySelectorAll(':scope > a')).toHaveLength(1);
    }
  });

  it('① 失败行有就地动作：整行是链接，动作条 hover / focus 才出现', async () => {
    renderHome();

    const row = await screen.findByTestId('home-todo-task-t-fail-1');
    const links = within(row).getAllByRole('link');
    // links[0] 是整行的主链接（Enter / 点击空白都进详情）
    expect(links[0]?.getAttribute('href')).toBe('/repos/acme__widgets/runs/t-fail-1');
    // 行内动作：看详情（同一目标）+ 打开 GitHub（外链）
    expect(links[1]?.getAttribute('href')).toBe('/repos/acme__widgets/runs/t-fail-1');
    expect(links.some((link) => link.getAttribute('href') === 'https://github.com/acme/widgets')).toBe(true);

    // 动作容器默认透明（不可见但仍在 Tab 序里），由 hover / focus-within 显现
    const cluster = row.querySelector(':scope > span:last-child');
    expect(cluster?.className).toContain('opacity-0');
    expect(cluster?.className).toContain('group-focus-within:opacity-100');

    const rerun = within(row).getByTestId('home-todo-task-t-fail-1-rerun') as HTMLButtonElement;
    expect(rerun.disabled).toBe(true);
    expect(rerun.getAttribute('title') ?? '').toContain('POST /api/tasks/:id/rerun');
  });

  it('① 无事可做时明说一句事实 + 给一个可行动作', async () => {
    stubTasks([]);
    stubIssues(null, null);
    server.use(
      http.get('/api/repos', () =>
        HttpResponse.json({
          items: [
            {
              repo: 'acme/widgets',
              enabled: true,
              dryRun: false,
              settingsValid: true,
              settingsError: null,
              settingsUpdatedAt: null,
              source: 'installation',
              installationId: '1',
              archivedAt: null,
              updatedAt: null,
            },
          ],
        }),
      ),
    );

    renderHome();

    const empty = await screen.findByTestId('home-todo-empty');
    expect(empty.textContent).toContain('当前没有需要你处理的事');
    expect(screen.getByTestId('home-todo-empty-action').getAttribute('href') ?? '').toContain('/runs');
  });

  it('② 最近活动：按天分组 + 单行（相对时间 · 对象 · intent 徽章 · @actor）', async () => {
    renderHome();

    const list = await screen.findByTestId('home-timeline-list');
    expect(within(list).getAllByTestId(/^event-/)).toHaveLength(2);
    // 今天的组与昨天的组各一个
    const groups = within(list).getAllByTestId(/^home-timeline-list-day-/);
    expect(groups).toHaveLength(2);
    expect(list.textContent).toContain('今天');
    expect(list.textContent).toContain('昨天');
    expect(list.textContent).toContain('issue#17');

    const row = within(list).getAllByTestId(/^event-/)[0] as HTMLElement;
    // 单行：intent 用徽章、actor 带 @、任务 id 只在行的 title 里
    expect(row.className).toContain('h-7');
    expect(row.textContent).toContain('评论');
    expect(row.textContent).toContain('@alice');
    expect(row.textContent).not.toContain('t-fail-1');
    expect(row.getAttribute('title') ?? '').toContain('任务 t-fail-1');
  });

  it('① 计数紧贴标题：`需要你处理 (N)`，不再挂在右侧动作区', async () => {
    renderHome();
    // 等数据到位（计数来自真实条目数，加载中不显示）
    await screen.findByTestId('home-todo-content');

    const heading = screen.getByRole('heading', { level: 2, name: /需要你处理/ });
    expect(heading.textContent).toBe('需要你处理(4)');
    const count = within(heading).getByTestId('section-count');
    expect(count.textContent).toBe('(4)');
  });

  it('③ 仓库是对象列表：状态点 + dry-run / 停用 / 配置非法 + 最近活动', async () => {
    renderHome();
    const list = await screen.findByTestId('home-repos-list');
    expect(within(list).getByTestId('home-repo-acme/widgets').textContent).toContain('dry-run');
    expect(within(list).getByTestId('home-repo-other/lib').textContent).toContain('停用');
    expect(within(list).getByTestId('home-repo-other/lib').textContent).toContain('配置非法');
    // 队列是全局口径（契约没有按仓库拆分），在分区说明里写明
    expect(screen.getByText(/队列 \d+ 待处理/)).toBeTruthy();
  });

  it('④ 趋势：图例可点隐藏，窗口切换写进 URL', async () => {
    const user = userEvent.setup();
    renderHome();

    const legend = await screen.findByTestId('home-trend-legend');
    const tasksButton = within(legend).getByRole('button', { name: '任务' });
    expect(tasksButton.getAttribute('aria-pressed')).toBe('true');
    await user.click(tasksButton);
    expect(within(screen.getByTestId('home-trend-legend')).getByRole('button', { name: '任务' }).getAttribute('aria-pressed')).toBe('false');

    await user.click(screen.getByRole('radio', { name: '7d' }));
    expect(screen.getByTestId('location').textContent).toContain('window=7d');
  });

  it('⑤ 快捷：「暂停全部」禁用 + 写明原因，导出审计与打开 GitHub 是真链接', async () => {
    rememberLastRepo('acme/widgets');
    renderHome();

    const actions = await screen.findByTestId('home-actions');
    const pause = within(actions).getByTestId('home-action-pause') as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    expect(pause.getAttribute('title') ?? '').toContain('POST /api/flags');
    expect(within(actions).getByTestId('home-action-export').getAttribute('href')).toBe('/api/audit/export.csv');
    expect(within(actions).getByTestId('home-action-github').getAttribute('href')).toBe('https://github.com/acme/widgets');
  });

  it('熔断态：`queue.pausedUntil` 非空才出提示', async () => {
    server.use(
      http.get('/api/overview', () =>
        HttpResponse.json({
          ...overviewMock(),
          queue: { depth: 12, active: 0, oldestQueuedMs: 900_000, pausedUntil: '2026-06-01T12:15:00.000Z' },
        }),
      ),
    );
    renderHome();

    expect((await screen.findByTestId('overview-paused')).textContent).toContain('全局 429 熔断中');
  });

  it('五态：空 / 错误 / 慢都有落点', async () => {
    const empty = renderHome('/?mock=empty');
    expect((await screen.findByTestId('overview-empty')).textContent).toContain('还没有任何数据');
    empty.unmount();

    const errored = renderHome('/?mock=error');
    expect((await screen.findByTestId('overview-error')).textContent).toContain('读取失败');
    errored.unmount();

    renderHome('/?mock=slow');
    expect(await screen.findByTestId('overview-loading')).toBeTruthy();
    expect(await screen.findByTestId('overview-content', undefined, { timeout: 5000 })).toBeTruthy();
  });
});
