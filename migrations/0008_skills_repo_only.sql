-- 0008：技能只能是项目级 —— 移除「全局技能」这个概念。
--
-- 为什么删数据、却**保留 `skills.scope` 列**：
--  - 概念已经从产品里移除：`GET /api/skills` 必须给 `repo`，`POST /api/skills` /
--    `POST /api/skills/import` 不再接受 `scope`（`packages/contract/src/skills.ts`），
--    所以历史上 `scope <> 'repo'` 的行（连同版本与审计）在这里清掉；
--  - 但**列先保留**：`skills.scope` 仍在 `SELECT_COLUMNS` 与 `skillListItemSchema.scope`
--    里，面板也还在读它。删列会要求「服务端与面板同一次发版」，而这里只要把取值钉死成
--    `'repo'` 就够——概念消失了，物理列晚一步再删（那时的迁移是纯 DDL，没有数据语义）。
--  - `repo` 同步收紧成 NOT NULL：没有「不属于任何项目」的技能，唯一索引里的
--    `coalesce(repo,'')` 因此变成恒等逻辑，但索引本身不动（改名/重建对查询没有收益）。
--
-- 回滚：**不可逆**。被删掉的全局技能正文不在库里（正文在磁盘
--       `<PI_BOT_DATA_DIR>/skills/<id>/<version>/`），要恢复只能连同 API 一起回滚，
--       再按 `skills_audit` 里剩下的记录重建。约束与默认值可单独回滚：
--         ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_scope_repo_only";
--         ALTER TABLE "skills" ALTER COLUMN "scope" DROP DEFAULT;
--         ALTER TABLE "skills" ALTER COLUMN "repo" DROP NOT NULL;
--
-- 幂等：每条语句都能重复执行（delete 按条件删、drop constraint if exists、
--       set default/not null 重复设置无副作用）。

-- 1. 先删版本与审计（没有外键级联，顺序必须手工保证；`repo is null` 的历史脏行一起清）。
DELETE FROM "skill_versions"
 WHERE "skill_id" IN (SELECT "id" FROM "skills" WHERE "scope" <> 'repo' OR "repo" IS NULL);
--> statement-breakpoint
DELETE FROM "skills_audit"
 WHERE "skill_id" IN (SELECT "id" FROM "skills" WHERE "scope" <> 'repo' OR "repo" IS NULL);
--> statement-breakpoint
-- 2. 再删技能本体：全局技能（`scope <> 'repo'`）与「没有项目」的脏行。
DELETE FROM "skills" WHERE "scope" <> 'repo' OR "repo" IS NULL;
--> statement-breakpoint
-- 3. 把 scope 钉死成 'repo'（先归一历史值，再加约束）。
UPDATE "skills" SET "scope" = 'repo' WHERE "scope" IS DISTINCT FROM 'repo';
--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "scope" SET DEFAULT 'repo';
--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_scope_repo_only";
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_scope_repo_only" CHECK ("scope" = 'repo');
--> statement-breakpoint
-- 4. repo 收成必填（上面已经把 `repo IS NULL` 的行删干净了）。
ALTER TABLE "skills" ALTER COLUMN "repo" SET NOT NULL;
