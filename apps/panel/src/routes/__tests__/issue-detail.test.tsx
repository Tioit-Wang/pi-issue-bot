/**
 * Issue 会话页 —— **首屏结构与内容**（`AC-27` / `AC-28` / `AC-29` / `Q-8` / `Q-9`）。
 *
 * 断言的是需求原文里可量化的事实，不是像素：
 * - `AC-27`：首屏自上而下 = 标题行 → 收起的原文卡 → 收起的系统提示词 → 第一条人类输入；
 * - `AC-28`：展开原文卡能看到作者、时间、标签与正文；评论不会既在卡里又在流里；
 * - `AC-29`：展开系统提示词看到的是完整 markdown 原文（含 `# 角色` / `## 硬约束` 标题）；
 * - `Q-8`：人类在右（带事件元信息）、agent 在左（三层工具，失败可见）；
 * - `Q-9` / `AC-33`：输入区只呈现形态，发送按钮禁用且 `title` 写明缺哪个接口。
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

/** 系统提示词的 markdown 原文（`AC-29` 要的就是这一段，含两级标题）。 */
const SYSTEM_PROMPT = `# 角色

你是 pi-issue-bot 的执行侧，只对当前 issue 负责。

## 硬约束

- 不猜实现细节：没看到代码就说没看到。
- 结论先给一句话，再给证据。
`;

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
    // 契约里 `verdict` / `actions` 必填但可空；没有信封的轮次就是 `null`
    verdict: null,
    actions: null,
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
      // 契约里这三个是**必填但可空**（服务端总会给出：取自同一条投递，取不到就是 null）
      body: '启动时 EACCES：/var/run/app.sock 没权限。',
      author: 'alice',
      createdAt: AT,
      participants: ['alice', 'pi-issue-bot[bot]'],
      reactionState: { stage: 'succeeded', content: 'rocket', appliedAt: AT, at: AT, commentId: '410002' },
      pendingFeedback: [],
    },
    // `systemPrompt` 必填但可空（服务端总会给出：`agent_sessions.system_prompt` 或 null）
    systemPrompt: null,
    turns: [
      makeTurn({ id: 'task:1', role: 'human', at: AT, text: '这个 EACCES 是什么原因？', channel: 'mention' }),
      bot,
    ],
  };
}

/**
 * 契约字段补上后的形状（`originalBody` + `systemPrompt`）。
 * 现在用 `as` 之外的方式塞进去：把多余字段挂在响应上，读取层按运行时形状认。
 */
function sessionWithExtras(): Record<string, unknown> {
  const base = session();
  return {
    ...base,
    issue: {
      ...base.issue,
      author: 'Tioit-Wang',
      createdAt: '2026-06-01T08:24:11.000Z',
      body: '部署脚本昨天开始一直失败，报 EACCES：/var/run/app.sock 打不开。',
    },
    systemPrompt: SYSTEM_PROMPT,
  };
}

function serveSession(data: Record<string, unknown> | null): void {
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

describe('AC-27 首屏结构：标题行 → 原文卡 → 系统提示词 → 第一条人类输入', () => {
  it('四块按顺序都在，且原文卡与系统提示词默认收起', async () => {
    serveSession(sessionWithExtras() as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');

    // ① 标题行
    expect(within(content).getByTestId('issue-conversation-title').textContent).toContain('EACCES');
    // ② 原文卡：默认收起（`<details>` 没有 open）
    const original = within(content).getByTestId('issue-original-card') as HTMLDetailsElement;
    expect(original.tagName).toBe('DETAILS');
    expect(original.hasAttribute('open')).toBe(false);
    // ③ 系统提示词：默认收起
    const prompt = within(content).getByTestId('issue-system-prompt').querySelector('details');
    expect(prompt?.hasAttribute('open')).toBe(false);
    // ④ 第一条人类输入在（不用滚到第二屏才知道它卡在哪）
    expect(within(content).getByTestId('issue-turn-human').textContent).toContain('EACCES');

    // 顺序就是 DOM 顺序：标题行 < 原文卡 < 系统提示词 < 第一条人类输入
    const order = [
      within(content).getByTestId('issue-conversation-header'),
      within(content).getByTestId('issue-original-card'),
      within(content).getByTestId('issue-system-prompt'),
      within(content).getByTestId('issue-turn-human'),
    ].map((node) => [...content.querySelectorAll('*')].indexOf(node));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});

describe('AC-28 原文卡：作者 / 时间 / 标签 / 正文', () => {
  it('收起时只露「原文 · 作者 · N 条评论」，展开才是正文与作者时间标签', async () => {
    serveSession(sessionWithExtras() as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const summary = within(content).getByTestId('issue-original-summary');
    expect(summary.textContent).toContain('原文');
    expect(summary.textContent).toContain('Tioit-Wang');
    expect(summary.textContent).toContain('1 条评论');

    // 正文只在展开后可见（`<details>` 收起时内容仍在 DOM，但组件按 `open` 语义渲染）
    const body = within(content).getByTestId('issue-original-body');
    expect(body.textContent).toContain('部署脚本昨天开始一直失败');
    expect(body.textContent).toContain('bug');

    // `AC-28` 的另一半：同一条评论不会既在原文卡又在会话流里。
    // 原文卡放的是 issue 主贴原文，会话流放的是评论 —— 两段文字必须不同。
    const turnsText = within(content).getByTestId('issue-turns').textContent ?? '';
    expect(turnsText).not.toContain('部署脚本昨天开始一直失败');
  });

  it('响应里**没有**正文字段时如实说明「契约缺字段」，不是「这个 issue 没有正文」', async () => {
    // 契约收紧后字段必填，但真实世界里仍有「旧服务端 / 缓存响应」不给这个键的可能。
    // 这里显式删掉那个键来模拟，钉住面板的容错分支：**缺字段 ≠ 没有正文**，
    // 文案必须指向契约而不是撒个「这个 issue 没写正文」的谎。
    const base = session() as unknown as Record<string, unknown>;
    const issue = { ...(base['issue'] as Record<string, unknown>) };
    delete issue['body'];
    serveSession({ ...base, issue });
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    expect(within(content).getByTestId('issue-original-missing').textContent).toContain(
      '没有 `IssueSummary.body` 这个字段',
    );
    // 两种「没有」不能混：缺字段时不出现「没有正文」
    expect(within(content).queryByTestId('issue-original-empty')).toBeNull();
  });

  it('正文是 `null` 时说「没有正文」，与「契约缺字段」区分开（WP12 §五.5）', async () => {
    const base = sessionWithExtras();
    const data = { ...base, issue: { ...(base['issue'] as Record<string, unknown>), body: null } };
    serveSession(data);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    // 服务端明确给了 null：这是「确实没有正文」，不是契约问题
    expect(within(content).getByTestId('issue-original-empty').textContent).toContain('没有正文');
    expect(within(content).queryByTestId('issue-original-missing')).toBeNull();
    // 作者与时间仍然是有的（三者互不牵连）
    expect(within(content).getByTestId('issue-original-summary').textContent).toContain('Tioit-Wang');
  });
});

describe('AC-29 系统提示词：完整 markdown 原文', () => {
  it('展开是那段原文（含 `# 角色` / `## 硬约束` 标题），不是分层表格或摘要', async () => {
    serveSession(sessionWithExtras() as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const text = within(content).getByTestId('issue-system-prompt-text');
    expect(text.tagName).toBe('PRE');
    expect(text.textContent).toContain('# 角色');
    expect(text.textContent).toContain('## 硬约束');
    expect(text.textContent).toContain('不猜实现细节');
    // 原文里的换行必须保留（`whitespace-pre-wrap`）
    expect(text.className).toContain('whitespace-pre-wrap');
  });

  it('响应里没有这个字段时如实说明「契约缺字段」，不用当前项目配置拼一份假的', async () => {
    // 同上：契约必填，但旧服务端可能不给。显式删键模拟，钉住容错分支。
    const base = session() as unknown as Record<string, unknown>;
    delete base['systemPrompt'];
    serveSession(base);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    expect(within(content).getByTestId('issue-system-prompt-empty').textContent).toContain(
      '没有 IssueSessionResponse.systemPrompt 这个字段',
    );
  });

  it('字段是 `null` 时说「这次会话没有记录」，与「契约缺字段」区分开', async () => {
    const base = session();
    serveSession({ ...base, systemPrompt: null });
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const empty = within(content).getByTestId('issue-system-prompt-empty').textContent ?? '';
    expect(empty).toContain('没有系统提示词的记录');
    // 不能把「服务端说没有」报成「契约缺字段」
    expect(empty).not.toContain('ag…');
    expect(empty).not.toContain('没有 IssueSessionResponse.systemPrompt 这个字段');
  });
});

describe('Q-8 会话流画法：人类在右、agent 在左、三层工具', () => {
  it('人类轮带触发来源 chip 与事件元信息（来源 · 编号 · 绝对时间）', async () => {
    serveSession(sessionWithExtras() as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const human = within(content).getByTestId('issue-turn-human');
    expect(human.textContent).toContain('被 @');
    expect(human.textContent).toContain('2026-06-02T10:00:00.000Z');
    // 人类轮在右：容器带 `justify-end`
    expect(human.innerHTML).toContain('justify-end');
  });

  it('agent 轮无卡片，三层工具默认收起，展开后逐条给出成功/失败', async () => {
    serveSession(sessionWithExtras() as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const bot = within(content).getByTestId('issue-turn-bot');
    expect(bot.textContent).toContain('运行完成');
    expect(bot.textContent).toContain('2 个工具');
    expect(bot.textContent).toContain('RuntimeDirectory');

    const toggle = within(bot).getByTestId('issue-turn-tools-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(bot).queryByTestId('issue-turn-tool-calls')).toBeNull();

    toggle.click();

    const tools = await within(bot).findByTestId('issue-turn-tool-calls');
    expect(tools.textContent).toContain('Bash');
    expect(tools.textContent).toContain('Read');
    // 失败的那一次有可见的失败标记（`StatusDot` 的 aria-label）
    expect(within(tools).getAllByRole('img', { name: '失败' }).length).toBeGreaterThan(0);
  });

  it('机器人这一轮没有正文时如实说明，不编结论', async () => {
    serveSession(session(botTurn(null)) as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const bot = within(content).getByTestId('issue-turn-bot');
    expect(within(bot).queryByTestId('issue-turn-bot-text')).toBeNull();
    expect(bot.textContent).toContain('timeout');
  });

/** 信封字段的合法取值（契约 `envelopeJsonValueSchema`：有界 JSON 值）。 */
type EnvelopeValue = string | number | boolean | Record<string, unknown> | unknown[] | null;

describe('AC-30 信封原文：verdict / actions 默认收起', () => {
  /** 一轮带信封的机器人轮（契约 C4）。 */
  function botWithEnvelope(verdict: EnvelopeValue, actions: EnvelopeValue): IssueTurn {
    return { ...botTurn(), verdict, actions };
  }

  it('两块都默认收起（`<details>` 不带 open），展开才是原样 JSON', async () => {
    serveSession(
      session(
        botWithEnvelope(
          { kind: 'issue', labels: ['bug'], evidence: [] },
          [{ intent: 'comment', body: '结果：这是容器只读挂载导致的。' }, { intent: 'label', labels: ['bug'] }],
        ),
      ) as unknown as Record<string, unknown>,
    );
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const verdict = within(content).getByTestId('issue-turn-verdict') as HTMLDetailsElement;
    const actions = within(content).getByTestId('issue-turn-actions') as HTMLDetailsElement;
    // 默认收起（AC-30 原话：「verdict/actions 默认收起」）
    expect(verdict.tagName).toBe('DETAILS');
    expect(verdict.hasAttribute('open')).toBe(false);
    expect(actions.tagName).toBe('DETAILS');
    expect(actions.hasAttribute('open')).toBe(false);

    // 收起时只露字段名与字符数，**不**露内容
    expect(within(verdict).getByTestId('issue-turn-verdict-summary').textContent).toContain('verdict');
    expect(within(content).queryByTestId('issue-turn-verdict-text')).toBeTruthy(); // 收起时仍在 DOM
    expect((within(content).getByTestId('issue-turn-verdict-text') as HTMLElement).textContent).toContain(
      '"kind": "issue"',
    );
    expect((within(content).getByTestId('issue-turn-actions-text') as HTMLElement).textContent).toContain(
      '这是容器只读挂载导致的',
    );
  });

  it('这一轮没有信封时如实说「本轮没有」，不画一个假的空块', async () => {
    // 人类轮恒为 `null`（契约 C4）；机器人轮也可以没有信封（dry-run 之外的坏产出）
    serveSession(session(botWithEnvelope(null, null)) as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const verdict = within(content).getByTestId('issue-turn-verdict');
    expect(verdict.textContent).toContain('本轮没有');
    expect(within(content).queryByTestId('issue-turn-verdict-text')).toBeNull();
  });

  it('超大信封按 4000 字符截断，并写明原文一共多少（不静默截断）', async () => {
    // 一条评论正文上限 60 000 字（`packages/envelope/src/v21.ts`）：这里造 8 000 字
    const huge = [{ intent: 'comment', body: 'x'.repeat(8_000) }];
    serveSession(session(botWithEnvelope(null, huge)) as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const text = within(content).getByTestId('issue-turn-actions-text') as HTMLElement;
    expect(text.textContent?.length).toBe(4_000);
    const note = within(content).getByTestId('issue-turn-actions-truncated').textContent ?? '';
    expect(note).toContain('原文共');
    expect(note).toContain('只显示前 4,000 字符');
    // 服务端没给 verdict 这一项：如实说没有，而不是拿 actions 顶上
    expect(within(content).getByTestId('issue-turn-verdict').textContent).toContain('本轮没有');
  });
});
});

describe('Q-9 / FR-7.5 / AC-33 输入区只呈现形态', () => {
  it('发送按钮 disabled，`title` 写明缺哪个接口；没有「已完成」的假提示', async () => {
    serveSession(sessionWithExtras() as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    const send = within(content).getByTestId('issue-composer-send') as HTMLButtonElement;
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(send.getAttribute('title')).toContain('POST /api/issues');
    expect(send.getAttribute('title')).toContain('messages');

    // 输入框可读但不可写（呈现形态）
    const input = within(content).getByTestId('issue-composer-input') as HTMLTextAreaElement;
    expect(input.readOnly).toBe(true);
    expect(content.textContent ?? '').not.toContain('已发送');
  });

  it('`⋯` 里缺写接口的动作也是禁用 + title 写明接口', async () => {
    serveSession(sessionWithExtras() as unknown as Record<string, unknown>);
    renderDetail();

    const content = await screen.findByTestId('issue-detail-content');
    (within(content).getByTestId('issue-conversation-menu') as HTMLButtonElement).click();

    const rerun = await screen.findByTestId('issue-menu-rerun');
    expect(rerun.hasAttribute('disabled')).toBe(true);
    expect(rerun.getAttribute('title')).toContain('POST /api/tasks/:id/rerun');
  });
});

describe('Issue 会话页：四态', () => {
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
