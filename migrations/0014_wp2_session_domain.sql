-- BR-5 会话域隔离（需求 §5.3 / FR-3.1 的边界）：issue 与 PR 必须**各自独立**的会话。
--
-- 为什么必须加这一列：GitHub 的 PR 编号与 issue 编号**同属一个序列**，同一仓库里
-- PR #7 与 issue #7 是两件不同的事。旧主键只有 `(repo, issue_number)`，于是：
--  - PR 上的评论被写进 issue #7 的会话行 → 两个域**上下文互相污染**（agent 会把 PR 的结论
--    当成 issue 的历史）；
--  - issue #7 关单回收沙箱时那条 UPDATE 顺带把 PR #7 的会话也标成 `idle`。
--
-- 取舍（报告里也写了）：**保留列名 `issue_number`**。对 PR 它同样是「编号」，语义靠 `domain`
-- 一列已经完整表达；改名会牵动 `queries/**`、面板、历史迁移与本轮之外的写入方，风险远大于收益。
--
-- 回填策略（**有损但有据**）：既有行一律标 `issue`。历史数据里没有任何信息能区分
-- 「这行是 issue 的还是 PR 的」（被执行的都是 issue 事件：`trigger/decide.ts` 对
-- `pull_request.*` 固定判 `pr-ignored`，从来不入队、不开会话），所以「全是 issue」是唯一
-- 有依据的默认，而不是随手挑一个值。
--
-- 语句一律带 IF NOT EXISTS / IF EXISTS（与 0009–0012 同口径：本仓库的迁移在目标机上
-- 可能已经被人手跑过一遍）。

-- 1) 加域列。DEFAULT 'issue' 同时承担两件事：新列不可空 + 既有行自动回填。
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "domain" text NOT NULL DEFAULT 'issue';
--> statement-breakpoint

-- 2) 显式回填（幂等：`UPDATE ... WHERE domain IS NULL` 在 DEFAULT 已填过的情况下匹配 0 行；
--    留着它是因为「先加列、后回填」是可重放脚本的常见形态，不能让回填只依赖列默认值）。
UPDATE "agent_sessions" SET "domain" = 'issue' WHERE "domain" IS NULL;
--> statement-breakpoint

-- 3) 取值面收口：只有 issue / pr 两个域。放在库里而不是只靠应用层，是因为
--    「写错一个域」的后果是会话串域，属于数据事故而不是排版问题。
ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_domain_check";
--> statement-breakpoint

ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_domain_check" CHECK ("domain" IN ('issue', 'pr'));
--> statement-breakpoint

-- 4) 主键换成三段键。
--
-- 为什么必须包在 DO 里做条件判断，而不是「DROP 旧主键 + ADD 新主键」两句直写：
-- 本仓库的迁移在目标机上可能已经被人手跑过一遍（0009–0012 同一条约定），
-- 那时 `ADD CONSTRAINT ... PRIMARY KEY` 会因为「表上已有一个主键」而整条失败。
-- 判据用 `pg_get_constraintdef`（不是约束名）：名字只是 drizzle 生成的，定义才是语义。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (repo, domain, issue_number)'
  ) THEN
    RETURN;
  END IF;
  -- 旧主键名来自 drizzle 的默认命名（0006_agent.sql:27）；另外顺手清掉手建环境里的 `_pkey`。
  ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_repo_issue_number_pk";
  ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_pkey";
  ALTER TABLE "agent_sessions"
    ADD CONSTRAINT "agent_sessions_repo_domain_issue_number_pk"
    PRIMARY KEY ("repo", "domain", "issue_number");
END $$;

-- 5) 域内点查的索引：主键已经覆盖 `(repo, domain, issue_number)`，
--    但面板与排障更常按「仓库 + 域」扫一片，避免拿主键前缀去猜。
CREATE INDEX IF NOT EXISTS "agent_sessions_repo_domain_idx"
  ON "agent_sessions" USING btree ("repo", "domain");
