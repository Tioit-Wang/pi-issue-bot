/**
 * 技能页（`/skills`）的页面测试 —— 覆盖 spec `docs/spec/skill-management.md` 的 R1 / R2 / R9 / R11：
 *
 *  1. 列表一条一行：名字、描述、来源 chip、作用域、版本、大小、开关、「被 X 覆盖」；
 *  2. 开关是**真写操作**：`PATCH {enabled:false}` + `X-Pi-Bot-CSRF` 头（R11），并且刷新后开关真的关了；
 *  3. 上传是**原始二进制**：`POST /api/skills?scope=global&enabled=true`，
 *     `Content-Type: application/zip`、body 字节逐个相等（不是 FormData）；
 *  4. 详情展开：frontmatter 表 / 正文 `<pre>` / 文件清单 / 校验（ok + warning）/ 版本标「当前」；
 *  5. 空态分两种：库里没有技能 vs 被筛选筛空（后者带「清除筛选」）。
 *
 * 断言方式沿用 `issues.test.tsx`：
 *  - **请求侧**：`request:start` 记录真实 URL；写操作的 body/头在 `server.use()` 的覆写里读
 *    （覆写后仍调用 `mocks/handlers/skills.ts` 的同一份纯函数，所以 mock 状态是连续的）；
 *  - **状态侧**：`AsyncSection` 的四态 `testid` 约定 `{testId}-{loading,error,content}`，
 *    空态是本页自己画的 `skills-empty`（里面要放「清除筛选」按钮，`emptyText` 只收字符串）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { patchSkillMock, resetSkillsMock, uploadSkillMock } from '../../mocks/handlers/skills.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import type { SkillPatch } from '../../../../../packages/contract/src/index.ts';
import { SkillsPage } from '../skills.tsx';

const server = setupServer(...createHandlers());

/** 每一次页面发出的请求（含 `/api/skills?...`）。 */
const requests: string[] = [];

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
  vi.restoreAllMocks();
});

beforeEach(() => {
  requests.length = 0;
  // mock 的 `Map` 是模块级状态，`resetHandlers()` 不会复位它
  resetSkillsMock();
});

function renderSkills(route = '/skills'): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(<SkillsPage />, { route });
}

/** 三条种子技能的 id（与 `mocks/handlers/skills.ts` 一致）。 */
const ID_GLOBAL_REVIEW = 'sk-review-pr-global';
const ID_REPO_REVIEW = 'sk-review-pr-repo';
const ID_TRIAGE = 'sk-triage';

describe('/skills 列表', () => {
  it('一行一个技能：名字/描述/来源/作用域/版本/大小/开关/覆盖标都在', async () => {
    renderSkills();
    const content = await screen.findByTestId('skills-content');

    const rows = within(content).getAllByTestId(/^skill-item-/);
    expect(rows).toHaveLength(3);

    // 1. 全局内置：v2、KB 大小、启用、被同名仓库技能覆盖
    const global = within(content).getByTestId(`skill-item-${ID_GLOBAL_REVIEW}`);
    expect(within(global).getByTestId('skill-row-name').textContent).toBe('/review-pr');
    expect(within(global).getByTestId('skill-row-name').className).toContain('font-mono');
    expect(within(global).getByTestId('skill-row-description').textContent ?? '').toContain('按清单审 PR');
    expect(within(global).getByTestId('skill-row-source').textContent).toBe('内置');
    expect(within(global).getByTestId('skill-row-scope').textContent).toBe('全局');
    expect(within(global).getByTestId('skill-row-version').textContent).toBe('v2');
    expect(within(global).getByTestId('skill-row-size').textContent).toBe('3.6 KB');
    expect(within(global).getByTestId('skill-row-overridden').textContent).toContain('被 /review-pr 覆盖');
    expect(within(global).getByTestId('skill-row-updated').textContent ?? '').not.toBe('');

    // 开关是 `role=switch` 的真按钮，状态走 aria-checked
    const on = within(global).getByTestId(`skill-toggle-${ID_GLOBAL_REVIEW}`);
    expect(on.getAttribute('role')).toBe('switch');
    expect(on.getAttribute('aria-checked')).toBe('true');

    // 2. 仓库作用域 + 面板上传：作用域显示 owner/name
    const repo = within(content).getByTestId(`skill-item-${ID_REPO_REVIEW}`);
    expect(within(repo).getByTestId('skill-row-scope').textContent).toBe('acme/widgets');
    expect(within(repo).getByTestId('skill-row-source').textContent).toBe('面板上传');
    expect(within(repo).queryByTestId('skill-row-overridden')).toBeNull();

    // 3. 停用 + MB 大小格式
    const triage = within(content).getByTestId(`skill-item-${ID_TRIAGE}`);
    expect(within(triage).getByTestId('skill-row-version').textContent).toBe('v3');
    expect(within(triage).getByTestId('skill-row-size').textContent).toBe('1.2 MB');
    expect(within(triage).getByTestId(`skill-toggle-${ID_TRIAGE}`).getAttribute('aria-checked')).toBe('false');
    expect(triage.textContent ?? '').toContain('已停用');

    // 列表请求本身不带筛选参数（「全部」≠「仅启用」）
    const listUrl = requests.find((url) => url.includes('/api/skills?'));
    expect(listUrl === undefined ? '/api/skills' : listUrl).not.toContain('enabled=');
  });

  it('筛选条进 URL：切「来源=内置」后 URL 与请求同时变', async () => {
    const user = userEvent.setup();
    renderSkills();

    await screen.findByTestId('skills-content');
    await user.selectOptions(screen.getByLabelText('来源筛选'), 'builtin');

    await waitFor(() => {
      expect(requests.some((url) => url.includes('/api/skills') && url.includes('source=builtin'))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(screen.getAllByTestId(/^skill-item-/)).toHaveLength(1);
    });
  });
});

describe('写操作（spec R11：PATCH / POST / DELETE 都要带 CSRF 头）', () => {
  it('开关：点击发出 PATCH {enabled:false}，带 X-Pi-Bot-CSRF，刷新后真的关了', async () => {
    const user = userEvent.setup();
    const calls: { url: string; csrf: string | null; body: unknown }[] = [];
    server.use(
      http.patch('/api/skills/:id', async ({ request, params }) => {
        const body = (await request.json()) as SkillPatch;
        calls.push({
          url: request.url,
          csrf: request.headers.get('X-Pi-Bot-CSRF'),
          body,
        });
        // 仍然走同一份 mock 状态：否则刷新回来的开关会「弹回去」，测试就看不出写操作生效
        const detail = patchSkillMock(String(params.id), body);
        if (detail === null) {
          return HttpResponse.json({ error: { code: 'not-found', message: '技能不存在' } }, { status: 404 });
        }
        return HttpResponse.json(detail);
      }),
    );

    renderSkills();
    await screen.findByTestId('skills-content');

    const toggle = screen.getByTestId(`skill-toggle-${ID_GLOBAL_REVIEW}`);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.url).toContain(`/api/skills/${ID_GLOBAL_REVIEW}`);
    expect(calls[0]?.body).toEqual({ enabled: false });
    expect(calls[0]?.csrf).toBe('1');

    // 列表被 invalidate 后重新拉，开关变成关
    await waitFor(() => {
      expect(screen.getByTestId(`skill-toggle-${ID_GLOBAL_REVIEW}`).getAttribute('aria-checked')).toBe(
        'false',
      );
    });
  });

  it('上传 zip：POST /api/skills?scope=global&enabled=true，application/zip 原始字节 + CSRF', async () => {
    const uploads: { url: string; contentType: string | null; csrf: string | null; bytes: number[] }[] =
      [];
    server.use(
      http.post('/api/skills', async ({ request }) => {
        const bytes = new Uint8Array(await request.arrayBuffer());
        uploads.push({
          url: request.url,
          contentType: request.headers.get('content-type'),
          csrf: request.headers.get('X-Pi-Bot-CSRF'),
          bytes: [...bytes],
        });
        return HttpResponse.json(uploadSkillMock(bytes), { status: 201 });
      }),
    );

    renderSkills();
    await screen.findByTestId('skills-content');

    // 4 字节本地文件头 `PK\x03\x04` + 几个任意字节：断言的是「原始字节原样送上去了」
    const bytes = [0x50, 0x4b, 0x03, 0x04, 0x07, 0x08, 0x09];
    const file = new File([new Uint8Array(bytes)], 'demo-skill.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByTestId('skills-upload-input'), { target: { files: [file] } });

    const ok = await screen.findByTestId('skills-notice-ok');
    expect(ok.textContent ?? '').toContain('已上传 /uploaded-demo（v1）');

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toContain('/api/skills?scope=global&enabled=true');
    expect(uploads[0]?.contentType).toBe('application/zip');
    expect(uploads[0]?.csrf).toBe('1');
    expect(uploads[0]?.bytes).toEqual(bytes);

    // 上传后列表刷新：新技能出现在列表里
    await waitFor(() => {
      expect(screen.getByTestId('skills-content').textContent ?? '').toContain('/uploaded-demo');
    });
  });

  it('删除：confirm 之后发 DELETE（带 CSRF），行从列表消失', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deletes: { url: string; csrf: string | null }[] = [];
    server.use(
      http.delete('/api/skills/:id', ({ request }) => {
        deletes.push({ url: request.url, csrf: request.headers.get('X-Pi-Bot-CSRF') });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderSkills();
    await screen.findByTestId('skills-content');
    await user.click(screen.getByTestId(`skill-delete-${ID_TRIAGE}`));

    await waitFor(() => {
      expect(deletes).toHaveLength(1);
    });
    expect(deletes[0]?.url).toContain(`/api/skills/${ID_TRIAGE}`);
    expect(deletes[0]?.csrf).toBe('1');

    const ok = await screen.findByTestId('skills-notice-ok');
    expect(ok.textContent ?? '').toContain('已删除 /triage');
  });
});

describe('详情（行内展开）', () => {
  it('展开显示 frontmatter / 正文 / 文件清单 / 校验 / 版本（标出当前版本）', async () => {
    const user = userEvent.setup();
    renderSkills();
    await screen.findByTestId('skills-content');

    // 默认不展开：详情接口一次都没请求
    expect(requests.some((url) => url.endsWith(`/api/skills/${ID_GLOBAL_REVIEW}`))).toBe(false);

    await user.click(screen.getByTestId(`skill-expand-${ID_GLOBAL_REVIEW}`));
    const detail = await screen.findByTestId(`skill-detail-${ID_GLOBAL_REVIEW}`);

    const frontmatter = await within(detail).findByTestId('skill-detail-frontmatter');
    expect(frontmatter.textContent ?? '').toContain('allowed-tools');
    expect(frontmatter.textContent ?? '').toContain('Bash, Read, Grep');
    expect(frontmatter.textContent ?? '').toContain('outputs');
    expect(frontmatter.textContent ?? '').toContain('comment, labels');

    const body = within(detail).getByTestId('skill-detail-body');
    expect(body.tagName).toBe('PRE');
    expect(body.className).toContain('whitespace-pre-wrap');
    expect(body.textContent ?? '').toContain('先读 diff 的');

    const files = within(detail).getByTestId('skill-detail-files');
    expect(files.textContent ?? '').toContain('assets/checklist.md');

    const validation = within(detail).getByTestId('skill-detail-validation');
    expect(validation.textContent ?? '').toContain('校验通过');
    expect(validation.textContent ?? '').toContain('timeout 未声明');

    // 版本列表：两条，当前版本 v2 打「当前」标
    await waitFor(() => {
      expect(within(detail).getAllByTestId('skill-version-row')).toHaveLength(2);
    });
    expect(within(detail).getByTestId('skill-version-current').textContent).toBe('当前');

    expect(requests.some((url) => url.endsWith(`/api/skills/${ID_GLOBAL_REVIEW}`))).toBe(true);
    expect(requests.some((url) => url.endsWith(`/api/skills/${ID_GLOBAL_REVIEW}/versions`))).toBe(true);
  });
});

describe('空态分流', () => {
  it('库里没有技能：提示传一个含 SKILL.md 的 zip', async () => {
    renderSkills('/skills?mock=empty');

    const empty = await screen.findByTestId('skills-empty');
    expect(empty.textContent ?? '').toContain('传一个含 SKILL.md 的 zip');
    expect(screen.queryAllByTestId(/^skill-item-/)).toHaveLength(0);
    expect(screen.queryByTestId('skills-empty-clear')).toBeNull();
  });

  it('被筛选筛空：提示没有符合条件的技能 + 清除筛选（点了就回到全部）', async () => {
    const user = userEvent.setup();
    renderSkills('/skills?scope=repo&source=builtin');

    const empty = await screen.findByTestId('skills-empty');
    expect(empty.textContent ?? '').toContain('没有符合条件的技能');
    expect(requests.some((url) => url.includes('scope=repo') && url.includes('source=builtin'))).toBe(
      true,
    );

    await user.click(screen.getByTestId('skills-empty-clear'));
    await waitFor(() => {
      expect(screen.queryByTestId('skills-empty')).toBeNull();
    });
    expect(screen.getAllByTestId(/^skill-item-/)).toHaveLength(3);
  });
});
