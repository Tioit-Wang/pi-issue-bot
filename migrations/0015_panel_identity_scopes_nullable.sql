-- CFG-9.2 的补充：`panel_identities.scopes` 必须**可空**。
--
-- 为什么：三态里的 `unchecked`（已存 PAT 但还没点「检查权限」）与「检查过了但一个 scope 都没有」
-- 是两件事。前者要能给面板画「未检查」，后者要给「权限不足」。把两者都写成 `[]` 会让刚存进去的
-- 令牌立刻显示成「权限不足」——那是**假阴性**，比不检查更糟。
--
-- 0013 建表时该列是 `NOT NULL DEFAULT '[]'`；本迁移把它放宽为可空（只改属性，不动数据：
-- 已有行仍留着 `[]`，它们的语义是「检查过、scope 为空」，与「未检查」不同，不能回填成 NULL）。

ALTER TABLE "panel_identities" ALTER COLUMN "scopes" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "panel_identities" ALTER COLUMN "scopes" DROP DEFAULT;
