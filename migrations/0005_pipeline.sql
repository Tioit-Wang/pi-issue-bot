-- 0005_pipeline：固定流水线改造的数据层（`docs/plan-fixed-pipeline.md` §4.3 / §4.4 / §4.5 / §10.2、S0 片）。
--
-- 三部分：
--  1. 新表 `issue_pipeline` + 关闭扫描索引：三阶段状态机的**唯一状态行**，复合主键 `(repo, issue_number)`；
--  2. 增量列：`tasks` 的正文/补充快照（P2）、`envelopes` 的阶段结论投影、`prompt_versions.kind`（4 条版本线，E3）；
--  3. **Q4 数据重置**：存量 `repos.settings` 用**一条** UPDATE 重置为新形状——删已废弃键、补 `pipeline` 段
--     （`managers` 为空时种入仓库 owner）、`labels.vocabulary` 丢弃缺 `role` 的整条。
--     Q4 定案「无需兼容老配置」，所以这里**不回填** `vocabulary.role`、也不保留旧形状；
--     迁移后由面板重新配置 `managers` / `role`，配置合法前 `settings_valid=false` 属预期
--     （`readRepoPolicy` 会在读的时候重新跑 schema，过期列不会让非法配置变可用）。
--
-- 幂等约定（与 0003 一致）：
--  - 每条 DDL 都带 `IF NOT EXISTS`，在「已经手工改过库」的环境上重复执行不会炸；
--  - 数据重置里每个表达式都是「按当前值重算成目标值」，不是自增/累加，且结尾带
--    `WHERE settings IS DISTINCT FROM 目标值`——第二次执行匹配 0 行，不会无端刷新 `settings_updated_at`。
--
-- 回滚（手工，本仓库不写 down 迁移）：见文件末尾的注释块。
CREATE TABLE IF NOT EXISTS "issue_pipeline" (
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"stage" text DEFAULT 'format' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"category" text,
	"format_attempts" integer DEFAULT 0 NOT NULL,
	"format_fail_count" integer DEFAULT 0 NOT NULL,
	"classify_attempts" integer DEFAULT 0 NOT NULL,
	"issue_version" text,
	"info_requested_at" timestamp with time zone,
	"last_recheck_at" timestamp with time zone,
	"mention_sent_at" timestamp with time zone,
	"mention_category" text,
	"gate_notice_at" timestamp with time zone,
	"session_id" text,
	"session_cursor" integer DEFAULT 0 NOT NULL,
	"session_turns" integer DEFAULT 0 NOT NULL,
	"session_started_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"blocked_reason" text,
	"ready_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_pipeline_repo_issue_number_pk" PRIMARY KEY("repo","issue_number")
);
--> statement-breakpoint
-- 48h 自动关闭作业（每 10 分钟）按 (state, info_requested_at) 扫描；`classify/awaiting_info` 的
-- `info_requested_at` 恒为 NULL，所以等管理员的 issue 不会被这条索引扫到（§2 注 / 11:00 拍板）。
CREATE INDEX IF NOT EXISTS "issue_pipeline_close_scan_idx" ON "issue_pipeline" USING btree ("state","info_requested_at");
--> statement-breakpoint
-- P2：issue 正文入队时快照，不依赖只留 90 天的 webhook 原文（也顺带修好命令任务「看不到正文」的老问题）
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "target_title" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "target_body" text;
--> statement-breakpoint
-- 补充评论段：**jsonb 数组**（最近 3 条，每条 ≤1000 字符）。默认 '[]' 而不是 NULL，
-- 读侧不必分支；写侧永远整体替换（不追加、不 concat），否则会越长越大。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "target_supplement" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- 阶段结论投影列（面板要按阶段筛选/画时间线，解 jsonb 写不出索引）；Agent 阶段的老信封保持 NULL
ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "stage_name" text;
--> statement-breakpoint
ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "stage_result" text;
--> statement-breakpoint
-- E3：4 条提示词版本线。默认值 'project' 让 0003 时代的存量行原地归位（不需要单独回填）
ALTER TABLE "prompt_versions" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
-- 旧唯一键 (repo, version) 必须删：否则阶段 0 存一版就会把 P1 的同号版本顶掉
DROP INDEX IF EXISTS "prompt_versions_repo_version_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_repo_kind_version_uq" ON "prompt_versions" USING btree ("repo","kind","version");
--> statement-breakpoint
-- ── Q4 数据重置：存量 `repos.settings` 一次 UPDATE 重置为新形状（可重复执行）──────────────
--
-- 逐段说明：
--  s0：非对象的 settings（NULL / 数组 / 标量）一律当空对象起步——Q4 允许覆盖存量数据，不做读路径宽容；
--  s1：① 删 `triggers.faces`（P7：服务端零消费；`triggers` 段不存在时不动，免造出一个空段）；
--      ② `pipeline` 段只保留 4 个已知键，`enabled` / `close_after_hours` / `max_runs_per_stage`
--         与任何未知键一起丢掉（Q2：阈值收为系统级常量；E1：不存在项目级开关）；
--      ③ `labels.vocabulary` 丢弃「缺 `role`」的整条（Q4 明确不回填），保留原顺序，其余键（`map`）不动；
--  s2：④ 三个提示词版本指针铺底为 0（已有值不覆盖，与 §4.4「4 条版本线」一致）；
--      ⑤ `managers` 是非空数组时原样保留；缺省 / 空数组时种入仓库 owner
--         （`split_part(repo_full_name,'/',1)`），让已接入仓库迁移后有一个可用的管理人员；
--  final：⑥ 只替换 `pipeline` 与 `labels` 两段，`labels.map` 等其余键原样保留；
--          `labels` 段原本不存在时也不新造（避免给未配置仓库凭空塞一个空词表）。
WITH "s0" AS (
	SELECT
		"repo_full_name" AS "repo",
		CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END AS "settings"
	FROM "repos"
), "s1" AS (
	SELECT
		"repo",
		CASE
			WHEN jsonb_typeof("settings" -> 'triggers') = 'object'
				THEN jsonb_set("settings", '{triggers}', ("settings" -> 'triggers') - 'faces', false)
			ELSE "settings"
		END AS "settings_no_faces",
		CASE WHEN jsonb_typeof("settings" -> 'labels') = 'object' THEN "settings" -> 'labels' ELSE NULL END AS "labels",
		jsonb_strip_nulls(
			jsonb_build_object(
				'managers', "settings" -> 'pipeline' -> 'managers',
				'format_prompt_version', "settings" -> 'pipeline' -> 'format_prompt_version',
				'classify_prompt_version', "settings" -> 'pipeline' -> 'classify_prompt_version',
				'agent_prompt_version', "settings" -> 'pipeline' -> 'agent_prompt_version'
			)
		) AS "pipeline_known",
		CASE
			WHEN jsonb_typeof("settings" -> 'labels' -> 'vocabulary') = 'array' THEN (
				SELECT coalesce(jsonb_agg("entry" ORDER BY "ord"), '[]'::jsonb)
				FROM jsonb_array_elements("settings" -> 'labels' -> 'vocabulary') WITH ORDINALITY AS "e"("entry", "ord")
				WHERE jsonb_typeof("entry") = 'object' AND "entry" ? 'role'
			)
			ELSE '[]'::jsonb
		END AS "vocabulary_with_role"
	FROM "s0"
), "s2" AS (
	SELECT
		"repo",
		"settings_no_faces",
		CASE
			WHEN "labels" IS NULL THEN NULL
			ELSE ("labels" - 'vocabulary') || jsonb_build_object('vocabulary', "vocabulary_with_role")
		END AS "labels_next",
		jsonb_build_object('format_prompt_version', 0, 'classify_prompt_version', 0, 'agent_prompt_version', 0)
			|| ("pipeline_known" - 'managers')
			|| jsonb_build_object(
				'managers',
				CASE
					WHEN jsonb_typeof("pipeline_known" -> 'managers') = 'array'
						AND jsonb_array_length("pipeline_known" -> 'managers') > 0
						THEN "pipeline_known" -> 'managers'
					ELSE jsonb_build_array(split_part("repo", '/', 1))
				END
			) AS "pipeline_next"
	FROM "s1"
), "final" AS (
	SELECT
		"repo",
		("settings_no_faces" - 'pipeline' - 'labels')
			|| jsonb_build_object('pipeline', "pipeline_next")
			|| CASE WHEN "labels_next" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('labels', "labels_next") END
			AS "settings"
	FROM "s2"
)
UPDATE "repos" AS "r"
SET "settings" = "final"."settings",
	"settings_updated_at" = now()
FROM "final"
WHERE "r"."repo_full_name" = "final"."repo"
	AND "r"."settings" IS DISTINCT FROM "final"."settings";

-- ── 回滚（手工）──────────────────────────────────────────────────────────────────────
-- 本仓库只有正向迁移，回滚要手工做，且**数据不可完全回滚**（Q4：老配置已按新形状重置）。
-- 按相反顺序执行：
--
--   -- 1. 提示词版本线回到单一 (repo, version) 唯一键
--   DROP INDEX IF EXISTS "prompt_versions_repo_kind_version_uq";
--   CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_repo_version_uidx" ON "prompt_versions" USING btree ("repo","version");
--   ALTER TABLE "prompt_versions" DROP COLUMN IF EXISTS "kind";
--
--   -- 2. 阶段结论投影列
--   ALTER TABLE "envelopes" DROP COLUMN IF EXISTS "stage_result";
--   ALTER TABLE "envelopes" DROP COLUMN IF EXISTS "stage_name";
--
--   -- 3. 正文 / 补充快照（`target_supplement` 是 jsonb 数组，删列即丢数据）
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "target_supplement";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "target_body";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "target_title";
--
--   -- 4. 流水线状态行（不可恢复：issue 的阶段进度只在这张表里）
--   DROP TABLE IF EXISTS "issue_pipeline";
--
-- 注意：DROP INDEX 与上一段 CREATE 在同一次部署里都做过时，重跑 0005 会重建新索引；
-- 想彻底回到 0004 的库形状，还要把已回滚环境里的 `schema_migrations` 中 `0005_pipeline` 那行删掉，
-- 否则运行器会因校验和一致而跳过它（这是有意的：历史迁移只读，不允许「改文件重跑」）。
