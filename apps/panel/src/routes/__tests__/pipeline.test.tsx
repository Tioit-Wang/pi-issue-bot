/**
 * 流水线页（`/repos/:repo/pipeline`）的页面级测试。
 *
 * 用仓库自带的 MSW mock（`createHandlers()`）：这一页的价值就在于「用 mock 能看到真实形态」——
 * 三段看板 + 未入流水线 + 门禁七行 + 四个提示词指针全部来自 mock 数据，没有一项是页面里写死的数字。
 *
 * 断言盯三件事：
 *  1. 指标条里**拿不到的数**显示 `—`（今日自动关闭），不编数；
 *  2. 看板四列 + 「未入流水线」一组同时存在（`pipeline === null` 不被吞进阶段 0）；
 *  3. 提示词指针同时出现「vN · 项目版本」与「系统默认」两种形态。
 */
import { screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { RepoPipelinePage } from '../repo-pipeline.tsx';

const server = setupServer(...createHandlers());

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});

function renderPipeline(repo = 'acme/widgets'): void {
  const segment = repo.replace('/', '__');
  renderWithProviders(
    <Routes>
      <Route path="/repos/:repo/pipeline" element={<RepoPipelinePage />} />
    </Routes>,
    { route: `/repos/${segment}/pipeline` },
  );
}

describe('流水线页', () => {
  it('页头：eyebrow 说明范围 + h1「流水线」+ 阶段配置入口', async () => {
    renderPipeline();

    expect(await screen.findByRole('heading', { level: 1, name: '流水线' })).toBeTruthy();
    expect(screen.getByText('当前仓库 ·').parentElement?.textContent).toContain('acme/widgets');
    const settingsLink = screen.getByTestId('pipeline-settings-link');
    // 设置页的流水线分区是**路径段**（`/settings/pipeline`），不是 `general#pipeline` 的 hash
    expect(settingsLink.getAttribute('href')).toBe('/repos/acme__widgets/settings/pipeline');
  });

  it('指标条：四格都在；「今日自动关闭」没有数据源 → —，并在 title 里说明缺哪个接口', async () => {
    renderPipeline();
    await screen.findByTestId('pipeline-metrics');

    for (const id of ['metric-in-pipeline', 'metric-awaiting', 'metric-blocked', 'metric-closed-today']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    const closedToday = screen.getByTestId('metric-closed-today');
    expect(closedToday.textContent).toContain('—');
    expect(closedToday.getAttribute('title') ?? '').toContain('缺接口');
    // 待人补充 / 阻塞两格带口径（最久 / 失败 n/5），不是裸数字
    expect(screen.getByTestId('metric-awaiting').textContent).toMatch(/最久/u);
    expect(screen.getByTestId('metric-blocked').textContent).toMatch(/失败 \d\/5/u);
  });

  it('阶段看板：四列 + 未入流水线一组，列底有口径、卡点开进详情', async () => {
    renderPipeline();
    const board = await screen.findByTestId('stage-board');

    for (const stage of ['format', 'classify', 'agent', 'closed']) {
      expect(within(board).getByTestId(`stage-column-${stage}`)).toBeTruthy();
      expect(within(board).getByTestId(`stage-footnote-${stage}`).textContent ?? '').not.toBe('');
    }

    // mock 里 `acme/widgets#17` 是 agent/ready，带会话（阶段 2）
    const card = within(board).getByTestId('stage-card-acme/widgets#issue17');
    expect(card.getAttribute('href')).toBe('/repos/acme__widgets/issues/issue/17');
    expect(card.textContent).toContain('已就绪');

    // `pipeline === null` 的行单独一组（mock 的填充行里有一部分没有状态行）
    expect(within(board).getByTestId('stage-unassigned')).toBeTruthy();
    expect(Number(within(board).getByTestId('stage-unassigned-count').textContent)).toBeGreaterThan(0);
  });

  it('门禁处置表：§8 的七行，状态用徽章、理由在 faint 列', async () => {
    renderPipeline();
    const table = await screen.findByTestId('gate-table');

    const rows = within(table).getAllByTestId(/^gate-row-/u);
    expect(rows).toHaveLength(7);
    // 关键行：blocked 的处置里有两条只读命令
    const blocked = within(table).getByTestId('gate-row-blocked');
    expect(blocked.textContent).toContain('/recheck --force');
    expect(blocked.textContent).toContain('/pipeline next');
  });

  it('右列：系统常量带「只读」、提示词指针两种形态、会话健康缺的写 —', async () => {
    renderPipeline();
    await screen.findByTestId('system-constants');

    expect(screen.getByTestId('system-constants').textContent).toContain('PIPELINE_FORMAT_MAX_FAILS');
    expect(screen.getByTestId('system-constants').textContent).toContain('PROMPT_LIMITS.body');

    const pointers = await screen.findByTestId('prompt-pointers');
    expect(pointers.textContent).toContain('v3 · 项目版本');
    expect(pointers.textContent).toContain('v2 · 项目版本');
    // agent 指针是 0 → 系统默认（mock 里故意留一个 0）
    expect(within(screen.getByTestId('prompt-pointer-agent')).getByTitle(/内置默认正文|prompt_version/u)).toBeTruthy();

    const health = screen.getByTestId('session-health');
    expect(health.textContent).toContain('复用会话');
    expect(health.textContent).toContain('已归档');
    expect(health.textContent).toContain('—');
  });
});
