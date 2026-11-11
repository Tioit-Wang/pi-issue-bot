/**
 * 提示词版本线的持久化（`prompt_versions` 表 + `repos.settings`）。
 *
 * 依据：`docs/plan-multi-repo.md` §7、`docs/impl-multi-repo.md` §2/§3、
 * `docs/plan-fixed-pipeline.md` §4.4（四类提示词）/ §4.5（版本指针）。
 *
 * ## 四条互不干扰的版本线（`kind`）
 *
 * | kind | 阶段 | 版本指针 | 上限 | `version=0` 的含义 |
 * |---|---|---|---|---|
 * | `project`     | 阶段 2（P1 人格层） | `settings.prompt.current_version`          | 4000 | **不注入**（没有内置正文） |
 * | `format_check`| 阶段 0             | `settings.pipeline.format_prompt_version`  | 8000 | 用内置默认模板 |
 * | `classify`    | 阶段 1             | `settings.pipeline.classify_prompt_version`| 8000 | 用内置默认模板 |
 * | `agent`       | 阶段 2（系统段）    | `settings.pipeline.agent_prompt_version`   | 4000 | 用内置默认模板 |
 *
 * 所以本文件的每条语句都必须带 `kind`：取号、读、写、指针全在**同一个 `(repo, kind)` 内**。
 * 少一个 `kind` 条件，阶段提示词就会串到 P1 上（版本号互相挤占、面板读到别人的正文）。
 *
 * ## 三条不可逆的设计选择（P1 时代定下，现在对四条线同样成立）
 *
 *  1. **正文只进 `prompt_versions`，不进 `settings`**：`settings` 是配置（谁启用哪个版本），
 *     长文本塞进 jsonb 会让 `PUT /settings` 的每次写都把正文重刷一遍，也没法做 diff/回滚。
 *  2. **保存即新建版本，历史行永不改写**：`savePrompt()` 只 INSERT，`rollbackPrompt()` 也是
 *     «新建一个指向旧内容的新版本»。所以「回到 v2」在库里留得下痕迹 ——
 *     改指针而不是改正文，是这一层唯一能审计的原因。
 *  3. **版本号由库算**（`INSERT … SELECT COALESCE(MAX(version),0)+1 … RETURNING version`），
 *     不在应用层 `MAX+1`：面板是并发入口（多标签页 / 两个人同时改），
 *     唯一索引 `(repo, kind, version)` 是最后一道防线，撞了就重试一次（`PROMPT_VERSION_RETRIES`）。
 *
 * ## 保存期校验（`docs/plan-fixed-pipeline.md` §16.3 末尾）
 *
 * 三个做插值的 kind（`format_check` / `classify` / `agent`）：
 *  - 未识别占位符 → 拒写并**列出名字**（静默吞掉拼错的占位符 = 让人以为它生效了）；
 *  - `format_check` 缺 `{{title}}` / `{{body}}` → 拒写（少一个占位符，判定对象就永远不进上下文）；
 *  - 超过 `PIPELINE_PROMPT_LIMITS[kind]` → 拒写。
 *
 * `project` 沿用现状：不插值、不校验未知占位符，闸门是 12k 预算预演（`prompt/budget.ts`）。
 * 阶段 kind **不做** 12k 预演（它们有自己的 8000/4000 上限），但预演结果照样返回给面板：
 * `agent` 的长度会直接扣掉 P1 的额度（R6 / V18），面板要能看见这件事。
 *
 * ## 最近一次装配统计放在哪
 *
 * 放在 `runtime_flags`（`key = 'assemble:prompt:stats'`, `repo = <repo>`，`value` 是 JSON 文本）。
 * 为什么借这张表而不是新建一张：它是项目里既有的「按仓库存的 key/value 小口袋」
 * （熔断、暂停、reactions_disabled 都在里面），而本包**不允许新增迁移**。
 * `until` 固定 NULL = 不过期；每次装配覆盖一行，不留历史。
 */

import { parseRepoSettings } from '../../../../packages/contract/src/index.ts';
import type { PromptKind, RepoSettings } from '../../../../packages/contract/src/index.ts';
import { readRepoPolicy, updateRepoSettings } from '../config/repo-config.ts';
import type { SqlRunner } from '../config/repo-config.ts';
import type { AssemblePromptStats } from '../skills/assemble.ts';
import { validateStagePrompt } from '../skills/prompt.ts';
import { isStageKind, pipelinePromptLimit, stagePromptDefault } from '../skills/stage-prompts.ts';
import { planPromptBudget } from './budget.ts';
import type { PromptBudget } from './budget.ts';

/** P1 正文的硬上限（远超预算，只用来挡「粘贴了一整本书」这种输入，真正的闸门是预算预演）。 */
export const PROMPT_BODY_MAX_CHARS = 20_000;

/** 版本号撞车时的重试次数（唯一索引 `(repo, kind, version)` 是最后一道防线）。 */
export const PROMPT_VERSION_RETRIES = 3;

/** 「最近一次装配统计」在 `runtime_flags` 里的 key（仓库级行，`repo` 非空）。 */
export const PROMPT_STATS_FLAG_KEY = 'assemble:prompt:stats';

/** 缺省 kind：老调用点（只关心 P1 的那些）等价于 `project`。 */
export const PROMPT_KIND_DEFAULT: PromptKind = 'project';

/**
 * kind → 版本指针在 `repos.settings` 里的位置。
 *
 * `project` 沿用 `settings.prompt.current_version`（`repo-config.ts` 的 `promptConfigSchema`），
 * 另外三条在 `settings.pipeline.{format,classify,agent}_prompt_version`（§4.5）。
 * 四条线各自独立：改一条不影响其它三条。
 */
export const PROMPT_KIND_POINTERS = {
  project: 'prompt.current_version',
  format_check: 'pipeline.format_prompt_version',
  classify: 'pipeline.classify_prompt_version',
  agent: 'pipeline.agent_prompt_version',
} as const;

/** `prompt_versions` 的一行（回滚与面板版本列表都用它）。 */
export interface PromptVersion {
  /** 这一行属于哪条版本线（四条线各自从 1 开始编号）。 */
  readonly kind: PromptKind;
  readonly version: number;
  readonly body: string;
  readonly note: string | null;
  readonly createdAt: string;
}

/** `GET /api/repos/:owner/:name/prompt?kind=…` 里「当前是什么」那部分。 */
export interface PromptState {
  /** 哪条版本线。 */
  readonly kind: PromptKind;
  /** 该 kind 的版本指针；`0` = 没有项目版本。 */
  readonly version: number;
  /**
   * 当前版本的正文；没有版本（或行已不在）时：
   *  - `project` → 空串（= 不注入）；
   *  - 阶段 kind → **内置默认模板**（`stagePromptDefault(kind)`，整体覆盖语义见 Q1）。
   */
  readonly body: string;
  /**
   * `project`: `settings.prompt.enabled`（关掉 = 装配结果与「没有 P1」逐字节一致）。
   * 阶段 kind 恒为 `true`：它们没有「关掉」这个概念（E1 全量切换），`version=0` 就是内置默认。
   */
  readonly enabled: boolean;
  /** 指针指向的行是否存在。行不在 = 配置能读、内容读不到，面板要能看见这件事。 */
  readonly present: boolean;
}

/** `savePrompt` / `rollbackPrompt` 的结果。只有 `ok:true` 才写了库。 */
export type SavePromptResult =
  | {
      readonly ok: true;
      readonly kind: PromptKind;
      readonly version: number;
      readonly prompt: PromptState;
      readonly budget: PromptBudget;
    }
  | {
      readonly ok: false;
      readonly kind: PromptKind;
      readonly code:
        | 'repo-not-found'
        | 'settings-invalid'
        | 'empty-body'
        | 'body-too-long'
        | 'version-not-found'
        | 'placeholder-unknown'
        | 'placeholder-missing';
      readonly message: string;
      /** 超预算时给出：`{available, requested}` 是面板要说人话的两个数字。 */
      readonly budget?: { readonly available: number; readonly requested: number };
      /** 未识别的占位符名字（400 时原样列给用户）。 */
      readonly unknownPlaceholders?: readonly string[];
      /** 该 kind 必须出现但缺失的占位符名字。 */
      readonly missingPlaceholders?: readonly string[];
    };

/** 写语句集中在这里（路由与单测都按 key 引用，不在各处抄 SQL）。 */
export const PROMPT_SQL = {
  /** $1 = repo, $2 = kind, $3 = version */
  selectVersion: `SELECT "repo", "kind", "version", "body", "note", "created_at" FROM "prompt_versions" WHERE "repo" = $1 AND "kind" = $2 AND "version" = $3`,
  /** $1 = repo, $2 = kind；版本倒序（面板默认看最新的） */
  selectVersions: `SELECT "repo", "kind", "version", "body", "note", "created_at" FROM "prompt_versions" WHERE "repo" = $1 AND "kind" = $2 ORDER BY "version" DESC`,
  /**
   * 新建版本：版本号在 SQL 里算，应用层不做 `MAX+1` 往返。
   * `MAX` 只在该 `(repo, kind)` 内取 —— 相差一个 `AND "kind" = $2` 就是四条线互相挤占。
   * $1 = repo, $2 = kind, $3 = body, $4 = note（可空）
   */
  insertNext: `INSERT INTO "prompt_versions" ("repo", "kind", "version", "body", "note")
SELECT $1, $2, COALESCE(MAX("version"), 0) + 1, $3, $4 FROM "prompt_versions" WHERE "repo" = $1 AND "kind" = $2
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

const asKind = (value: unknown): PromptKind =>
  value === 'project' || value === 'format_check' || value === 'classify' || value === 'agent'
    ? value
    : PROMPT_KIND_DEFAULT;

/** 唯一索引冲突（`prompt_versions_repo_kind_version_uq`）。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

function toPromptVersion(row: Row): PromptVersion {
  return {
    kind: asKind(row['kind']),
    version: asVersion(row['version']),
    body: asString(row['body']),
    note: typeof row['note'] === 'string' ? row['note'] : null,
    createdAt: asIso(row['created_at']),
  };
}

/** 该 kind 在 `settings` 里的版本指针（缺行 / 坏值一律 0）。 */
function pointerOf(settings: RepoSettings, kind: PromptKind): number {
  switch (kind) {
    case 'format_check':
      return settings.pipeline.format_prompt_version;
    case 'classify':
      return settings.pipeline.classify_prompt_version;
    case 'agent':
      return settings.pipeline.agent_prompt_version;
    default:
      return settings.prompt.current_version;
  }
}

/** 只换该 kind 的指针，其余 settings 一个字不动。 */
function withPointer(settings: RepoSettings, kind: PromptKind, version: number): RepoSettings {
  switch (kind) {
    case 'format_check':
      return { ...settings, pipeline: { ...settings.pipeline, format_prompt_version: version } };
    case 'classify':
      return { ...settings, pipeline: { ...settings.pipeline, classify_prompt_version: version } };
    case 'agent':
      return { ...settings, pipeline: { ...settings.pipeline, agent_prompt_version: version } };
    default:
      return { ...settings, prompt: { ...settings.prompt, current_version: version } };
  }
}

/* ── 读 ───────────────────────────────────────────────────────────────────── */

/**
 * 当前启用的正文（版本号 + 正文 + 开关）。仓库不存在时返回「没有版本」而不是抛错。
 *
 * 阶段 kind 的 `version = 0` 落在**内置默认模板**上（`stagePromptDefault`），
 * 于是调用方不必自己判断「是默认还是项目版」（Q1：整体覆盖，不拼接）。
 */
export async function getPrompt(
  db: SqlRunner,
  repo: string,
  kind: PromptKind = PROMPT_KIND_DEFAULT,
): Promise<PromptState> {
  const policy = await readRepoPolicy(db, repo);
  const settings = policy.settings;
  const enabled = kind === 'project' ? (settings?.prompt.enabled ?? true) : true;
  if (settings === null) {
    return { kind, version: 0, body: stagePromptDefault(kind), enabled, present: false };
  }
  const version = pointerOf(settings, kind);
  if (version === 0) {
    return { kind, version: 0, body: stagePromptDefault(kind), enabled, present: false };
  }
  const row = await versionRow(db, { repo, kind, version });
  return {
    kind,
    version,
    body: row?.body ?? stagePromptDefault(kind),
    enabled,
    present: row !== null,
  };
}

/** 该 `(repo, kind)` 的全部版本（新→旧）。正文一并给出：面板要能「看一版再回滚」。 */
export async function listPromptVersions(
  db: SqlRunner,
  repo: string,
  kind: PromptKind = PROMPT_KIND_DEFAULT,
): Promise<PromptVersion[]> {
  const result = await db.query(PROMPT_SQL.selectVersions, [repo, kind]);
  return (result.rows as Row[]).map(toPromptVersion);
}

async function versionRow(
  db: SqlRunner,
  ref: { readonly repo: string; readonly kind: PromptKind; readonly version: number },
): Promise<PromptVersion | null> {
  const result = await db.query(PROMPT_SQL.selectVersion, [ref.repo, ref.kind, ref.version]);
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

/** 新建一个版本（版本号在该 `(repo, kind)` 内由库算）。返回新版本号。 */
async function insertVersion(
  db: SqlRunner,
  ref: { readonly repo: string; readonly kind: PromptKind; readonly body: string; readonly note: string | null },
): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < PROMPT_VERSION_RETRIES; attempt += 1) {
    try {
      const result = await db.query(PROMPT_SQL.insertNext, [ref.repo, ref.kind, ref.body, ref.note]);
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

/** 把该 kind 的指针指向 `version`，其余 settings 一个字不动。 */
async function pointCurrentVersion(
  db: SqlRunner,
  repo: string,
  settings: RepoSettings,
  kind: PromptKind,
  version: number,
): Promise<{ readonly ok: boolean; readonly settings: RepoSettings | null }> {
  const updated = await updateRepoSettings(db, repo, withPointer(settings, kind, version));
  return updated.ok ? { ok: true, settings: updated.settings } : { ok: false, settings: null };
}

/** 预算预演的入参：`agent` 的长度会直接扣掉 P1 的额度（R6 / V18）。 */
function budgetOf(input: {
  readonly body: string;
  readonly kind: PromptKind;
  readonly lastStats: (AssemblePromptStats & { readonly at: string | null }) | null;
}): PromptBudget {
  return planPromptBudget({
    body: input.body,
    lastStats: input.lastStats,
    // 阶段提示词落在 `basePrompt` 里（`assemble.ts` 把它记进 `stats.baseChars`），
    // 所以这里用同一个口径预演：长度直接扣 P1。
    stageBaseChars: isStageKind(input.kind) ? input.body.length : 0,
  });
}

/**
 * 保存一条新版本（四条线各自独立）。
 *
 * 顺序是刻意的：**先校验、再预演预算、最后写库**。存不下就一行都不写（连版本都不建），
 * 这样「面板说不行」和「库里有什么」永远不会互相矛盾。
 */
export async function savePrompt(
  db: SqlRunner,
  repo: string,
  body: string,
  note?: string | null,
  kind: PromptKind = PROMPT_KIND_DEFAULT,
): Promise<SavePromptResult> {
  const trimmed = body.trim();
  if (trimmed === '') {
    return {
      ok: false,
      kind,
      code: 'empty-body',
      message: isStageKind(kind)
        ? `${kind} 正文不能为空（要恢复内置默认，请把版本指针回 0）`
        : 'P1 正文不能为空（要清空这一层，请把 prompt.enabled 关掉）',
    };
  }
  if (trimmed.length > PROMPT_BODY_MAX_CHARS) {
    return {
      ok: false,
      kind,
      code: 'body-too-long',
      message: `${kind} 正文 ${String(trimmed.length)} 字符，超过硬上限 ${String(PROMPT_BODY_MAX_CHARS)}`,
    };
  }

  // 三个做插值的 kind 走 §16.3 的校验（未知占位符 / format_check 缺 title·body / 超上限）。
  const issues = validateStagePrompt({ kind, body: trimmed });
  if (issues.unknown.length > 0) {
    return {
      ok: false,
      kind,
      code: 'placeholder-unknown',
      message: `${kind} 正文里有未识别的占位符：${issues.unknown.map((name) => `{{${name}}}`).join('、')}（可用：{{title}} {{body}} {{repo}} {{target}} {{labels}} {{author}} {{url}} {{recheck}}）`,
      unknownPlaceholders: issues.unknown,
    };
  }
  if (issues.missing.length > 0) {
    return {
      ok: false,
      kind,
      code: 'placeholder-missing',
      message: `${kind} 正文缺少必需的占位符：${issues.missing.map((name) => `{{${name}}}`).join('、')}`,
      missingPlaceholders: issues.missing,
    };
  }
  if (issues.tooLong) {
    return {
      ok: false,
      kind,
      code: 'body-too-long',
      message: `${kind} 正文 ${String(issues.chars)} 字符，超过上限 ${String(issues.limit)}`,
    };
  }

  const policy = await readRepoPolicy(db, repo);
  if (!policy.known) {
    return { ok: false, kind, code: 'repo-not-found', message: `仓库不存在：${repo}（先用 POST /api/repos 添加）` };
  }
  // settings 读不出来时不写：写一份默认值上去会把 last-known-good 冲掉（`config/repo-config.ts` 的约定）。
  const settings = policy.settings;
  if (!policy.settingsValid || settings === null) {
    return {
      ok: false,
      kind,
      code: 'settings-invalid',
      message: `仓库 ${repo} 的 settings 当前不可用，先修好配置再改提示词：${policy.settingsError ?? '（无原因）'}`,
    };
  }

  const budget = budgetOf({ body: trimmed, kind, lastStats: await readLastAssembleStats(db, repo) });
  // 只有 P1 被预算硬闸门拦（阶段 kind 的上限已在上面的 `issues.tooLong` 里判过）。
  if (kind === 'project' && !budget.ok) {
    return {
      ok: false,
      kind,
      code: 'body-too-long',
      message: `这条 P1 需要 ${String(budget.requested)} 字符，但预算只剩 ${String(budget.available)}（总预算 ${String(budget.budgetChars)}）`,
      budget: { available: budget.available, requested: budget.requested },
    };
  }

  const version = await insertVersion(db, { repo, kind, body: trimmed, note: note ?? null });
  const pointed = await pointCurrentVersion(db, repo, settings, kind, version);
  if (!pointed.ok) {
    // 版本行已经写了（历史不可改写），但指针没动：如实报错，让人再存一次。
    return {
      ok: false,
      kind,
      code: 'settings-invalid',
      message: `版本 v${String(version)} 已写入，但 ${PROMPT_KIND_POINTERS[kind]} 没更新成功`,
    };
  }
  return {
    ok: true,
    kind,
    version,
    prompt: {
      kind,
      version,
      body: trimmed,
      enabled: kind === 'project' ? (pointed.settings?.prompt.enabled ?? settings.prompt.enabled) : true,
      present: true,
    },
    budget,
  };
}

/**
 * 回滚到某个旧版本 = **新建一个内容与之相同的新版本**，再让指针指过去。
 *
 * 为什么不直接把指针拨回旧号：那样「当前用的是哪一版」与「历史长什么样」会纠缠在一起，
 * 而且旧版本可能正是当时因为超预算 / 内容有问题才被换掉的。新建版本让每次启用都有独立的时间戳。
 * 预算预演照样跑一遍：存不下的回滚没有意义（下一轮就会被整段丢弃）。
 */
export async function rollbackPrompt(
  db: SqlRunner,
  repo: string,
  version: number,
  kind: PromptKind = PROMPT_KIND_DEFAULT,
): Promise<SavePromptResult> {
  const policy = await readRepoPolicy(db, repo);
  if (!policy.known) {
    return { ok: false, kind, code: 'repo-not-found', message: `仓库不存在：${repo}` };
  }
  const settings = policy.settings;
  if (!policy.settingsValid || settings === null) {
    return {
      ok: false,
      kind,
      code: 'settings-invalid',
      message: `仓库 ${repo} 的 settings 当前不可用，先修好配置再回滚：${policy.settingsError ?? '（无原因）'}`,
    };
  }

  const target = await versionRow(db, { repo, kind, version });
  if (target === null) {
    return { ok: false, kind, code: 'version-not-found', message: `没有这一版：${repo} ${kind} v${String(version)}` };
  }

  const budget = budgetOf({ body: target.body, kind, lastStats: await readLastAssembleStats(db, repo) });
  if (kind === 'project' && !budget.ok) {
    return {
      ok: false,
      kind,
      code: 'body-too-long',
      message: `v${String(version)} 的正文需要 ${String(budget.requested)} 字符，但预算只剩 ${String(budget.available)}`,
      budget: { available: budget.available, requested: budget.requested },
    };
  }

  const created = await insertVersion(db, { repo, kind, body: target.body, note: `回滚到 v${String(version)}` });
  const pointed = await pointCurrentVersion(db, repo, settings, kind, created);
  if (!pointed.ok) {
    return {
      ok: false,
      kind,
      code: 'settings-invalid',
      message: `版本 v${String(created)} 已写入，但 ${PROMPT_KIND_POINTERS[kind]} 没更新成功`,
    };
  }
  return {
    ok: true,
    kind,
    version: created,
    prompt: {
      kind,
      version: created,
      body: target.body,
      enabled: kind === 'project' ? (pointed.settings?.prompt.enabled ?? settings.prompt.enabled) : true,
      present: true,
    },
    budget,
  };
}

/**
 * 「恢复默认」= 把指针拨回 0，**不删历史版本**（§4.4 / V15）。
 *
 * 对 `project` 来说「默认」就是「这一层不注入」；对阶段 kind 来说是内置模板。
 * 历史行原样保留：恢复默认之后仍然可以回滚回某个项目版本。
 */
export async function resetPromptToDefault(
  db: SqlRunner,
  repo: string,
  kind: PromptKind = PROMPT_KIND_DEFAULT,
): Promise<{ readonly ok: true; readonly prompt: PromptState } | { readonly ok: false; readonly message: string }> {
  const policy = await readRepoPolicy(db, repo);
  if (!policy.settingsValid || policy.settings === null) {
    return { ok: false, message: `仓库 ${repo} 的 settings 当前不可用（或不存在）` };
  }
  const updated = await updateRepoSettings(db, repo, withPointer(policy.settings, kind, 0));
  if (!updated.ok) {
    return { ok: false, message: updated.error };
  }
  return { ok: true, prompt: await getPrompt(db, repo, kind) };
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
  const prompt = await getPrompt(db, repo, 'project');
  return { ok: true, prompt };
}

/**
 * 装配用的正文（运行期每轮任务都会调它）：
 *  - `project`：**开关关掉 / 没有当前版本 / 行不存在** 一律返回空串，
 *    于是 `assemblePrompt({ projectPrompt: '' })` 的输出与「没有 P1」逐字节相同；
 *  - 阶段 kind：项目版本正文，`version = 0`（或行不在）时返回**内置默认模板**（Q1：整体覆盖，不拼接）。
 *
 * 它只读一次库、不解析 settings 的其它段。
 */
export async function activePromptBody(
  db: SqlRunner,
  repo: string,
  kind: PromptKind = PROMPT_KIND_DEFAULT,
): Promise<string> {
  const state = await getPrompt(db, repo, kind);
  if (kind === 'project') {
    return state.enabled ? state.body : '';
  }
  return state.body;
}

/**
 * 运行期便捷入口：`kind` → 是否用内置默认（面板据此显示「当前为系统默认」）。
 * 纯函数，不读库。
 */
export function isSystemDefault(state: Pick<PromptState, 'kind' | 'version' | 'present'>): boolean {
  return isStageKind(state.kind) && (state.version === 0 || !state.present);
}

/** 该 kind 的保存期上限（面板展示与校验共用一个数字）。 */
export function promptLimitOf(kind: PromptKind): number {
  return pipelinePromptLimit(kind);
}

/** 把 settings 里 `prompt` 段补齐成合法形状（面板写 settings 时用；纯函数，便于单测）。 */
export function withPromptSettings(settings: unknown, patch: { enabled?: boolean; current_version?: number }): RepoSettings {
  return parseRepoSettings({
    ...(settings !== null && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}),
    prompt: patch,
  });
}
