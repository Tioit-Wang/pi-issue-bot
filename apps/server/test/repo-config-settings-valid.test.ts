/**
 * 回归（P2-6）：`repos.settings_valid` 必须按**严格** `repoSettingsSchema` 判定，
 * 不能硬写 `true`（`docs/plan-fixed-pipeline.md` §4.5 / Q4）。
 *
 * 缺陷形状：`REPO_SQL.upsert` 把 `settings_valid` 写死 `true`。于是「部署没配
 * `PI_BOT_DEFAULT_SETTINGS`」时建出来的行是**形状默认值**（`DEFAULT_REPO_SETTINGS`，
 * `agent.managers: []`）却声明 valid —— webhook 会拿一份没人配过的配置开工，
 * 面板也会显示「配置正常」。
 *
 * 修法：`upsertRepo()` 用严格校验的结果给 `settings_valid` / `settings_error`；
 * `loadDefaultRepoSettings()` 的部署默认路径同样不能声明 valid（形状默认 ≠ 合法运行配置）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  REPO_SETTINGS_ENV,
  defaultRepoSettingsStatus,
  readRepoPolicy,
  resetDefaultRepoSettingsCache,
  upsertRepo,
} from '../src/config/repo-config.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';

let db: TestDb;
let previousDefaultEnv: string | undefined;

beforeAll(async () => {
  db = await openTestDb();
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

beforeEach(async () => {
  await db.sql('truncate table repos cascade');
  previousDefaultEnv = process.env[REPO_SETTINGS_ENV];
  delete process.env[REPO_SETTINGS_ENV];
  resetDefaultRepoSettingsCache();
});

describe('部署默认 settings 的 valid 判定（P2-6）', () => {
  it('PI_BOT_DEFAULT_SETTINGS 未设置 → 形状默认值，**不能**声明 valid', () => {
    const status = defaultRepoSettingsStatus();
    expect(status.ok).toBe(false);
    expect(status.error ?? '').toContain('agent.managers');
    resetDefaultRepoSettingsCache();
  });

  it('PI_BOT_DEFAULT_SETTINGS 是合法运行配置 → valid', () => {
    process.env[REPO_SETTINGS_ENV] = JSON.stringify(validRepoSettings());
    resetDefaultRepoSettingsCache();
    const status = defaultRepoSettingsStatus();
    expect(status.ok).toBe(true);
    expect(status.error).toBeNull();
    resetDefaultRepoSettingsCache();
  });
});

describe('upsertRepo 的 settings_valid（真 PG，P2-6）', () => {
  it('默认值不合法 → 行建出来但 settings_valid=false + settings_error 写明原因', async () => {
    const created = await upsertRepo(db.pool, { repo: REPO });
    expect(created.ok).toBe(true);

    const rows = await db.sql(
      'select settings_valid, settings_error, settings from repos where repo_full_name = $1',
      [REPO],
    );
    expect(rows[0]?.['settings_valid']).toBe(false);
    expect(String(rows[0]?.['settings_error'])).toContain('agent.managers');

    // 读侧据此判为不可用（webhook 忽略该仓库的投递）
    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.known).toBe(true);
    expect(policy.settingsValid).toBe(false);
    expect(policy.settings).toBeNull();
    expect(String(policy.settingsError)).toContain('agent.managers');
  });

  it('部署默认合法 → settings_valid=true', async () => {
    process.env[REPO_SETTINGS_ENV] = JSON.stringify(validRepoSettings());
    resetDefaultRepoSettingsCache();
    const created = await upsertRepo(db.pool, { repo: REPO });
    expect(created.ok).toBe(true);

    const rows = await db.sql(
      'select settings_valid, settings_error from repos where repo_full_name = $1',
      [REPO],
    );
    expect(rows[0]).toMatchObject({ settings_valid: true, settings_error: null });
    const policy = await readRepoPolicy(db.pool, REPO);
    expect(policy.settingsValid).toBe(true);
    expect(policy.settings).not.toBeNull();
  });

  it('显式给了合法 settings → valid；显式给了非法 settings → 不写库', async () => {
    const good = await upsertRepo(db.pool, { repo: REPO, settings: validRepoSettings() });
    expect(good.ok).toBe(true);
    let rows = await db.sql('select settings_valid from repos where repo_full_name = $1', [REPO]);
    expect(rows[0]?.['settings_valid']).toBe(true);

    await db.sql('truncate table repos cascade');
    const bad = await upsertRepo(db.pool, { repo: REPO, settings: { agent: { managers: [] } } });
    expect(bad.ok).toBe(false);
    rows = await db.sql('select count(*)::int as n from repos');
    expect(rows[0]?.['n']).toBe(0);
  });
});
