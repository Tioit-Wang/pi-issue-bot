-- 0006_agent：issue agent v0.3 的数据层（`docs/dev-plan-issue-agent.md` §4，S0 退役片）。
--
-- 三部分：
--  1. 新表 `agent_sessions` / `agent_messages` / `agent_denials`：
--     会话状态从 `issue_pipeline` **搬家**（那条表随三段流水线一起退役），消息表同时是队列；
--  2. 数据搬家：`issue_pipeline` 的会话四列 → `agent_sessions`（保住已有 issue 的对话连续性）；
--  3. 退役：`DROP TABLE issue_pipeline` / `prompt_versions`，并把 `repos.settings` 收窄到
--     `agent` 段（`pipeline.managers` → `agent.managers`；删 `pipeline` / `prompt` /
--     `commands` / `create_issue`；`triggers` 只留 `aliases`；`skills.repo_skills` → `project_skills`）。
--
-- 幂等约定（与 0003 / 0005 一致）：
--  - 每条 DDL 都带 `IF NOT EXISTS` / `IF EXISTS`：在「已经手工改过库」的环境上重复执行不会炸；
--  - 数据搬家在 `DO $$` 里先查 `to_regclass('issue_pipeline')`：第二次执行时表已经没了，整段跳过；
--  - settings 收窄是「按当前值重算成目标值」，结尾带 `WHERE settings IS DISTINCT FROM 目标值` ——
--    第二次执行匹配 0 行，不会无端刷新 `settings_updated_at`。
--
-- 回滚（手工；本仓库不写 down 迁移）：见文件末尾的注释块（含 `issue_pipeline` 的原始 DDL 与
-- 三列保留说明，抄自 `0005_pipeline.sql:18-48`）。
CREATE TABLE IF NOT EXISTS "agent_sessions" (
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"session_id" text,
	"cursor" integer DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_repo_issue_number_pk" PRIMARY KEY("repo","issue_number")
);
--> statement-breakpoint
-- 消息级**永久幂等**（需求 §1.2 / §5 规则 2）：主键就是幂等键，命中即返回上次的 comment_*。
-- `kind` = `mention`（人消息，永久幂等）| `event`（模板消息，key 含 `issue.updated_at`）。
CREATE TABLE IF NOT EXISTS "agent_messages" (
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text DEFAULT 'mention' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"comment_id" bigint,
	"comment_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_repo_issue_number_fingerprint_pk" PRIMARY KEY("repo","issue_number","fingerprint")
);
--> statement-breakpoint
-- dispatcher 按 issue 取最老一条（`status in ('queued','running')`）+ 面板按状态筛
CREATE INDEX IF NOT EXISTS "agent_messages_queue_idx" ON "agent_messages" USING btree ("repo","issue_number","status","created_at");
--> statement-breakpoint
-- 权限拒绝**独立记账**：`status='denied'` 不得参与幂等命中，否则该用户日后被提成管理员，
-- 同一句话会被永久静默且查不到原因（需求 §1.2 / 用例 C-10、X-09）。
CREATE TABLE IF NOT EXISTS "agent_denials" (
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"actor_login" text NOT NULL,
	"replied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_denials_repo_issue_number_actor_login_pk" PRIMARY KEY("repo","issue_number","actor_login")
);
--> statement-breakpoint
-- ── 会话状态搬家（v1 计划踩过的坑：删 issue_pipeline 顺手删掉了会话游标）──────────────
DO $$
BEGIN
	IF to_regclass('public.issue_pipeline') IS NOT NULL THEN
		INSERT INTO "agent_sessions" ("repo","issue_number","session_id","cursor","turns","started_at")
		SELECT "repo","issue_number","session_id","session_cursor","session_turns","session_started_at"
		FROM "issue_pipeline"
		WHERE "session_id" IS NOT NULL
		ON CONFLICT ("repo","issue_number") DO NOTHING;
	END IF;
END $$;
--> statement-breakpoint
-- ── 退役 ──────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "issue_pipeline";
--> statement-breakpoint
DROP TABLE IF EXISTS "prompt_versions";
--> statement-breakpoint
-- ── settings 收窄（`docs/dev-plan-issue-agent.md` §2.6 的映射逐段处理）────────────
--
-- 逐段说明：
--  s0：非对象的 settings（NULL / 数组 / 标量）一律当空对象起步；
--  s1：算出 `agent.managers` —— 已经有 `agent.managers` 就用它，否则取 `pipeline.managers`，
--      都没有给 `[]`（形状合法值；`settings_valid=false` 属预期，由面板重新配置）；
--  s2：删掉 `pipeline` / `prompt` / `commands` / `create_issue` 四段，写入 `agent` 段
--      （保留 `agent` 里已存在的其它键，只覆盖 `managers`）；
--  s3：`triggers` 只留 `aliases`（`enabled` / `users` / `merge_defaults` / `remove` 删）；
--  s4：`skills.repo_skills` → `skills.project_skills`（布尔），缺省 true；
--  final：一次性写回，只在值真的变了时写（重复执行 0 行）。
WITH "s0" AS (
	SELECT
		"repo_full_name" AS "repo",
		CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END AS "settings"
	FROM "repos"
), "s1" AS (
	SELECT
		"repo",
		"settings",
		CASE
			WHEN jsonb_typeof("settings" -> 'agent' -> 'managers') = 'array' THEN "settings" -> 'agent' -> 'managers'
			WHEN jsonb_typeof("settings" -> 'pipeline' -> 'managers') = 'array' THEN "settings" -> 'pipeline' -> 'managers'
			ELSE '[]'::jsonb
		END AS "managers"
	FROM "s0"
), "s2" AS (
	SELECT
		"repo",
		jsonb_set(
			"settings" - 'pipeline' - 'prompt' - 'commands' - 'create_issue',
			'{agent}',
			coalesce(("settings" - 'pipeline' - 'prompt' - 'commands' - 'create_issue') -> 'agent', '{}'::jsonb)
				|| jsonb_build_object('managers', "managers"),
			true
		) AS "settings"
	FROM "s1"
), "s3" AS (
	SELECT
		"repo",
		CASE
			WHEN jsonb_typeof("settings" -> 'triggers') = 'object' AND "settings" -> 'triggers' ? 'aliases'
				THEN jsonb_set("settings", '{triggers}', jsonb_build_object('aliases', "settings" -> 'triggers' -> 'aliases'), true)
			WHEN jsonb_typeof("settings" -> 'triggers') = 'object'
				THEN "settings" - 'triggers'
			ELSE "settings"
		END AS "settings"
	FROM "s2"
), "s4" AS (
	SELECT
		"repo",
		CASE
			WHEN jsonb_typeof("settings" -> 'skills') = 'object'
				THEN jsonb_set(
					"settings",
					'{skills}',
					jsonb_build_object(
						'project_skills',
						CASE
							WHEN jsonb_typeof("settings" -> 'skills' -> 'project_skills') = 'boolean' THEN "settings" -> 'skills' -> 'project_skills'
							WHEN jsonb_typeof("settings" -> 'skills' -> 'repo_skills') = 'boolean' THEN "settings" -> 'skills' -> 'repo_skills'
							ELSE 'true'::jsonb
						END
					),
					true
				)
			ELSE "settings"
		END AS "settings"
	FROM "s3"
)
UPDATE "repos" AS "r"
SET
	"settings" = "s4"."settings",
	"settings_updated_at" = now()
FROM "s4"
WHERE "r"."repo_full_name" = "s4"."repo"
	AND "r"."settings" IS DISTINCT FROM "s4"."settings";
--> statement-breakpoint
/*
 * ── 回滚（手工，本仓库不写 down 迁移）────────────────────────────────────────────
 *
 * 1) settings 回填（只能恢复到「形状」层面，语义由部署自己决定）：
 *    - `agent.managers` → `pipeline.managers`；
 *    - 其余 `pipeline` / `prompt` / `commands` / `create_issue` 四段按 0005 时代的默认值补回；
 *    - `triggers` 补回 `{enabled: true, merge_defaults: true, remove: [], users: 'all'}`；
 *    - `skills.project_skills` → `skills.repo_skills`。
 *
 * 2) 会话状态搬回 `issue_pipeline`（先建表，再 INSERT…SELECT，最后 DROP agent_sessions
 *    之外的两张新表）。`issue_pipeline` 的原始 DDL（抄自 `0005_pipeline.sql:18-48`）：
 *
 *    CREATE TABLE IF NOT EXISTS "issue_pipeline" (
 *      "repo" text NOT NULL,
 *      "issue_number" integer NOT NULL,
 *      "stage" text DEFAULT 'format' NOT NULL,
 *      "state" text DEFAULT 'pending' NOT NULL,
 *      "category" text,
 *      "format_attempts" integer DEFAULT 0 NOT NULL,
 *      "format_fail_count" integer DEFAULT 0 NOT NULL,
 *      "classify_attempts" integer DEFAULT 0 NOT NULL,
 *      "issue_version" text,
 *      "info_requested_at" timestamp with time zone,
 *      "last_recheck_at" timestamp with time zone,
 *      "mention_sent_at" timestamp with time zone,
 *      "mention_category" text,
 *      "gate_notice_at" timestamp with time zone,
 *      "session_id" text,
 *      "session_cursor" integer DEFAULT 0 NOT NULL,
 *      "session_turns" integer DEFAULT 0 NOT NULL,
 *      "session_started_at" timestamp with time zone,
 *      "stale_at" timestamp with time zone,
 *      "blocked_reason" text,
 *      "ready_at" timestamp with time zone,
 *      "closed_at" timestamp with time zone,
 *      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 *      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 *      CONSTRAINT "issue_pipeline_repo_issue_number_pk" PRIMARY KEY("repo","issue_number")
 *    );
 *    CREATE INDEX IF NOT EXISTS "issue_pipeline_close_scan_idx"
 *      ON "issue_pipeline" USING btree ("state","info_requested_at");
 *
 *    搬回时**只填会话三列**（`session_id` / `session_cursor` / `session_turns`）与
 *    `session_started_at`；`stage` / `state` / `category` 等阶段列没有对应的新数据来源，
 *    回滚后只能停在 `format/pending`（0005 时代的默认值），三列保留说明：
 *      - `session_id`：原样回填（对话连续性）；
 *      - `session_cursor`：原样回填（`after` 游标）；
 *      - `session_turns`：原样回填（轮换计数）；
 *      - `session_started_at`：原样回填（7 天轮换的起点）。
 *
 * 3) `prompt_versions` 无法回滚（正文已删）：需要时从备份或 `settings.agent.project_prompt` 重建。
 */
