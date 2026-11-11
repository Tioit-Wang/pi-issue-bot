/**
 * issue 列表的流水线列与**客户端筛选**（阶段 / 状态 / 类别）。
 *
 * 两条口径必须钉住：
 *  1. 四列（阶段 / 类别 / 停留 / 尝试）在没有 `issue_pipeline` 行时是「未入流水线」+ `—`，
 *     不是 0、也不是「阶段 0 待跑」；
 *  2. 三个筛选**只作用在已加载的行**上（服务端 `issuesQuerySchema` 没有这些参数），
 *     所以筛选生效时**不会**再发一次请求 —— 这与「搜索/标签/时间窗」是同一套客户端机制。
 */
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../../test/render.tsx';
import type { IssueListItem, IssuePipeline } from '../../../lib/contract.ts';
import { IssueTable } from '../issue-table.tsx';
import { IssuesPage } from '../../../routes/issues.tsx';

const server = setupServer(...createHandlers());
const requests: string[] = [];

const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

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
  server.use(
    http.get('/api/repos', () =>
      HttpResponse.json({ items: [{ repo: 'acme/widgets', enabled: true, dryRun: false, settingsValid: true }] }),
    ),
  );
});

function pipeline(overrides: Partial<IssuePipeline> = {}): IssuePipeline {
  return {
    stage: 'format',
    state: 'pending',
    category: null,
    formatFailCount: 0,
    infoRequestedAt: null,
    blockedReason: null,
    readyAt: null,
    staleAt: null,
    sessionId: null,
    sessionTurns: 0,
    ...overrides,
  };
}

function row(number: number, p: IssuePipeline | null): IssueListItem {
  return {
    repo: 'acme/widgets',
    kind: 'issue',
    number,
    title: `演示 issue ${String(number)}`,
    url: `https://github.com/acme/widgets/issues/${String(number)}`,
    state: 'open',
    stateStale: false,
    lastActivityAt: ago(40),
    humanTurns: 1,
    autoTurns: 0,
    botTurns: 1,
    lastReplyAt: null,
    lastActorLogin: 'alice',
    lastActorKind: 'human',
    awaitingReply: false,
    labels: [],
    outcomes: { succeeded: 1 },
    lastPreview: null,
    reactionState: null,
    labelDecisions: null,
    feedback: [],
    pipeline: p,
  };
}

const ROWS: IssueListItem[] = [
  row(1, pipeline({ stage: 'agent', state: 'ready', category: 'defect', formatFailCount: 1, readyAt: ago(5 * 60) })),
  row(2, pipeline({ stage: 'format', state: 'awaiting_info', formatFailCount: 2, infoRequestedAt: ago(30 * 60) })),
  row(3, null),
];

function serveIssues(rows: readonly IssueListItem[]): void {
  server.use(
    http.get('/api/issues', () =>
      HttpResponse.json({ generatedAt: new Date().toISOString(), issues: rows, hasMore: false, nextCursor: null }),
    ),
  );
}

describe('issue 列表：流水线四列', () => {
  it('阶段 / 类别 / 停留 / 尝试 都从 pipeline 投影；超过 24h 用警示色', () => {
    renderWithProviders(
      <IssueTable rows={ROWS} selectedKey={null} onSelect={() => {}} showRepo={false} caption="演示数据" />,
    );

    const ready = screen.getByTestId('issue-row-acme/widgets#issue1');
    expect(ready.textContent).toContain('阶段 2 · 已就绪');
    expect(ready.textContent).toContain('缺陷');
    expect(within(ready).getByTestId('issue-row-attempts').textContent).toBe('1/5');
    expect(within(ready).getByTestId('issue-row-dwell').textContent).toBe('5.0h');

    const awaiting = screen.getByTestId('issue-row-acme/widgets#issue2');
    expect(awaiting.textContent).toContain('阶段 0 · 待人补充');
    // 30 小时 > 24 小时阈值：文字用 danger 色（不整行染色），title 里写明起算点
    const dwell = within(awaiting).getByTestId('issue-row-dwell');
    expect(dwell.className).toContain('text-danger-fg');
    expect(dwell.getAttribute('title') ?? '').toContain('进入「等补充」的时刻');

    // 没有流水线行：中性描边徽章 + 三个 —（不是 0）
    const unassigned = screen.getByTestId('issue-row-acme/widgets#issue3');
    expect(unassigned.textContent).toContain('未入流水线');
    expect(within(unassigned).queryByTestId('issue-row-dwell')).toBeNull();
    expect(within(unassigned).queryByTestId('issue-row-attempts')).toBeNull();
  });
});

describe('issue 列表：阶段 / 状态 / 类别筛选（客户端）', () => {
  it('阶段筛选生效且不再发请求；「未入流水线」是一等选项', async () => {
    serveIssues(ROWS);
    const user = userEvent.setup();
    renderWithProviders(<IssuesPage />, { route: '/issues' });

    const content = await screen.findByTestId('issues-content');
    expect(within(content).getAllByTestId(/^issue-row-acme\/widgets#issue\d+$/u)).toHaveLength(3);
    const requestsAfterLoad = requests.filter((url) => url.includes('/api/issues?')).length;

    // 阶段 = 阶段 0 · 格式检查 → 只剩 #2
    await user.selectOptions(screen.getByLabelText('阶段筛选'), '阶段 0 · 格式检查');
    await waitFor(() => {
      expect(
        within(screen.getByTestId('issues-content')).getAllByTestId(/^issue-row-acme\/widgets#issue\d+$/u),
      ).toHaveLength(1);
    });
    expect(screen.getByTestId('issue-row-acme/widgets#issue2')).toBeTruthy();

    // 阶段 = 未入流水线 → 只剩 #3
    await user.selectOptions(screen.getByLabelText('阶段筛选'), '未入流水线');
    await waitFor(() => {
      expect(screen.getByTestId('issue-row-acme/widgets#issue3')).toBeTruthy();
    });
    expect(screen.queryByTestId('issue-row-acme/widgets#issue2')).toBeNull();

    // 状态 + 类别：先把阶段清掉，再按「已就绪」筛
    await user.selectOptions(screen.getByLabelText('阶段筛选'), '');
    await user.selectOptions(screen.getByLabelText('流水线状态筛选'), 'ready');
    await waitFor(() => {
      expect(screen.getByTestId('issue-row-acme/widgets#issue1')).toBeTruthy();
    });
    expect(screen.queryByTestId('issue-row-acme/widgets#issue2')).toBeNull();

    await user.selectOptions(screen.getByLabelText('流水线状态筛选'), '');
    await user.selectOptions(screen.getByLabelText('类别筛选'), 'defect');
    await waitFor(() => {
      expect(screen.getByTestId('issue-row-acme/widgets#issue1')).toBeTruthy();
    });
    expect(screen.queryByTestId('issue-row-acme/widgets#issue3')).toBeNull();

    // 客户端筛选：整个过程只有首屏那一次 /api/issues
    expect(requests.filter((url) => url.includes('/api/issues?')).length).toBe(requestsAfterLoad);
  });
});
