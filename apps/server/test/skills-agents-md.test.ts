/**
 * `skills/agents-md.ts` 的单测（spec §7 / §2.2 / R7）。
 *
 * 全部用 `node:fs/promises` + `os.tmpdir()` 造临时 worktree —— 不碰库、不碰网络、不碰仓库本身，
 * 所以这套用例可以在任何机器上跑（包括没有 docker / 没有 PG 的环境）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENTS_MD_FILENAME,
  AGENTS_MD_LIMITS,
  AGENTS_MD_TRUNCATED_MARK,
  collectAgentsMd,
} from '../src/skills/agents-md.ts';
import { UNTRUSTED_SENTINEL } from '../src/skills/prompt.ts';

const created: string[] = [];

/** 造一个临时 worktree 目录。 */
async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-bot-agents-md-'));
  created.push(dir);
  return dir;
}

/** 在 worktree 里写一个文件（自动建父目录）。 */
async function putFile(root: string, relPath: string, text: string): Promise<void> {
  const target = path.join(root, ...relPath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

/** 一段文本里出现了几次围栏哨兵（一个完整的 fence 是 2 次：开 + 关）。 */
function sentinelCount(text: string): number {
  return text.split(UNTRUSTED_SENTINEL).length - 1;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('collectAgentsMd', () => {
  it('根 AGENTS.md 超 4000 字符：按字符截断并留可见标记', async () => {
    const root = await makeWorktree();
    await putFile(root, AGENTS_MD_FILENAME, 'A'.repeat(5_000));

    const result = await collectAgentsMd({ worktreeDir: root });

    expect(result.root).not.toBeNull();
    const section = result.root;
    if (section === null) {
      throw new Error('unreachable');
    }
    expect(section.path).toBe(AGENTS_MD_FILENAME);
    expect(section.truncated).toBe(true);
    expect(section.bytes).toBe(5_000);
    expect(section.text).toContain(AGENTS_MD_TRUNCATED_MARK);
    // 截断是「前 4000 字符 + sanitize 自己的说明 + 本层的标记」，所以一定远小于原文
    expect(section.text.length).toBeLessThan(5_000);
    expect(section.text).toContain('A'.repeat(1_000));
  });

  it('根 AGENTS.md 没超限：不截断、无标记、内容被围栏包裹', async () => {
    const root = await makeWorktree();
    await putFile(root, AGENTS_MD_FILENAME, '构建用 pnpm，测试用 vitest。');

    const result = await collectAgentsMd({ worktreeDir: root });

    expect(result.root?.truncated).toBe(false);
    expect(result.root?.text).not.toContain(AGENTS_MD_TRUNCATED_MARK);
    // 必须整段被围栏包裹（AGENTS.md 是不可信输入，spec §8）
    expect(result.root?.text.startsWith(`${UNTRUSTED_SENTINEL}:agents-md>>>`)).toBe(true);
    expect(result.root?.text.endsWith(`${UNTRUSTED_SENTINEL}:agents-md:END>>>`)).toBe(true);
    expect(sentinelCount(result.root?.text ?? '')).toBe(2);
    expect(result.root?.text).toContain('构建用 pnpm');
  });

  it('就近：从任务路径逐级向上，最多 3 个、越近越靠前、不含根', async () => {
    const root = await makeWorktree();
    await putFile(root, AGENTS_MD_FILENAME, '根约定');
    for (const dir of ['a', 'a/b', 'a/b/c', 'a/b/c/d']) {
      await putFile(root, `${dir}/${AGENTS_MD_FILENAME}`, `${dir} 的约定`);
    }

    const result = await collectAgentsMd({ worktreeDir: root, hintPaths: ['a/b/c/d/foo.ts'] });

    expect(result.nearby.map((section) => section.path)).toEqual([
      'a/b/c/d/AGENTS.md',
      'a/b/c/AGENTS.md',
      'a/b/AGENTS.md',
    ]);
    expect(result.nearby[0]?.text).toContain('a/b/c/d 的约定');
    // 根不进就近层（它有自己的位置）
    expect(result.nearby.some((section) => section.path === AGENTS_MD_FILENAME)).toBe(false);
  });

  it('多个 hint 指向同一子树：去重，且按「最近」的那次算深度', async () => {
    const root = await makeWorktree();
    for (const dir of ['a', 'a/b']) {
      await putFile(root, `${dir}/${AGENTS_MD_FILENAME}`, `${dir} 的约定`);
    }

    const result = await collectAgentsMd({
      worktreeDir: root,
      hintPaths: ['a/b/foo.ts', 'a/b/bar/baz.ts'],
    });

    expect(result.nearby.map((section) => section.path)).toEqual(['a/b/AGENTS.md', 'a/AGENTS.md']);
  });

  it('`..` 逃逸与绝对路径被跳过（进 skipped），一个字节都不读', async () => {
    const root = await makeWorktree();
    await putFile(root, AGENTS_MD_FILENAME, '根约定');

    const result = await collectAgentsMd({
      worktreeDir: root,
      hintPaths: ['../etc/passwd', 'a/../../outside', 'C:\\Windows\\win.ini', '/etc/hosts'],
    });

    expect(result.nearby).toHaveLength(0);
    expect(result.root).not.toBeNull();
    expect(result.skipped.some((item) => item.includes('.. 段'))).toBe(true);
    expect(result.skipped.some((item) => item.includes('盘符路径'))).toBe(true);
    expect(result.skipped.some((item) => item.includes('绝对路径'))).toBe(true);
  });

  it('文件缺失不算错误：不抛、不进 skipped', async () => {
    const root = await makeWorktree();

    const result = await collectAgentsMd({ worktreeDir: root, hintPaths: ['apps/server/src/foo.ts'] });

    expect(result.root).toBeNull();
    expect(result.nearby).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('超过 1 MB 的文件直接跳过并记 skipped', async () => {
    const root = await makeWorktree();
    await putFile(root, `big/${AGENTS_MD_FILENAME}`, 'A'.repeat(AGENTS_MD_LIMITS.maxFileBytes + 1));

    const result = await collectAgentsMd({ worktreeDir: root, hintPaths: ['big/foo.ts'] });

    expect(result.nearby).toEqual([]);
    expect(result.skipped.some((item) => item.includes('1 MB'))).toBe(true);
  });

  it('就近合计超过 6000 字符：越远的整段丢弃（不切字符）', async () => {
    const root = await makeWorktree();
    // 每段 2000 字符 → 单段没超限，3 段合计肯定超 6000（围栏本身也要算）
    for (const dir of ['a', 'a/b', 'a/b/c']) {
      await putFile(root, `${dir}/${AGENTS_MD_FILENAME}`, 'B'.repeat(AGENTS_MD_LIMITS.nearbyMaxChars));
    }

    const result = await collectAgentsMd({ worktreeDir: root, hintPaths: ['a/b/c/foo.ts'] });

    expect(result.nearby.length).toBeLessThan(AGENTS_MD_LIMITS.maxNearby);
    expect(result.skipped.some((item) => item.includes('就近合计'))).toBe(true);
    const total = result.nearby.reduce((sum, section) => sum + section.text.length, 0);
    expect(total).toBeLessThanOrEqual(AGENTS_MD_LIMITS.nearbyTotalChars);
  });

  it('工作中的 worktreeDir 不存在：返回空结果而不是抛错', async () => {
    const result = await collectAgentsMd({ worktreeDir: path.join(tmpdir(), 'pi-bot-does-not-exist-xyz') });

    expect(result.root).toBeNull();
    expect(result.nearby).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});
