import { describe, expect, it, beforeEach } from 'vitest';
import {
  LAST_REPO_STORAGE_KEY,
  decodeRepo,
  encodeRepo,
  forgetLastRepo,
  readLastRepo,
  rememberLastRepo,
  repoGitHubUrl,
  repoIssuePath,
  repoIssuesPath,
  repoRunPath,
  repoRunsPath,
  repoSettingsPath,
  repoWorkspacePath,
} from './repo-route.ts';

/**
 * `:repo` 单段编码的**唯一契约**（`docs/plan-multi-repo.md` §9）。
 *
 * 这组用例的价值在边界：仓库名里允许下划线，所以分隔符必须从**第一个** `__` 处切分，
 * 否则 `acme/foo__bar` 会被解成 `acme/foo` + 多出来的 `bar`。
 */
describe('encodeRepo / decodeRepo', () => {
  it('`owner/name` ↔ `owner__name` 往返无损', () => {
    expect(encodeRepo('acme/widgets')).toBe('acme__widgets');
    expect(decodeRepo('acme__widgets')).toBe('acme/widgets');
  });

  it('仓库名自带下划线时，按第一个分隔符切分（往返仍然无损）', () => {
    expect(encodeRepo('acme/foo__bar')).toBe('acme__foo__bar');
    expect(decodeRepo('acme__foo__bar')).toBe('acme/foo__bar');
    expect(decodeRepo(encodeRepo('Tioit-Wang/pi-issue-bot'))).toBe('Tioit-Wang/pi-issue-bot');
  });

  it('非法输入：编码原样返回，解码给 null（页面据此 404）', () => {
    expect(encodeRepo('no-slash')).toBe('no-slash');
    expect(encodeRepo('/leading')).toBe('/leading');
    expect(encodeRepo('trailing/')).toBe('trailing/');

    expect(decodeRepo('')).toBeNull();
    expect(decodeRepo('acme')).toBeNull();
    expect(decodeRepo('__widgets')).toBeNull();
    expect(decodeRepo('acme__')).toBeNull();
    // 两段式（旧的 `/issues/:owner/:name/...` 写法）不能当单段编码
    expect(decodeRepo('acme/widgets')).toBeNull();
    // 非法字符（空格 / 中文 / 冒号）不放行
    expect(decodeRepo('ac me__widgets')).toBeNull();
    expect(decodeRepo('acme__wid gets')).toBeNull();
  });
});

describe('路径构造', () => {
  it('工作台 / Issue / 运行 / 设置都挂在 `/repos/:repo` 下', () => {
    expect(repoWorkspacePath('acme/widgets')).toBe('/repos/acme__widgets');
    expect(repoIssuesPath('acme/widgets')).toBe('/repos/acme__widgets/issues');
    expect(repoIssuePath('acme/widgets', 'issue', 17)).toBe('/repos/acme__widgets/issues/issue/17');
    expect(repoIssuePath('acme/widgets', 'pr', '42')).toBe('/repos/acme__widgets/issues/pr/42');
    expect(repoRunsPath('acme/widgets')).toBe('/repos/acme__widgets/runs');
    expect(repoRunPath('acme/widgets', 't-mock-1')).toBe('/repos/acme__widgets/runs/t-mock-1');
    expect(repoSettingsPath('acme/widgets')).toBe('/repos/acme__widgets/settings');
    expect(repoSettingsPath('acme/widgets', 'triggers')).toBe('/repos/acme__widgets/settings/triggers');
  });

  it('id 里带 `/` 之类的字符会被转义（不会把路径切坏）', () => {
    expect(repoRunPath('acme/widgets', 'a/b')).toBe('/repos/acme__widgets/runs/a%2Fb');
  });

  it('GitHub 地址只对合法 `owner/name` 生成', () => {
    expect(repoGitHubUrl('acme/widgets')).toBe('https://github.com/acme/widgets');
    expect(repoGitHubUrl('acme')).toBeNull();
    expect(repoGitHubUrl('acme/')).toBeNull();
  });
});

describe('「上次打开的仓库」（旧链接重定向用）', () => {
  beforeEach(() => {
    forgetLastRepo();
  });

  it('写进去的是编码后的单段，读出来是 `owner/name`', () => {
    rememberLastRepo('acme/widgets');
    expect(globalThis.localStorage.getItem(LAST_REPO_STORAGE_KEY)).toBe('acme__widgets');
    expect(readLastRepo()).toBe('acme/widgets');
  });

  it('没存过 → null；存了非法值 → 也当 null（不要拿坏值拼 URL）', () => {
    expect(readLastRepo()).toBeNull();
    globalThis.localStorage.setItem(LAST_REPO_STORAGE_KEY, 'garbage');
    expect(readLastRepo()).toBeNull();
  });

  it('forgetLastRepo 之后回到 null', () => {
    rememberLastRepo('other/lib');
    expect(readLastRepo()).toBe('other/lib');
    forgetLastRepo();
    expect(readLastRepo()).toBeNull();
  });
});
