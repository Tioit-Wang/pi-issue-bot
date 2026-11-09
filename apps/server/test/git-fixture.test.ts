/**
 * 真 git 测试夹具（不是测试文件：供 `git-*.test.ts` import）。
 *
 * 为什么做成夹具而不是每个文件各写一遍：`git-repo-cache` / `git-writeback` /
 * `git-branch-cleanup` 都需要同一个形状的「真 bare 仓库 + 一条初始提交 + 一个
 * 记录 argv 的执行器」。复制三份意味着三份会慢慢漂移，而这里漂移的后果是
 * 「某个测试其实在测另一个东西」。
 *
 * 全部操作都在 `os.tmpdir()` 下的临时目录里，**不碰工作区仓库本体**；
 * `git` 身份用 run-git 的默认值（`pi-issue-bot <bot@…>`），并隔离全局/系统配置，
 * 这样宿主机上的 `user.name`、`core.hooksPath`、`url.*.insteadOf` 都影响不到断言。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';


import { createExecFileRunGit, gitOutput } from '../src/git/run-git.ts';
import type { GitResult, RunGit, RunGitOptions } from '../src/git/run-git.ts';

/** 默认仓库内容：一个源文件、一个未声明的 README、一份 CI 定义（拒收清单的靶子）。 */
export const DEFAULT_FILES: Readonly<Record<string, string>> = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 2;\n',
  'README.md': '# demo\n',
  '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
};

export interface GitFixture {
  readonly root: string;
  /** 远端 bare 仓库（`origin` 指向它）。 */
  readonly bareDir: string;
  /** 一个普通检出（用来造提交并推到 bare）。 */
  readonly sourceDir: string;
  readonly cacheRoot: string;
  readonly jobRoot: string;
  readonly repo: string;
  readonly remoteUrl: string;
  readonly initialSha: string;
  /** 所有 git 调用的 argv（断言「没有 --force」用）。 */
  readonly calls: string[][];
  readonly runGit: RunGit;
  cleanup(): Promise<void>;
}

/** git 可执行文件是否可用（不可用时整组 skip，不假装跑过）。 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await createExecFileRunGit()(['--version']);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

export async function createGitFixture(options: {
  files?: Readonly<Record<string, string>>;
  repo?: string;
} = {}): Promise<GitFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-git-'));
  const bareDir = path.join(root, 'remote.git');
  const sourceDir = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  const jobRoot = path.join(root, 'jobs');
  const repo = options.repo ?? 'acme/demo';

  // 隔离配置：HOME/USERPROFILE 指到临时目录，不读系统级 gitconfig。
  const git = createExecFileRunGit({
    env: {
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    },
  });
  const calls: string[][] = [];
  const runGit: RunGit = async (args: readonly string[], callOptions?: RunGitOptions): Promise<GitResult> => {
    calls.push([...args]);
    return git(args, callOptions);
  };

  await git(['init', '--bare', '--initial-branch=main', bareDir]);
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--initial-branch=main'], { cwd: sourceDir });
  await writeFiles(sourceDir, options.files ?? DEFAULT_FILES);
  await git(['add', '-A'], { cwd: sourceDir });
  await git(['commit', '-m', 'init'], { cwd: sourceDir });
  await git(['remote', 'add', 'origin', bareDir], { cwd: sourceDir });
  await git(['push', 'origin', 'main'], { cwd: sourceDir });
  const initialSha = gitOutput(await git(['rev-parse', 'HEAD'], { cwd: sourceDir }));

  return {
    root,
    bareDir,
    sourceDir,
    cacheRoot,
    jobRoot,
    repo,
    remoteUrl: bareDir,
    initialSha,
    calls,
    runGit,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 在 source 仓库里改文件并提交，然后推到 bare 的 main。 */
export async function commitInSource(
  fixture: GitFixture,
  changes: Readonly<Record<string, string>>,
  message = 'change',
): Promise<string> {
  await writeFiles(fixture.sourceDir, changes);
  await fixture.runGit(['add', '-A'], { cwd: fixture.sourceDir });
  await fixture.runGit(['commit', '-m', message], { cwd: fixture.sourceDir });
  await fixture.runGit(['push', 'origin', 'main'], { cwd: fixture.sourceDir });
  return gitOutput(await fixture.runGit(['rev-parse', 'HEAD'], { cwd: fixture.sourceDir }));
}

/** 读某个仓库里某个 revision 上的文件内容（`<rev>:<path>`）。 */
export async function showFile(input: {
  runGit: RunGit;
  cwd: string;
  rev: string;
  file: string;
}): Promise<string> {
  const result = await input.runGit(['show', `${input.rev}:${input.file}`], { cwd: input.cwd, allowFailure: true });
  return result.code === 0 ? result.stdout : '';
}

/** 某个 revision 相对父提交改动的文件名（`--name-only`，用来断言推送集）。 */
export async function changedFiles(runGit: RunGit, cwd: string, rev: string): Promise<string[]> {
  const result = await runGit(['show', '--pretty=format:', '--name-only', rev], { cwd, allowFailure: true });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 夹具自检（这个文件本身也是 `*.test.ts`，vitest 要求它至少有一个真断言）。
 * 顺带把「bare 仓库 + 一条初始提交」这条前提验一遍：后面三个真 git 文件都靠它。
 */
describe('git-fixture', () => {
  it('能在临时目录里建出 bare 仓库与一条初始提交', async (ctx) => {
    if (!(await isGitAvailable())) {
      ctx.skip();
      return;
    }
    const fixture = await createGitFixture();
    try {
      const bareHead = gitOutput(await fixture.runGit(['rev-parse', 'refs/heads/main'], { cwd: fixture.bareDir }));
      expect(bareHead).toBe(fixture.initialSha);
      expect(fixture.calls.length).toBeGreaterThan(0);
      // 隔离性：夹具的 HOME 指在临时目录里，绝不读写宿主的 gitconfig。
      expect(fixture.root.startsWith(os.tmpdir())).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});
