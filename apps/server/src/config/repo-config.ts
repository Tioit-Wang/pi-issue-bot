/**
 * 仓库配置 `.github/pi-bot.yml` 的加载与落库（B11，tech-plan §8.2 的 `config/` 模块）。
 *
 * 三段职责，都做成可注入：
 *  1. **拉取** —— 从 GitHub 读文件（`contents` API）。注入 `RepoConfigFetcher`，单测不碰网络。
 *  2. **校验** —— YAML 子集解析（`yaml.ts`）→ `parseRepoConfig()`（契约包的 zod）。
 *  3. **落库 + 通知** —— 写 `repos.config / config_valid / config_error / enabled / dry_run`；
 *     非法配置**禁用该仓库并通知 owner**（plan §10），不用默认值继续跑。
 *
 * 三条硬规则：
 *  - 校验失败不是「用默认值继续」：`config_valid=false` + `enabled=false` + 通知。
 *  - `dry_run` 缺省 `true`（契约 schema 里就是 `default(true)`，这里不写第二份默认值）。
 *  - 文件不存在 → 视为「用默认配置」：`config_valid=true`、`enabled=true`、`dry_run=true`，
 *    不通知。理由：没写配置和写错配置是两件事，前者是常态（第一次接入）。
 */
// 说明：本仓库的 workspace 包目前**没有**链进 `apps/server/node_modules`
// （`apps/server/package.json` 未声明 `@pi-issue-bot/*`，E9 又禁止本 session 跑 install），
// 因此这里与并行 session（`queries/`）的写法一致：用相对路径引到 packages 源码。
// TODO(owner: PM)：把 `"@pi-issue-bot/{contract,shared}": "workspace:*"` 加进
// `apps/server/package.json` 并统一 `pnpm install`，之后把这些相对路径改回包名。
import { repoConfigSchema } from '../../../../packages/contract/src/index.ts';
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { splitRepo } from '../github/index.ts';
import type { GithubClient } from '../github/index.ts';
import { parseYamlSubset, YamlSubsetError } from './yaml.ts';

/** 配置文件路径（仓库根相对）。 */
export const REPO_CONFIG_PATH = '.github/pi-bot.yml';

/** 只要 `query` 就行——真实实现是 `pg.Pool`，测试实现是几行假函数。 */
export type SqlRunner = {
  query: (text: string, values?: readonly unknown[]) => Promise<{
    readonly rows: unknown[];
    readonly rowCount?: number | null;
  }>;
};

/* ── 1. 拉取 ──────────────────────────────────────────────────────────────── */

export type RepoConfigFetchResult = {
  /** 文件是否存在。不存在不是错误（见文件头第三条）。 */
  readonly found: boolean;
  readonly yaml: string | null;
  /** 文件 blob sha；用于「同一提交不重复解析」。 */
  readonly sha: string | null;
};

export type RepoConfigFetcher = (input: {
  readonly repo: string;
  readonly path: string;
  readonly ref?: string;
}) => Promise<RepoConfigFetchResult>;

type ContentsResponse = {
  readonly content?: unknown;
  readonly encoding?: unknown;
  readonly sha?: unknown;
};

/**
 * 用 `GithubClient` 实现拉取。
 *
 * 404 单独识别（`classifyGithubError` 把 404 归到 `not_found`），其余错误照常抛：
 * 网络/权限错误不该被当成「没有配置文件」，否则一次抖动就会把所有仓库的配置清空。
 */
export function createGithubRepoConfigFetcher(client: GithubClient): RepoConfigFetcher {
  return async (input) => {
    const { owner, repo } = splitRepo(input.repo);
    const params: Record<string, unknown> = { owner, repo, path: input.path };
    if (input.ref !== undefined) {
      params['ref'] = input.ref;
    }
    try {
      const response = await client.request<ContentsResponse>(
        'GET /repos/{owner}/{repo}/contents/{path}',
        params,
      );
      const data = response.data;
      const raw = decodeContents(data);
      return {
        found: raw !== null,
        yaml: raw,
        sha: typeof data.sha === 'string' ? data.sha : null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return { found: false, yaml: null, sha: null };
      }
      throw error;
    }
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  if (status === 404) {
    return true;
  }
  const info = (error as { info?: { status?: unknown } }).info;
  return info?.status === 404;
}

/** contents API 的 `content` 是 base64（可能带换行）；也容忍直接给 UTF-8 文本。 */
function decodeContents(data: ContentsResponse): string | null {
  if (typeof data.content !== 'string') {
    return null;
  }
  if (data.encoding === 'base64' || data.encoding === undefined) {
    const normalized = data.content.replace(/\s+/gu, '');
    return Buffer.from(normalized, 'base64').toString('utf8');
  }
  return data.content;
}

/* ── 2. 校验 ──────────────────────────────────────────────────────────────── */

export type RepoConfigParseResult =
  | { readonly ok: true; readonly config: RepoConfig }
  | { readonly ok: false; readonly error: string; readonly issues: readonly string[] };

/** YAML 文本 → `RepoConfig`。错误消息控制在 500 字内（`repos.config_error` 列宽 + 面板展示）。 */
export function decodeRepoConfig(yamlText: string): RepoConfigParseResult {
  let parsed: unknown;
  try {
    parsed = parseYamlSubset(yamlText);
  } catch (error) {
    const message = error instanceof YamlSubsetError ? error.message : describeError(error);
    return { ok: false, error: `YAML 解析失败：${message}`, issues: [message] };
  }

  const result = repoConfigSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  return {
    ok: false,
    error: `配置不符合 schema：${issues.join('; ')}`.slice(0, 500),
    issues,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── 3. 落库 + 通知 ───────────────────────────────────────────────────────── */

export const REPO_CONFIG_SQL = {
  /** UPSERT `repos` 一行；$1 repo, $2 enabled, $3 dryRun, $4 config(jsonb|null), $5 valid, $6 error */
  upsert: `INSERT INTO "repos" ("repo_full_name", "enabled", "dry_run", "config", "config_valid", "config_error", "updated_at")
VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
ON CONFLICT ("repo_full_name") DO UPDATE
SET "enabled" = EXCLUDED."enabled",
    "dry_run" = EXCLUDED."dry_run",
    "config" = EXCLUDED."config",
    "config_valid" = EXCLUDED."config_valid",
    "config_error" = EXCLUDED."config_error",
    "updated_at" = now()`,
  /** webhook 判定用：$1 repo → { enabled, dry_run, config, config_valid } */
  readPolicy: `SELECT "enabled", "dry_run", "config", "config_valid", "config_error" FROM "repos" WHERE "repo_full_name" = $1`,
} as const;

/** 仓库策略（webhook 第 5 步读它：开关 + dry-run + 配置快照）。 */
export type RepoPolicy = {
  /** `repos` 里有这一行 */
  readonly known: boolean;
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly configValid: boolean;
  readonly config: RepoConfig | null;
  readonly configError: string | null;
};

/** 没有 `repos` 行时的默认策略：不开工（配置还没同步过）。 */
export const UNKNOWN_REPO_POLICY: RepoPolicy = Object.freeze({
  known: false,
  enabled: false,
  dryRun: true,
  configValid: false,
  config: null,
  configError: null,
});

export async function readRepoPolicy(db: SqlRunner, repo: string): Promise<RepoPolicy> {
  const result = await db.query(REPO_CONFIG_SQL.readPolicy, [repo]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return UNKNOWN_REPO_POLICY;
  }
  const stored = row['config'];
  const parsed = stored === null || stored === undefined ? null : safeParseRepoConfig(stored);
  return {
    known: true,
    enabled: row['enabled'] === true,
    dryRun: row['dry_run'] !== false,
    configValid: row['config_valid'] === true,
    config: parsed,
    configError: typeof row['config_error'] === 'string' ? row['config_error'] : null,
  };
}

/** 快照里存的已经是校验过的结构；这里再走一遍 zod 是为了对付「列被手改了」。 */
function safeParseRepoConfig(input: unknown): RepoConfig | null {
  const result = repoConfigSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** 非法配置时通知 owner（plan §10）。注入实现：GitHub 评论 / 邮件 / 告警都行。 */
export type RepoConfigNotifier = (input: {
  readonly repo: string;
  readonly error: string;
  readonly issues: readonly string[];
}) => Promise<void>;

export type SyncRepoConfigDeps = {
  readonly fetch: RepoConfigFetcher;
  readonly db: SqlRunner;
  readonly logger?: Logger;
  /** 不传则只落库不通知（`config_valid=false` 仍然会让 webhook 跳过该仓库）。 */
  readonly notify?: RepoConfigNotifier;
  /** 读哪个 ref（默认仓库默认分支）。 */
  readonly ref?: string;
  readonly now?: () => Date;
};

export type SyncRepoConfigResult = {
  readonly repo: string;
  readonly found: boolean;
  readonly valid: boolean;
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly error: string | null;
  readonly sha: string | null;
  readonly notified: boolean;
};

/**
 * 拉一次配置并落库。
 *
 * 顺序有意：**先落库再通知**。通知失败（GitHub 挂了）不该让「仓库已禁用」这个结论丢掉。
 */
export async function syncRepoConfig(
  deps: SyncRepoConfigDeps,
  repo: string,
): Promise<SyncRepoConfigResult> {
  const fetched = await deps.fetch({
    repo,
    path: REPO_CONFIG_PATH,
    ...(deps.ref === undefined ? {} : { ref: deps.ref }),
  });

  if (!fetched.found) {
    const defaults = repoConfigSchema.parse({ version: 1 });
    await deps.db.query(REPO_CONFIG_SQL.upsert, [
      repo,
      defaults.enabled,
      defaults.dry_run,
      null,
      true,
      null,
    ]);
    deps.logger?.info({ repo, path: REPO_CONFIG_PATH }, '仓库没有 pi-bot.yml，按默认配置入库');
    return {
      repo,
      found: false,
      valid: true,
      enabled: defaults.enabled,
      dryRun: defaults.dry_run,
      error: null,
      sha: null,
      notified: false,
    };
  }

  const decoded = decodeRepoConfig(fetched.yaml ?? '');
  if (!decoded.ok) {
    // 非法：禁用 + 落错误原因 + 通知 owner
    await deps.db.query(REPO_CONFIG_SQL.upsert, [repo, false, true, null, false, decoded.error]);
    deps.logger?.warn({ repo, issues: decoded.issues }, '仓库配置非法，已禁用该仓库并准备通知 owner');
    let notified = false;
    if (deps.notify !== undefined) {
      try {
        await deps.notify({ repo, error: decoded.error, issues: decoded.issues });
        notified = true;
      } catch (error) {
        deps.logger?.error(
          { repo, err: describeError(error) },
          '通知 owner 失败（仓库仍保持禁用）',
        );
      }
    }
    return {
      repo,
      found: true,
      valid: false,
      enabled: false,
      dryRun: true,
      error: decoded.error,
      sha: fetched.sha,
      notified,
    };
  }

  const config = decoded.config;
  await deps.db.query(REPO_CONFIG_SQL.upsert, [
    repo,
    config.enabled,
    config.dry_run,
    config,
    true,
    null,
  ]);
  deps.logger?.info({ repo, enabled: config.enabled, dryRun: config.dry_run }, '仓库配置已加载');
  return {
    repo,
    found: true,
    valid: true,
    enabled: config.enabled,
    dryRun: config.dry_run,
    error: null,
    sha: fetched.sha,
    notified: false,
  };
}
