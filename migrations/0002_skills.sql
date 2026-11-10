-- 0002: 技能管理（面板可写面）—— 事实源 `docs/spec/skill-management.md` §5。
--
-- 三张表，各管一件事，别合并：
--  1. `skills`          技能本体，一个 (name, scope, repo) 一行，软删（`deleted_at`）。
--  2. `skill_versions`  不可变版本：库里只存文件清单与哈希，正文在磁盘
--                       `<PI_BOT_DATA_DIR>/skills/<skill_id>/<version>/`。
--  3. `skills_audit`    写审计：谁、什么时候、对哪个技能干了什么、内容指纹是什么。
--                       上传即生效且没有审批流（spec D0/D6），审计就是唯一的事后追溯手段，
--                       所以这三张表必须一起上，缺审计等于没做。
--
-- 唯一约束用表达式索引 `coalesce(repo,'')`：`scope='global'` 时 `repo` 是 NULL，
-- 而 Postgres 唯一索引把 NULL 视作互不相等，不套 coalesce 就能插进两条同名全局技能。
CREATE TABLE IF NOT EXISTS "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"repo" text,
	"source" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"description" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_name_scope_uidx" ON "skills" USING btree ("name","scope",coalesce("repo", '')) WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_list_idx" ON "skills" USING btree ("scope","repo","enabled") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_versions" (
	"skill_id" text NOT NULL,
	"version" integer NOT NULL,
	"files" jsonb NOT NULL,
	"tree_sha256" text NOT NULL,
	"validation" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_id_version_pk" PRIMARY KEY("skill_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"action" text NOT NULL,
	"actor" text,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_audit_skill_created_idx" ON "skills_audit" USING btree ("skill_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_audit_action_created_idx" ON "skills_audit" USING btree ("action","created_at");
