/**
 * 供应商 / 模型角色 / 面板身份的**真库**用例（`migrations/0013_wp9_model_providers.sql` 建的表）。
 *
 * 覆盖六条「面板上看不出来但一定要对」的事实：
 *  1. key 落库是 AES-256-GCM 密文（明文不出现），掩码可读、解密回原值；
 *  2. 换错密钥解密**必须抛**（不变式 I9：不许当成「未配置」）；
 *  3. `clear_key` 真清空，`key` 与 `clear_key` 同时给直接拒绝；
 *  4. 项目级「继承 / 覆盖」：`inherit` 删行，`override` 写行，生效值按「项目优先」；
 *  5. 角色只能绑到目录里存在的模型（保存时就拒，不静默失效）；
 *  6. 身份三态：过期 / scope 不足都落 `panel_identities.status`，「退回 bot」落 `identity_fallbacks`。
 *
 * 用真 PostgreSQL（`helpers/queries-db.ts` 建库 + advisory lock）；本文件只碰自己这几张表，
 * 所以不复用 `seedStandard`（它没有这几张表的数据）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSecretKey, looksEncrypted } from '../src/runtime/crypto.ts';
import {
  deleteIdentity,
  identityViewOf,
  listFallbacks,
  listIdentities,
  listProviders,
  listRepoRoleSelections,
  listRoleBindings,
  parseModelCatalog,
  priceOf,
  readIdentityToken,
  readProviderKey,
  recordFallback,
  recordIdentityCheck,
  saveIdentity,
  saveProvider,
  saveRepoRoleSelection,
  saveRoleBinding,
} from '../src/config/model-settings.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const REPO = 'acme/widgets';

let db: TestDb;
/** AES-256 密钥（32 字节）：与生产一样由装配层注入，不在模块内部读 env。 */
const KEY = generateSecretKey();
/** 另一把密钥（换错钥匙的场景）。 */
const WRONG_KEY = generateSecretKey();

beforeAll(async () => {
  db = await openTestDb(FIXED_NOW);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.pool.query(
    `truncate table model_providers, model_roles, repo_model_roles, panel_identities, identity_fallbacks cascade`,
  );
});

describe('CFG-8.1 供应商记录（真库）', () => {
  it('key 只存密文 + 掩码；读视图不带明文；解密回到原值', async () => {
    const saved = await saveProvider(
      db.pool,
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        key: 'sk-live-1234567890abcdef',
        models: [
          { model: 'deepseek-v4.1-flash', price: { input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2 } },
        ],
      },
      KEY,
    );
    expect(saved.ok).toBe(true);

    const rows = await db.sql(`select key_enc, key_mask from model_providers where id = 'deepseek'`);
    const row = rows[0] as { key_enc: string; key_mask: string };
    // 密文格式 + 明文不落库
    expect(looksEncrypted(row.key_enc)).toBe(true);
    expect(row.key_enc).not.toContain('sk-live-1234567890abcdef');
    expect(row.key_mask).toBe('sk-l…cdef');

    const view = (await listProviders(db.pool))[0];
    expect(view?.keyConfigured).toBe(true);
    expect(view?.keyMask).toBe('sk-l…cdef');
    // 读视图的类型里根本没有明文列
    expect(JSON.stringify(view)).not.toContain('sk-live-1234567890abcdef');

    expect(await readProviderKey(db.pool, 'deepseek', KEY)).toBe('sk-live-1234567890abcdef');
  });

  it('换错密钥解密必须抛（不变式 I9：不许静默当成「未配置」）', async () => {
    await saveProvider(db.pool, { id: 'deepseek', name: 'DeepSeek', key: 'sk-live-1234567890abcdef' }, KEY);
    await expect(readProviderKey(db.pool, 'deepseek', WRONG_KEY)).rejects.toThrow(/解密失败/u);
  });

  it('clear_key 真清空；key 与 clear_key 同时给直接拒绝（不猜意图）', async () => {
    await saveProvider(db.pool, { id: 'p1', name: 'P1', key: 'sk-first-12345678' }, KEY);
    const cleared = await saveProvider(db.pool, { id: 'p1', name: 'P1', clearKey: true }, KEY);
    expect(cleared.ok).toBe(true);
    const view = await listProviders(db.pool);
    expect(view[0]?.keyConfigured).toBe(false);
    expect(view[0]?.keyMask).toBe(null);
    expect(await readProviderKey(db.pool, 'p1', KEY)).toBe(null);

    const both = await saveProvider(db.pool, { id: 'p1', key: 'sk-second-12345678', clearKey: true }, KEY);
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error).toContain('不能同时给');
  });

  it('未传字段原样保留（只改名字不会把 base URL / key / 目录抹掉）', async () => {
    await saveProvider(
      db.pool,
      {
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://p1.example/v1',
        key: 'sk-first-12345678',
        models: [{ model: 'm1', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } }],
      },
      KEY,
    );
    await saveProvider(db.pool, { id: 'p1', name: 'P1 改名' }, KEY);
    const view = (await listProviders(db.pool))[0];
    expect(view?.name).toBe('P1 改名');
    expect(view?.baseUrl).toBe('https://p1.example/v1');
    expect(view?.keyConfigured).toBe(true);
    expect(view?.models.map((item) => item.model)).toEqual(['m1']);
  });

  it('目录里单价是「模型的属性」：按模型查，查不到返回 null（不补 0）', async () => {
    await saveProvider(
      db.pool,
      {
        id: 'p1',
        name: 'P1',
        models: [{ model: 'm1', price: { input_usd_per_mtok: 1.5, output_usd_per_mtok: 6 } }],
      },
      KEY,
    );
    const view = (await listProviders(db.pool))[0];
    expect(priceOf(view?.models ?? [], 'm1')).toEqual({ input_usd_per_mtok: 1.5, output_usd_per_mtok: 6 });
    expect(priceOf(view?.models ?? [], 'm-unknown')).toBe(null);
  });

  it('目录里的坏条目被跳过（不合法的一项不该让整页设置打不开）', async () => {
    expect(parseModelCatalog([{ model: 'ok', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } }, { model: '' }, 42])).toEqual([
      { model: 'ok', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } },
    ]);
  });
});

describe('CFG-8.2 模型角色四档（真库）', () => {
  it('四档固定四行；没配的档 configured=false', async () => {
    const bindings = await listRoleBindings(db.pool);
    expect(bindings.map((item) => item.role)).toEqual(['agent', 'format', 'classify', 'fallback']);
    expect(bindings.every((item) => !item.configured)).toBe(true);
  });

  it('只能绑目录里存在的模型（拼错就当场拒，不留下静默失效的配置）', async () => {
    await saveProvider(
      db.pool,
      { id: 'p1', name: 'P1', models: [{ model: 'm1', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } }] },
      KEY,
    );
    const missing = await saveRoleBinding(db.pool, { role: 'agent', providerId: 'p1', model: 'm-typo' });
    expect(missing.ok).toBe(false);

    const unknownProvider = await saveRoleBinding(db.pool, { role: 'agent', providerId: 'nope', model: 'm1' });
    expect(unknownProvider.ok).toBe(false);

    const badRole = await saveRoleBinding(db.pool, { role: 'boss', providerId: 'p1', model: 'm1' });
    expect(badRole.ok).toBe(false);

    const ok = await saveRoleBinding(db.pool, { role: 'agent', providerId: 'p1', model: 'm1' });
    expect(ok.ok).toBe(true);
    const bindings = await listRoleBindings(db.pool);
    expect(bindings.find((item) => item.role === 'agent')).toMatchObject({
      configured: true,
      providerId: 'p1',
      model: 'm1',
    });
  });
});

describe('CFG-8.3 项目级「继承 / 覆盖」（真库）', () => {
  it('没有覆盖行 = 继承（overridden=false）；写行 = 覆盖；inherit 删行回到继承', async () => {
    await saveProvider(
      db.pool,
      {
        id: 'p1',
        name: 'P1',
        models: [
          { model: 'global-model', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } },
          { model: 'repo-model', price: { input_usd_per_mtok: 3, output_usd_per_mtok: 9 } },
        ],
      },
      KEY,
    );
    await saveRoleBinding(db.pool, { role: 'agent', providerId: 'p1', model: 'global-model' });

    // 初始：继承
    let selections = await listRepoRoleSelections(db.pool, REPO);
    expect(selections.find((item) => item.role === 'agent')).toMatchObject({ overridden: false, model: null });

    // 覆盖
    const overridden = await saveRepoRoleSelection(db.pool, {
      repo: REPO,
      role: 'agent',
      selection: { mode: 'override', provider_id: 'p1', model: 'repo-model' },
    });
    expect(overridden.ok).toBe(true);
    selections = await listRepoRoleSelections(db.pool, REPO);
    expect(selections.find((item) => item.role === 'agent')).toMatchObject({ overridden: true, model: 'repo-model' });

    // 回到继承（删行，而不是写一行空值）
    const inherited = await saveRepoRoleSelection(db.pool, { repo: REPO, role: 'agent', selection: { mode: 'inherit' } });
    expect(inherited.ok).toBe(true);
    selections = await listRepoRoleSelections(db.pool, REPO);
    expect(selections.find((item) => item.role === 'agent')).toMatchObject({ overridden: false, model: null });
    const rows = await db.sql(`select count(*)::int as n from repo_model_roles where repo = $1`, [REPO]);
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('覆盖也只能指向目录里存在的模型', async () => {
    await saveProvider(
      db.pool,
      { id: 'p1', name: 'P1', models: [{ model: 'm1', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } }] },
      KEY,
    );
    const result = await saveRepoRoleSelection(db.pool, {
      repo: REPO,
      role: 'format',
      selection: { mode: 'override', provider_id: 'p1', model: 'm-typo' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('CFG-9.1 / CFG-9.2 面板身份与退回留痕（真库）', () => {
  it('PAT 只存密文 + 掩码；解密回原值；删除后读不到', async () => {
    await saveIdentity(db.pool, { login: 'alice', token: 'github_pat_1234567890abcdef' }, KEY);
    const rows = await db.sql(`select token_enc, token_mask, status from panel_identities where login = 'alice'`);
    const row = rows[0] as { token_enc: string; token_mask: string; status: string };
    expect(looksEncrypted(row.token_enc)).toBe(true);
    expect(row.token_mask).toBe('gith…cdef');
    // 存完是 unchecked：CFG-9.2 不让「存了但不知道能不能用」冒充可用
    expect(row.status).toBe('unchecked');

    expect(await readIdentityToken(db.pool, 'alice', KEY)).toBe('github_pat_1234567890abcdef');
    await deleteIdentity(db.pool, 'alice');
    expect(await readIdentityToken(db.pool, 'alice', KEY)).toBe(null);
    expect(await listIdentities(db.pool, FIXED_NOW)).toEqual([]);
  });

  it('三态落库：过期与 scope 不足都写进 status，且理由可读', async () => {
    await saveIdentity(db.pool, { login: 'bob', token: 'github_pat_1234567890abcdef' }, KEY);
    await recordIdentityCheck(db.pool, {
      login: 'bob',
      scopes: ['repo'],
      expiresAt: '2026-05-01T00:00:00.000Z',
      state: 'expired',
      detail: '个人 PAT 已于 2026-05-01T00:00:00.000Z 过期，已退回 bot 身份',
      checkedAt: FIXED_NOW,
    });
    const expired = (await listIdentities(db.pool, FIXED_NOW))[0];
    expect(expired?.state).toBe('expired');
    expect(expired?.tokenExpiresAt).toBe('2026-05-01T00:00:00.000Z');

    // scope 不足：状态由 `classifyIdentityState()` 现算（不是读库里的 status 列）
    await recordIdentityCheck(db.pool, {
      login: 'bob',
      scopes: ['read:user'],
      expiresAt: null,
      state: 'ok',
      detail: '（库里写 ok，但事实是 scope 不够）',
      checkedAt: FIXED_NOW,
    });
    const insufficient = (await listIdentities(db.pool, FIXED_NOW))[0];
    expect(insufficient?.state).toBe('insufficient-scope');
    expect([...(insufficient?.missingScopes ?? [])]).toEqual(['issues:write']);
  });

  it('判定只读事实：scope 快照 + 过期时刻，判态由 classifyIdentityState 现算', () => {
    const view = identityViewOf(
      {
        login: 'carol',
        token_enc: 'v1:aa:bb:cc',
        token_mask: 'gith…cdef',
        scopes: ['repo'],
        token_expires_at: null,
        status: 'anything',
        checked_at: null,
        check_detail: null,
        updated_at: null,
      },
      FIXED_NOW,
    );
    expect(view.state).toBe('ok');
    expect(view.missingScopes).toEqual([]);
  });

  it('「退回 bot」留痕可查（倒序，且带原因）', async () => {
    await recordFallback(db.pool, {
      login: 'alice',
      state: 'expired',
      operation: 'comment',
      target: 'acme/widgets#12',
      reason: '个人 PAT 已过期，已退回 bot 身份',
      at: new Date('2026-06-01T10:00:00.000Z'),
    });
    await recordFallback(db.pool, {
      login: 'alice',
      state: 'insufficient-scope',
      operation: 'label',
      target: 'acme/widgets#13',
      reason: '个人 PAT 缺 issues:write 权限，已退回 bot 身份',
      at: new Date('2026-06-01T11:00:00.000Z'),
    });
    const rows = await listFallbacks(db.pool, 10);
    expect(rows.map((row) => row.operation)).toEqual(['label', 'comment']);
    expect(rows[0]?.state).toBe('insufficient-scope');
    expect(rows[0]?.reason).toContain('issues:write');
  });
});
