-- 0003_multi_repo：多仓库改造的数据层（`docs/impl-multi-repo.md` §2）。
--
-- 纯新增：ALTER TABLE ADD COLUMN / CREATE TABLE / CREATE INDEX。写在文件里的每个 DDL 都带
-- `IF NOT EXISTS`，所以在「已经有 0001/0002 手工改过的库」上重复执行也不会炸（与 0001/0002 同一约定）。
-- 不写数据搬迁脚本：`.github/pi-bot.yml` 的旧值留在 `repos.config`（过渡期列），新配置从默认值起步。
--
-- 过渡期保留 `repos.config / config_valid / config_error`：W1 之后不再读写，W3 再删列。
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "settings_valid" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "settings_error" text;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "settings_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "installation_id" bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_installation_id_idx" ON "repos" USING btree ("installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_updated_at_idx" ON "repos" USING btree ("updated_at");
--> statement-breakpoint
-- 未知仓库的投递也记 `repo`（W1-B 排查「哪次投递没被处理」）
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "repo" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_repo_received_at_idx" ON "webhook_deliveries" USING btree ("repo","received_at");
--> statement-breakpoint
-- 熔断 / 暂停开关按仓库区分：repo NULL = 全局。
-- PG 的唯一索引把 NULL 视为互不相等，所以用两条 partial 索引代替 (key, repo) 复合唯一键。
ALTER TABLE "runtime_flags" ADD COLUMN IF NOT EXISTS "repo" text;
--> statement-breakpoint
ALTER TABLE "runtime_flags" DROP CONSTRAINT IF EXISTS "runtime_flags_pkey";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_flags_global_uidx" ON "runtime_flags" USING btree ("key") WHERE "repo" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_flags_repo_uidx" ON "runtime_flags" USING btree ("key","repo") WHERE "repo" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "bot_labels" ADD COLUMN IF NOT EXISTS "source_key" text;
--> statement-breakpoint
ALTER TABLE "bot_labels" ADD COLUMN IF NOT EXISTS "judgement_hash" text;
--> statement-breakpoint
ALTER TABLE "bot_labels" ADD COLUMN IF NOT EXISTS "reason" text;
--> statement-breakpoint
ALTER TABLE "bot_labels" ADD COLUMN IF NOT EXISTS "run_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_number" integer NOT NULL,
	"comment_id" bigint,
	"stage" text NOT NULL,
	"content" text NOT NULL,
	"anchor" text DEFAULT '' NOT NULL,
	"reaction_id" bigint,
	"applied_at" timestamp with time zone,
	"audit" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_feedback_stage_uidx" ON "issue_feedback" USING btree ("repo","target_kind","target_number","stage","anchor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_feedback_target_idx" ON "issue_feedback" USING btree ("repo","target_kind","target_number");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "label_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"target_number" integer NOT NULL,
	"judgement_hash" text,
	"desired" jsonb,
	"applied" jsonb,
	"blocked_reason" text,
	"reason" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "label_decisions_repo_target_idx" ON "label_decisions" USING btree ("repo","target_number","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quota_counters" (
	"repo" text NOT NULL,
	"kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quota_counters_repo_kind_window_uidx" ON "quota_counters" USING btree ("repo","kind","window_start");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_versions" (
	"repo" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_repo_version_uidx" ON "prompt_versions" USING btree ("repo","version");
