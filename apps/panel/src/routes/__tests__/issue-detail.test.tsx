/**
 * Issue 会话详情：**只展示会话本身**（按需求文档 §5 的「完整对话」demo）。
 *
 * 断言盯着两件事：
 *  - 结构：人类轮是气泡、机器人轮是「轮 → 组 → 工具」三层折叠；
 *  - 去掉了过时的产出视图：结论正文 / 标签与理由 / 缺哪些信息 / reaction 台账 / 重跑按钮。
 *
 * 数据自带（`server.use`），不依赖共享 fixture。
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
  commentUrl?: string | null;
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
    commentId: null,
    commentUrl: input.commentUrl ?? null,
    labels: [],
    status: input.status ?? 'succeeded',
    failureClass: input.failureClass ?? null,
    taskId: input.taskId ?? null,
    attempts: 1,
    toolCalls: input.toolCalls ?? [],
    truncated: false,
  };
}

/** 一轮机器人：带两个工具调用 + 一段输出。 */
function botTurn(text: string | null = '结论：把 socket 放到 RuntimeDirectory，别放 /tmp。'): IssueTurn {
  return makeTurn({
    id: 'run:1',
    role: 'bot',
    at: AT,
    text,
    status: text === null ? 'failed' : 'succeeded',
    failureClass: text === null ? 'timeout' : null,
    taskId: 't-17-1',
    toolCalls: [
      { name: 'Bash', summary: 'Get-ChildItem -Force', at: AT, ok: true },
      { name: 'Read', summary: '.github/ISSUE_TEMPLATE/bug_report.md', at: AT, ok: false },
    ],
  });
}

function session(bot = botTurn()): IssueSessionResponse {
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
      labels: ['bug'],
      participants: ['alice', 'pi-issue-bot[bot]'],
      reactionState: { stage: 'succeeded', content: 'rocket', appliedAt: AT, at: AT, commentId: '410002' },
      pendingFeedback: [],
    },
    turns: [makeTurn({ id: 'task:1', role: 'human', at: AT, text: '这个 EACCES 是什么原因？', channel: 'mention' }), bot],
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

describe('Issue 会话详情：结构与内容', () => {
  it('会话栏给出轮次统计，人类轮是气泡、机器人轮给出工具与输出', async () => {
    serveSession(session());
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    expect(screen.getByRole('heading', { level: 1 }).textContent ?? '').toContain('issue#17');

    // 会话栏：轮次 / 人类 / 机器人
    const head = within(content).getByTestId('issue-detail-session-header');
    expect(head.textContent).toContain('轮次');
    expect(head.textContent).toContain('2');
    expect(head.textContent).toContain('人类');
    expect(head.textContent).toContain('机器人');

    // 人类轮：正文照原样显示（右对齐气泡里）
    const human = within(content).getByTestId('issue-detail-turn-human');
    expect(human.textContent).toContain('EACCES');

    // 机器人轮：轮标题写「运行完成 / 耗时 / N 个工具」
    const bot = within(content).getByTestId('issue-detail-turn-bot');
    expect(bot.textContent).toContain('运行完成');
    expect(bot.textContent).toContain('2 个工具');
    // 输出块
    expect(bot.textContent).toContain('RuntimeDirectory');
  });

  it('工具调用默认收起，点开后逐条列出（三层里的第三层）', async () => {
    serveSession(session());
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const bot = within(content).getByTestId('issue-detail-turn-bot');
    const toggle = within(bot).getByTestId('issue-detail-tools-toggle') as HTMLButtonElement;

    // 收起时没有工具列表
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(bot).queryByTestId('issue-detail-tool-calls')).toBeNull();

    toggle.click();

    const tools = await within(bot).findByTestId('issue-detail-tool-calls');
    expect(tools.textContent).toContain('Bash');
    expect(tools.textContent).toContain('Get-ChildItem');
    expect(tools.textContent).toContain('Read');
    // 失败次数在组标题里如实写出来
    expect(tools.textContent).toContain('1 次失败');
  });

  it('机器人这一轮没有正文时如实说明，不编结论', async () => {
    serveSession(session(botTurn(null)));
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const bot = within(content).getByTestId('issue-detail-turn-bot');
    // 没有输出块（`输出` 标签不出现），但有失败分类
    expect(bot.textContent).not.toContain('输出');
    expect(bot.textContent).toContain('timeout');
  });

  it('已移除的产出视图不再渲染（结论正文 / 标签与理由 / 缺哪些信息 / reaction 台账 / 重跑）', async () => {
    serveSession(session());
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    for (const removed of [
      'issue-detail-result',
      'issue-detail-label-decision',
      'issue-detail-missing',
      'issue-detail-reaction',
      'issue-detail-rerun-button',
      'issue-detail-cost',
      'issue-detail-timeline',
    ]) {
      expect(within(content).queryByTestId(removed)).toBeNull();
    }
    expect(content.textContent ?? '').not.toContain('结论正文');
    expect(content.textContent ?? '').not.toContain('缺哪些信息');
    expect(content.textContent ?? '').not.toContain('标签与理由');
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

describe('Issue 会话详情：四态', () => {
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
