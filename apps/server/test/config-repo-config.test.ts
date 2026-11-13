/**
 * `repos` 存储（`config/repo-config.ts`）的测试：默认 seed、合法读写、非法不落库、
 * last-known-good、归档不可用、列表。
 *
 * 落库部分用**真 PostgreSQL**：`settings` / `settings_valid` / `settings_error` / `enabled` /
 * `dry_run` / `archived_at` 的最终取值就是 webhook 与面板看到的东西，只有真库能证明
 * 「非法配置不写库、库里留着最后一次合法值」（`docs/impl-multi-repo.md` §2/§4）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_SETTINGS } from '../../../packages/contract/src/index.ts';
import {
  REPO_SETTINGS_ENV,
  UNKNOWN_REPO_POLICY,
  defaultRepoSettings,
  listRepos,
  loadDefaultRepoSettings,
  readRepoPolicy,
  resetDefaultRepoSettingsCache,
  updateRepoSettings,
  upsertRepo,
  validateRepoSettings,
} from '../src/config/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { TEST_MANAGER, validRepoSettings } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';

describe('部署默认 settings（PI_BOT_DEFAULT_SETTINGS）', () => {
  it('未设置 → 契约默认值（不复制第二份默认值）', () => {
    expect(loadDefaultRepoSettings(undefined)).toEqual(DEFAULT_REPO_SETTINGS);
    expect(loadDefaultRepoSettings('   ')).toEqual(DEFAULT_REPO_SETTINGS);
    expect(DEFAULT_REPO_SETTINGS.version).toBe(1);
    expect(DEFAULT_REPO_SETTINGS.limits.concurrency_per_repo).toBe(2);
    expect(DEFAULT_REPO_SETTINGS.labels.max_per_issue).toBe(6);
    expect(DEFAULT_REPO_SETTINGS.agent.on_opened).toBe('proposal-analysis');
  });

  it('内联 JSON：在默认值上覆写（未写的键仍有默认值）', () => {
    // 部署默认也是一份**合法运行配置**：`managers` 非空 + 词表两角色（§4.5 / Q4），
    // 所以夹具直接用 `validRepoSettings()` 序列化，只显式覆写本用例关心的键。
    const settings = loadDefaultRepoSettings(
      JSON.stringify(validRepoSettings({ dry_run: false, limits: { queue_wait_minutes: 3 } })),
    );
    expect(settings.dry_run).toBe(false);
    expect(settings.limits.queue_wait_minutes).toBe(3);
    // 没写的段仍取默认值
    expect(settings.limits.max_comments_per_hour).toBe(10);
    expect(settings.agent.managers).toEqual([TEST_MANAGER]);
  });

  it('文件路径：读文件后按 JSON 解析（相对路径按 cwd 解析）', () => {
    const files = new Map<string, string>([
      ['/etc/pi-bot/default.json', JSON.stringify(validRepoSettings({ enabled: false }))],
    ]);
    const settings = loadDefaultRepoSettings('/etc/pi-bot/default.json', (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      return content;
    });
    expect(settings.enabled).toBe(false);
    expect(settings.limits.max_comments_per_hour).toBe(10);
  });

  it('解析失败要抛明确错误（不静默降级成默认值）', () => {
    expect(() => loadDefaultRepoSettings('{not json')).toThrow(/不是合法 JSON/u);
    expect(() => loadDefaultRepoSettings('{"bogus_key": 1}')).toThrow(/不符合 repoSettingsSchema/u);
    expect(() =>
      loadDefaultRepoSettings('/nope/missing.json', () => {
        throw new Error('ENOENT: no such file');
      }),
    ).toThrow(/读取部署默认仓库配置失败/u);
  });

  it('defaultRepoSettings() 走缓存，reset 后重新解析 env', () => {
    const key = REPO_SETTINGS_ENV;
    const previous = process.env[key];
    try {
      delete process.env[key];
      resetDefaultRepoSettingsCache();
      expect(defaultRepoSettings()).toEqual(DEFAULT_REPO_SETTINGS);

      process.env[key] = JSON.stringify(validRepoSettings({ dry_run: false }));
      // 缓存命中：还是上一次的值
      expect(defaultRepoSettings().dry_run).toBe(true);
      resetDefaultRepoSettingsCache();
      expect(defaultRepoSettings().dry_run).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
      resetDefaultRepoSettingsCache();
    }
  });
});

describe('validateRepoSettings', () => {
  it('合法 → ok；非法 → issues 带字段路径', () => {
    // `{}` 不再是合法运行配置（`agent.managers` 非空是 §4.5 / Q4 的硬要求），合法配置要带着它
    expect(validateRepoSettings(validRepoSettings()).ok).toBe(true);
    const emptyManagers = validateRepoSettings({});
    expect(emptyManagers.ok).toBe(false);
    if (!emptyManagers.ok) {
      expect(emptyManagers.issues.join(' ')).toContain('agent.managers');
    }

    const invalid = validateRepoSettings({ limits: { max_task_minutes: 999 } });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) {
      return;
    }
    expect(invalid.error).toContain('repoSettingsSchema');
    expect(invalid.issues.join(' ')).toContain('limits.max_task_minutes');

    const unknownKey = validateRepoSettings({ dryrun: true });
    expect(unknownKey.ok).toBe(false);
    if (unknownKey.ok) {
      return;
    }
    expect(unknownKey.error).toContain('dryrun');
  });
});

describe('repos 存储（真 PG）', () => {
  let db: TestDb;
  /** 进入本 describe 前的 `PI_BOT_DEFAULT_SETTINGS`（afterAll 恢复，别污染同进程的其它文件）。 */
  let previousDefaultEnv: string | undefined;

  beforeAll(async () => {
    db = await openTestDb();
    // 「部署默认」现在也必须是**合法运行配置**：`managers` 为空 = 整份配置解析失败，
    // `upsertRepo()` 会 seed 出一行 `settings_valid=false`。所以夹具用 env 给一份合法的默认值
    // （不是改产品默认值 —— `DEFAULT_REPO_SETTINGS` 是形状默认值，见 `packages/contract/src/repo-config.ts`）。
    previousDefaultEnv = process.env[REPO_SETTINGS_ENV];
    process.env[REPO_SETTINGS_ENV] = JSON.stringify(validRepoSettings());
    resetDefaultRepoSettingsCache();
  });

  afterAll(async () => {
    if (previousDefaultEnv === undefined) {
      delete process.env[REPO_SETTINGS_ENV];
    } else {
      process.env[REPO_SETTINGS_ENV] = previousDefaultEnv;
    }
    resetDefaultRepoSettingsCache();
    await db.close();
  });

  // 只清 `repos`（本文件的落库断言只关心这一张表；见 http-webhook.test.ts 里的同类说明）
  beforeEach(async () => {
    await db.pool.query('truncate table repos cascade');
  });

  it('upsertRepo：用部署默认 settings seed 一行（source=manual）', async () => {
    const created = await upsertRepo(db.pool, { repo: REPO });
    expect(created.ok).toBe(true);

    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy).toMatchObject({
      known: true,
      enabled: true,
      dryRun: true,
      settingsValid: true,
      settingsError: null,
      source: 'manual',
      installationId: null,
      archivedAt: null,
    });
    // 过渡期别名与 settings 同值（旧调用点仍可用）
    expect(policy.configValid).toBe(true);
    expect(policy.config?.limits.concurrency_per_repo).toBe(2);

    const rows = await db.sql(
      'select settings, settings_valid, source, settings_updated_at from repos where repo_full_name = $1',
      [REPO],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['settings_valid']).toBe(true);
    expect(rows[0]?.['source']).toBe('manual');
    expect(rows[0]?.['settings_updated_at']).toBeInstanceOf(Date);
  });

  it('upsertRepo：重复调用幂等，且不覆盖面板改过的 settings', async () => {
    await upsertRepo(db.pool, { repo: REPO });
    const updated = await updateRepoSettings(db.pool, REPO, {
      ...validRepoSettings(),
      dry_run: false,
      limits: { ...DEFAULT_REPO_SETTINGS.limits, concurrency_per_repo: 5 },
    });
    expect(updated.ok).toBe(true);

    await upsertRepo(db.pool, { repo: REPO, source: 'installation', installationId: 42 });
    const rows = await db.sql('select count(*)::int as n from repos');
    expect(rows[0]?.['n']).toBe(1);

    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.dryRun).toBe(false);
    expect(policy.settings?.limits.concurrency_per_repo).toBe(5);
    // 安装事件补上了来源与 installation id
    expect(policy.source).toBe('installation');
    expect(policy.installationId).toBe('42');
  });

  it('upsertRepo：安装来源可以显式建一个「关着 + dry-run」的行', async () => {
    const created = await upsertRepo(db.pool, {
      repo: REPO,
      source: 'installation',
      installationId: 7,
      enabled: false,
      dryRun: true,
    });
    expect(created.ok).toBe(true);
    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.enabled).toBe(false);
    expect(policy.dryRun).toBe(true);
    expect(policy.installationId).toBe('7');
  });

  it('updateRepoSettings：合法配置写库，并把 enabled / dry_run 列同步过去', async () => {
    await upsertRepo(db.pool, { repo: REPO });
    const result = await updateRepoSettings(
      db.pool,
      REPO,
      // 只覆写启停与映射；词表仍是 `validRepoSettings()` 的合法两角色（§4.5）
      validRepoSettings({
        enabled: true,
        dry_run: false,
        labels: { map: { bug: ['bug', 'needs-info'] } },
      }),
    );
    expect(result.ok).toBe(true);

    const rows = await db.sql('select enabled, dry_run, settings, settings_error from repos');
    expect(rows[0]).toMatchObject({ enabled: true, dry_run: false, settings_error: null });
    expect((rows[0]?.['settings'] as { labels: { map: Record<string, unknown> } }).labels.map['bug']).toEqual([
      'bug',
      'needs-info',
    ]);

    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.dryRun).toBe(false);
    expect(policy.settings?.labels.map['bug']).toEqual(['bug', 'needs-info']);
  });

  it('updateRepoSettings：非法配置不写库（库里保持 last-known-good）', async () => {
    await upsertRepo(db.pool, { repo: REPO });
    const good = await updateRepoSettings(db.pool, REPO, {
      ...validRepoSettings(),
      limits: { ...DEFAULT_REPO_SETTINGS.limits, max_task_minutes: 25 },
    });
    expect(good.ok).toBe(true);

    const bad = await updateRepoSettings(db.pool, REPO, {
      ...validRepoSettings(),
      limits: { ...DEFAULT_REPO_SETTINGS.limits, max_task_minutes: 999 },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) {
      return;
    }
    expect(bad.notFound).toBe(false);
    expect(bad.issues.join(' ')).toContain('limits.max_task_minutes');

    // 库里还是上一次的合法值，webhook 不会因为一次手滑就哑掉
    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.settingsValid).toBe(true);
    expect(policy.settings?.limits.max_task_minutes).toBe(25);
  });

  it('last-known-good：库里的 jsonb 被手改成非法 → settings=null 且标为不可用', async () => {
    await upsertRepo(db.pool, { repo: REPO });
    // 绕过 API 直接改库（模拟手改 / 旧结构）
    await db.pool.query(`update repos set settings = '{"compliance": {"enabled": false}}'::jsonb`);

    const policy = await readRepoPolicy(db.pool, REPO);
    // 仓库存在，但配置不可用 → webhook 忽略它的投递
    expect(policy.known).toBe(true);
    expect(policy.settingsValid).toBe(false);
    expect(policy.settings).toBeNull();
    expect(policy.config).toBeNull();
    expect(policy.settingsError).toContain('compliance');
  });

  it('settings_valid=false 时直接按不可用处理，并带上列里记的原因', async () => {
    await upsertRepo(db.pool, { repo: REPO });
    await db.pool.query(
      `update repos set settings_valid = false, settings_error = '面板写入失败：手工回滚' where repo_full_name = $1`,
      [REPO],
    );
    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.known).toBe(true);
    expect(policy.settingsValid).toBe(false);
    expect(policy.settings).toBeNull();
    expect(policy.settingsError).toBe('面板写入失败：手工回滚');
  });

  it('归档 → enabled=false（不删行），重新安装后恢复', async () => {
    await upsertRepo(db.pool, { repo: REPO });
    await db.pool.query(`update repos set archived_at = now() where repo_full_name = $1`, [REPO]);

    const archived = await readRepoPolicy(db.pool, REPO);
    expect(archived.enabled).toBe(false);
    expect(archived.archivedAt).not.toBeNull();
    // settings 仍然可读（面板要展示归档仓库的配置）
    expect(archived.settingsValid).toBe(true);

    // 重新安装 = 复活（upsertRepo 清 archived_at）
    await upsertRepo(db.pool, { repo: REPO, source: 'installation', installationId: 9 });
    const restored = await readRepoPolicy(db.pool, REPO);
    expect(restored.enabled).toBe(true);
    expect(restored.archivedAt).toBeNull();
  });

  it('readRepoPolicy：repos 没有这一行 → UNKNOWN_REPO_POLICY（webhook 据此忽略）', async () => {
    expect(await readRepoPolicy(db.pool, 'nobody/nothing')).toEqual(UNKNOWN_REPO_POLICY);
    expect(UNKNOWN_REPO_POLICY.known).toBe(false);
    expect(UNKNOWN_REPO_POLICY.enabled).toBe(false);
    expect(UNKNOWN_REPO_POLICY.settings).toBeNull();
  });

  it('updateRepoSettings：仓库不存在 → notFound（HTTP 层据此回 404）', async () => {
    // 「仓库不存在」要用**合法**配置才走得 database 分支（非法配置会先在校验层被挡回）
    const result = await updateRepoSettings(db.pool, 'nobody/nothing', validRepoSettings());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.notFound).toBe(true);
  });

  it('listRepos：列出全部仓库与状态（按 repo_full_name 升序）', async () => {
    await upsertRepo(db.pool, { repo: 'acme/zeta' });
    await upsertRepo(db.pool, { repo: 'acme/alpha', source: 'installation', installationId: 11 });
    await db.pool.query(`update repos set archived_at = now() where repo_full_name = 'acme/zeta'`);

    const repos = await listRepos(db.pool);
    expect(repos.map((item) => item.repo)).toEqual(['acme/alpha', 'acme/zeta']);
    expect(repos[0]).toMatchObject({
      enabled: true,
      source: 'installation',
      installationId: '11',
      archivedAt: null,
    });
    expect(repos[1]).toMatchObject({ enabled: false, source: 'manual', installationId: null });
    expect(repos[1]?.archivedAt).not.toBeNull();
    expect(repos[0]?.settingsUpdatedAt).not.toBeNull();
  });

  it('读路径不会写库（`readRepoPolicy` 是只读的）', async () => {
    await upsertRepo(db.pool, { repo: REPO });
    const before = await db.sql('select settings_updated_at, updated_at from repos');
    await readRepoPolicy(db.pool, REPO);
    const after = await db.sql('select settings_updated_at, updated_at from repos');
    expect(after).toEqual(before);
  });
});
