/**
 * 仓库行（`repos`）的读写 —— 多仓库改造后**配置的唯一载体**（`docs/impl-multi-repo.md` §2/§4）。
 *
 * 与旧的 `repo-config.ts`（`.github/pi-bot.yml` 拉取 → 校验 → 落库 + 通知）相比，这里：
 *  - **不读仓库里的配置文件**（yaml 整体退役，§0.2），配置只从 `repos.settings`（jsonb）来；
 *  - **不拉取、不通知**：所有写发生在面板（`PUT /api/repos/:owner/:name/settings`）；
 *  - 仍保留「非法配置 = 该仓库不可用」的语义：`settings_valid=false` + `settings_error`，
 *    读侧返回 `settings: null`（`known: true`），webhook 据此忽略该仓库的投递。
 *
 * 三条硬规则：
 *  - **写库前必校验**：`updateRepoSettings()` 校验不通过就一个字都不写，库里始终留着最后一次合法值
 *    （last-known-good），所以一次手滑不会把线上机器人弄哑。
 *  - **默认值只有一处**：`repoSettingsSchema.parse({})`（契约包），`PI_BOT_DEFAULT_SETTINGS` 只是
 *    「在默认值上覆写」的部署入口；建行（`upsertRepo`）时 seed 一次，之后只认库里的值。
 *  - **归档不可用**：`archived_at` 非空一律按 `enabled=false` 返回（不删行，保留审计与成本历史）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_REPO_SETTINGS, repoSettingsSchema } from '../../../../packages/contract/src/index.ts';
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';

/** 只要 `query` 就行——真实实现是 `pg.Pool`，测试实现是几行假函数。 */
export type SqlRunner = {
  query: (text: string, values?: readonly unknown[]) => Promise<{
    readonly rows: unknown[];
    readonly rowCount?: number | null;
  }>;
};

/* ── 1. 部署默认 settings ──────────────────────────────────────────────────── */

/**
 * 部署默认配置的 env 名：**文件路径或内联 JSON**。
 *
 * - 空 / 未设置 → 契约默认值（`repoSettingsSchema.parse({})`）；
 * - 以 `{` 开头 → 当内联 JSON 解析；
 * - 其它 → 当文件路径（相对路径按进程 cwd 解析）读 UTF-8 后按 JSON 解析。
 *
 * 解析失败一律**抛明确错误**（启动即失败，不静默降级成默认值）：部署写错了配置却照常跑，
 * 等于把错误配置的后果推给所有仓库。
 */
export const REPO_SETTINGS_ENV = 'PI_BOT_DEFAULT_SETTINGS';

/** 默认 settings 的读取器（注入点：单测不读真文件）。 */
export type FileReader = (filePath: string) => string;

const readFileUtf8: FileReader = (filePath) => readFileSync(filePath, 'utf8');

/**
 * 解析部署默认配置（`PI_BOT_DEFAULT_SETTINGS`）。
 *
 * @param source env 原文；`undefined` / 空串 = 用契约默认值
 * @param readFile 读文件实现（默认 `fs.readFileSync`，单测注入假实现）
 */
export function loadDefaultRepoSettings(
  source: string | undefined = process.env[REPO_SETTINGS_ENV],
  readFile: FileReader = readFileUtf8,
): RepoConfig {
  const raw = (source ?? '').trim();
  if (raw === '') {
    return DEFAULT_REPO_SETTINGS;
  }

  let text = raw;
  let origin = `${REPO_SETTINGS_ENV}（内联 JSON）`;
  if (!raw.startsWith('{')) {
    const filePath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    origin = `${REPO_SETTINGS_ENV}=${raw}`;
    try {
      text = readFile(filePath);
    } catch (error) {
      throw new Error(
        `读取部署默认仓库配置失败（${origin} → ${filePath}）：${describeError(error)}`,
        { cause: error },
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`部署默认仓库配置不是合法 JSON（${origin}）：${describeError(error)}`, {
      cause: error,
    });
  }

  const validated = validateRepoSettings(parsed);
  if (!validated.ok) {
    throw new Error(`部署默认仓库配置不符合 repoSettingsSchema（${origin}）：${validated.error}`);
  }
  return validated.settings;
}

/** 进程内缓存：第一次用到时解析，失败即抛（调用方：启动路径 / 建行）。 */
let cachedDefault: RepoConfig | null = null;

/** 部署默认 settings（首次使用时从 `PI_BOT_DEFAULT_SETTINGS` 解析，之后走缓存）。 */
export function defaultRepoSettings(): RepoConfig {
  cachedDefault ??= loadDefaultRepoSettings();
  return cachedDefault;
}

/** 清缓存（单测用：换 env 后要让下一次调用重新解析）。 */
export function resetDefaultRepoSettingsCache(): void {
  cachedDefault = null;
}

/* ── 2. 校验 ───────────────────────────────────────────────────────────────── */

export type SettingsValidation =
  | { readonly ok: true; readonly settings: RepoConfig }
  | { readonly ok: false; readonly error: string; readonly issues: readonly string[] };

/** `settings` 的 zod 校验。错误消息控制在 500 字内（`repos.settings_error` 列的可读长度）。 */
export function validateRepoSettings(input: unknown): SettingsValidation {
  const result = repoSettingsSchema.safeParse(input);
  if (result.success) {
    return { ok: true, settings: result.data };
  }
  const issues = result.error.issues.map((issue) => {
    const at = issue.path.map((part) => String(part)).join('.');
    return at === '' ? issue.message : `${at}: ${issue.message}`;
  });
  return {
    ok: false,
    error: `配置不符合 repoSettingsSchema：${issues.join('; ')}`.slice(0, 500),
    issues,
  };
}

/* ── 3. 读 ─────────────────────────────────────────────────────────────────── */

export const REPO_SQL = {
  /** $1 = repo_full_name */
  selectOne: `SELECT "enabled", "dry_run", "archived_at", "settings", "settings_valid", "settings_error", "source", "installation_id", "settings_updated_at", "updated_at"
FROM "repos" WHERE "repo_full_name" = $1`,
  /** 列表：面板的仓库切换器与「所有仓库」视图 */
  selectAll: `SELECT "repo_full_name", "enabled", "dry_run", "archived_at", "settings_valid", "settings_error", "source", "installation_id", "settings_updated_at", "updated_at"
FROM "repos" ORDER BY "repo_full_name"`,
  /**
   * 建行（或补全安装信息）。参数：$1 repo, $2 enabled, $3 dry_run, $4 settings(jsonb), $5 source, $6 installation_id。
   *
   * 冲突时**不覆盖 settings / enabled / dry_run**：重新安装 App 不该把面板里调好的配置冲掉。
   * 只补 `source` / `installation_id`、清掉 `archived_at`（重新安装 = 复活）。
   */
  upsert: `INSERT INTO "repos" ("repo_full_name", "enabled", "dry_run", "settings", "settings_valid", "settings_error", "settings_updated_at", "source", "installation_id", "updated_at")
VALUES ($1, $2, $3, $4::jsonb, true, null, now(), $5, $6, now())
ON CONFLICT ("repo_full_name") DO UPDATE
SET "source" = EXCLUDED."source",
    "installation_id" = COALESCE(EXCLUDED."installation_id", "repos"."installation_id"),
    "archived_at" = null,
    "updated_at" = now()`,
  /**
   * 写 settings。参数：$1 repo, $2 settings(jsonb), $3 enabled, $4 dry_run。
   * `enabled` / `dry_run` 两列与 settings 里的同名开关**同步**（webhook 与队列读列，不解析 jsonb）。
   */
  updateSettings: `UPDATE "repos"
SET "settings" = $2::jsonb,
    "settings_valid" = true,
    "settings_error" = null,
    "settings_updated_at" = now(),
    "enabled" = $3,
    "dry_run" = $4,
    "updated_at" = now()
WHERE "repo_full_name" = $1`,
} as const;

/** 仓库来源：面板手动添加 / GitHub App 安装事件。 */
export type RepoSource = 'manual' | 'installation';

/**
 * 仓库策略（webhook 第 5 步、任务执行前读它）。
 *
 * `settings / settingsValid / settingsError` 是新名字；`config / configValid / configError`
 * 是过渡期别名（同一个值），只为让还没迁移的调用点（`http/webhook.ts`、`app/compose.ts`）继续编译。
 */
export type RepoPolicy = {
  /** `repos` 里有这一行 */
  readonly known: boolean;
  /** 开关：`enabled` 列 && 未归档 */
  readonly enabled: boolean;
  readonly dryRun: boolean;
  /** `settings` 能否解析；false 时 `settings` 为 null（webhook 忽略该仓库） */
  readonly settingsValid: boolean;
  /** 解析成功后的配置；非法 / 列标记为不可用时为 null */
  readonly settings: RepoConfig | null;
  /** 非法原因（面板展示） */
  readonly settingsError: string | null;
  readonly source: RepoSource | null;
  /** GitHub installation id（bigint 以字符串给出，避免精度问题）；`manual` 来源为 null */
  readonly installationId: string | null;
  /** 归档时刻（ISO）；非空 = 不可用 */
  readonly archivedAt: string | null;
  /** @deprecated 用 `settings` */
  readonly config: RepoConfig | null;
  /** @deprecated 用 `settingsValid` */
  readonly configValid: boolean;
  /** @deprecated 用 `settingsError` */
  readonly configError: string | null;
};

/** 没有 `repos` 行时的默认策略：不开工（未知仓库一律忽略）。 */
export const UNKNOWN_REPO_POLICY: RepoPolicy = Object.freeze({
  known: false,
  enabled: false,
  dryRun: true,
  settingsValid: false,
  settings: null,
  settingsError: null,
  source: null,
  installationId: null,
  archivedAt: null,
  config: null,
  configValid: false,
  configError: null,
});

/** 读一个仓库的策略（含 settings 解析与 last-known-good 语义）。 */
export async function readRepoPolicy(db: SqlRunner, repo: string): Promise<RepoPolicy> {
  const result = await selectRepoRow(db, repo);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return UNKNOWN_REPO_POLICY;
  }

  const columnValid = row['settings_valid'] !== false;
  const parsed = parseStoredSettings(row['settings']);
  const settingsValid = columnValid && parsed.ok;

  // 两种「不可用」：列被标成 false（面板/人写坏了），或列说合法但 JSON 解析不出来（手改库）
  let settingsError: string | null = null;
  if (!columnValid) {
    settingsError =
      asString(row['settings_error']) ?? (parsed.ok ? null : parsed.error) ?? '配置不可用（settings_valid=false）';
  } else if (!parsed.ok) {
    settingsError = parsed.error;
  }
  const archivedAt = asIsoString(row['archived_at']);

  const settings = settingsValid ? parsed.settings : null;
  const policy: RepoPolicy = {
    known: true,
    // 归档 = 不可用（不删行）
    enabled: row['enabled'] === true && archivedAt === null,
    dryRun: row['dry_run'] !== false,
    settingsValid,
    settings,
    settingsError,
    source: asSource(row['source']),
    installationId: asIdString(row['installation_id']),
    archivedAt,
    config: settings,
    configValid: settingsValid,
    configError: settingsError,
  };
  return policy;
}

/**
 * 读 `repos` 行，并把「库没迁移」这类数据库错误翻成能照做的提示。
 *
 * 为什么需要这层：`settings` 等列是 0003 才加的。库停在 0002 时 `select` 直接抛
 * `42703 undefined_column`，上层只能显示「配置不可用」，运维看不出真实原因是「没跑迁移」。
 */
async function selectRepoRow(db: SqlRunner, repo: string) {
  try {
    return await db.query(REPO_SQL.selectOne, [repo]);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === '42703' || code === '42P01') {
      throw new Error(
        '数据库结构未迁移：repos 缺少多仓库改造的列/表，请先执行 `pi-bot migrate`（migrations/0003_multi_repo、0004_seed_settings_from_legacy）再启动',
        { cause: error },
      );
    }
    throw error;
  }
}

/** 库里的 jsonb → `RepoConfig`。手改过库、或版本升级后旧结构都是这条路径失败。 */
function parseStoredSettings(
  value: unknown,
): { readonly ok: true; readonly settings: RepoConfig } | { readonly ok: false; readonly error: string } {
  if (value === null || value === undefined) {
    // 列 NOT NULL，理论到不了；真到了就当「用默认值」而不是「配置坏了」
    return { ok: true, settings: DEFAULT_REPO_SETTINGS };
  }
  const validated = validateRepoSettings(value);
  if (validated.ok) {
    return { ok: true, settings: validated.settings };
  }
  return { ok: false, error: validated.error };
}

/** 仓库列表的一行（面板切换器 / 系统页）。 */
export type RepoSummary = {
  readonly repo: string;
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly settingsValid: boolean;
  readonly settingsError: string | null;
  readonly settingsUpdatedAt: string | null;
  readonly source: RepoSource;
  /** bigint 以字符串给出 */
  readonly installationId: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string | null;
};

/** 全部仓库（按 `repo_full_name` 升序；面板自己决定展示顺序）。 */
export async function listRepos(db: SqlRunner): Promise<readonly RepoSummary[]> {
  const result = await db.query(REPO_SQL.selectAll);
  return result.rows.map((item) => {
    const row = item as Record<string, unknown>;
    const archivedAt = asIsoString(row['archived_at']);
    return {
      repo: String(row['repo_full_name']),
      enabled: row['enabled'] === true && archivedAt === null,
      dryRun: row['dry_run'] !== false,
      settingsValid: row['settings_valid'] !== false,
      settingsError: asString(row['settings_error']),
      settingsUpdatedAt: asIsoString(row['settings_updated_at']),
      source: asSource(row['source']) ?? 'manual',
      installationId: asIdString(row['installation_id']),
      archivedAt,
      updatedAt: asIsoString(row['updated_at']),
    };
  });
}

/* ── 4. 写 ─────────────────────────────────────────────────────────────────── */

export type UpsertRepoInput = {
  readonly repo: string;
  /** 缺省 `manual` */
  readonly source?: RepoSource;
  readonly installationId?: number | string | null;
  /** 缺省用 `settings.enabled` */
  readonly enabled?: boolean;
  /** 缺省用 `settings.dry_run` */
  readonly dryRun?: boolean;
  /** 缺省用部署默认（`defaultRepoSettings()`） */
  readonly settings?: unknown;
};

export type UpsertRepoResult =
  | { readonly ok: true; readonly repo: string; readonly settings: RepoConfig }
  | { readonly ok: false; readonly error: string; readonly issues: readonly string[] };

/**
 * 建行 / 补全安装信息。**只在建行时写 settings**（冲突时不覆盖，见 `REPO_SQL.upsert`）。
 *
 * 配置非法 → 不写库，返回错误（调用方决定的 HTTP 状态：面板 400、安装事件日志 + 跳过）。
 */
export async function upsertRepo(db: SqlRunner, input: UpsertRepoInput): Promise<UpsertRepoResult> {
  const validated =
    input.settings === undefined ? { ok: true as const, settings: defaultRepoSettings() } : validateRepoSettings(input.settings);
  if (!validated.ok) {
    return { ok: false, error: validated.error, issues: validated.issues };
  }
  const settings = validated.settings;
  const enabled = input.enabled ?? settings.enabled;
  const dryRun = input.dryRun ?? settings.dry_run;
  await db.query(REPO_SQL.upsert, [
    input.repo,
    enabled,
    dryRun,
    JSON.stringify(settings),
    input.source ?? 'manual',
    input.installationId === null || input.installationId === undefined
      ? null
      : String(input.installationId),
  ]);
  return { ok: true, repo: input.repo, settings };
}

export type UpdateSettingsResult =
  | { readonly ok: true; readonly repo: string; readonly settings: RepoConfig }
  | {
      readonly ok: false;
      /** `true` = 没有这一行（HTTP 404），`false` = 配置非法（HTTP 400） */
      readonly notFound: boolean;
      readonly error: string;
      readonly issues: readonly string[];
    };

/**
 * 覆盖一个仓库的 settings。
 *
 * **校验失败不写库**：库里的值保持最后一次合法状态（last-known-good），webhook 继续按它工作。
 */
export async function updateRepoSettings(
  db: SqlRunner,
  repo: string,
  settings: unknown,
): Promise<UpdateSettingsResult> {
  const validated = validateRepoSettings(settings);
  if (!validated.ok) {
    return { ok: false, notFound: false, error: validated.error, issues: validated.issues };
  }
  const result = await db.query(REPO_SQL.updateSettings, [
    repo,
    JSON.stringify(validated.settings),
    validated.settings.enabled,
    validated.settings.dry_run,
  ]);
  if ((result.rowCount ?? 0) === 0) {
    return {
      ok: false,
      notFound: true,
      error: `仓库不存在：${repo}（先用 POST /api/repos 添加）`,
      issues: [],
    };
  }
  return { ok: true, repo, settings: validated.settings };
}

/* ── 5. 小工具 ─────────────────────────────────────────────────────────────── */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asSource(value: unknown): RepoSource | null {
  return value === 'manual' || value === 'installation' ? value : null;
}

/** timestamptz（pg 给 Date，假实现可能给字符串）→ ISO 字符串。 */
function asIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' && value !== '' ? value : null;
}

/** bigint（pg 默认给字符串）→ 十进制字符串。 */
function asIdString(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}
