/**
 * P1「项目人格层」的持久化（`prompt_versions` 表 + `repos.settings.prompt`）。
 *
 * 依据：`docs/plan-multi-repo.md` §7、`docs/impl-multi-repo.md` §2/§3。
 *
 * ## 三条不可逆的设计选择
 *
 *  1. **正文只进 `prompt_versions`，不进 `settings`**：`settings` 是配置（谁启用哪个版本），
 *     长文本塞进 jsonb 会让 `PUT /settings` 的每次写都把正文重刷一遍，也没法做 diff/回滚。
 *  2. **保存即新建版本，历史行永不改写**：`savePrompt()` 只 INSERT，`rollbackPrompt()` 也是
 *     «新建一个指向旧内容的新版本»。所以「回到 v2」在库里留得下痕迹——
 *     改 `current_version` 而不是改正文，是这一层唯一能审计的原因。
 *  3. **版本号由库算**（`INSERT … SELECT COALESCE(MAX(version),0)+1 … RETURNING version`），
 *     不在应用层 `MAX+1`：面板是并发入口（多标签页 / 两个人同时改），
 *     唯一索引 `(repo, version)` 是最后一道防线，撞了就重试一次（`PROMPT_VERSION_RETRIES`）。
 *
 * ## 保存期预算
 *
 * `savePrompt()` 在写库**之前**跑 `planPromptBudget()`（`prompt/budget.ts`）：
 * 存不下就返回 `{ok:false, budget:{available, requested}}`，一行都不写。
 * 运行期的整段丢弃兜底仍然在（`skills/assemble.ts`），两者不是替代关系。
 *
 * ## 最近一次装配统计放在哪
 *
 * 放在 `runtime_flags`（`key = 'assemble:prompt:stats'`, `repo = <repo>`，`value` 是 JSON 文本）。
 * 为什么借这张表而不是新建一张：它是项目里既有的「按仓库存的 key/value 小口袋」
 * （熔断、暂停、reactions_disabled 都在里面），而本包**不允许新增迁移**（`migrations/**` 不在
 * W3-G 的文件范围内）。`until` 固定 NULL = 不过期；每次装配覆盖一行，不留历史。
 *
 * 写它的是运行期（`recordAssembleStats()`，见 `docs/impl-multi-repo.md` W3-G 汇报里的接口形状）。
 * 没人调用时读侧返回 `null`，预算退回保守估算——功能不会因此不可用。
 */

import { parseRepoSettings } from '../../../../packages/contract/src/index.ts';
import type { RepoSettings } from '../../../../packages/contract/src/index.ts';
import { readRepoPolicy, updateRepoSettings } from '../config/repo-config.ts';
import type { SqlRunner } from '../config/repo-config.ts';
import type { AssemblePromptStats } from '../skills/assemble.ts';
import { planPromptBudget } from './budget.ts';
import type { PromptBudget } from './budget.ts';

/** P1 正文的硬上限（远超预算，只用来挡「粘贴了一整本书」这种输入，真正的闸门是预算预演）。 */
export const PROMPT_BODY_MAX_CHARS = 20_000;

/** 版本号撞车时的重试次数（唯一索引 `(repo, version)` 是最后一道防线）。 */
export const PROMPT_VERSION_RETRIES = 3;

/** 「最近一次装配统计」在 `runtime_flags` 里的 key（仓库级行，`repo` 非空）。 */
export const PROMPT_STATS_FLAG_KEY = 'assemble:prompt:stats';

/** `prompt_versions` 的一行（回滚与面板版本列表都用它）。 */
export interface PromptVersion {
  readonly version: number;
  readonly body: string;
  readonly note: string | null;
  readonly createdAt: string;
}

/** `GET /api/repos/:owner/:name/prompt` 里「当前是什么」那部分。 */
export interface PromptState {
  /** `settings.prompt.current_version`；`0` = 还没有任何版本。 */
  readonly version: number;
  /** 当前版本的正文；没有版本（或行已不在）时是空串。 */
  readonly body: string;
  /** `settings.prompt.enabled`：关掉 = 装配结果与「没有 P1」逐字节一致。 */
  readonly enabled: boolean;
  /** `current_version` 指向的行是否存在。行不在 = 配置能读、内容读不到，面板要能看见这件事。 */
  readonly present: boolean;
}

/** `savePrompt` / `rollbackPrompt` 的结果。只有 `ok:true` 才写了库。 */
export type SavePromptResult =
  | {
      readonly ok: true;
      readonly version: number;
      readonly prompt: PromptState;
      readonly budget: PromptBudget;
    }
  | {
      readonly ok: false;
      readonly code: 'repo-not-found' | 'settings-invalid' | 'empty-body' | 'body-too-long' | 'version-not-found';
      readonly message: string;
      /** 超预算时给出：`{available, requested}` 是面板要说人话的两个数字。 */
      readonly budget?: { readonly available: number; readonly requested: number };
    };

/** 写语句集中在这里（路由与单测都按 key 引用，不在各处抄 SQL）。 */
export const PROMPT_SQL = {
  /** $1 = repo, $2 = version */
  selectVersion: `SELECT "version", "body", "note", "created_at" FROM "prompt_versions" WHERE "repo" = $1 AND "version" = $2`,
  /** $1 = repo；版本倒序（面板默认看最新的） */
  selectVersions: `SELECT "version", "body", "note", "created_at" FROM "prompt_versions" WHERE "repo" = $1 ORDER BY "version" DESC`,
  /**
   * 新建版本：版本号在 SQL 里算，应用层不做 `MAX+1` 往返。
   * $1 = repo, $2 = body, $3 = note（可空）
   */
  insertNext: `INSERT INTO "prompt_versions" ("repo", "version", "body", "note")
SELECT $1, COALESCE(MAX("version"), 0) + 1, $2, $3 FROM "prompt_versions" WHERE "repo" = $1
RETURNING "version"`,
  /** $1 = key, $2 = repo */
  readStats: `SELECT "value" FROM "runtime_flags" WHERE "key" = $1 AND "repo" = $2`,
  /** $1 = key, $2 = repo, $3 = value（仓库级 UPSERT：`runtime_flags` 的唯一性拆成了两条 partial 索引） */
  upsertStats: `INSERT INTO "runtime_flags" ("key", "repo", "value", "until", "updated_at")
VALUES ($1, $2, $3, NULL, now())
ON CONFLICT ("key", "repo") WHERE "repo" IS NOT NULL DO UPDATE
SET "value" = EXCLUDED."value", "until" = NULL, "updated_at" = now()`,
} as const;

/* ── 小工具 ───────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

const asIso = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : '';
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const asVersion = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number(value ?? 0);

/** 唯一索引冲突（`prompt_versions_repo_version_uidx`）。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

function toPromptVersion(row: Row): PromptVersion {
  return {
    version: asVersion(row['version']),
    body: asString(row['body']),
    note: typeof row['note'] === 'string' ? row['note'] : null,
    createdAt: asIso(row['created_at']),
  };
}

/* ── 读 ───────────────────────────────────────────────────────────────────── */

/** 当前启用的 P1（版本号 + 正文 + 开关）。仓库不存在时返回「没有版本」而不是抛错。 */
export async function getPrompt(db: SqlRunner, repo: string): Promise<PromptState> {
  const policy = await readRepoPolicy(db, repo);
  const config = policy.settings?.prompt ?? null;
  if (config === null || config.current_version === 0) {
    return { version: config?.current_version ?? 0, body: '', enabled: config?.enabled ?? true, present: false };
  }
  const row = await versionRow(db, repo, config.current_version);
  return {
    version: config.current_version,
    body: row?.body ?? '',
    enabled: config.enabled,
    present: row !== null,
  };
}

/** 该仓库的全部版本（新→旧）。正文一并给出：面板要能「看一版再回滚」。 */
export async function listPromptVersions(db: SqlRunner, repo: string): Promise<PromptVersion[]> {
  const result = await db.query(PROMPT_SQL.selectVersions, [repo]);
  return (result.rows as Row[]).map(toPromptVersion);
}

async function versionRow(db: SqlRunner, repo: string, version: number): Promise<PromptVersion | null> {
  const result = await db.query(PROMPT_SQL.selectVersion, [repo, version]);
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : toPromptVersion(row);
}

/** 最近一次真实装配的统计（`recordAssembleStats()` 写的），没有则 `null`。 */
export async function readLastAssembleStats(
  db: SqlRunner,
  repo: string,
): Promise<(AssemblePromptStats & { readonly at: string | null }) | null> {
  const result = await db.query(PROMPT_SQL.readStats, [PROMPT_STATS_FLAG_KEY, repo]);
  const row = (result.rows as Row[])[0];
  const raw = row === undefined ? '' : asString(row['value']);
  if (raw === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 坏数据不抛：预算退回保守估算，装配本身不受影响（这里是「读不到就少一条信息」的路径）。
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const num = (key: string): number => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const truncated = Array.isArray(record['truncated'])
    ? record['truncated'].filter((item): item is string => typeof item === 'string')
    : [];
  return {
    baseChars: num('baseChars'),
    promptChars: num('promptChars'),
    agentsChars: num('agentsChars'),
    skillChars: num('skillChars'),
    totalChars: num('totalChars'),
    truncated,
    at: typeof record['at'] === 'string' ? record['at'] : null,
  };
}

/* ── 写 ───────────────────────────────────────────────────────────────────── */

/**
 * 记一次装配统计（运行期每轮装配后调一次；**不抛错**是调用方的责任，这里只写库）。
 *
 * 它是保存期预算预演的输入：没有它，预算只能按保守估算（P1 只拿 2400）算，
 * 而这个仓库其实可能空得很（P1 能拿满 4000）。
 */
export async function recordAssembleStats(
  db: SqlRunner,
  repo: string,
  stats: AssemblePromptStats,
  options: { readonly now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const value = JSON.stringify({
    at: now.toISOString(),
    ...stats,
  });
  await db.query(PROMPT_SQL.upsertStats, [PROMPT_STATS_FLAG_KEY, repo, value]);
}

/** 新建一个版本并把 `settings.prompt.current_version` 指过去。返回新版本号。 */
async function insertVersion(db: SqlRunner, repo: string, body: string, note: string | null): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < PROMPT_VERSION_RETRIES; attempt += 1) {
    try {
      const result = await db.query(PROMPT_SQL.insertNext, [repo, body, note]);
      const row = (result.rows as Row[])[0];
      const version = row === undefined ? Number.NaN : asVersion(row['version']);
      if (Number.isFinite(version) && version > 0) {
        return version;
      }
      throw new Error('prompt_versions 插入后没有返回版本号');
    } catch (error) {
      lastError = error;
      // 只有「版本号撞车」值得重试（两个标签页同时保存）；其它错误立刻抛。
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 把 `current_version` 指向 `version`，其余 settings 一个字不动。 */
async function pointCurrentVersion(
  db: SqlRunner,
  repo: string,
  settings: RepoSettings,
  version: number,
): Promise<{ readonly ok: boolean; readonly settings: RepoSettings | null }> {
  const next: RepoSettings = {
    ...settings,
    prompt: { ...settings.prompt, current_version: version },
  };
  const updated = await updateRepoSettings(db, repo, next);
  return updated.ok ? { ok: true, settings: updated.settings } : { ok: false, settings: null };
}

/**
 * 保存一条新的 P1 版本。
 *
 * 顺序是刻意的：**先预演预算、再写库**。存不下就一行都不写（连版本都不建），
 * 这样「面板说超了」和「库里有什么」永远不会互相矛盾。
 */
export async function savePrompt(
  db: SqlRunner,
  repo: string,
  body: string,
  note?: string | null,
): Promise<SavePromptResult> {
  const trimmed = body.trim();
  if (trimmed === '') {
    return { ok: false, code: 'empty-body', message: 'P1 正文不能为空（要清空这一层，请把 prompt.enabled 关掉）' };
  }
  if (trimmed.length > PROMPT_BODY_MAX_CHARS) {
    return {
      ok: false,
      code: 'body-too-long',
      message: `P1 正文 ${String(trimmed.length)} 字符，超过硬上限 ${String(PROMPT_BODY_MAX_CHARS)}`,
    };
  }

  const policy = await readRepoPolicy(db, repo);
  if (!policy.known) {
    return { ok: false, code: 'repo-not-found', message: `仓库不存在：${repo}（先用 POST /api/repos 添加）` };
  }
  // settings 读不出来时不写：写一份默认值上去会把 last-known-good 冲掉（`config/repo-config.ts` 的约定）。
  const settings = policy.settings;
  if (!policy.settingsValid || settings === null) {
    return {
      ok: false,
      code: 'settings-invalid',
      message: `仓库 ${repo} 的 settings 当前不可用，先修好配置再改提示词：${policy.settingsError ?? '（无原因）'}`,
    };
  }

  const budget = planPromptBudget({ body: trimmed, lastStats: await readLastAssembleStats(db, repo) });
  if (!budget.ok) {
    return {
      ok: false,
      code: 'body-too-long',
      message: `这条 P1 需要 ${String(budget.requested)} 字符，但预算只剩 ${String(budget.available)}（总预算 ${String(budget.budgetChars)}）`,
      budget: { available: budget.available, requested: budget.requested },
    };
  }

  const version = await insertVersion(db, repo, trimmed, note ?? null);
  const pointed = await pointCurrentVersion(db, repo, settings, version);
  if (!pointed.ok) {
    // 版本行已经写了（历史不可改写），但指针没动：如实报错，让人再存一次。
    return {
      ok: false,
      code: 'settings-invalid',
      message: `版本 v${String(version)} 已写入，但 settings.prompt.current_version 没更新成功`,
    };
  }
  return {
    ok: true,
    version,
    prompt: { version, body: trimmed, enabled: pointed.settings?.prompt.enabled ?? settings.prompt.enabled, present: true },
    budget,
  };
}

/**
 * 回滚到某个旧版本 = **新建一个内容与之相同的新版本**，再让 `current_version` 指过去。
 *
 * 为什么不直接把 `current_version` 拨回旧号：那样「当前用的是哪一版」与「历史长什么样」会纠缠在一起，
 * 而且旧版本可能正是当时因为超预算 / 内容有问题才被换掉的。新建版本让每次启用都有独立的时间戳。
 * 预算预演照样跑一遍：存不下的回滚没有意义（下一轮就会被整段丢弃）。
 */
export async function rollbackPrompt(db: SqlRunner, repo: string, version: number): Promise<SavePromptResult> {
  const policy = await readRepoPolicy(db, repo);
  if (!policy.known) {
    return { ok: false, code: 'repo-not-found', message: `仓库不存在：${repo}` };
  }
  const settings = policy.settings;
  if (!policy.settingsValid || settings === null) {
    return {
      ok: false,
      code: 'settings-invalid',
      message: `仓库 ${repo} 的 settings 当前不可用，先修好配置再回滚：${policy.settingsError ?? '（无原因）'}`,
    };
  }

  const target = await versionRow(db, repo, version);
  if (target === null) {
    return { ok: false, code: 'version-not-found', message: `没有这一版：${repo} v${String(version)}` };
  }

  const budget = planPromptBudget({ body: target.body, lastStats: await readLastAssembleStats(db, repo) });
  if (!budget.ok) {
    return {
      ok: false,
      code: 'body-too-long',
      message: `v${String(version)} 的正文需要 ${String(budget.requested)} 字符，但预算只剩 ${String(budget.available)}`,
      budget: { available: budget.available, requested: budget.requested },
    };
  }

  const created = await insertVersion(db, repo, target.body, `回滚到 v${String(version)}`);
  const pointed = await pointCurrentVersion(db, repo, settings, created);
  if (!pointed.ok) {
    return {
      ok: false,
      code: 'settings-invalid',
      message: `版本 v${String(created)} 已写入，但 settings.prompt.current_version 没更新成功`,
    };
  }
  return {
    ok: true,
    version: created,
    prompt: {
      version: created,
      body: target.body,
      enabled: pointed.settings?.prompt.enabled ?? settings.prompt.enabled,
      present: true,
    },
    budget,
  };
}

/** 只切开关（不新建版本）。关掉 = 装配结果与「没有 P1」逐字节一致。 */
export async function setPromptEnabled(
  db: SqlRunner,
  repo: string,
  enabled: boolean,
): Promise<{ readonly ok: true; readonly prompt: PromptState } | { readonly ok: false; readonly message: string }> {
  const policy = await readRepoPolicy(db, repo);
  if (!policy.settingsValid || policy.settings === null) {
    return { ok: false, message: `仓库 ${repo} 的 settings 当前不可用（或不存在）` };
  }
  const next: RepoSettings = { ...policy.settings, prompt: { ...policy.settings.prompt, enabled } };
  const updated = await updateRepoSettings(db, repo, next);
  if (!updated.ok) {
    return { ok: false, message: updated.error };
  }
  const prompt = await getPrompt(db, repo);
  return { ok: true, prompt };
}

/**
 * 装配用的 P1 正文：**开关关掉 / 没有当前版本 / 行不存在** 一律返回空串，
 * 于是 `assemblePrompt({ projectPrompt: '' })` 的输出与「没有 P1」逐字节一致。
 *
 * 它只读一次库、不解析 settings 的其它段：运行期每轮任务都会调它。
 */
export async function activePromptBody(db: SqlRunner, repo: string): Promise<string> {
  const state = await getPrompt(db, repo);
  return state.enabled ? state.body : '';
}

/** 把 settings 里 `prompt` 段补齐成合法形状（面板写 settings 时用；纯函数，便于单测）。 */
export function withPromptSettings(settings: unknown, patch: { enabled?: boolean; current_version?: number }): RepoSettings {
  return parseRepoSettings({
    ...(settings !== null && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}),
    prompt: patch,
  });
}
