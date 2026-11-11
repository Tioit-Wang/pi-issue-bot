-- 0004_seed_settings_from_legacy：把 `.github/pi-bot.yml` 时代的 `repos.config` 快照播种成
-- `repos.settings`（`repoSettingsSchema` 形状），让升级前就存在的仓库不会因为
-- 「`settings` 还是 `{}`、而面板读不到旧配置」被判定为配置无效。
--
-- 三条约束：
--  1. **只补空**：仅当 `settings` 为 `{}`/NULL 且 `config` 非空时才写，重复执行无副作用；
--  2. **只搬 schema 里还存在的键**：`compliance` 段在契约里已删除（判定依据改由项目提示词承载），
--     这里**不搬**；段内键逐个列，未知键不会被带进来（`repoSettingsSchema` 是 `.strict()`）；
--  3. **不覆盖面板已改过的配置**：非空 `settings` 一律不动。
--
-- 幂等性由 `WHERE` 保证，不需要 `IF NOT EXISTS`（这不是 DDL）。

UPDATE "repos" AS r
SET "settings" = (
      jsonb_build_object('version', 1)
      || jsonb_strip_nulls(
           jsonb_build_object(
             'enabled', r."enabled",
             'dry_run', r."dry_run",
             'model', r."config" -> 'model'
           )
         )
      || jsonb_strip_nulls(
           jsonb_build_object(
             'labels',
             jsonb_strip_nulls(
               jsonb_build_object(
                 'map', coalesce(r."config" -> 'labels' -> 'map', '{}'::jsonb),
                 'allow', r."config" -> 'labels' -> 'allow',
                 'missing', 'warn',
                 'max_per_issue', 6,
                 'vocabulary', coalesce(r."config" -> 'labels' -> 'vocabulary', '[]'::jsonb)
               )
             )
           )
         )
      || jsonb_strip_nulls(
           jsonb_build_object(
             'commands',
             jsonb_strip_nulls(
               jsonb_build_object(
                 'enabled', r."config" -> 'commands' -> 'enabled',
                 'allowed', r."config" -> 'commands' -> 'allowed',
                 'author_associations', r."config" -> 'commands' -> 'author_associations',
                 'allow_users', r."config" -> 'commands' -> 'allow_users',
                 'rate_limit_per_hour', r."config" -> 'commands' -> 'rate_limit_per_hour'
               )
             )
           )
         )
      || jsonb_strip_nulls(
           jsonb_build_object(
             'create_issue',
             jsonb_strip_nulls(
               jsonb_build_object(
                 'enabled', r."config" -> 'create_issue' -> 'enabled',
                 'daily_quota', r."config" -> 'create_issue' -> 'daily_quota',
                 'scenarios', r."config" -> 'create_issue' -> 'scenarios'
               )
             )
           )
         )
      || jsonb_strip_nulls(
           jsonb_build_object(
             'skills',
             jsonb_strip_nulls(
               jsonb_build_object('repo_skills', r."config" -> 'skills' -> 'repo_skills')
             )
           )
         )
      || jsonb_strip_nulls(
           jsonb_build_object(
             'limits',
             jsonb_strip_nulls(
               jsonb_build_object(
                 'max_comments_per_hour', r."config" -> 'limits' -> 'max_comments_per_hour',
                 'max_actions_per_run', r."config" -> 'limits' -> 'max_actions_per_run',
                 'max_task_minutes', r."config" -> 'limits' -> 'max_task_minutes'
               )
             )
           )
         )
    ),
    "settings_valid" = true,
    "settings_error" = null,
    "settings_updated_at" = now()
WHERE (r."settings" IS NULL OR r."settings" = '{}'::jsonb)
  AND r."config" IS NOT NULL
  AND jsonb_typeof(r."config") = 'object';
