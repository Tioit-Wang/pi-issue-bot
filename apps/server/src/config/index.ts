/**
 * `config/` 的公共出口（tech-plan §8.2：`http/webhook` 与 `serve` 经这里取仓库配置与进程配置）。
 *
 * 分工：
 *  - `env.ts` —— 进程级 env（只在 CLI 入口读取，其余模块吃注入对象）
 *  - `repo-config.ts` —— `.github/pi-bot.yml` 的拉取 → 校验 → 落库 + 通知
 *  - `yaml.ts` —— 受限 YAML 子集解析（只服务仓库配置；见该文件头的取舍说明）
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
  REPO_CONFIG_PATH,
  REPO_CONFIG_SQL,
  UNKNOWN_REPO_POLICY,
  createGithubRepoConfigFetcher,
  decodeRepoConfig,
  readRepoPolicy,
  syncRepoConfig,
} from './repo-config.ts';
export type {
  RepoConfigFetchResult,
  RepoConfigFetcher,
  RepoConfigNotifier,
  RepoConfigParseResult,
  RepoPolicy,
  SqlRunner,
  SyncRepoConfigDeps,
  SyncRepoConfigResult,
} from './repo-config.ts';

export { YamlSubsetError, parseYamlSubset } from './yaml.ts';
export type { YamlMap, YamlScalar, YamlValue } from './yaml.ts';
