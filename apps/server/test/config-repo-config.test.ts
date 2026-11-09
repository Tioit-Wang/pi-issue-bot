/**
 * 仓库配置（`config/repo-config.ts`）与受限 YAML 解析（`config/yaml.ts`）的测试。
 *
 * 落库部分用 **真 PostgreSQL**：`config_valid` / `enabled` / `dry_run` / `config_error` 四个列的
 * 最终取值就是 DBA 与面板看到的东西，只有真库能证明「非法配置确实把仓库关掉了」（plan §10）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import {
  REPO_CONFIG_PATH,
  REPO_CONFIG_SQL,
  UNKNOWN_REPO_POLICY,
  YamlSubsetError,
  createGithubRepoConfigFetcher,
  decodeRepoConfig,
  parseYamlSubset,
  readRepoPolicy,
  syncRepoConfig,
} from '../src/config/index.ts';
import type { RepoConfigFetcher, RepoConfigNotifier } from '../src/config/index.ts';
import type { GithubClient } from '../src/github/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';

const VALID_YAML = [
  '# 仓库级配置',
  'version: 1',
  'enabled: true',
  'dry_run: false',
  'labels:',
  '  map:',
  '    bug: bug',
  '    needs-info: needs-info',
  '  allow: [bug, needs-info]',
  'commands:',
  '  allowed:',
  '    - /review-pr',
  '    - /issue-triage',
  '  author_associations: [OWNER, MEMBER]',
  'limits:',
  '  max_comments_per_hour: 5',
].join('\n');

describe('parseYamlSubset（受限 YAML 子集）', () => {
  it('嵌套映射 + 序列 + 行内数组 + 标量类型', () => {
    expect(parseYamlSubset(VALID_YAML)).toEqual({
      version: 1,
      enabled: true,
      dry_run: false,
      labels: {
        map: { bug: 'bug', 'needs-info': 'needs-info' },
        allow: ['bug', 'needs-info'],
      },
      commands: {
        allowed: ['/review-pr', '/issue-triage'],
        author_associations: ['OWNER', 'MEMBER'],
      },
      limits: { max_comments_per_hour: 5 },
    });
  });

  it('注释与引号：行尾注释被剥掉，引号内的 # 与 : 保留', () => {
    const yaml = ['a: 1  # 行尾注释', 'b: "x: y # not comment"', "c: 'it''s'"].join('\n');
    expect(parseYamlSubset(yaml)).toEqual({ a: 1, b: 'x: y # not comment', c: "it's" });
  });

  it('空文档 → {}（缺字段由 zod 默认值兜底），空映射与空值', () => {
    expect(parseYamlSubset('')).toEqual({});
    expect(parseYamlSubset('a: {}\nb:')).toEqual({ a: {}, b: null });
  });

  it('序列项是映射（`- key: value`）', () => {
    const yaml = ['rules:', '  - id: steps', '    required: true', '  - id: version'].join('\n');
    expect(parseYamlSubset(yaml)).toEqual({
      rules: [{ id: 'steps', required: true }, { id: 'version' }],
    });
  });

  it('不支持的写法明确报错并带行号（制表符 / 重复键 / 块标量 / 行内映射）', () => {
    expect(() => parseYamlSubset('a:\n\tb: 1')).toThrow(YamlSubsetError);
    expect(() => parseYamlSubset('a: 1\na: 2')).toThrow(/重复的键/);
    expect(() => parseYamlSubset('a: |\n  x')).toThrow(/块标量/);
    expect(() => parseYamlSubset('a: {b: 1}')).toThrow(/行内映射/);
    expect(() => parseYamlSubset('a: 1\n  b: 2')).toThrow(/更深缩进/);
  });
});

describe('decodeRepoConfig（YAML → 契约 schema）', () => {
  it('合法配置：解析后带出 schema 默认值（dry_run 缺省 true）', () => {
    const result = decodeRepoConfig('version: 1\n');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.dry_run).toBe(true);
    expect(result.config.enabled).toBe(true);
    expect(result.config.commands.allowed).toContain('/review-pr');
    expect(result.config.limits.max_task_minutes).toBe(20);
  });

  it('未知键 → 不合法（`.strict()` 不接受拼错的键）', () => {
    const result = decodeRepoConfig('version: 1\nbogus_key: 1\n');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('配置不符合 schema');
    expect(result.issues.join(' ')).toContain('bogus_key');
  });

  it('YAML 语法错 → 不合法，错误消息带行号', () => {
    const result = decodeRepoConfig('version: 1\n   broken: 2\n');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('YAML 解析失败');
    expect(result.error).toContain('第 2 行');
  });
});

describe('拉取：createGithubRepoConfigFetcher', () => {
  function clientWith(
    responder: (route: string, params: Record<string, unknown> | undefined) => unknown,
  ): GithubClient {
    const request = async <T>(route: string, params?: Record<string, unknown>): Promise<unknown> => {
      return responder(route, params) as T;
    };
    return {
      request: request as GithubClient['request'],
      getMetrics: () => ({ getCalls: 1, nonGetCalls: 0 }),
      resetMetrics: () => undefined,
    };
  }

  it('contents API 的 base64 内容被解开', async () => {
    const yaml = 'version: 1\n';
    const client = clientWith(() => ({
      status: 200,
      headers: {},
      data: { content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64', sha: 'abc123' },
    }));
    const fetcher = createGithubRepoConfigFetcher(client);
    const result = await fetcher({ repo: REPO, path: REPO_CONFIG_PATH });
    expect(result).toEqual({ found: true, yaml, sha: 'abc123' });
  });

  it('404 → found=false（没写配置不是错误）', async () => {
    const client = clientWith(() => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const fetcher = createGithubRepoConfigFetcher(client);
    expect(await fetcher({ repo: REPO, path: REPO_CONFIG_PATH })).toEqual({
      found: false,
      yaml: null,
      sha: null,
    });
  });

  it('其它错误照常抛出（一次网络抖动不该被当成「没有配置文件」）', async () => {
    const client = clientWith(() => {
      throw Object.assign(new Error('Bad Gateway'), { status: 502 });
    });
    const fetcher = createGithubRepoConfigFetcher(client);
    await expect(fetcher({ repo: REPO, path: REPO_CONFIG_PATH })).rejects.toThrow('Bad Gateway');
  });
});

describe('落库：syncRepoConfig / readRepoPolicy（真 PG）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await openTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  // 只清 `repos`（本文件的落库断言只关心这一张表；见 http-webhook.test.ts 里的同类说明）
  beforeEach(async () => {
    await db.pool.query('truncate table repos cascade');
  });

  function fetcherOf(result: { found: boolean; yaml: string | null; sha: string | null }): RepoConfigFetcher {
    return async () => result;
  }

  it('合法配置：enabled / dry_run 取自文件，config_valid=true', async () => {
    const result = await syncRepoConfig(
      { fetch: fetcherOf({ found: true, yaml: VALID_YAML, sha: 'sha-1' }), db: db.pool },
      REPO,
    );
    expect(result).toMatchObject({ valid: true, enabled: true, dryRun: false, notified: false, sha: 'sha-1' });

    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy).toMatchObject({ known: true, enabled: true, dryRun: false, configValid: true });
    expect(policy.config?.commands.allowed).toEqual(['/review-pr', '/issue-triage']);
  });

  it('非法配置：config_valid=false + 禁用仓库 + 通知 owner（通知失败也不改变禁用）', async () => {
    const notified: Array<{ repo: string; error: string }> = [];
    const notify: RepoConfigNotifier = async (input) => {
      notified.push({ repo: input.repo, error: input.error });
    };

    const result = await syncRepoConfig(
      {
        fetch: fetcherOf({ found: true, yaml: 'version: 1\nbogus_key: 1\n', sha: 'sha-2' }),
        db: db.pool,
        notify,
        logger: createNullLogger(),
      },
      REPO,
    );

    expect(result).toMatchObject({ valid: false, enabled: false, dryRun: true, notified: true });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.repo).toBe(REPO);
    expect(notified[0]?.error).toContain('bogus_key');

    const rows = await db.sql(
      'select enabled, dry_run, config_valid, config_error, config from repos where repo_full_name = $1',
      [REPO],
    );
    expect(rows[0]).toMatchObject({ enabled: false, dry_run: true, config_valid: false, config: null });
    expect(String(rows[0]?.['config_error'])).toContain('bogus_key');
  });

  it('通知抛错：仍然落库为禁用（通知是尽力而为）', async () => {
    const result = await syncRepoConfig(
      {
        fetch: fetcherOf({ found: true, yaml: 'version: 1\nbogus_key: 1\n', sha: null }),
        db: db.pool,
        notify: async () => {
          throw new Error('GitHub 挂了');
        },
        logger: createNullLogger(),
      },
      REPO,
    );
    expect(result).toMatchObject({ valid: false, enabled: false, notified: false });
    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.enabled).toBe(false);
  });

  it('没有配置文件：按默认配置入库（enabled=true / dry_run=true），不通知', async () => {
    const result = await syncRepoConfig(
      { fetch: fetcherOf({ found: false, yaml: null, sha: null }), db: db.pool },
      REPO,
    );
    expect(result).toMatchObject({ found: false, valid: true, enabled: true, dryRun: true, notified: false });
    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy).toMatchObject({ known: true, enabled: true, dryRun: true, configValid: true });
  });

  it('readRepoPolicy：repos 没有这一行 → UNKNOWN_REPO_POLICY（webhook 据此忽略）', async () => {
    expect(await readRepoPolicy(db.pool, 'nobody/nothing')).toEqual(UNKNOWN_REPO_POLICY);
  });

  it('重复同步同一仓库是幂等的（UPSERT，不报唯一键冲突）', async () => {
    const deps = { fetch: fetcherOf({ found: true, yaml: VALID_YAML, sha: 'sha-1' }), db: db.pool };
    await syncRepoConfig(deps, REPO);
    await syncRepoConfig(deps, REPO);
    const rows = await db.sql('select count(*)::int as n from repos');
    expect(rows[0]?.['n']).toBe(1);
  });

  it('SQL 常量与表列名对得上（读一次就能发现列名漂移）', async () => {
    await db.pool.query(REPO_CONFIG_SQL.upsert, [REPO, true, true, null, true, null]);
    const rows = await db.sql(REPO_CONFIG_SQL.readPolicy, [REPO]);
    expect(rows).toHaveLength(1);
  });
});
