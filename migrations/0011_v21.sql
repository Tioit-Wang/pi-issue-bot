-- v2.1（`docs/v21-contract.md`）：事件判定留痕、会话状态、评论槽位、压缩记录。
--
-- 本迁移**只加列与建表**，不改任何旧列的类型/默认值（也不回填数据）：
--  - 判定留痕（FR-2.1 / BR-6）：每次投递都要能回答「触发了没有、为什么没触发」，
--    所以 `webhook_deliveries` 加 `decision` + `decision_reason` 两列。可空是刻意的：
--    v2.1 之前的历史投递没有判定结论，而且「还没判定」与「判定为忽略」必须能区分。
--  - 会话状态（FR-3.4）：会话只有 `active` / `idle` 两种运行状态，**没有 ended**；
--    issue 关闭只回收沙箱（`sandbox_id` 置 NULL + `closed_at` 记时刻），会话与历史永久保留。
--    默认 `idle`：会话行先建、沙箱后拉。
--  - 评论槽位（FR-5.3）：同 issue 同槽位只保留一条评论，靠 `(repo, issue_number, slot)` 主键兜底。
--  - 压缩记录（FR-5.6）：每次压缩追加一行，不改写历史，面板按 issue 读压缩史。
--
-- 语句一律 IF NOT EXISTS：本仓库的迁移在目标机上可能被人手跑过一遍（见 0009/0010 的同类处理）。

-- 1) 事件判定留痕
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "decision" text;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "decision_reason" text;
--> statement-breakpoint

-- 2) 会话运行状态（沙箱存在 / 已回收）
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT 'idle';
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "sandbox_id" text;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
--> statement-breakpoint

-- 3) 评论槽位：`(repo, issue_number, slot)` 一条评论
CREATE TABLE IF NOT EXISTS "comment_slots" (
  "repo" text NOT NULL,
  "issue_number" integer NOT NULL,
  "slot" text NOT NULL,
  "comment_id" bigint,
  "body_hash" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comment_slots_repo_issue_number_slot_pk" PRIMARY KEY("repo","issue_number","slot")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comment_slots_repo_issue_idx"
  ON "comment_slots" USING btree ("repo","issue_number");
--> statement-breakpoint

-- 4) 压缩记录：一次压缩一行（`generation` 在同一会话内单调递增）
CREATE TABLE IF NOT EXISTS "agent_compactions" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "repo" text NOT NULL,
  "issue_number" integer NOT NULL,
  "session_id" text NOT NULL,
  "generation" integer DEFAULT 0 NOT NULL,
  "before_tokens" integer DEFAULT 0 NOT NULL,
  "after_tokens" integer DEFAULT 0 NOT NULL,
  "summary_chars" integer DEFAULT 0 NOT NULL,
  "fallback" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_compactions_repo_issue_created_idx"
  ON "agent_compactions" USING btree ("repo","issue_number","created_at")
