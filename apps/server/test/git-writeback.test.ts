/**
 * **真 git** 验收：写回闸门（tech-plan §5.6 / dev-plan §6 M4 ⛔「容器内容不得流入 PR」）。
 *
 * 每个例子的形状都是同一个：真 bare 仓库 + 真 worktree → 改文件 → `runWriteback`
 * → 回 bare 仓库断言「到底推上去了哪些字节」。不是 mock：
 *   - 正例：声明 `src/a.ts` 且只改它 → 推送后 bare 里只有这一个文件变化；
 *   - 反例 1（模拟 `postinstall`）：改了未声明的 `README.md` 与一个新增文件 →
 *     推送内容里不含它们，且 `dropped` 有它们；
 *   - 反例 2：改了 `.github/workflows/ci.yml` → 整次写回失败，bare 无新提交；
 *   - 反例 3：`.git/hooks/pre-commit` / `pre-push` 放了会写文件的钩子 → 推送成功且钩子未执行
 *     （并用「把 hooksPath 改回去」的差分证明这个钩子确实会写文件）；
 *   - 反例 4：`paths` 里有 `../escape`、或工作树里出现指向仓库外的 symlink → 拒绝；
 *   - 全程断言：push 的 argv 里没有 `--force` / `+refspec`；worktree 真索引没被动过。
 */
import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RepoCache,
  createExecFileRunGit,
  createWritebackCommit,
  gitOutput,
  indexSnapshotsEqual,
  runWriteback,
  snapshotIndex,
  summarizePathSet,
  toWritebackAuditRecord,
} from '../src/git/index.ts';
import type { RunGit } from '../src/git/index.ts';
import { changedFiles, createGitFixture, isGitAvailable, showFile } from './git-fixture.test.ts';
import type { GitFixture } from './git-fixture.test.ts';

const gitAvailable = await isGitAvailable();

describe.skipIf(!gitAvailable)('git/writeback（真 git · 写回闸门）', { timeout: 180_000 }, () => {
  let fixture: GitFixture;
  let cache: RepoCache;

  beforeAll(async () => {
    fixture = await createGitFixture();
    cache = new RepoCache({ cacheRoot: fixture.cacheRoot, runGit: fixture.runGit });
  });

  afterAll(async () => {
    if (fixture !== undefined) {
      await fixture.cleanup();
    }
  });

  /** 从缓存开一棵干净工作树（detach 在初始提交上）。 */
  async function newJob(name: string): Promise<string> {
    const jobDir = path.join(fixture.jobRoot, name);
    await cache.ensureWorktree({
      repo: fixture.repo,
      remoteUrl: fixture.remoteUrl,
      taskId: name,
      jobDir,
      headSha: fixture.initialSha,
    });
    return jobDir;
  }

  async function bareBranches(): Promise<string[]> {
    const result = await fixture.runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: fixture.bareDir,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** push 的 argv 里不许出现 force 语义（worktree remove 的 --force 不在其列）。 */
  function expectNoForcePush(): void {
    const pushes = fixture.calls.filter((args) => args.includes('push'));
    expect(pushes.length).toBeGreaterThan(0);
    for (const args of pushes) {
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--force-with-lease');
      expect(args).not.toContain('--mirror');
      // refspec 里开头的 `+` 是另一种强推写法。
      expect(args.some((item) => item.startsWith('+'))).toBe(false);
    }
  }

  it('正例：声明 src/a.ts 且只改它 → 推上去的只有它一个文件', async () => {
    const jobDir = await newJob('t1');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 42;\n', 'utf8');

    const result = await runWriteback({
      jobDir,
      taskId: 't1',
      branch: 'bot/t1-fix-a',
      declared: ['src/a.ts'],
      runGit: fixture.runGit,
    });

    expect(result.status).toBe('pushed');
    if (result.status !== 'pushed') {
      return;
    }
    expect(result.intersect).toEqual(['src/a.ts']);
    expect(result.dropped).toEqual([]);

    // bare 仓库里：bot 分支指向这个 commit，且只改了 src/a.ts。
    const bareSha = gitOutput(
      await fixture.runGit(['rev-parse', 'refs/heads/bot/t1-fix-a'], { cwd: fixture.bareDir }),
    );
    expect(bareSha).toBe(result.commit);
    expect(await changedFiles(fixture.runGit, fixture.bareDir, result.commit)).toEqual(['src/a.ts']);
    expect(await showFile({ runGit: fixture.runGit, cwd: fixture.bareDir, rev: result.commit, file: 'src/a.ts' })).toContain('42');
    expect(await showFile({ runGit: fixture.runGit, cwd: fixture.bareDir, rev: result.commit, file: 'README.md' })).toBe('# demo\n');
    // main 没被动过：写回只到 bot/* 分支。
    expect(gitOutput(await fixture.runGit(['rev-parse', 'refs/heads/main'], { cwd: fixture.bareDir }))).toBe(fixture.initialSha);

    // 审计摘要四个集合都在，且推送集与 dropped 对得上。
    expect(result.audit.intersect.sha256).toBe(summarizePathSet(['src/a.ts']).sha256);
    expect(result.audit.declared.count).toBe(1);
    expect(result.audit.dropped.count).toBe(0);
    const auditRecord = toWritebackAuditRecord(result);
    expect(auditRecord['status']).toBe('pushed');
    expect(auditRecord['commit']).toBe(result.commit);

    // 临时索引用完即弃；worktree 的真索引一个字节都没动。
    expect((await stat(path.join(jobDir, '.pi-bot', 'writeback.index'))).isFile()).toBe(true);
    const statusAfter = await fixture.runGit(['status', '--porcelain', '-z'], { cwd: jobDir });
    const staged = statusAfter.stdout
      .split('\0')
      .filter((entry) => entry.length > 0 && entry.slice(0, 1) !== ' ' && entry.slice(0, 2) !== '??');
    expect(staged).toEqual([]);

    expectNoForcePush();
  });

  it('反例 1（模拟 postinstall）：未声明的 README.md 与新增文件不流入，且进 dropped', async () => {
    const jobDir = await newJob('t2');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 7;\n', 'utf8');
    // 这两处就是「容器侧顺手干的事」：改一个文件、扔一个新文件。
    await writeFile(path.join(jobDir, 'README.md'), '# pwned by postinstall\n', 'utf8');
    await mkdir(path.join(jobDir, 'extra'), { recursive: true });
    await writeFile(path.join(jobDir, 'extra', 'injected.txt'), 'payload\n', 'utf8');

    const result = await runWriteback({
      jobDir,
      taskId: 't2',
      branch: 'bot/t2-fix-a',
      declared: ['src/a.ts'],
      runGit: fixture.runGit,
    });

    expect(result.status).toBe('pushed');
    if (result.status !== 'pushed') {
      return;
    }
    expect(result.intersect).toEqual(['src/a.ts']);
    expect(result.dropped).toEqual(['README.md', 'extra/injected.txt']);
    expect(result.audit.dropped.count).toBe(2);

    // 关键断言：bare 里的这个 commit 完全不含未声明变更。
    expect(await changedFiles(fixture.runGit, fixture.bareDir, result.commit)).toEqual(['src/a.ts']);
    expect(await showFile({ runGit: fixture.runGit, cwd: fixture.bareDir, rev: result.commit, file: 'README.md' })).toBe('# demo\n');
    const injected = await fixture.runGit(['cat-file', '-e', `${result.commit}:extra/injected.txt`], {
      cwd: fixture.bareDir,
      allowFailure: true,
    });
    expect(injected.code).not.toBe(0);

    expectNoForcePush();
  });

  it('反例 2：改了 .github/workflows/ci.yml → 整次写回失败，bare 无新提交', async () => {
    const jobDir = await newJob('t3');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 8;\n', 'utf8');
    await writeFile(path.join(jobDir, '.github', 'workflows', 'ci.yml'), 'name: pwned\non: push\n', 'utf8');

    const before = gitOutput(await fixture.runGit(['rev-list', '--all', '--count'], { cwd: fixture.bareDir }));
    const branchesBefore = await bareBranches();

    const result = await runWriteback({
      jobDir,
      taskId: 't3',
      branch: 'bot/t3-ci',
      declared: ['src/a.ts'],
      runGit: fixture.runGit,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      return;
    }
    expect(result.code).toBe('WRITEBACK_REJECTED');
    expect(result.reason).toBe('actual-protected');
    expect(result.paths).toEqual(['.github/workflows/ci.yml']);
    expect(result.audit.intersect.count).toBe(0);
    // 提示：这是「信号」，审计里必须留下实际变更集合。
    expect(result.audit.actual.paths).toContain('.github/workflows/ci.yml');

    // bare 一点没变：提交数、分支列表都没动。
    expect(gitOutput(await fixture.runGit(['rev-list', '--all', '--count'], { cwd: fixture.bareDir }))).toBe(before);
    expect(await bareBranches()).toEqual(branchesBefore);
    expect(await bareBranches()).not.toContain('bot/t3-ci');

    // 失败路径也不该凭空造出提交对象对应的分支。
    expect(towritebackAuditStatus(result)).toBe('writeback_rejected');
  });

  it('反例 3：钩子会写文件，但写回过程中从不执行（core.hooksPath=/dev/null）', async () => {
    const jobDir = await newJob('t4');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 9;\n', 'utf8');

    // 钩子放在缓存仓库的共同 git 目录里（linked worktree 共用这一份 hooks）。
    const commonDirRaw = gitOutput(await fixture.runGit(['rev-parse', '--git-common-dir'], { cwd: jobDir }));
    const commonDir = path.resolve(jobDir, commonDirRaw);
    const hooksDir = path.join(commonDir, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const sentinel = path.join(fixture.root, 'HOOK_RAN.txt');
    const hookBody = `#!/bin/sh\ntouch "${sentinel.replace(/\\/g, '/')}"\n`;
    for (const name of ['pre-commit', 'pre-push']) {
      const file = path.join(hooksDir, name);
      await writeFile(file, hookBody, 'utf8');
      await chmod(file, 0o755);
    }

    // 差分证明（先做）：基座参数清空 = 回到 git 默认钩子路径，同一份钩子**确实会**执行。
    // 这也说明「下面那次没执行」只能归因于 core.hooksPath=/dev/null 与 --no-verify。
    const probeDir = await newJob('t4-probe');
    const hookEnabled = createExecFileRunGit({ baseArgs: [] });
    await hookEnabled(['commit', '--allow-empty', '-m', 'hook probe'], { cwd: probeDir });
    expect((await stat(sentinel)).isFile()).toBe(true);
    await rm(sentinel, { force: true });
    await expect(stat(sentinel)).rejects.toThrow();

    // 基座参数确实带上了 core.hooksPath=/dev/null。
    const hooksPath = gitOutput(await fixture.runGit(['config', '--get', 'core.hooksPath'], { cwd: jobDir }));
    expect(hooksPath).toBe('/dev/null');

    const result = await runWriteback({
      jobDir,
      taskId: 't4',
      branch: 'bot/t4-hooks',
      declared: ['src/a.ts'],
      runGit: fixture.runGit,
    });
    expect(result.status).toBe('pushed');
    // 推送成功，而钩子一个都没跑（pre-commit 与 pre-push 都会 touch 同一个文件）。
    await expect(stat(sentinel)).rejects.toThrow();
    if (result.status === 'pushed') {
      expect(result.pushArgv).toContain('--no-verify');
    }

    expectNoForcePush();
  });

  it('反例 4a：声明里出现 ../escape → 拒绝，且不产生任何推送', async () => {
    const jobDir = await newJob('t5');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 10;\n', 'utf8');
    const before = await bareBranches();

    const result = await runWriteback({
      jobDir,
      taskId: 't5',
      branch: 'bot/t5-escape',
      declared: ['src/a.ts', '../escape'],
      runGit: fixture.runGit,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      return;
    }
    expect(result.reason).toBe('declared-invalid');
    expect(result.paths).toContain('../escape');
    expect(await bareBranches()).toEqual(before);
  });

  it('反例 4b：工作树里有指向仓库外的 symlink → 拒绝（即使没声明它）', async (ctx) => {
    const jobDir = await newJob('t6');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 11;\n', 'utf8');
    const outside = path.join(fixture.root, 'outside-secret.txt');
    await writeFile(outside, 'secret\n', 'utf8');
    const linkPath = path.join(jobDir, 'escape.link');
    try {
      await symlink(outside, linkPath, 'file');
    } catch (_error) {
      // 没有创建 symlink 的权限（Windows 需要开发者模式/管理员）时，如实跳过这一条。
      ctx.skip();
      return;
    }

    const before = await bareBranches();
    const result = await runWriteback({
      jobDir,
      taskId: 't6',
      branch: 'bot/t6-symlink',
      declared: ['src/a.ts'],
      runGit: fixture.runGit,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      return;
    }
    expect(result.reason).toBe('symlink-escape');
    expect(result.paths).toEqual(['escape.link']);
    expect(await bareBranches()).toEqual(before);
  });

  it('令牌：走 askpass 脚本且推送后立即删除，令牌不进 argv', async () => {
    const jobDir = await newJob('t7');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 12;\n', 'utf8');
    const token = 'ghs_test_token_do_not_leak';
    let askpassSeenDuringPush = false;

    const observingRunGit: RunGit = async (args, options) => {
      if (args.includes('push')) {
        const entries = await readdir(path.join(jobDir, '.pi-bot')).catch(() => [] as string[]);
        askpassSeenDuringPush = entries.some((name) => name.startsWith('askpass-'));
      }
      return fixture.runGit(args, options);
    };

    const result = await runWriteback({
      jobDir,
      taskId: 't7',
      branch: 'bot/t7-token',
      declared: ['src/a.ts'],
      runGit: observingRunGit,
      token,
    });

    expect(result.status).toBe('pushed');
    expect(askpassSeenDuringPush).toBe(true);

    // 推送结束：脚本立即删除，令牌没有出现在任何 argv / stdout 里。
    const leftovers = (await readdir(path.join(jobDir, '.pi-bot'))).filter((name) => name.startsWith('askpass-'));
    expect(leftovers).toEqual([]);
    expect(fixture.calls.flat().join(' ')).not.toContain(token);
    if (result.status === 'pushed') {
      expect(result.pushArgv.join(' ')).not.toContain(token);
      // 脚本内容只回显环境变量，不含令牌本身。
      expect(result.pushArgv.join(' ')).not.toContain('PI_BOT_GIT_TOKEN');
    }
  });

  it('索引不变式：createWritebackCommit 不动 worktree 的真索引，runWriteback 会强制校验它', async () => {
    const jobDir = await newJob('t8');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 13;\n', 'utf8');

    const before = await snapshotIndex(jobDir, fixture.runGit);
    const commit = await createWritebackCommit({
      jobDir,
      paths: ['src/a.ts'],
      message: 'bot: push_branch / t8',
      runGit: fixture.runGit,
    });
    const after = await snapshotIndex(jobDir, fixture.runGit);

    expect(before.exists).toBe(true);
    expect(indexSnapshotsEqual(before, after)).toBe(true);
    expect(before.sha256).toBe(after.sha256);
    expect(commit.tree).not.toBe('');
    expect(commit.parent).toBe(fixture.initialSha);
    expect(commit.stagedPaths).toEqual(['src/a.ts']);

    // 临时索引里确实只有交集路径（`ls-files --stage` 用它自己的索引）。
    const staged = await fixture.runGit(['ls-files', '--stage', '--', 'src/a.ts'], {
      cwd: jobDir,
      env: { GIT_INDEX_FILE: commit.indexFile },
    });
    expect(staged.stdout.trim().length).toBeGreaterThan(0);
    const readme = await fixture.runGit(['ls-files', '--stage', '--', 'README.md'], {
      cwd: jobDir,
      env: { GIT_INDEX_FILE: commit.indexFile },
    });
    // README 没被写回，但它在 read-tree 里是存在的（与父提交一致），所以这里应当**有**它。
    expect(readme.stdout.trim().length).toBeGreaterThan(0);

    // 空交集必须被拒绝（否则会造出「什么都没改」的提交）。
    await expect(
      createWritebackCommit({ jobDir, paths: [], message: 'x', runGit: fixture.runGit }),
    ).rejects.toThrow();
  });

  it('真索引的条目在写回后完全不变（树的指纹相同、staged 为空）', async () => {
    const jobDir = await newJob('t9');
    await writeFile(path.join(jobDir, 'src', 'a.ts'), 'export const a = 14;\n', 'utf8');
    const gitDir = gitOutput(await fixture.runGit(['rev-parse', '--git-dir'], { cwd: jobDir }));
    const indexPath = path.join(path.resolve(jobDir, gitDir), 'index');
    const entriesBefore = (await fixture.runGit(['ls-files', '--stage'], { cwd: jobDir })).stdout;
    const treeBefore = gitOutput(await fixture.runGit(['write-tree'], { cwd: jobDir }));

    const result = await runWriteback({
      jobDir,
      taskId: 't9',
      branch: 'bot/t9-index',
      declared: ['src/a.ts'],
      runGit: fixture.runGit,
    });
    expect(result.status).toBe('pushed');

    const entriesAfter = (await fixture.runGit(['ls-files', '--stage'], { cwd: jobDir })).stdout;
    const treeAfter = gitOutput(await fixture.runGit(['write-tree'], { cwd: jobDir }));
    expect(entriesAfter).toBe(entriesBefore);
    expect(treeAfter).toBe(treeBefore);
    expect((await stat(indexPath)).isFile()).toBe(true);

    // 关键：真索引里没有被 stage 任何东西（字节可能被 git 自己的 stat 刷新重写）。
    const staged = (await fixture.runGit(['status', '--porcelain', '-z'], { cwd: jobDir })).stdout
      .split('\0')
      .filter((entry) => entry.length > 0 && entry.slice(0, 1) !== ' ' && entry.slice(0, 2) !== '??');
    expect(staged).toEqual([]);
  });

  it('空交集：声明与实际没有重合时不推送（也不报错）', async () => {
    const jobDir = await newJob('t10');
    await writeFile(path.join(jobDir, 'README.md'), '# only readme\n', 'utf8');
    const before = await bareBranches();

    const result = await runWriteback({
      jobDir,
      taskId: 't10',
      branch: 'bot/t10-empty',
      declared: ['src/a.ts'],
      runGit: fixture.runGit,
    });

    expect(result.status).toBe('empty');
    expect(result.audit.dropped.paths).toEqual(['README.md']);
    expect(await bareBranches()).toEqual(before);
  });
});

/** 把写回结果压成审计行时的 `status`（拒绝路径要能被面板检索到）。 */
function towritebackAuditStatus(result: Parameters<typeof toWritebackAuditRecord>[0]): unknown {
  return toWritebackAuditRecord(result)['status'];
}
