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
 * 契约正在被 W3-H 改（`reactionState` / `labelDecisions` 刚落地），
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
import { IssuesPage } from '../issues.tsx';

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
  labelDecisions?: IssueListItem['labelDecisions'];
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
    labelDecisions: input.labelDecisions ?? null,
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
    labelDecisions: {
      lastAt: minutesAgo(29),
      desired: ['bug', 'needs-info', 'priority:high'],
      applied: ['bug', 'needs-info'],
      reason: '缺少复现步骤；没有说明版本',
      blocked: [{ reason: '词表外标签 priority:high', count: 1 }],
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

/** 用本文件的 rows 顶掉 `/api/issues`（游标 `i:<offset>`，与契约的「不透明游标」一致）。 */
function serveIssues(rows: readonly IssueListItem[], options: { pageSize?: number } = {}): void {
  server.use(
    http.get('/api/issues', ({ request }) => {
      const url = new URL(request.url);
      const limit = options.pageSize ?? Number(url.searchParams.get('limit') ?? '30');
      const cursor = url.searchParams.get('cursor') ?? '';
      const offset = cursor.startsWith('i:') ? Number(cursor.slice(2)) : 0;
      const page = rows.slice(offset, offset + limit);
      const next = offset + page.length;
      const hasMore = next < rows.length;
      return HttpResponse.json({
        generatedAt: new Date(NOW).toISOString(),
        issues: page,
        hasMore,
        nextCursor: hasMore ? `i:${String(next)}` : null,
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

function headerTexts(): string[] {
  const table = screen.getByTestId('issue-table');
  return within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent ?? '');
}

describe('Issue 中心：表格', () => {
  it('全局视图：列＝项目/编号/标题/标签/状态/reaction/耗时/最后活动，带 caption 与 scope', async () => {
    serveIssues(ROWS);
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    expect(content).toBeTruthy();
    expect(headerTexts()).toEqual(['项目', '编号', '标题', '标签', '状态', 'reaction', '耗时', '最后活动']);

    // a11y：表头是 `<th scope="col">`，caption 只留排序与行数口径
    const table = screen.getByTestId('issue-table');
    for (const cell of within(table).getAllByRole('columnheader')) {
      expect(cell.getAttribute('scope')).toBe('col');
    }
    const caption = table.querySelector('caption');
    expect(caption?.textContent ?? '').toContain('按最后更新倒序');
    // 列头 title 说明「—」的含义（口径不写进 caption）
    expect(within(table).getByRole('columnheader', { name: '耗时' }).getAttribute('title') ?? '').toContain('—');

    // 行内容：编号 / 标题 / 标签 / reaction / 待人回答
    const row = within(content).getByTestId('issue-row-acme/widgets#issue17');
    expect(row.textContent).toContain('#17');
    expect(row.textContent).toContain('EACCES');
    expect(row.textContent).toContain('bug');
    expect(row.textContent).toContain('待人回答');
    expect(row.textContent).toContain('rocket');
    // 打标被拦：来自 labelDecisions.blocked
    expect(row.textContent).toContain('打标被拦');

    // 首屏：limit=10、不带 cursor
    const listUrl = requests.find((url) => url.includes('/api/issues?'));
    expect(listUrl).toContain('limit=10');
    expect(listUrl).not.toContain('cursor=');
  });

  it('耗时列：接口没给字段时显示 —，列头 title 说明（不是 0）', async () => {
    serveIssues(ROWS);
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    const row = within(content).getByTestId('issue-row-acme/widgets#issue17');
    const cells = within(row).getAllByRole('cell');
    // 全局视图：项目/编号/标题/标签/状态/reaction/耗时/最后活动 ⇒ 耗时 = index 6
    expect(cells[6]?.textContent).toBe('—');
    // 「— 不是 0」的口径挂在列头 title 上（不再占 caption 一行）
    const head = within(screen.getByTestId('issue-table')).getByRole('columnheader', { name: '耗时' });
    expect(head.getAttribute('title') ?? '').toContain('还没有 durationMs / costUsd');
  });

  it('仓库上下文：没有「项目」列、请求带 repo、行链接是新路径', async () => {
    serveIssues(ROWS);
    renderWithProviders(<IssuesPage repoLock="acme/widgets" />, { route: '/repos/acme__widgets/issues' });

    const content = await screen.findByTestId('issues-content');
    expect(screen.getByRole('heading', { level: 1, name: 'Issue 中心' })).toBeTruthy();
    expect(headerTexts()).toEqual(['编号', '标题', '标签', '状态', 'reaction', '耗时', '最后活动']);
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

    await user.selectOptions(screen.getByLabelText('状态筛选'), 'open');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('state=open');
    });
    await waitFor(() => {
      expect(requests.some((url) => url.includes('state=open'))).toBe(true);
    });

    requests.length = 0;
    await user.selectOptions(screen.getByLabelText('待人回答筛选'), 'true');
    await waitFor(() => {
      expect(requests.some((url) => url.includes('awaiting=true'))).toBe(true);
    });
    expect(screen.getByTestId('location').textContent).toContain('awaiting=true');

    requests.length = 0;
    await user.selectOptions(screen.getByLabelText('类型筛选'), 'pr');
    await waitFor(() => {
      expect(requests.some((url) => url.includes('kind=pr'))).toBe(true);
    });
  });

  it('摘要里的数字点一下就是筛选（只改 URL），再点一次取消', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();

    await screen.findByTestId('issues-content');
    const failedChip = screen.getByTestId('issues-summary-failed');
    expect(failedChip.getAttribute('aria-pressed')).toBe('false');

    await user.click(failedChip);
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('status=failed');
    });
    expect(screen.getByTestId('issues-summary-failed').getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByTestId('issues-summary-failed'));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).not.toContain('status=failed');
    });
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
    await user.selectOptions(screen.getByLabelText('标签筛选'), 'needs-info');
    await waitFor(() => {
      const rows = screen.getByTestId('issues-content');
      expect(within(rows).getAllByTestId('issue-row-link')).toHaveLength(2);
    });

    // 时间窗：40 天前的行被过滤掉
    await user.selectOptions(screen.getByLabelText('标签筛选'), '');
    await user.selectOptions(screen.getByLabelText('时间窗筛选'), '30d');
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
    const many = Array.from({ length: 12 }, (_, index) =>
      makeRow({ number: 100 + index, title: `演示 issue ${String(100 + index)}`, minutesAgo: 10 + index }),
    );
    serveIssues(many);
    const user = userEvent.setup();
    renderCenter();

    await screen.findByTestId('issues-content');
    expect(screen.getAllByTestId('issue-row-link')).toHaveLength(10);

    await user.click(screen.getByTestId('issues-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('issue-row-link')).toHaveLength(12);
    });
    expect(requests.some((url) => url.includes('cursor=i%3A10') || url.includes('cursor=i:10'))).toBe(true);
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

describe('Issue 中心：主从与键盘', () => {
  it('点行选中：`?selected=` 进 URL，右侧出概要 + 打开完整详情', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();

    const content = await screen.findByTestId('issues-content');
    const row = within(content).getByTestId('issue-row-acme/widgets#issue17');
    await user.click(row);

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('selected=acme%2Fwidgets%23issue17');
    });
    // 选中态用品牌底（data-state=selected），不是胶囊
    expect(within(content).getByTestId('issue-row-acme/widgets#issue17').getAttribute('data-state')).toBe('selected');

    const preview = await screen.findByTestId('issue-preview');
    expect(preview.textContent).toContain('EACCES');
    expect(within(preview).getByTestId('issue-preview-open')).toBeTruthy();
  });

  it('键盘：j/k 移动选中，Enter 打开整页详情', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderCenter();
    await screen.findByTestId('issues-content');

    await user.keyboard('j');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('selected=acme%2Fwidgets%23issue17');
    });

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