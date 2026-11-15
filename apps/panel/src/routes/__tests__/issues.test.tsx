/**
 * Issue 中心（W2-F）：表格列、筛选（服务端参数 vs 客户端过滤）、分页、四态、a11y。
 *
 * 断言方式沿用本仓库既有约定：
 *  - **请求侧**：MSW 的 `request:start` 记录真实 URL，「筛选 = 换一次请求」是观测到的事实；
 *  - **状态侧**：`AsyncSection` 的四态 `testid` 约定 `{testId}-{loading,error,empty,content}`；
 *  - **URL 侧**：`MemoryRouter` 不写 `window.location`，所以用 `LocationProbe` 渲染
 *    `useLocation().search`，断言「筛选进了 URL（刷新不丢）」。
 *
 * 数据全部由本文件自带（`server.use` 覆盖 `/api/issues` 与 `/api/repos`）：
 * 用别人正在动的 fixture 会让「筛选错了」和「fixture 改了」看起来一样。
 */
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HttpResponse, delay, http } from 'msw';
import { setupServer } from 'msw/node';
import { useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import type { IssueListItem } from '../../lib/contract.ts';
import { deriveStatus } from '../../components/issues/status.ts';
import { IssuesPage } from '../issues.tsx';
import { pickFilterOption } from './filter-helpers.tsx';

const server = setupServer(...createHandlers());

/** 每一次页面发出的请求（含 `/api/issues?...`）。 */
const requests: string[] = [];

const NOW = Date.now();
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', (event) => {
    requests.push(event.request.url);
  });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});
beforeEach(() => {
  requests.length = 0;
  // 仓库清单：`lib/repos.ts` 认 `{ repos: [...] }`（W1-C 的降级约定）
  server.use(
    http.get('/api/repos', () =>
      HttpResponse.json({
        repos: [
          { repo: 'acme/widgets', enabled: true, dryRun: false, settingsValid: true },
          { repo: 'other/lib', enabled: false, dryRun: false, settingsValid: true },
        ],
      }),
    ),
  );
 });

type RowInput = {
  number: number;
  title: string;
  repo?: string;
  state?: IssueListItem['state'];
  labels?: string[];
  awaitingReply?: boolean;
  minutesAgo?: number;
  outcomes?: IssueListItem['outcomes'];
  lastPreview?: string | null;
  reactionState?: IssueListItem['reactionState'];
};

/** 一行列表数据（只写关心的字段，其余按契约给默认值）。 */
function makeRow(input: RowInput): IssueListItem {
  const repo = input.repo ?? 'acme/widgets';
  return {
    repo,
    kind: 'issue',
    number: input.number,
    title: input.title,
    url: `https://github.com/${repo}/issues/${String(input.number)}`,
    state: input.state ?? 'open',
    stateStale: false,
    lastActivityAt: minutesAgo(input.minutesAgo ?? 30),
    humanTurns: 1,
    autoTurns: 0,
    botTurns: 1,
    lastReplyAt: null,
    lastActorLogin: 'alice',
    lastActorKind: 'human',
    awaitingReply: input.awaitingReply ?? false,
    labels: input.labels ?? [],
    outcomes: input.outcomes ?? { succeeded: 1 },
    lastPreview: input.lastPreview ?? '机器人这一轮的结论',
    reactionState: input.reactionState ?? null,
    feedback: [],
  };
}

const ROWS: IssueListItem[] = [
  makeRow({
    number: 17,
    title: "EACCES: permission denied, open '/var/run/app.sock'",
    labels: ['bug', 'needs-info'],
    awaitingReply: true,
    minutesAgo: 30,
    lastPreview: '不会。A 轮结论',
    reactionState: {
      stage: 'succeeded',
      content: 'rocket',
      appliedAt: minutesAgo(28),
      at: minutesAgo(28),
      commentId: null,
    },
  }),
  makeRow({ number: 42, title: 'CI 在 Node 22 上偶发超时', state: 'closed', labels: ['needs-info'], minutesAgo: 120 }),
  makeRow({
    number: 7,
    title: 'build 脚本能否强制 --frozen-lockfile',
    repo: 'other/lib',
    state: 'unknown',
    outcomes: { queued: 1 },
    minutesAgo: 5,
    awaitingReply: true,
  }),
  // 40 天没动：用来验证「时间窗」确实是客户端过滤（不是摆设）
  makeRow({ number: 300, title: '很久以前的告警', outcomes: { failed: 1 }, minutesAgo: 40 * 24 * 60 }),
];

/**
 * 用本文件的 rows 顶掉 `/api/issues`（游标 `i:<offset>`，与契约的「不透明游标」一致）。
 *
 * `totalEstimate` 默认是**全量**（= 满足筛选的行数），所以 `status` 筛选时要按同一份谓词
 * 再算一遍 —— 这正是服务端口径，也是 C3 要断言的「计数是全量、不是已加载」。
 */
function serveIssues(
  rows: readonly IssueListItem[],
  options: { pageSize?: number; /** 覆盖服务端计数（`null` = 服务端没统计）。 */ totalEstimate?: number | null } = {},
): void {
  server.use(
    http.get('/api/issues', ({ request }) => {
      const url = new URL(request.url);
      const limit = options.pageSize ?? Number(url.searchParams.get('limit') ?? '30');
      const cursor = url.searchParams.get('cursor') ?? '';
      const offset = cursor.startsWith('i:') ? Number(cursor.slice(2)) : 0;
      // 服务端筛选：mock 也按同一份 `status` 谓词计数（`deriveStatus` 与契约一致）
      const status = url.searchParams.get('status');
      const matched = status === null ? rows : rows.filter((row) => deriveStatus(row) === status);
      const page = matched.slice(offset, offset + limit);
      const next = offset + page.length;
      const hasMore = next < matched.length;
      return HttpResponse.json({
        generatedAt: new Date(NOW).toISOString(),
        issues: page,
        hasMore,
        nextCursor: hasMore ? `i:${String(next)}` : null,
        totalEstimate: options.totalEstimate === undefined ? matched.length : options.totalEstimate,
      });
    }),
  );
}

/** 把当前路由的查询串渲染出来（`MemoryRouter` 下断言 URL 同步的唯一办法）。 */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderCenter(route = '/issues') {
  return renderWithProviders(
    <>
      <IssuesPage />
      <LocationProbe />
    </>,
    { route },
  );
}

describe('Issue 队列（FR-7.4 的三左栏之一）', () => {
  it('全局视图：一行一个 issue（编号 / 标题 / 标签 / 状态），rail 头带计数与本页口径', async () => {
    serveIssues(ROWS);
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    expect(content).toBeTruthy();

    // 头部是「小标签 + 计数」（`rail-head`），不是表头行
    const rail = screen.getByTestId('issue-rail');
    expect(rail.className).toContain('w-rail');
    expect(rail.className).toContain('flex-1');

    // 行内容：编号 / 标题 / 标签 / reaction / 待人回答
    const row = within(content).getByTestId('issue-row-acme/widgets#issue17');
    expect(row.textContent).toContain('#17');
    expect(row.textContent).toContain('EACCES');
    expect(row.textContent).toContain('bug');
    expect(row.textContent).toContain('待人回答');
    expect(row.textContent).toContain('rocket');

    // 首屏：limit=20、不带 cursor
    const listUrl = requests.find((url) => url.includes('/api/issues?'));
    expect(listUrl).toContain('limit=20');
    expect(listUrl).not.toContain('cursor=');
  });

  it('仓库上下文：没有「项目」前缀、请求带 repo、行链接是新路径', async () => {
    serveIssues(ROWS);
    renderWithProviders(<IssuesPage repoLock="acme/widgets" />, { route: '/repos/acme__widgets/issues' });

    const content = await screen.findByTestId('issues-content');
    expect(content).toBeTruthy();
    // 仓库已锁 ⇒ 没有仓库下拉
    expect(screen.queryByLabelText('仓库筛选')).toBeNull();

    const listUrl = requests.find((url) => url.includes('/api/issues?'));
    expect(listUrl).toContain('repo=acme%2Fwidgets');

    const firstLink = within(content).getAllByTestId('issue-row-link')[0];
    expect(firstLink?.getAttribute('href')).toBe('/repos/acme__widgets/issues/issue/17');
  });
});

describe('Issue 中心：筛选', () => {
  it('服务端筛选：状态 / 待人回答 / 类型都落到请求参数与 URL 上', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();

    await screen.findByTestId('issues-content');
    requests.length = 0;

    await pickFilterOption(user, '状态筛选', 'open');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('state=open');
    });
    await waitFor(() => {
      expect(requests.some((url) => url.includes('state=open'))).toBe(true);
    });

    requests.length = 0;
    await pickFilterOption(user, '待人回答筛选', '待人回答');
    await waitFor(() => {
      expect(requests.some((url) => url.includes('awaiting=true'))).toBe(true);
    });
    expect(screen.getByTestId('location').textContent).toContain('awaiting=true');

    requests.length = 0;
    await pickFilterOption(user, '类型筛选', 'Pull request');
    await waitFor(() => {
      expect(requests.some((url) => url.includes('kind=pr'))).toBe(true);
    });
  });

  it('状态带与队列同源（`lib/issue-counts.ts`）—— 数字是筛选入口', async () => {
    // 状态带挂在 `AppLayout` 上，页面级测试看不到它；这里锁住的是**同源口径**：
    // 三个分桶（待处理 / 运行中 / 失败）与状态带的 `strip-*` 用的是同一个 hook。
    serveIssues(ROWS);
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    expect(within(content).getByTestId('issues-split')).toBeTruthy();
    // 队列头部的计数与行数一致（口径不会两处各算一遍）
    const rail = screen.getByTestId('issue-rail');
    expect(rail.textContent).toContain('4 项');
  });

  it('C3 计数是全量口径（`totalEstimate`），不是「已加载」', async () => {
    // 一页只给 2 行，但全量是 4：两者必须能区分
    serveIssues(ROWS, { pageSize: 2 });
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    expect(within(content).getAllByTestId('issue-row-link')).toHaveLength(2);

    // rail 头部的计数 = 服务端全量 4，不是已加载的 2
    expect(screen.getByTestId('issue-rail').textContent).toContain('4 项');
    // caption 同时给出两个口径
    const caption = screen.getByTestId('issues-caption').textContent ?? '';
    expect(caption).toContain('共 4 行（全量口径）');
    expect(caption).toContain('已加载 2 行');
  });

  it('`totalEstimate` 为 `null` 时如实说「服务端没有返回全量计数」，不冒充 0', async () => {
    serveIssues(ROWS, { totalEstimate: null });
    renderCenter();

    await screen.findByTestId('issues-content');
    const rail = screen.getByTestId('issue-rail').textContent ?? '';
    // 全量未知 → 退回「已加载 N 项」，并明确写出这是已加载口径
    expect(rail).toContain('已加载 4 项');
    expect(rail).not.toContain('0 项');
    expect(screen.getByTestId('issues-caption').textContent).toContain('服务端没有返回全量计数');
  });

  it('客户端筛选时计数退回「已加载」（不拿全量冒充筛选结果）', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();

    await screen.findByTestId('issues-content');
    await user.type(screen.getByLabelText('搜索标题或编号'), '42');
    await waitFor(() => {
      expect(within(screen.getByTestId('issues-content')).getAllByTestId('issue-row-link')).toHaveLength(1);
    });
    // 客户端筛选只作用于已加载行：头部如实标出口径
    expect(screen.getByTestId('issue-rail').textContent).toContain('已加载 1 项');
  });

  it('客户端过滤：搜索标题/编号、标签、时间窗都在已加载的行里生效（不发额外请求）', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    expect(within(content).getAllByTestId('issue-row-link')).toHaveLength(4);

    // 搜索：编号
    requests.length = 0;
    await user.type(screen.getByLabelText('搜索标题或编号'), '42');
    await waitFor(() => {
      expect(within(screen.getByTestId('issues-content')).getAllByTestId('issue-row-link')).toHaveLength(1);
    });
    expect(screen.getByTestId('location').textContent).toContain('q=42');
    // 客户端过滤不换请求
    expect(requests.filter((url) => url.includes('/api/issues?') && !url.includes('cursor='))).toHaveLength(0);
    // 口径不再写进 caption：改成工具条上的 (i) + Tooltip（D3 文案规则），hover 后仍可达
    await user.hover(screen.getByRole('button', { name: '筛选范围' }));
    const scopeTip = await screen.findByRole('tooltip');
    expect(scopeTip.textContent ?? '').toContain('只筛选已加载的');

    // 搜索：清掉后再按标签过滤
    await user.clear(screen.getByLabelText('搜索标题或编号'));
    await pickFilterOption(user, '标签筛选', 'needs-info');
    await waitFor(() => {
      const rows = screen.getByTestId('issues-content');
      expect(within(rows).getAllByTestId('issue-row-link')).toHaveLength(2);
    });

    // 时间窗：40 天前的行被过滤掉
    await pickFilterOption(user, '标签筛选', '全部标签');
    await pickFilterOption(user, '时间窗筛选', '最近 30 天');
    await waitFor(() => {
      expect(within(screen.getByTestId('issues-content')).getAllByTestId('issue-row-link')).toHaveLength(3);
    });
    expect(screen.queryByTestId('issue-row-acme/widgets#issue300')).toBeNull();
  });

  it('清除筛选：所有 URL 键都清掉（外部参数除外）', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter('/issues?state=open&keep=1');

    await screen.findByTestId('issues-content');
    await user.click(screen.getByTestId('issues-clear'));

    await waitFor(() => {
      const search = screen.getByTestId('location').textContent ?? '';
      expect(search).not.toContain('state=open');
      expect(search).toContain('keep=1');
    });
  });
});

describe('Issue 中心：分页与四态', () => {
  it('游标分页：加载更多把第二页拼在后面', async () => {
    const many = Array.from({ length: 24 }, (_, index) =>
      makeRow({ number: 100 + index, title: `演示 issue ${String(100 + index)}`, minutesAgo: 10 + index }),
    );
    serveIssues(many);
    const user = userEvent.setup();
    renderCenter();

    await screen.findByTestId('issues-content');
    expect(screen.getAllByTestId('issue-row-link')).toHaveLength(20);

    await user.click(screen.getByTestId('issues-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('issue-row-link')).toHaveLength(24);
    });
    expect(requests.some((url) => url.includes('cursor=i%3A20') || url.includes('cursor=i:20'))).toBe(true);
  });

  it('四态：loading / error / empty / content 都有落点', async () => {
    // loading：慢响应先出骨架
    server.use(
      http.get('/api/issues', async () => {
        await delay(200);
        return HttpResponse.json({ generatedAt: new Date(NOW).toISOString(), issues: ROWS, hasMore: false, nextCursor: null });
      }),
    );
    const first = renderCenter();
    expect(await screen.findByTestId('issues-loading')).toBeTruthy();
    expect(await screen.findByTestId('issues-content', undefined, { timeout: 3000 })).toBeTruthy();
    first.unmount();

    // error：500 → Alert
    server.use(
      http.get('/api/issues', () =>
        HttpResponse.json({ error: { code: 'internal', message: '读取数据库失败' } }, { status: 500 }),
      ),
    );
    const second = renderCenter();
    expect((await screen.findByTestId('issues-error')).textContent).toContain('读取失败');
    second.unmount();

    // empty：库里 0 条 ⇒ 引导文案（不是「筛选无结果」）
    server.use(
      http.get('/api/issues', () =>
        HttpResponse.json({ generatedAt: new Date(NOW).toISOString(), issues: [], hasMore: false, nextCursor: null }),
      ),
    );
    const third = renderCenter();
    expect((await screen.findByTestId('issues-empty')).textContent ?? '').toContain('还没有处理过的 Issue 会话');
    third.unmount();

    // 筛选无结果 ≠ 库里没有：空态文案要不一样
    const fourth = renderCenter('/issues?q=zzz');
    expect((await screen.findByTestId('issues-empty')).textContent ?? '').toContain('当前筛选下没有会话');
    fourth.unmount();
  });
});

describe('Issue 队列：主从与键盘', () => {
  it('首屏默认选中第一条：右侧直接是会话流（AC-27 要求首屏就能看到它卡在哪）', async () => {
    serveIssues(ROWS);
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    // 默认选中第一条（不写 URL）：右侧立刻是完整会话流，不是「未选中」
    expect(within(content).getByTestId('issue-row-acme/widgets#issue17').getAttribute('data-state')).toBe('selected');
    expect(await screen.findByTestId('issue-conversation')).toBeTruthy();
    expect(screen.queryByTestId('issues-preview-empty')).toBeNull();
  });

  it('点另一行：`?selected=` 进 URL，右侧换成那一行的会话流', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    const row = within(content).getByTestId('issue-row-acme/widgets#issue42');
    await user.click(row);

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('selected=acme%2Fwidgets%23issue42');
    });
    // 选中态是「左侧 3px 强调条 + 浅强调底」（`rail-row-selected`），不是胶囊
    expect(within(content).getByTestId('issue-row-acme/widgets#issue42').getAttribute('data-state')).toBe('selected');
    expect(await screen.findByTestId('issue-conversation')).toBeTruthy();
  });

  it('键盘：j/k 移动选中，Enter 打开整页详情', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();
    await screen.findByTestId('issues-content');

    // 首屏已选中第一条；`j` 下移一条
    await user.keyboard('j');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('issue42');
    });

    await user.keyboard('k');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('issue17');
    });

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('/repos/acme__widgets/issues/issue/17');
    });
  });

  it('`/` 聚焦搜索，Esc 清掉筛选', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter('/issues?state=open');
    await screen.findByTestId('issues-content');

    await user.keyboard('/');
    expect(document.activeElement).toBe(screen.getByLabelText('搜索标题或编号'));

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).not.toContain('state=open');
    });
  });
});