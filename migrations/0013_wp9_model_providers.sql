-- 需求 §6.8 / §6.9（CFG-8.1 / CFG-8.2 / CFG-8.3 / CFG-9.1 / CFG-9.2）：供应商、模型角色四档、
-- 项目级覆盖、面板个人 PAT 与「退回 bot」留痕。
--
-- 本迁移**只建表**，不改任何旧列的类型/默认值，也不回填数据：
--  - `model_providers`：一家供应商一条行（名称 / base URL / key 密文与掩码 / 连通性 / 可用 model 列表）。
--    key **只存密文**（`v1:<iv>:<tag>:<ct>`，AES-256-GCM，与 `host_credentials.token_enc` 同一实现），
--    明文永不落库、不进容器（需求 §6.8「安全」；AGENTS 不变式 I9）。
--    `models` 是**模型目录**：`[{"model":"deepseek-v4.1-flash","input_usd_per_mtok":0.3,"output_usd_per_mtok":1.2}]`。
--    单价挂在模型上而不是角色上：角色是「四档各绑一个模型」，同一个模型被两档共用时单价必须一致，
--    而项目级覆盖换模型之后单价仍然查得到（挂在角色上就会出现「覆盖后单价未知」）。
--  - `model_roles`：四档角色（agent / format / classify / fallback）的**全局**绑定（供应商 + 模型）。
--  - `repo_model_roles`：项目级覆盖。**没有行 = 继承全局**（CFG-8.3 的「继承全局（模型名）」），
--    有行才覆盖——所以这张表的稀疏性本身就是契约的一部分，不做 seed。
--  - `panel_identities`：按用户存的个人 PAT（密文 + 掩码 + scope 快照 + 过期时刻 + 最近判定态）。
--  - `identity_fallbacks`：令牌不可用（缺失 / scope 不足 / 过期 / 无效）而退回 bot 的留痕，可查。
--
-- 语句一律带 IF NOT EXISTS：本仓库的迁移在目标机上可能被人手跑过一遍（见 0009/0010/0011/0012）。

-- 1) 供应商（含模型目录与单价）
CREATE TABLE IF NOT EXISTS "model_providers" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "base_url" text,
  "key_enc" text,
  "key_mask" text,
  "models" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'unknown',
  "latency_ms" integer,
  "checked_at" timestamp with time zone,
  "check_error" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- 2) 模型角色四档（全局绑定）
CREATE TABLE IF NOT EXISTS "model_roles" (
  "role" text PRIMARY KEY,
  "provider_id" text NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- 3) 项目级覆盖（稀疏：没有行 = 继承全局）
CREATE TABLE IF NOT EXISTS "repo_model_roles" (
  "repo" text NOT NULL,
  "role" text NOT NULL,
  "provider_id" text NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "repo_model_roles_repo_role_pk" PRIMARY KEY("repo", "role")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_model_roles_repo_idx" ON "repo_model_roles" ("repo");
--> statement-breakpoint

-- 4) 面板身份（个人 PAT）
CREATE TABLE IF NOT EXISTS "panel_identities" (
  "login" text PRIMARY KEY,
  "token_enc" text NOT NULL,
  "token_mask" text NOT NULL,
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "token_expires_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'unchecked',
  "checked_at" timestamp with time zone,
  "check_detail" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- 5) 「退回 bot」留痕（CFG-9.2：不得静默成功，也不得静默失败）
CREATE TABLE IF NOT EXISTS "identity_fallbacks" (
  "id" bigserial PRIMARY KEY,
  "login" text,
  "state" text NOT NULL,
  "operation" text NOT NULL,
  "target" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_fallbacks_created_at_idx" ON "identity_fallbacks" ("created_at");
