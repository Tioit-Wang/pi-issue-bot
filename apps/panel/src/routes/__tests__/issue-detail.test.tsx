/**
 * Issue 详情（W2-F）：**「结果去哪了」**的六个区块 + 四态。
 *
 * 这一页的核心不是「好看」，是**别把信息说错**，所以断言都盯着诚实性：
 *  - `actions.external_ref IS NULL`（没有评论）时正文仍要显示，并标「未发布到 GitHub」；
 *  - 标签理由来自 `labelDecisions.reason`，被拦原因来自 `labelDecisions.blocked`；
 *  - 「缺哪些信息」是 `reason` 的切分结果，不是另编一份；
 *  - 重跑按钮**必须 disabled**（写接口没落地），并且旁边写清原因。
 *
 * 数据自带（`server.use`），不依赖 W3-H 正在改的 fixture。
 */
import { screen, within } from '@testing-library/react';
import { HttpResponse, delay, http } from 'msw';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import type { IssueSessionResponse, IssueTurn } from '../../lib/contract.ts';
import { IssueDetailPage } from '../issue-detail.tsx';

const server = setupServer(...createHandlers());

const AT = '2026-06-02T10:00:00.000Z';

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});

function makeTurn(input: {
  id: string;
  role: IssueTurn['role'];
  at: string;
  text?: string | null;
  commentId?: string | null;
  commentUrl?: string | null;
  labels?: string[];
  status?: IssueTurn['status'];
  failureClass?: IssueTurn['failureClass'];
  taskId?: string | null;
  channel?: IssueTurn['channel'];
  toolCalls?: IssueTurn['toolCalls'];
}): IssueTurn {
  return {
    id: input.id,
    role: input.role,
    login: input.role === 'human' ? 'alice' : 'pi-issue-bot[bot]',
    at: input.at,
    channel: input.channel ?? null,
    text: input.text ?? null,
    commentId: input.commentId ?? null,
    commentUrl: input.commentUrl ?? null,
    labels: input.labels ?? [],
    status: input.status ?? 'succeeded',
    failureClass: input.failureClass ?? null,
    taskId: input.taskId ?? null,
    attempts: 1,
    toolCalls: input.toolCalls ?? [],
    truncated: false,
  };
}

/** 完整会话：人类提问 + 机器人结论（无评论 = external_ref 为空）+ 一轮失败。 */
function session(options: { published?: boolean; botText?: string | null } = {}): IssueSessionResponse {
  const published = options.published ?? false;
  // `botText: null` 是「这一轮没有正文」的合法用例，不能被 ?? 吃掉
  const botText = 'botText' in options ? options.botText : '结论：把 socket 放到 RuntimeDirectory，别放 /tmp。';
  return {
    generatedAt: AT,
    issue: {
      repo: 'acme/widgets',
      kind: 'issue',
      number: 17,
      title: "EACCES: permission denied, open '/var/run/app.sock'",
      url: 'https://github.com/acme/widgets/issues/17',
      state: 'open',
      stateStale: false,
      labels: ['bug', 'needs-info'],
      participants: ['alice', 'pi-issue-bot[bot]'],
      reactionState: {
        stage: 'succeeded',
        content: 'rocket',
        appliedAt: AT,
        at: AT,
        commentId: published ? '410002' : null,
      },
      pendingFeedback: [],
    },
    turns: [
      makeTurn({ id: 'task:1', role: 'human', at: AT, text: '这个 EACCES 是什么原因？', channel: 'mention', taskId: 't-17-1' }),
      makeTurn({
        id: 'run:1',
        role: 'bot',
        at: AT,
        text: botText,
        status: botText === null ? 'failed' : 'succeeded',
        failureClass: botText === null ? 'timeout' : null,
        labels: ['bug'],
        taskId: 't-17-1',
        commentId: published ? '410002' : null,
        commentUrl: published ? 'https://github.com/acme/widgets/issues/17#issuecomment-410002' : null,
      }),
    ],
  };
}

/** `labelDecisions` 挂在 `issue` 上（契约位置），由读取器兜住。 */
function sessionWithLabels(data: IssueSessionResponse): IssueSessionResponse {
  return {
    ...data,
    issue: {
      ...data.issue,
      // 契约里 `IssueSummary` 没有 `labelDecisions`：这里模拟后端后续把它放进来
      ...({ labelDecisions: {
        lastAt: AT,
        desired: ['bug', 'needs-info', 'priority:high'],
        applied: ['bug', 'needs-info'],
        reason: '缺少复现步骤；没有说明部署方式',
        blocked: [{ reason: '词表外标签 priority:high', count: 2 }],
      } } as object),
    },
  };
}

function serveSession(data: IssueSessionResponse | null): void {
  server.use(
    http.get('/api/issues/:owner/:name/:kind/:number', () => {
      if (data === null) {
        return HttpResponse.json({ error: { code: 'not-found', message: '这个 issue 没有会话记录' } }, { status: 404 });
      }
      return HttpResponse.json(data);
    }),
  );
}

function renderDetail(route = '/repos/acme__widgets/issues/issue/17') {
  return renderWithProviders(
    <Routes>
      <Route path="/repos/:repo/issues/:kind/:number" element={<IssueDetailPage />} />
    </Routes>,
    { route },
  );
}

describe('Issue 详情：关键区块', () => {
  it('结论正文 / 标签与理由 / reaction / 缺哪些信息 / run 时间线 / 重跑 六块都在', async () => {
    serveSession(sessionWithLabels(session()));
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    expect(screen.getByRole('heading', { level: 1 }).textContent ?? '').toContain('issue#17');

    // ① 结论正文：没有评论 ⇒ 正文照常显示 + 明确标注「未发布到 GitHub」
    const result = within(content).getByTestId('issue-detail-result');
    expect(result.textContent).toContain('RuntimeDirectory');
    expect(screen.getByTestId('issue-detail-result-unpublished')).toBeTruthy();
    // 「为什么没发布」不再占正文行：挂在徽章的 title 上（hover 与读屏都可达）
    expect(screen.getByTestId('issue-detail-result-unpublished').getAttribute('title') ?? '').toContain(
      '没有对应评论',
    );

    // ② 标签与理由：reason + 被拦原因（含次数）
    const labels = within(content).getByTestId('issue-detail-label-decision');
    expect(labels.textContent).toContain('bug');
    expect(within(labels).getByTestId('issue-detail-labels-reason').textContent).toContain('缺少复现步骤');
    expect(within(labels).getByTestId('issue-detail-labels-blocked').textContent).toContain('词表外标签');
    expect(labels.textContent).toContain('priority:high');

    // ③ reaction：最新终态 + 台账为空时的说明
    // reaction：头部徽章给出最新终态（右侧台账在 dry-run / 空台账时是一条说明）
    expect(screen.getByTestId('issue-detail-header').textContent).toContain('rocket');

    // ④ 缺哪些信息：来自 reason 的切分（两条）
    const missing = within(content).getByTestId('issue-detail-missing');
    const items = within(missing).getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('缺少复现步骤');
    expect(items[1]).toContain('没有说明部署方式');

    // ⑤ run 时间线：两轮各一行，任务列可点
    const timeline = within(content).getByTestId('issue-detail-timeline');
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(2);
    expect(within(timeline).getAllByRole('link').map((link) => link.textContent)).toContain('t-17-1');

    // ⑥ 重跑：禁用 + 写明原因（不假装可点）
    const button = within(content).getByTestId('issue-detail-rerun-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title') ?? '').toContain('POST /api/tasks/:id/rerun');
    expect(within(content).getByTestId('issue-detail-rerun').textContent).toContain('写接口未就绪');
  });

  it('有评论的轮次：不标「未发布」，给 GitHub 链接', async () => {
    serveSession(session({ published: true }));
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const result = within(content).getByTestId('issue-detail-result');
    expect(screen.getByTestId('issue-detail-result-unpublished').textContent).toContain('已发布评论');
    expect(within(result).getByRole('link', { name: '在 GitHub 看这条评论' })).toBeTruthy();
  });

  it('没有机器人正文：结论区块如实说明（不编一段结论）', async () => {
    serveSession(session({ botText: null }));
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const result = within(content).getByTestId('issue-detail-result');
    expect(result.textContent).toContain('没有正文');
    expect(result.textContent).toContain('timeout');
  });

  it('仓库上下文：面包屑给出「全部项目 / acme/widgets / Issue 中心 / issue#17」', async () => {
    serveSession(session());
    renderDetail();

    await screen.findByTestId('issue-detail-content');
    const crumbs = screen.getByTestId('issue-detail-header-breadcrumb');
    expect(crumbs.textContent).toContain('全部项目');
    expect(crumbs.textContent).toContain('acme/widgets');
    expect(crumbs.textContent).toContain('Issue 中心');
    expect(crumbs.textContent).toContain('issue#17');
  });
});

describe('Issue 详情：四态', () => {
  it('loading / error / 空（404）/ content', async () => {
    // loading
    server.use(
      http.get('/api/issues/:owner/:name/:kind/:number', async () => {
        await delay(200);
        return HttpResponse.json(session());
      }),
    );
    const first = renderDetail();
    expect(await screen.findByTestId('issue-detail-loading')).toBeTruthy();
    expect(await screen.findByTestId('issue-detail-content', undefined, { timeout: 3000 })).toBeTruthy();
    first.unmount();

    // error（500 不是「没有会话」，要显示错误态）
    server.use(
      http.get('/api/issues/:owner/:name/:kind/:number', () =>
        HttpResponse.json({ error: { code: 'internal', message: '读取数据库失败' } }, { status: 500 }),
      ),
    );
    const second = renderDetail();
    expect((await screen.findByTestId('issue-detail-error')).textContent).toContain('读取失败');
    second.unmount();

    // 404 ⇒ 空态（正常业务态：这个 issue 我们从没处理过）
    serveSession(null);
    const third = renderDetail();
    const empty = await screen.findByTestId('issue-detail-empty');
    expect(empty.textContent).toContain('找不到这个会话');
    expect(screen.queryByTestId('issue-detail-error')).toBeNull();
    third.unmount();
  });
});