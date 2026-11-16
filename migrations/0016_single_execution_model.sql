-- 需求 §6.8（CFG-8.2 收窄）：撤掉「模型角色四档」，只留**一个执行模型** + 项目级覆盖。
--
-- 为什么撤：四档里只有 agent（执行）档真的生效。pi-host 的 `session/create` 只带 `systemPrompt`、
-- `turn/start` 只带 `input.text`，`format` / `classify` / `fallback` 没有 per-session 模型槽位，
-- 配了也永远用不上——「界面上有、实际没用」的配置比没有更糟。
--
-- 做法：把旧表里 `role = 'agent'` 的那一行搬进单行表，其余角色行**丢弃**（它们从未进过运行期，
-- 丢掉不改变任何运行行为），然后删掉旧表。0013 一个字都不改：已应用的迁移只读（见 migrate.ts 的 sha256 校验）。
--
-- 语法约定同 0009~0015：建表/删表一律 IF NOT EXISTS / IF EXISTS，搬迁用 DO 块先探表在不在——
-- 本仓库的迁移允许目标机上被人手跑过一遍，重复执行不能炸。

CREATE TABLE IF NOT EXISTS "model_default" (
  "singleton" boolean PRIMARY KEY DEFAULT true,
  "provider_id" text NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "model_default_singleton_chk" CHECK ("singleton")
);
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.model_roles') IS NOT NULL THEN
    INSERT INTO "model_default" ("singleton", "provider_id", "model", "updated_at")
    SELECT true, "provider_id", "model", "updated_at" FROM "model_roles" WHERE "role" = 'agent'
    ON CONFLICT ("singleton") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "repo_model_override" (
  "repo" text PRIMARY KEY,
  "provider_id" text NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.repo_model_roles') IS NOT NULL THEN
    INSERT INTO "repo_model_override" ("repo", "provider_id", "model", "updated_at")
    SELECT "repo", "provider_id", "model", "updated_at" FROM "repo_model_roles" WHERE "role" = 'agent'
    ON CONFLICT ("repo") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS "repo_model_roles";
--> statement-breakpoint

DROP TABLE IF EXISTS "model_roles";
