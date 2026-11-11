/**
 * 项目技能页（`/repos/:repo/skills`）的页面测试 —— 四件事必须有测试钉住：
 *
 *  1. **三个内置技能排在最前**（按名字，不认 id）：列表接口把内置技能排在后面时也要顶上去；
 *  2. **编辑走模态框**：点「编辑」弹出弹窗，左边文件树、右边等宽 textarea，
 *     回填的是 `GET /api/skills/:id/files` 拿到的 `SKILL.md`（frontmatter + 正文），不是 Markdown 渲染；
 *  3. **保存失败给服务端原文**：`不允许在编辑器里改技能名…` 要原样贴在弹窗里，不吞成「保存失败」；
 *  4. **导入 zip 必须落在当前项目**（`?repo=…`，没有 `scope` 这个概念了），且结果逐条展示（不是只报个数字）。
 *
 * 断言方式沿用 `skills.test.tsx`：请求侧记录真实 URL / body，mock 状态用
 * `mocks/handlers/skills.ts` 的同一份纯函数推进（测试里覆写拦截器时也调它们）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { resetSkillsMock } from '../../mocks/handlers/skills.ts';
import { Toaster, clearToasts } from '../../components/ui/toast.tsx';
import { renderWithProviders } from '../../../test/render.tsx';
import { RepoSkillsPage } from '../repo-skills.tsx';

const server = setupServer(...createHandlers());

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
  clearToasts();
});

/** 路由里的仓库是单段编码 `owner__name`；`ROUTE_PATTERN` 是路由表里的写法（含 `:repo`）。 */
const ROUTE = '/repos/acme__widgets/skills';
const ROUTE_PATTERN = '/repos/:repo/skills';

/** 种子 id（与 `mocks/handlers/skills.ts` 一致）。 */
const ID_ISSUE_FORMAT = 'sk-builtin-issue-format';
const ID_RELEASE_NOTES = 'sk-release-notes';

/** 列表里每一行的技能名（顺序即渲染顺序）。 */
function rowNames(): string[] {
  const list = screen.getByTestId('repo-skills-list');
  return within(list)
    .getAllByTestId('repo-skill-row-name')
    .map((node) => node.textContent ?? '');
}

function renderPage(): ReturnType<typeof renderWithProviders> {
  // 页面靠 `useParams()` 拿 `:repo`，所以必须挂在一个真路由上；
  // `Toaster` 只在 `AppLayout` 里挂，单页测试要自己挂一个才能看到 toast。
  return renderWithProviders(
    <Routes>
      <Route
        path={ROUTE_PATTERN}
        element={
          <>
            <RepoSkillsPage />
            <Toaster />
          </>
        }
      />
    </Routes>,
    { route: ROUTE },
  );
}

/** 一个「像 zip」的字节串：`PK\x03\x04` + 明文的文件名（mock 只扫中央目录里的路径）。 */
function zipBytes(paths: string[]): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(paths.join('\n'))]);
}

describe('/repos/:repo/skills 列表', () => {
  it('三个内置技能排在最前（按名字，不按接口返回顺序），其余按名字跟在后面', async () => {
    renderPage();
    await screen.findByTestId('repo-skills-list');

    // 内置技能是引擎自带的（`source=builtin`），本项目自己的那份是 `repo=acme/widgets`
    expect(
      requests.some((url) => url.includes('/api/skills') && url.includes('repo=acme%2Fwidgets')),
    ).toBe(true);
    expect(
      requests.some((url) => url.includes('/api/skills') && url.includes('source=builtin')),
    ).toBe(true);

    expect(rowNames()).toEqual([
      '/issue-format',
      '/label-triage',
      '/issue-analysis',
      '/release-notes',
      '/review-pr',
    ]);
  });

  it('每行带来源徽章、版本号、启用开关；本项目那条是「面板上传」', async () => {
    renderPage();
    await screen.findByTestId('repo-skills-list');

    const builtinRow = screen.getByTestId(`repo-skill-item-${ID_ISSUE_FORMAT}`);
    expect(within(builtinRow).getByTestId('repo-skill-row-source').textContent).toBe('内置');
    expect(within(builtinRow).getByTestId('repo-skill-row-version').textContent).toBe('v1');
    expect(within(builtinRow).getByTestId('repo-skill-row-description').textContent ?? '').toContain(
      '把 issue 正文整理成固定结构',
    );
    const toggle = within(builtinRow).getByTestId(`repo-skill-toggle-${ID_ISSUE_FORMAT}`);
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    const repoRow = screen.getByTestId(`repo-skill-item-${ID_RELEASE_NOTES}`);
    expect(within(repoRow).getByTestId('repo-skill-row-source').textContent).toBe('面板上传');
    expect(within(repoRow).getByTestId('repo-skill-row-version').textContent).toBe('v2');
  });

  it('空态：本项目没有自定义技能时是一句话 + 内置技能仍在列表里（不是空卡片）', async () => {
    // 本项目那条查询返回空；`source=builtin` 那条照常返回三个内置技能
    const builtinRow = (id: string, name: string, description: string, sizeBytes: number) => ({
      id,
      name,
      description,
      scope: 'repo',
      repo: null,
      source: 'builtin',
      enabled: true,
      currentVersion: 1,
      overriddenBy: null,
      sizeBytes,
      updatedAt: new Date().toISOString(),
    });
    server.use(
      http.get('/api/skills', ({ request }) => {
        const params = new URL(request.url).searchParams;
        const data =
          params.get('source') === 'builtin'
            ? {
                generatedAt: new Date().toISOString(),
                skills: [
                  builtinRow(
                    ID_ISSUE_FORMAT,
                    '/issue-format',
                    '把 issue 正文整理成固定结构：现象、复现步骤、期望行为、环境。',
                    1_840,
                  ),
                  builtinRow(
                    'sk-builtin-label-triage',
                    '/label-triage',
                    '按标签词表给 issue 打标签；与人工标签冲突时保留人工的那一个。',
                    1_620,
                  ),
                  builtinRow(
                    'sk-builtin-issue-analysis',
                    '/issue-analysis',
                    '读代码与日志给出一句话结论，不猜实现细节。',
                    2_100,
                  ),
                ],
              }
            : { generatedAt: new Date().toISOString(), skills: [] };
        return HttpResponse.json(data);
      }),
    );

    renderPage();

    const empty = await screen.findByTestId('repo-skills-empty');
    expect(empty.textContent ?? '').toContain('本项目还没有自定义技能');
    expect(empty.textContent ?? '').toContain('3 个内置技能已在生效');
    // 空态旁边仍然有行（内置技能），且没有方框空态
    expect(rowNames()).toHaveLength(3);
  });
});

describe('编辑走模态框', () => {
  it('点「编辑」弹出模态框：文件树 + 等宽 textarea，回填 SKILL.md（frontmatter + 正文）', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('repo-skills-list');

    // 默认不请求文件列表，也没有编辑器
    expect(requests.some((url) => url.endsWith(`/api/skills/${ID_ISSUE_FORMAT}/files`))).toBe(false);
    expect(screen.queryByTestId('skill-editor-textarea')).toBeNull();

    await user.click(screen.getByTestId(`repo-skill-edit-${ID_ISSUE_FORMAT}`));

    const panel = await screen.findByTestId('skill-editor-modal-panel');
    expect(panel.getAttribute('role')).toBe('dialog');

    const textarea = await screen.findByTestId('skill-editor-textarea');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.className).toContain('font-mono');
    expect(textarea.className).toContain('whitespace-pre-wrap');

    const value = (textarea as HTMLTextAreaElement).value;
    // frontmatter 在最前（YAML 块），正文跟在后面 —— 是一个文件，不是两段
    expect(value.startsWith('---\n')).toBe(true);
    expect(value).toContain('name: /issue-format');
    expect(value).toContain('allowed-tools:\n  - Read\n  - Grep');
    expect(value).toContain('## 何时用');
    expect(value).toContain('把正文拆成粒度一致的段落');

    // 文件树里有 SKILL.md，且它就是当前文件
    const tree = screen.getByTestId('skill-editor-tree');
    expect(within(tree).getByTestId('skill-editor-file-SKILL.md').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('skill-editor-current-path').textContent).toBe('SKILL.md');

    // 内置技能：一句「保存后即为本项目覆盖」的说明，不是整段解释
    expect(screen.getByTestId('skill-editor-hint').textContent ?? '').toContain('这是内置技能的副本');

    // 文件只在打开时拉一次
    expect(requests.filter((url) => url.endsWith(`/api/skills/${ID_ISSUE_FORMAT}/files`))).toHaveLength(1);

    await user.click(screen.getByTestId('skill-editor-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('skill-editor-textarea')).toBeNull();
    });
  });

  it('点技能名也能打开同一个模态框（标题带技能名与版本号）', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('repo-skills-list');

    await user.click(screen.getByTestId(`repo-skill-open-${ID_RELEASE_NOTES}`));
    await screen.findByTestId('skill-editor-textarea');

    const panel = screen.getByTestId('skill-editor-modal-panel');
    expect(within(panel).getByRole('heading', { level: 2 }).textContent ?? '').toContain('/release-notes');
    expect(screen.getByTestId('skill-editor-version').textContent).toBe('v2');
  });

  it('保存成功：PUT { path, text } + CSRF 头，行内提示「已保存」，列表行版本刷新', async () => {
    const user = userEvent.setup();
    const puts: { url: string; csrf: string | null; path: string; text: string }[] = [];
    server.use(
      http.put('/api/skills/:id/files', async ({ request }) => {
        const body = (await request.json()) as { path: string; text: string };
        puts.push({
          url: request.url,
          csrf: request.headers.get('X-Pi-Bot-CSRF'),
          path: body.path,
          text: body.text,
        });
        return HttpResponse.json({});
      }),
    );

    renderPage();
    await screen.findByTestId('repo-skills-list');
    await user.click(screen.getByTestId(`repo-skill-edit-${ID_RELEASE_NOTES}`));

    const textarea = await screen.findByTestId('skill-editor-textarea');
    await user.click(textarea);
    await user.keyboard('{Control>}{End}{/Control}');
    await user.keyboard('\n额外一行：发布前对照 CHANGELOG。');

    const save = screen.getByTestId('skill-editor-save');
    expect(save.hasAttribute('disabled')).toBe(false);
    await user.click(save);

    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    expect(puts[0]?.url).toContain(`/api/skills/${ID_RELEASE_NOTES}/files`);
    expect(puts[0]?.csrf).toBe('1');
    expect(puts[0]?.path).toBe('SKILL.md');
    expect(puts[0]?.text).toContain('额外一行：发布前对照 CHANGELOG。');

    // 弹窗不自动关（用户可能接着改另一个文件）
    expect(screen.getByTestId('skill-editor-textarea')).toBeTruthy();
  });

  it('保存失败 400：弹窗内显示服务端原文（不吞成「保存失败」），编辑器不关', async () => {
    const user = userEvent.setup();
    const serverMessage = '不允许在编辑器里改技能名（当前 /release-notes，收到 /other）：请新建技能后再删旧的';
    server.use(
      http.put('/api/skills/:id/files', () =>
        HttpResponse.json({ error: { code: 'bad-request', message: serverMessage } }, { status: 400 }),
      ),
    );

    renderPage();
    await screen.findByTestId('repo-skills-list');
    await user.click(screen.getByTestId(`repo-skill-edit-${ID_RELEASE_NOTES}`));

    const textarea = await screen.findByTestId('skill-editor-textarea');
    await user.click(textarea);
    await user.keyboard('{Control>}{End}{/Control}');
    await user.keyboard('\n改写一行。');
    await user.click(screen.getByTestId('skill-editor-save'));

    const error = await screen.findByTestId('skill-editor-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.className).toContain('text-danger-fg');
    // 服务端 message 原文（含具体的当前名 / 收到的名字）
    expect(error.textContent ?? '').toContain(serverMessage);

    // 失败不收起弹窗：用户还要接着改
    expect(screen.getByTestId('skill-editor-textarea')).toBeTruthy();
    // 也没有「已保存」
    expect(screen.queryByTestId('skill-editor-saved')).toBeNull();
  });
});

describe('页面级导入技能 zip 落在当前项目', () => {
  it('POST /api/skills/import?repo=acme/widgets&enabled=true（原始字节 + CSRF，无 scope），结果逐条展示', async () => {
    const uploads: { url: string; csrf: string | null; bytes: number[] }[] = [];
    server.use(
      http.post('/api/skills/import', async ({ request }) => {
        const bytes = new Uint8Array(await request.arrayBuffer());
        uploads.push({
          url: request.url,
          csrf: request.headers.get('X-Pi-Bot-CSRF'),
          bytes: [...bytes],
        });
        return HttpResponse.json({
          generatedAt: new Date().toISOString(),
          imported: [
            { id: 'sk-import-demo-a', name: '/demo-a', version: 1, created: true },
            { id: 'sk-import-demo-b', name: '/demo-b', version: 2, created: false },
          ],
          errors: ['bad_name/SKILL.md：目录名不能作为技能名（需小写字母/数字/连字符，且以字母开头）'],
          warnings: ['同名技能已存在，已覆盖成新版本：/demo-b'],
        });
      }),
    );

    renderPage();
    await screen.findByTestId('repo-skills-list');

    const bytes = [...zipBytes(['demo-a/SKILL.md', 'demo-b/SKILL.md', 'bad_name/SKILL.md'])];
    const file = new File([new Uint8Array(bytes)], 'skills.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByTestId('repo-skills-import-input'), { target: { files: [file] } });

    const summary = await screen.findByTestId('repo-skills-import-summary');
    expect(summary.textContent).toBe('导入完成：新建 1 个，覆盖 1 个，跳过 1 个');

    const items = screen.getAllByTestId('repo-skills-import-item');
    expect(items.map((node) => node.textContent)).toEqual(['/demo-a v1 · 新建', '/demo-b v2 · 覆盖']);
    // 错误逐条显示（不是只报条数）
    expect(screen.getByTestId('repo-skills-import-error-item').textContent ?? '').toContain(
      'bad_name/SKILL.md：目录名不能作为技能名',
    );
    expect(screen.getByTestId('repo-skills-import-warning').textContent ?? '').toContain(
      '同名技能已存在',
    );

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toContain('/api/skills/import?repo=acme%2Fwidgets&enabled=true');
    expect(uploads[0]?.url).not.toContain('scope=');
    expect(uploads[0]?.csrf).toBe('1');
    expect(uploads[0]?.bytes).toEqual(bytes);
  });
});

/**
 * 回归：技能只属于项目 —— 列表请求**一定带 `repo=`**、**一定不带 `scope=`**。
 * 这条断言是「全局技能」被移除后的护栏：谁再把 `scope` 拼回查询串（或漏掉 `repo`），这里就红。
 */
describe('技能查询串只认 repo', () => {
  it('每一次 GET /api/skills 都带 repo=acme%2Fwidgets，且都没有 scope=', async () => {
    renderPage();
    await screen.findByTestId('repo-skills-list');

    const listCalls = requests.filter((url) => url.includes('/api/skills?'));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const url of listCalls) {
      expect(url).toContain('repo=acme%2Fwidgets');
      expect(url).not.toContain('scope=');
    }
  });
});
