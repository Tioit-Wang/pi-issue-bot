/**
 * 供应商 / 模型角色 / 面板身份的**存储层**（需求 §6.8、§6.9）。
 *
 * 为什么单独一个文件而不是塞进 `repo-config.ts`：
 *  - 这三件事是**全局**配置（不是某个仓库的 settings），读写口径与 `repos.settings` 完全不同；
 *  - key / PAT 要加密（AES-256-GCM），而「加密 key 从哪来」是一个**进程级**事实
 *    （`EnvironmentFile` 注入），只有装配层知道。放一起会让 `repo-config` 被迫认识密钥。
 *
 * 四条硬约束：
 *  1. **明文永不落库**：`key_enc` / `token_enc` 只存 `encryptSecret()` 的产物，
 *     读路径返回的是掩码（`keyMask` / `tokenMask`），真值只有 `readProviderKey()` /
 *     `readIdentityToken()` 两处解密出口。
 *  2. **解密失败必须抛**（AGENTS 不变式 I9）：换错 key、密文被篡改一律 `AppError`，
 *     不许静默当成「未配置」——那会让一家配好的供应商看起来从没配过。
 *  3. **`now` 注入**：身份三态里有一项是「过期」，测试必须能摆位（AGENTS §6.2）。
 *  4. **写库前必校验**：`saveProvider()` 校验不过就一个字节都不写（与 `updateRepoSettings()` 同口径）。
 */
import { AppError } from '../runtime/deps.ts';
import { decryptSecret, encryptSecret, looksEncrypted } from '../runtime/crypto.ts';
import {
  MODEL_ROLE_KEYS,
  classifyIdentityState,
  maskSecret,
  missingRequiredScopes,
  modelProviderIdSchema,
  modelRoleKeySchema,
  modelCatalogEntrySchema,
  type ModelCatalogEntry,
  type ModelPrice,
  type ModelProviderStatus,
  type ModelRoleKey,
  type PanelIdentityState,
} from '../../../../packages/contract/src/index.ts';
import type { SqlRunner } from './repo-config.ts';

/* ── 1. 行形状（读侧用，与 `db/schema.ts` 一一对应） ─────────────────────────── */

type ProviderRow = {
  id: string;
  name: string;
  base_url: string | null;
  key_enc: string | null;
  key_mask: string | null;
  models: unknown;
  enabled: boolean | null;
  status: string | null;
  latency_ms: number | null;
  checked_at: Date | string | null;
  check_error: string | null;
  updated_at: Date | string | null;
};

type RoleRow = {
  role: string;
  provider_id: string;
  model: string;
  updated_at: Date | string | null;
};

type RepoRoleRow = {
  repo: string;
  role: string;
  provider_id: string;
  model: string;
  updated_at: Date | string | null;
};

type IdentityRow = {
  login: string;
  token_enc: string;
  token_mask: string;
  scopes: unknown;
  token_expires_at: Date | string | null;
  status: string | null;
  checked_at: Date | string | null;
  check_detail: string | null;
  updated_at: Date | string | null;
};

type FallbackRow = {
  id: number | string;
  login: string | null;
  state: string;
  operation: string;
  target: string;
  reason: string;
  created_at: Date | string;
};

/* ── 2. 读模型（界面/装配层用） ─────────────────────────────────────────────── */

/** 供应商的读视图：**只有掩码与「配没配」**，真值要显式经 `readProviderKey()`。 */
export type ProviderView = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly keyConfigured: boolean;
  readonly keyMask: string | null;
  readonly models: readonly ModelCatalogEntry[];
  readonly enabled: boolean;
  readonly status: ModelProviderStatus;
  readonly latencyMs: number | null;
  readonly checkedAt: string | null;
  readonly checkError: string | null;
  readonly updatedAt: string | null;
};

/** 一档角色的**全局**绑定（`configured: false` = 没配）。 */
export type RoleBindingView = {
  readonly role: ModelRoleKey;
  readonly configured: boolean;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly updatedAt: string | null;
};

/** 项目级一行：`inherit` = 没有覆盖行（跟全局），`override` = 有覆盖行。 */
export type RepoRoleSelectionView = {
  readonly role: ModelRoleKey;
  readonly overridden: boolean;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly updatedAt: string | null;
};

/** 身份读视图：掩码 + 三态，**永不含明文**。 */
export type IdentityView = {
  readonly login: string;
  readonly tokenMask: string;
  readonly state: PanelIdentityState;
  readonly stateReason: string;
  readonly scopes: readonly string[] | null;
  readonly missingScopes: readonly string[];
  readonly tokenExpiresAt: string | null;
  readonly checkedAt: string | null;
  readonly updatedAt: string | null;
};

/* ── 3. 归一化小工具 ────────────────────────────────────────────────────────── */

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function statusOf(value: unknown): ModelProviderStatus {
  return value === 'ok' || value === 'fail' ? value : 'unknown';
}

/**
 * jsonb 的 model 目录 → 契约形状。
 *
 * 为什么要逐条 `safeParse` 而不是直接 `as`：这列是 jsonb，手改库/旧格式都可能让单项不合法；
 * 一条坏数据不该让整页设置打不开（静默丢这一条并保留其余的，比整页 500 好），
 * 但**单价缺失绝不补 0**——「补 0」等于告诉用户这次没花钱。
 */
export function parseModelCatalog(raw: unknown): readonly ModelCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ModelCatalogEntry[] = [];
  for (const item of raw) {
    const parsed = modelCatalogEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/** 从模型目录解出单价；目录里没有这个模型 → `null`（不是 0）。 */
export function priceOf(
  models: readonly ModelCatalogEntry[],
  model: string | null,
): ModelPrice | null {
  if (model === null) return null;
  const hit = models.find((entry) => entry.model === model);
  return hit === undefined ? null : hit.price;
}

function toProviderView(row: ProviderRow): ProviderView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: stringOrNull(row.base_url),
    // 「配没配」看密文列有没有值：掩码列是同一个写入一起写的，但密文才是事实
    keyConfigured: stringOrNull(row.key_enc) !== null,
    keyMask: stringOrNull(row.key_mask),
    models: parseModelCatalog(row.models),
    enabled: row.enabled !== false,
    status: statusOf(row.status),
    latencyMs: typeof row.latency_ms === 'number' ? row.latency_ms : null,
    checkedAt: isoOrNull(row.checked_at),
    checkError: stringOrNull(row.check_error),
    updatedAt: isoOrNull(row.updated_at),
  };
}

/* ── 4. 供应商读写 ──────────────────────────────────────────────────────────── */

/** 全部供应商（`id` 升序：面板一行一家，顺序必须稳定）。 */
export async function listProviders(db: SqlRunner): Promise<readonly ProviderView[]> {
  const result = await db.query(
    `select id, name, base_url, key_enc, key_mask, models, enabled, status,
            latency_ms, checked_at, check_error, updated_at
       from model_providers
      order by id asc`,
  );
  return (result.rows as ProviderRow[]).map(toProviderView);
}

/** 单个供应商；不存在返回 `null`（http 层映射 404）。 */
export async function readProvider(db: SqlRunner, id: string): Promise<ProviderView | null> {
  const result = await db.query(
    `select id, name, base_url, key_enc, key_mask, models, enabled, status,
            latency_ms, checked_at, check_error, updated_at
       from model_providers
      where id = $1`,
    [id],
  );
  const row = result.rows[0] as ProviderRow | undefined;
  return row === undefined ? null : toProviderView(row);
}

/**
 * 解密一家供应商的 key（**唯一明文出口**）。
 *
 * 三种返回：`null` = 确实没配（合法）；字符串 = 明文；抛错 = 密文解不开（不许当成没配）。
 */
export async function readProviderKey(
  db: SqlRunner,
  id: string,
  key: Uint8Array,
): Promise<string | null> {
  const result = await db.query(`select key_enc from model_providers where id = $1`, [id]);
  const row = result.rows[0] as { key_enc: string | null } | undefined;
  const enc = row?.key_enc ?? null;
  if (enc === null) return null;
  if (!looksEncrypted(enc)) {
    // 手改库把明文塞进来了：这本身就是事故，必须报错而不是「能读就用」
    throw new AppError(`供应商 ${id} 的 key 不是密文格式（model_providers.key_enc）`, {
      code: 'MODEL_PROVIDER_KEY_INVALID',
      failureClass: 'auth',
      retriable: false,
    });
  }
  return decryptSecret(enc, { key });
}

export type SaveProviderInput = {
  readonly id: string;
  readonly name?: string;
  readonly baseUrl?: string | null;
  /** 明文 key；不传 = 不变，`clearKey: true` 才清空。 */
  readonly key?: string;
  readonly clearKey?: boolean;
  readonly models?: readonly ModelCatalogEntry[];
  readonly enabled?: boolean;
};

export type SaveProviderResult =
  | { readonly ok: true; readonly provider: ProviderView }
  | { readonly ok: false; readonly error: string; readonly issues: readonly string[] };

/**
 * 新建/更新一家供应商（未传的字段原样保留）。
 *
 * `clearKey` 与 `key` 互斥：同时给等于没说清要哪一个，直接拒绝（宁可让面板改一次请求，
 * 也不要猜「他到底是想清空还是想改」）。
 */
export async function saveProvider(
  db: SqlRunner,
  input: SaveProviderInput,
  key: Uint8Array,
): Promise<SaveProviderResult> {
  const idParsed = modelProviderIdSchema.safeParse(input.id);
  if (!idParsed.success) {
    return { ok: false, error: `供应商 id 不合法：${input.id}`, issues: [idParsed.error.message] };
  }
  if (input.key !== undefined && input.clearKey === true) {
    return { ok: false, error: 'key 与 clear_key 不能同时给', issues: ['既改了 key 又要清空'] };
  }

  const existing = await readProvider(db, idParsed.data);
  const name = input.name ?? existing?.name ?? idParsed.data;
  const baseUrl = input.baseUrl === undefined ? (existing?.baseUrl ?? null) : input.baseUrl;
  const models = input.models === undefined ? (existing?.models ?? []) : input.models;
  const enabled = input.enabled ?? existing?.enabled ?? true;

  // 三态：保持（不传密文列）／写入新密文／清空
  let keyEnc: string | null;
  let keyMask: string | null;
  if (input.clearKey === true) {
    keyEnc = null;
    keyMask = null;
  } else if (input.key !== undefined) {
    keyEnc = encryptSecret(input.key, { key });
    // 掩码也从密文解出同一份明文算，保证「界面显示的掩码」与「实际用的 key」是同一把
    keyMask = maskSecret(input.key);
  } else {
    const kept = await db.query(`select key_enc, key_mask from model_providers where id = $1`, [idParsed.data]);
    const row = kept.rows[0] as { key_enc: string | null; key_mask: string | null } | undefined;
    keyEnc = row?.key_enc ?? null;
    keyMask = row?.key_mask ?? null;
  }

  await db.query(
    `insert into model_providers
       (id, name, base_url, key_enc, key_mask, models, enabled, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
     on conflict (id) do update
       set name = $2, base_url = $3, key_enc = $4, key_mask = $5,
           models = $6::jsonb, enabled = $7, updated_at = now()`,
    [idParsed.data, name, baseUrl, keyEnc, keyMask, JSON.stringify(models), enabled],
  );

  const saved = await readProvider(db, idParsed.data);
  if (saved === null) {
    return { ok: false, error: `写入后读不到供应商：${idParsed.data}`, issues: [] };
  }
  return { ok: true, provider: saved };
}

/** 记录一次连通性测定的结果（写 `status` / `latency_ms` / `checked_at` / `check_error`）。 */
export async function recordProviderCheck(
  db: SqlRunner,
  input: {
    readonly id: string;
    readonly status: ModelProviderStatus;
    readonly latencyMs: number | null;
    readonly checkedAt: Date;
    readonly error: string | null;
    /** 探测到的可用 model 列表；`undefined` = 不改目录。 */
    readonly models?: readonly string[] | undefined;
  },
): Promise<void> {
  await db.query(
    `update model_providers
        set status = $2, latency_ms = $3, checked_at = $4, check_error = $5, updated_at = now()
      where id = $1`,
    [input.id, input.status, input.latencyMs, input.checkedAt.toISOString(), input.error],
  );
  if (input.models !== undefined && input.models.length > 0) {
    // 用探测结果覆盖**模型名**，单价沿用目录里已有的（探测接口不报价）
    const current = await readProvider(db, input.id);
    const previous = current?.models ?? [];
    const merged: ModelCatalogEntry[] = input.models.map((model) => {
      const hit = previous.find((entry) => entry.model === model);
      return hit ?? { model, price: { input_usd_per_mtok: 0, output_usd_per_mtok: 0 } };
    });
    await db.query(`update model_providers set models = $2::jsonb where id = $1`, [
      input.id,
      JSON.stringify(merged),
    ]);
  }
}

/* ── 5. 角色四档（全局 + 项目覆盖） ────────────────────────────────────────── */

/** 全部供应商（供解析单价时用；内部复用 `listProviders` 的 SQL 结果）。 */
async function providerCatalogOf(
  db: SqlRunner,
): Promise<ReadonlyMap<string, ProviderView>> {
  const providers = await listProviders(db);
  return new Map(providers.map((provider) => [provider.id, provider]));
}

/** 四档的全局绑定（固定六顺序，缺的档 `configured: false`）。 */
export async function listRoleBindings(db: SqlRunner): Promise<readonly RoleBindingView[]> {
  const result = await db.query(`select role, provider_id, model, updated_at from model_roles`);
  const rows = result.rows as RoleRow[];
  const byRole = new Map(rows.map((row) => [row.role, row]));
  return MODEL_ROLE_KEYS.map((role) => {
    const row = byRole.get(role);
    return {
      role,
      configured: row !== undefined,
      providerId: row?.provider_id ?? null,
      model: row?.model ?? null,
      updatedAt: isoOrNull(row?.updated_at),
    };
  });
}

/** 写一档全局绑定（`role` 必须是四档之一）。 */
export async function saveRoleBinding(
  db: SqlRunner,
  input: { readonly role: string; readonly providerId: string; readonly model: string },
): Promise<saveRoleResultType> {
  const roleParsed = modelRoleKeySchema.safeParse(input.role);
  if (!roleParsed.success) {
    return { ok: false, error: `角色只能是 ${MODEL_ROLE_KEYS.join(' / ')}`, issues: [roleParsed.error.message] };
  }
  const provider = await readProvider(db, input.providerId);
  if (provider === null) {
    // 保存时不校验供应商存在 = 拼错一个字母就永久静默失效（需求点名的坑）
    return { ok: false, error: `供应商不存在：${input.providerId}`, issues: ['provider_id'] };
  }
  const known = provider.models.some((entry) => entry.model === input.model);
  if (!known) {
    return {
      ok: false,
      error: `供应商 ${input.providerId} 的 model 目录里没有 ${input.model}（先把 model 加进目录，单价才有来源）`,
      issues: ['model'],
    };
  }
  await db.query(
    `insert into model_roles (role, provider_id, model, updated_at)
     values ($1, $2, $3, now())
     on conflict (role) do update
       set provider_id = $2, model = $3, updated_at = now()`,
    [roleParsed.data, input.providerId, input.model],
  );
  return { ok: true };
}

export type saveRoleResultType =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly issues: readonly string[] };

/** 一档的单价（从全局绑定 + 供应商目录解析）；未配置为 `null`。 */
export async function resolveRolePrice(
  db: SqlRunner,
  role: ModelRoleKey,
): Promise<ModelPrice | null> {
  const bindings = await listRoleBindings(db);
  const binding = bindings.find((item) => item.role === role);
  if (binding === undefined || binding.providerId === null || binding.model === null) return null;
  const provider = await readProvider(db, binding.providerId);
  return provider === null ? null : priceOf(provider.models, binding.model);
}

/** 项目级四档覆写（固定四行；没有覆盖行 = `overridden: false`）。 */
export async function listRepoRoleSelections(
  db: SqlRunner,
  repo: string,
): Promise<readonly RepoRoleSelectionView[]> {
  const result = await db.query(
    `select repo, role, provider_id, model, updated_at from repo_model_roles where repo = $1`,
    [repo],
  );
  const byRole = new Map((result.rows as RepoRoleRow[]).map((row) => [row.role, row]));
  return MODEL_ROLE_KEYS.map((role) => {
    const row = byRole.get(role);
    return {
      role,
      overridden: row !== undefined,
      providerId: row?.provider_id ?? null,
      model: row?.model ?? null,
      updatedAt: isoOrNull(row?.updated_at),
    };
  });
}

/**
 * 写/删项目级覆盖（CFG-8.3）：`inherit` 删行，`override` 写行。
 *
 * 删行为什么不是「写一行 provider_id='' 」：稀疏性就是语义（没行=继承），
 * 写空串会让「继承」与「覆盖成一个不存在的供应商」变成同一件事。
 */
export async function saveRepoRoleSelection(
  db: SqlRunner,
  input: {
    readonly repo: string;
    readonly role: string;
    readonly selection: { readonly mode: 'inherit' } | {
      readonly mode: 'override';
      readonly provider_id: string;
      readonly model: string;
    };
  },
): Promise<saveRoleResultType> {
  const roleParsed = modelRoleKeySchema.safeParse(input.role);
  if (!roleParsed.success) {
    return { ok: false, error: `角色只能是 ${MODEL_ROLE_KEYS.join(' / ')}`, issues: [roleParsed.error.message] };
  }
  const selection = input.selection;
  if (selection.mode === 'inherit') {
    await db.query(`delete from repo_model_roles where repo = $1 and role = $2`, [
      input.repo,
      roleParsed.data,
    ]);
    return { ok: true };
  }
  const provider = await readProvider(db, selection.provider_id);
  if (provider === null) {
    return { ok: false, error: `供应商不存在：${selection.provider_id}`, issues: ['provider_id'] };
  }
  if (!provider.models.some((entry) => entry.model === selection.model)) {
    return {
      ok: false,
      error: `供应商 ${selection.provider_id} 的 model 目录里没有 ${selection.model}`,
      issues: ['model'],
    };
  }
  await db.query(
    `insert into repo_model_roles (repo, role, provider_id, model, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (repo, role) do update
       set provider_id = $3, model = $4, updated_at = now()`,
    [input.repo, roleParsed.data, selection.provider_id, selection.model],
  );
  return { ok: true };
}

/**
 * **生效**的一档（CFG-8.3 的执行面）：项目覆盖优先，否则全局。
 *
 * 为什么单独一个函数：执行面（`agent`/`format`/`classify`/兜底）只该问「这一档最终用谁」，
 * 不该各自实现一次「先查项目再查全局」——两处实现迟早漂成两个答案。
 */
export async function resolveEffectiveRole(
  db: SqlRunner,
  repo: string | null,
  role: ModelRoleKey,
): Promise<{ readonly providerId: string; readonly model: string; readonly source: 'repo' | 'global' } | null> {
  if (repo !== null) {
    const overrides = await listRepoRoleSelections(db, repo);
    const hit = overrides.find((item) => item.role === role);
    if (hit !== undefined && hit.overridden && hit.providerId !== null && hit.model !== null) {
      return { providerId: hit.providerId, model: hit.model, source: 'repo' };
    }
  }
  const bindings = await listRoleBindings(db);
  const global = bindings.find((item) => item.role === role);
  if (global === undefined || !global.configured || global.providerId === null || global.model === null) {
    return null;
  }
  return { providerId: global.providerId, model: global.model, source: 'global' };
}

/** 供单价解析复用（导出给「成本计算读配置」那侧，避免它自己再查一遍目录）。 */
export async function providerCatalogMap(
  db: SqlRunner,
): Promise<ReadonlyMap<string, ProviderView>> {
  return providerCatalogOf(db);
}

/* ── 6. 面板身份（个人 PAT） ───────────────────────────────────────────────── */

function parseScopes(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((item): item is string => typeof item === 'string' && item !== '');
}

/** 把一行身份记录判成三态（`classifyIdentityState` 是**唯一**判定实现）。 */
export function identityViewOf(row: IdentityRow, at: Date): IdentityView {
  const scopes = parseScopes(row.scopes);
  const expiresAt = isoOrNull(row.token_expires_at);
  const classified = classifyIdentityState({
    configured: true,
    // `unchecked` 的语义是「还没读过 scope」：空数组是「读了，但一个都没有」
    scopes: scopes === null ? null : scopes,
    expiresAt,
    at,
  });
  return {
    login: row.login,
    tokenMask: row.token_mask,
    state: classified.state,
    stateReason: classified.reason,
    scopes,
    missingScopes: scopes === null ? [] : missingRequiredScopes(scopes),
    tokenExpiresAt: expiresAt,
    checkedAt: isoOrNull(row.checked_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}

/** 一个用户配的身份；没配返回 `null`。 */
export async function readIdentity(
  db: SqlRunner,
  login: string,
  at: Date,
): Promise<IdentityView | null> {
  const result = await db.query(
    `select login, token_enc, token_mask, scopes, token_expires_at, status, checked_at, check_detail, updated_at
       from panel_identities
      where login = $1`,
    [login],
  );
  const row = result.rows[0] as IdentityRow | undefined;
  return row === undefined ? null : identityViewOf(row, at);
}

/** 全部身份（面板「当前身份」在多用户部署下取第一行不够，这里给列表）。 */
export async function listIdentities(db: SqlRunner, at: Date): Promise<readonly IdentityView[]> {
  const result = await db.query(
    `select login, token_enc, token_mask, scopes, token_expires_at, status, checked_at, check_detail, updated_at
       from panel_identities
      order by login asc`,
  );
  return (result.rows as IdentityRow[]).map((row) => identityViewOf(row, at));
}

/** 解密一个用户的 PAT（**唯一明文出口**）；没配返回 `null`，密文坏了一律抛。 */
export async function readIdentityToken(
  db: SqlRunner,
  login: string,
  key: Uint8Array,
): Promise<string | null> {
  const result = await db.query(`select token_enc from panel_identities where login = $1`, [login]);
  const row = result.rows[0] as { token_enc: string } | undefined;
  if (row === undefined) return null;
  if (!looksEncrypted(row.token_enc)) {
    throw new AppError(`panel_identities(${login}) 的 token 不是密文格式`, {
      code: 'PANEL_IDENTITY_TOKEN_INVALID',
      failureClass: 'auth',
      retriable: false,
    });
  }
  return decryptSecret(row.token_enc, { key });
}

/** 存/更新一个用户的 PAT（明文只在这一个函数的参数里出现，落库前加密）。 */
export async function saveIdentity(
  db: SqlRunner,
  input: { readonly login: string; readonly token: string },
  key: Uint8Array,
): Promise<void> {
  // `scopes` 写成 SQL NULL 而不是 `'[]'`：三态里的 `unchecked` 的语义是「还没读过 scope」，
  // 而 `[]` 是「读了，但一个 scope 都没有」——两者混同会让刚存进去的令牌显示成「权限不足」。
  await db.query(
    `insert into panel_identities (login, token_enc, token_mask, scopes, status, updated_at)
     values ($1, $2, $3, null, 'unchecked', now())
     on conflict (login) do update
       set token_enc = $2, token_mask = $3, scopes = null,
           status = 'unchecked', checked_at = null, check_detail = null, updated_at = now()`,
    [input.login, encryptSecret(input.token, { key }), maskSecret(input.token)],
  );
}

/** 删除一个用户的 PAT（面板「清除个人令牌」→ 一切写回退回 bot）。 */
export async function deleteIdentity(db: SqlRunner, login: string): Promise<void> {
  await db.query(`delete from panel_identities where login = $1`, [login]);
}

/**
 * 记一次「检查权限」的结论：scope 快照 + 过期时刻 + 三态。
 *
 * 为什么不在这里判定三态：判定只有 `classifyIdentityState()` 一处（在契约里，
 * 面板与服务端共用），这里只负责把**事实**（scope / 过期）落下来。
 */
export async function recordIdentityCheck(
  db: SqlRunner,
  input: {
    readonly login: string;
    readonly scopes: readonly string[] | null;
    readonly expiresAt: string | null;
    readonly state: PanelIdentityState;
    readonly detail: string;
    readonly checkedAt: Date;
  },
): Promise<void> {
  await db.query(
    `update panel_identities
        set scopes = $2::jsonb,
            token_expires_at = $3,
            status = $4,
            checked_at = $5,
            check_detail = $6,
            updated_at = now()
      where login = $1`,
    [
      input.login,
      JSON.stringify(input.scopes ?? []),
      input.expiresAt,
      input.state,
      input.checkedAt.toISOString(),
      input.detail,
    ],
  );
}

/* ── 7. 「退回 bot」留痕（CFG-9.2） ───────────────────────────────────────── */

/** 一条退回留痕的写入参数。 */
export type FallbackRecord = {
  readonly login: string | null;
  readonly state: PanelIdentityState;
  readonly operation: string;
  readonly target: string;
  readonly reason: string;
  readonly at: Date;
};

/**
 * 记一条退回留痕。
 *
 * 为什么要落库而不是只打日志：需求要求「写回失败原因要**显式呈现**」，而呈现的地方是面板；
 * 只写日志等于把「为什么这次是 bot 署名的」埋进无法按 issue 查询的地方。
 */
export async function recordFallback(db: SqlRunner, record: FallbackRecord): Promise<void> {
  await db.query(
    `insert into identity_fallbacks (login, state, operation, target, reason, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      record.login,
      record.state,
      record.operation.slice(0, 64),
      record.target.slice(0, 200),
      record.reason.slice(0, 500),
      record.at.toISOString(),
    ],
  );
}

/** 最近 N 条退回留痕（面板「为什么这次是 bot」列表；倒序）。 */
export async function listFallbacks(
  db: SqlRunner,
  limit: number,
): Promise<readonly (FallbackRow & { readonly state: string })[]> {
  const result = await db.query(
    `select id, login, state, operation, target, reason, created_at
       from identity_fallbacks
      order by created_at desc, id desc
      limit $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
  return result.rows as (FallbackRow & { readonly state: string })[];
}

export type { ProviderRow, RoleRow, IdentityRow, FallbackRow };
