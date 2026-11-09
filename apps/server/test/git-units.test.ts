/**
 * 写回闸门与推送规则的**纯函数**测试（不需要真 git）。
 *
 * 这里覆盖的是「不跑 git 也能证明」的那部分：
 *   - porcelain `-z` 的解析（含重命名两条项、含空格/中文路径）；
 *   - declared glob 的展开语义（`*` 不跨目录、`**` 跨目录、目录写法补 `**`）；
 *   - 声明校验与拒收清单（绝对路径 / `..` / `.github/workflows/**` / `.git/**` / `.pi-bot/**`）；
 *   - 审计摘要的排序、sha256 与 200 条截断；
 *   - 强推令牌拦截、`bot/*` 分支白名单；
 *   - askpass 脚本「只回显环境变量、内容里没有令牌、0600、删除」。
 *
 * 真 git 的部分在 `git-repo-cache.test.ts` / `git-writeback.test.ts` / `git-branch-cleanup.test.ts`。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  AppError,
  MAX_AUDIT_PATHS,
  assertBotBranch,
  assertNoForceArgs,
  createAskpassScript,
  evaluateWriteback,
  globToRegExp,
  isBotBranch,
  isWritebackProtectedPath,
  matchesDeclared,
  parseLsRemote,
  parseStatusPorcelainZ,
  summarizePathSet,
  validateDeclaredPaths,
} from '../src/git/index.ts';
import type { RunGit } from '../src/git/run-git.ts';
import type { PathProbe } from '../src/git/writeback-gate.ts';

const JOB_DIR = path.resolve('/tmp/pi-git-units/job');

/** 造一个只回放固定 stdout 的 runGit（gate 只用到 `status`）。 */
function fakeRunGit(stdout: string): RunGit {
  return async () => ({ argv: ['status'], code: 0, stdout, stderr: '' });
}

/** 造一个探针：只有 `escape.link` 是 symlink，且指向仓库外。 */
function fakeProbe(): PathProbe {
  const escapePath = path.resolve(JOB_DIR, 'escape.link');
  const outside = path.resolve('/outside/secret');
  return {
    lstat: async (target) => ({ isSymbolicLink: () => target === escapePath }),
    realpath: async (target) => (target === escapePath ? outside : path.resolve(target)),
  };
}

/** 把 porcelain `-z` 的记录拼起来（一条记录一个 NUL，便于读）。 */
function porcelain(entries: readonly string[]): string {
  return `${entries.join('\0')}\0`;
}

describe('parseStatusPorcelainZ', () => {
  it('解析修改与未跟踪的记录', () => {
    const parsed = parseStatusPorcelainZ(porcelain(['M  src/a.ts', '?? new file.txt', ' D src/b.ts']));
    expect(parsed).toEqual([
      { path: 'src/a.ts', status: 'M ' },
      { path: 'new file.txt', status: '??' },
      { path: 'src/b.ts', status: ' D' },
    ]);
  });

  it('解析重命名：新路径在前，旧路径是紧随其后的第二条项', () => {
    const parsed = parseStatusPorcelainZ(porcelain(['R  src/new.ts', 'src/old.ts', 'M  other.ts']));
    expect(parsed).toEqual([
      { path: 'src/new.ts', status: 'R ', origPath: 'src/old.ts' },
      { path: 'other.ts', status: 'M ' },
    ]);
  });

  it('含中文与空格的路径不被转义（-z 的意义）', () => {
    const parsed = parseStatusPorcelainZ(porcelain(['?? 文档/说明 文档.md']));
    expect(parsed).toEqual([{ path: '文档/说明 文档.md', status: '??' }]);
  });
});

describe('declared glob 展开', () => {
  it('字面量精确匹配', () => {
    expect(matchesDeclared('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchesDeclared('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('`*` 不跨目录，`**` 跨目录，`**/` 能匹配零层', () => {
    expect(matchesDeclared('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesDeclared('src/deep/a.ts', 'src/*.ts')).toBe(false);
    expect(matchesDeclared('src/deep/a.ts', 'src/**.ts')).toBe(true);
    expect(matchesDeclared('src/deep/a.ts', 'src/**/a.ts')).toBe(true);
    expect(matchesDeclared('src/a.ts', 'src/**/a.ts')).toBe(true);
  });

  it('目录写法等价于 `dir/**`，反斜杠被归一化', () => {
    expect(matchesDeclared('src/a.ts', 'src/')).toBe(true);
    expect(matchesDeclared('src\\a.ts', 'src/a.ts')).toBe(true);
    expect(matchesDeclared('./src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('globToRegExp 对正则元字符做转义（`a+b.ts` 不是量词）', () => {
    expect(globToRegExp('src/a+b.ts').test('src/a+b.ts')).toBe(true);
    expect(globToRegExp('src/a+b.ts').test('src/aaab.ts')).toBe(false);
  });
});

describe('声明校验与拒收清单', () => {
  it('空声明判 declared-empty', () => {
    expect(validateDeclaredPaths([])[0]?.reason).toBe('declared-empty');
  });

  it('绝对路径与 `..` 出仓判 declared-invalid', () => {
    const issues = validateDeclaredPaths(['/etc/passwd', '../escape', 'C:\\Windows\\x.txt', 'a/../b']);
    expect(issues).toHaveLength(4);
    expect(issues.every((issue) => issue.reason === 'declared-invalid')).toBe(true);
  });

  it('命中拒收清单判 declared-protected', () => {
    const paths = ['.git/config', '.git/hooks/pre-commit', '.github/workflows/ci.yml', 'sub/.gitmodules', '.pi-bot/writeback.index'];
    const issues = validateDeclaredPaths(paths);
    expect(issues.map((issue) => issue.reason)).toEqual(paths.map(() => 'declared-protected'));
  });

  it('拒收清单是「只能收紧」：`envelope` 的项与写回侧独有的 `.pi-bot/` 都在', () => {
    expect(isWritebackProtectedPath('.github/workflows/ci.yml')).toBe(true);
    expect(isWritebackProtectedPath('.pi-bot/askpass-1.cmd')).toBe(true);
    expect(isWritebackProtectedPath('src/a.ts')).toBe(false);
  });
});

describe('审计摘要', () => {
  it('排序去重后取 sha256，与输入顺序无关', () => {
    const first = summarizePathSet(['b.ts', 'a.ts']);
    const second = summarizePathSet(['a.ts', 'b.ts', 'a.ts']);
    expect(first.sha256).toBe(second.sha256);
    expect(first.count).toBe(2);
    expect(first.paths).toEqual(['a.ts', 'b.ts']);
  });

  it(`超过 ${MAX_AUDIT_PATHS} 条时只列前 200 条，count 不截断`, () => {
    const many = Array.from({ length: MAX_AUDIT_PATHS + 5 }, (_, index) => `f${String(index).padStart(3, '0')}.ts`);
    const summary = summarizePathSet(many);
    expect(summary.count).toBe(MAX_AUDIT_PATHS + 5);
    expect(summary.paths).toHaveLength(MAX_AUDIT_PATHS);
    expect(summary.truncated).toBe(true);
  });
});

describe('强推与分支白名单', () => {
  it('拒绝 --force / -f / --force-with-lease / --mirror', () => {
    for (const flag of ['--force', '-f', '--force-with-lease', '--mirror']) {
      expect(() => assertNoForceArgs(['push', flag, 'origin'])).toThrow(AppError);
    }
    expect(() => assertNoForceArgs(['push', '--porcelain', 'origin', 'abc:refs/heads/bot/x'])).not.toThrow();
  });

  it('只接受 bot/* 分支名', () => {
    expect(isBotBranch('bot/task-1-fix')).toBe(true);
    expect(() => assertBotBranch('bot/t1')).not.toThrow();
    for (const bad of ['main', 'bot/', 'bot/x y', 'bot/x:y', 'refs/heads/bot/x', 'bot/x..y', 'feature/bot']) {
      expect(isBotBranch(bad), bad).toBe(false);
      expect(() => assertBotBranch(bad), bad).toThrow(AppError);
    }
  });
});

describe('askpass 脚本', () => {
  let root = '';
  afterAll(async () => {
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('只回显环境变量：脚本内容里没有令牌，权限 0600，删除后不复存在', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pi-askpass-'));
    const token = 'ghs_super_secret_token_value';
    const script = await createAskpassScript({ dir: path.join(root, '.pi-bot') });
    const content = await readFile(script.path, 'utf8');
    expect(content).toContain(script.tokenEnvKey);
    expect(content).not.toContain(token);

    if (process.platform !== 'win32') {
      const mode = (await stat(script.path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    await script.remove();
    await expect(stat(script.path)).rejects.toThrow();
    // 第二次删是幂等的（finally 里可能被调用两次）。
    await expect(script.remove()).resolves.toBeUndefined();
  });
});

describe('ls-remote 解析', () => {
  it('只认同 refs/heads/ 前缀', () => {
    const parsed = parseLsRemote(
      ['abc\trefs/heads/bot/t1-a', 'def\trefs/heads/main', 'ghi\trefs/tags/v1', ''].join('\n'),
    );
    expect(parsed).toEqual([
      { sha: 'abc', branch: 'bot/t1-a' },
      { sha: 'def', branch: 'main' },
    ]);
  });
});

describe('evaluateWriteback（假 git：只验闸门逻辑）', () => {
  const base = { jobDir: JOB_DIR, runGit: fakeRunGit(''), probe: fakeProbe() };

  it('推送集是 declared ∩ actual，其余进 dropped', async () => {
    const result = await evaluateWriteback({
      ...base,
      declared: ['src/a.ts'],
      runGit: fakeRunGit(porcelain(['M  src/a.ts', 'M  README.md'])),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.intersect).toEqual(['src/a.ts']);
    expect(result.dropped).toEqual(['README.md']);
    expect(result.audit.actual.count).toBe(2);
    expect(result.audit.intersect.count).toBe(1);
    expect(result.audit.dropped.paths).toEqual(['README.md']);
  });

  it('实际变更命中拒收清单 → 整次失败（不是跳过）', async () => {
    const result = await evaluateWriteback({
      ...base,
      declared: ['src/a.ts'],
      runGit: fakeRunGit(porcelain(['M  src/a.ts', 'M  .github/workflows/ci.yml'])),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('WRITEBACK_REJECTED');
    expect(result.reason).toBe('actual-protected');
    expect(result.paths).toEqual(['.github/workflows/ci.yml']);
  });

  it('指向仓库外的 symlink → 整次失败', async () => {
    const result = await evaluateWriteback({
      ...base,
      declared: ['escape.link'],
      runGit: fakeRunGit(porcelain(['?? escape.link'])),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('symlink-escape');
    expect(result.paths).toEqual(['escape.link']);
  });

  it('声明集合里出现 `../escape` → 整次失败', async () => {
    const result = await evaluateWriteback({
      ...base,
      declared: ['../escape'],
      runGit: fakeRunGit(porcelain(['M  README.md'])),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('declared-invalid');
    expect(result.audit.declared.paths).toEqual(['../escape']);
  });

  it('glob 声明展开到实际变更集内（含多层目录）', async () => {
    const result = await evaluateWriteback({
      ...base,
      declared: ['src/**'],
      runGit: fakeRunGit(porcelain(['M  src/a.ts', 'M  src/deep/c.ts', 'M  README.md'])),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.intersect).toEqual(['src/a.ts', 'src/deep/c.ts']);
    expect(result.dropped).toEqual(['README.md']);
  });

  it('重命名：新路径被声明覆盖时，旧路径的删除也进推送集', async () => {
    const result = await evaluateWriteback({
      ...base,
      declared: ['src/new.ts'],
      runGit: fakeRunGit(porcelain(['R  src/new.ts', 'src/old.ts'])),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.intersect).toEqual(['src/new.ts', 'src/old.ts']);
    expect(result.dropped).toEqual([]);
  });
});
