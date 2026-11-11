/**
 * 技能编辑器模态框（`components/skills/skill-editor-modal.tsx`）与页面级导入的测试。
 *
 * 钉住的是**交互合同**，不是像素：
 *  1. 打开即拉 `GET /api/skills/:id/files`，左树右编辑器，目录嵌套正确、当前文件高亮；
 *  2. 点另一个文件 → 右边换成它的原文（纯文本，不渲染 Markdown）；
 *  3. 保存 → `PUT /api/skills/:id/files { path, text }`（+ CSRF），path 必须是**当前文件**；
 *  4. 保存 400 → 弹窗内贴服务端 `message` 原文（不吞成「保存失败」）；
 *  5. 弹窗内上传 zip → `POST /api/skills/:id/versions`（原始字节 + CSRF），成功后关窗；
 *  6. 页面级导入 zip → 逐条显示 `imported` 与 `errors`（错误不缩成「N 个」）；
 *  7. Esc 关闭；有未保存修改时先确认（`window.confirm` 说「不要」就不关）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandlers } from '../mocks/handlers/index.ts';
import { resetSkillsMock } from '../mocks/handlers/skills.ts';
import { SkillEditorModal } from '../components/skills/skill-editor-modal.tsx';
import { Toaster, clearToasts } from '../components/ui/toast.tsx';
import { renderWithProviders } from '../../test/render.tsx';
import { RepoSkillsPage } from '../routes/repo-skills.tsx';
import type { SkillListItem } from '../../../../packages/contract/src/index.ts';

const server = setupServer(...createHandlers());

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // mock 的 `Map` 是模块级状态，`resetHandlers()` 不会复位它
  resetSkillsMock();
  clearToasts();
});

/** `/release-notes` 的列表行（与 `mocks/handlers/skills.ts` 的 seed 对应：两层目录）。 */
const ITEM: SkillListItem = {
  id: 'sk-release-notes',
  name: '/release-notes',
  description: '按合并日志生成发布说明草稿，只写用户可见的变更。',
  scope: 'repo',
  repo: 'acme/widgets',
  source: 'upload',
  enabled: true,
  currentVersion: 2,
  overriddenBy: null,
  sizeBytes: 3_080,
  updatedAt: new Date().toISOString(),
};

/** 打开弹窗（单独挂载组件：测的是弹窗本身，不掺列表页）。 */
function renderModal(): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  renderWithProviders(
    <>
      <SkillEditorModal item={ITEM} onClose={onClose} />
      <Toaster />
    </>,
  );
  return { onClose };
}

/** 一个「像 zip」的字节串：`PK\x03\x04` + 明文的文件名（mock 只扫中央目录里的路径）。 */
function zipFile(paths: string[], name = 'skill.zip'): File {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(paths.join('\n'))]);
  return new File([bytes], name, { type: 'application/zip' });
}

describe('技能编辑器模态框', () => {
  it('打开即拉文件列表：左栏文件树列出目录与文件，SKILL.md 是当前文件', async () => {
    renderModal();

    const tree = await screen.findByTestId('skill-editor-tree');
    // 根文件
    expect(within(tree).getByTestId('skill-editor-file-SKILL.md')).toBeTruthy();
    // 两级目录：references/ 与 references/guides/
    expect(within(tree).getByTestId('skill-editor-dir-references')).toBeTruthy();
    expect(within(tree).getByTestId('skill-editor-dir-references/guides')).toBeTruthy();
    expect(within(tree).getByTestId('skill-editor-file-references/guides/versioning.md')).toBeTruthy();

    // 文件树里显出字节数（不是「—」）
    expect(within(tree).getByTestId('skill-editor-file-SKILL.md').textContent ?? '').toMatch(/\d+ KB|B/);

    // 当前文件是 SKILL.md，且被 aria-current 标出
    expect(screen.getByTestId('skill-editor-current-path').textContent).toBe('SKILL.md');
    expect(
      within(tree).getByTestId('skill-editor-file-SKILL.md').getAttribute('aria-current'),
    ).toBe('true');

    // 标题带技能名与版本
    expect(screen.getByTestId('skill-editor-version').textContent).toBe('v2');
  });

  it('点另一个文件：编辑器内容切到它（纯文本，不是渲染后的 Markdown）', async () => {
    const user = userEvent.setup();
    renderModal();

    const textarea = await screen.findByTestId('skill-editor-textarea');
    expect((textarea as HTMLTextAreaElement).value).toContain('name: /release-notes');
    // 未改动时保存是禁用的
    expect(screen.getByTestId('skill-editor-save').hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByTestId('skill-editor-file-references/publishing.md'));

    expect(screen.getByTestId('skill-editor-current-path').textContent).toBe('references/publishing.md');
    const value = (screen.getByTestId('skill-editor-textarea') as HTMLTextAreaElement).value;
    expect(value).toContain('# 发布流程');
    expect(value).not.toContain('name: /release-notes');
    // 纯文本：没有 HTML 元素被造出来
    expect(screen.getByTestId('skill-editor-textarea').tagName).toBe('TEXTAREA');
  });

  it('保存发出 { path, text } 到当前文件：PUT /api/skills/:id/files + CSRF（Ctrl+S 也行）', async () => {
    const user = userEvent.setup();
    const puts: { url: string; csrf: string | null; path: string; text: string }[] = [];
    server.use(
      http.put('/api/skills/:id/files', async ({ request, params }) => {
        const body = (await request.json()) as { path: string; text: string };
        puts.push({ url: request.url, csrf: request.headers.get('X-Pi-Bot-CSRF'), ...body });
        // 走同一份 mock 状态：否则刷新回来的内容与版本号不会变
        return HttpResponse.json({
          ...ITEM,
          currentVersion: ITEM.currentVersion + 1,
          id: String(params.id),
        });
      }),
    );

    renderModal();
    const textarea = await screen.findByTestId('skill-editor-textarea');

    await user.click(screen.getByTestId('skill-editor-file-references/publishing.md'));
    const target = screen.getByTestId('skill-editor-textarea');
    await user.click(target);
    await user.keyboard('{Control>}{End}{/Control}');
    await user.keyboard('\n5. 发布后把 tag 与说明贴到公告里。');

    // Ctrl+S 与点「保存」等价
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    expect(puts[0]?.url).toContain(`/api/skills/${ITEM.id}/files`);
    expect(puts[0]?.csrf).toBe('1');
    expect(puts[0]?.path).toBe('references/publishing.md');
    expect(puts[0]?.text).toContain('5. 发布后把 tag 与说明贴到公告里。');
    // 提示「已保存」，弹窗仍在（用户可能接着改下一个文件）
    expect((await screen.findByTestId('skill-editor-saved')).textContent ?? '').toContain('已保存');
    expect(textarea).toBeTruthy();
  });

  it('保存 400：把服务端 message 原文贴在弹窗里（不吞成「保存失败」）', async () => {
    const user = userEvent.setup();
    const serverMessage = '技能校验不通过：SKILL.md frontmatter 非法：description 至少 10 个字符且必须单行';
    server.use(
      http.put('/api/skills/:id/files', () =>
        HttpResponse.json({ error: { code: 'bad-request', message: serverMessage } }, { status: 400 }),
      ),
    );

    renderModal();
    await screen.findByTestId('skill-editor-textarea');
    await user.click(screen.getByTestId('skill-editor-textarea'));
    await user.keyboard('{Control>}{End}{/Control}');
    await user.keyboard('x');
    await user.click(screen.getByTestId('skill-editor-save'));

    const error = await screen.findByTestId('skill-editor-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.className).toContain('text-danger-fg');
    expect(error.textContent ?? '').toContain(serverMessage);
    // 弹窗不关、草稿还在（用户接着改）
    expect((screen.getByTestId('skill-editor-textarea') as HTMLTextAreaElement).value).toContain('x');
    expect(screen.queryByTestId('skill-editor-saved')).toBeNull();
  });

  it('弹窗内上传 zip 覆盖本技能：POST /api/skills/:id/versions（原始字节 + CSRF），成功后关窗', async () => {
    const uploads: { url: string; csrf: string | null; contentType: string | null; bytes: number[] }[] = [];
    server.use(
      http.post('/api/skills/:id/versions', async ({ request, params }) => {
        uploads.push({
          url: request.url,
          csrf: request.headers.get('X-Pi-Bot-CSRF'),
          contentType: request.headers.get('content-type'),
          bytes: [...new Uint8Array(await request.arrayBuffer())],
        });
        return HttpResponse.json(
          {
            skill: { ...ITEM, id: String(params.id), currentVersion: 3 },
            version: 3,
            validation: { ok: true, errors: [], warnings: [] },
          },
          { status: 201 },
        );
      }),
    );

    const { onClose } = renderModal();
    await screen.findByTestId('skill-editor-textarea');

    const file = zipFile(['release-notes/SKILL.md']);
    fireEvent.change(screen.getByTestId('skill-editor-upload-input'), { target: { files: [file] } });

    const toaster = await screen.findByTestId('toaster');
    expect(toaster.textContent ?? '').toContain('已用 zip 覆盖 /release-notes（v3）');

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toContain(`/api/skills/${ITEM.id}/versions`);
    expect(uploads[0]?.csrf).toBe('1');
    expect(uploads[0]?.contentType).toBe('application/zip');
    expect(uploads[0]?.bytes.slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('上传失败（名字不一致）时把服务端原文显示在弹窗里，不关窗', async () => {
    const serverMessage = 'zip 里的技能名（/other）与当前技能（/release-notes）不一致：覆盖只能改内容，不能改名';
    server.use(
      http.post('/api/skills/:id/versions', () =>
        HttpResponse.json({ error: { code: 'bad-request', message: serverMessage } }, { status: 400 }),
      ),
    );

    const { onClose } = renderModal();
    await screen.findByTestId('skill-editor-textarea');

    fireEvent.change(screen.getByTestId('skill-editor-upload-input'), {
      target: { files: [zipFile(['other/SKILL.md'])] },
    });

    const error = await screen.findByTestId('skill-editor-upload-error');
    expect(error.textContent ?? '').toContain(serverMessage);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc 关闭；有未保存修改时先确认（说「不要」就不关）', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await screen.findByTestId('skill-editor-textarea');

    // 没改动：Esc 直接关
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // 有改动：确认框说「不要」→ 不关
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByTestId('skill-editor-textarea'));
    await user.keyboard('x');
    await user.click(screen.getByTestId('skill-editor-cancel'));
    expect(confirm).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('页面级导入 zip', () => {
  it('逐条显示 imported（新建/覆盖）与 errors/warnings', async () => {
    server.use(
      http.post('/api/skills/import', () =>
        HttpResponse.json({
          generatedAt: new Date().toISOString(),
          imported: [
            { id: 'sk-import-alpha', name: '/alpha', version: 1, created: true },
            { id: 'sk-import-beta', name: '/beta', version: 3, created: false },
          ],
          errors: ['bad_name/SKILL.md：目录名不能作为技能名（需小写字母/数字/连字符，且以字母开头）'],
          warnings: ['同名技能已存在，已覆盖成新版本：/beta'],
        }),
      ),
    );

    renderWithProviders(
      <Routes>
        <Route
          path="/repos/:repo/skills"
          element={
            <>
              <RepoSkillsPage />
              <Toaster />
            </>
          }
        />
      </Routes>,
      { route: '/repos/acme__widgets/skills' },
    );
    await screen.findByTestId('repo-skills-list');

    fireEvent.change(screen.getByTestId('repo-skills-import-input'), {
      target: { files: [zipFile(['alpha/SKILL.md', 'beta/SKILL.md', 'bad_name/SKILL.md'], 'bundle.zip')] },
    });

    const summary = await screen.findByTestId('repo-skills-import-summary');
    expect(summary.textContent).toBe('导入完成：新建 1 个，覆盖 1 个，跳过 1 个');
    expect(screen.getAllByTestId('repo-skills-import-item').map((node) => node.textContent)).toEqual([
      '/alpha v1 · 新建',
      '/beta v3 · 覆盖',
    ]);
    // 错误与告警都**逐条**显示
    expect(screen.getByTestId('repo-skills-import-error-item').textContent ?? '').toContain(
      'bad_name/SKILL.md：目录名不能作为技能名',
    );
    expect(screen.getByTestId('repo-skills-import-warning').textContent ?? '').toContain(
      '同名技能已存在',
    );
  });

  it('整包失败（如不是 zip）显示服务端原文，不显示「导入完成」', async () => {
    server.use(
      http.post('/api/skills/import', () =>
        HttpResponse.json(
          { error: { code: 'bad-request', message: 'zip 解析失败：不是合法的 zip（缺少 PK 魔数）' } },
          { status: 400 },
        ),
      ),
    );

    renderWithProviders(
      <Routes>
        <Route path="/repos/:repo/skills" element={<RepoSkillsPage />} />
      </Routes>,
      { route: '/repos/acme__widgets/skills' },
    );
    await screen.findByTestId('repo-skills-list');

    fireEvent.change(screen.getByTestId('repo-skills-import-input'), {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'not-a-zip.zip', { type: 'application/zip' })] },
    });

    const error = await screen.findByTestId('repo-skills-import-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent ?? '').toContain('缺少 PK 魔数');
    expect(screen.queryByTestId('repo-skills-import-summary')).toBeNull();
  });
});
