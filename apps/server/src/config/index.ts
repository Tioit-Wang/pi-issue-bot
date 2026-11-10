/**
 * `config/` 的公共出口（tech-plan §8.2：`http/webhook` 与 `serve` 经这里取仓库配置与进程配置）。
 *
 * 分工：
 *  - `env.ts` —— 进程级 env（只在 CLI 入口读取，其余模块吃注入对象）
 *  - `repo-config.ts` —— `repos` 表的读写（settings / 开关 / 来源 / 归档），部署默认 settings
 *  - `yaml.ts` —— 受限 YAML 子集解析。`.github/pi-bot.yml` 退役后**已无生产调用者**，
 *    仅保留给仍在用它的测试与历史数据解析；W3 之后可整体删除。
 */
export {
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_METRICS_HOST,
  DEFAULT_METRICS_PORT,
  ENV_KEYS,
  ConfigError,
  defaultMigrationsDir,
  readDatabaseUrl,
  readServeConfig,
} from './env.ts';
export type { EnvLike, ServeConfig } from './env.ts';

export {
  REPO_SETTINGS_ENV,
  REPO_SQL,
  UNKNOWN_REPO_POLICY,
  defaultRepoSettings,
  listRepos,
  loadDefaultRepoSettings,
  readRepoPolicy,
  resetDefaultRepoSettingsCache,
  updateRepoSettings,
  upsertRepo,
  validateRepoSettings,
} from './repo-config.ts';
export type {
  FileReader,
  RepoPolicy,
  RepoSource,
  RepoSummary,
  SettingsValidation,
  SqlRunner,
  UpdateSettingsResult,
  UpsertRepoInput,
  UpsertRepoResult,
} from './repo-config.ts';

export { YamlSubsetError, parseYamlSubset } from './yaml.ts';
export type { YamlMap, YamlScalar, YamlValue } from './yaml.ts';
