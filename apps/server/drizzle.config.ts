/**
 * drizzle-kit 配置：**只用于 `generate`**（产出 `migrations/*.sql`），不用于 `push` / `migrate`。
 *
 * 为什么只 generate（docs/tech-plan.md §7.2、§8.4）：
 *  - 真跑迁移是 `pi-bot migrate` → `apps/server/src/db/migrate.ts` 的 `runMigrations()`，
 *    它有自己的账本表 `schema_migrations`，按文件名顺序逐条在事务里执行。
 *    如果同时让 `drizzle-kit migrate` 跑，它会用另一套账本（`__drizzle_migrations`）再执行一遍，
 *    于是同一条 DDL 被应用两次 → 已部署环境直接报错。**本仓库只有一本账**，就是 migrate.ts。
 *  - 本机没有 PostgreSQL（dev-plan §13.1），所以 `push`/`migrate` 在这里根本跑不了；
 *    `generate` 是纯离线的（读 schema.ts + 比对 `migrations/meta/` 快照）。
 *
 * 跑法（在 apps/server 下，config 的 schema/out 是相对本文件的路径）：
 *   pnpm --filter @pi-issue-bot/server exec drizzle-kit generate
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  /** 数据模型唯一事实源 */
  schema: './src/db/schema.ts',
  /** 迁移产物落在仓库根（dev-setup §4：`migrations/` 归数据库 owner） */
  out: '../../migrations',
  /** 生成时打印变化明细，便于 review 每个迁移 */
  verbose: true,
  /** 交互式提问（删除列/表时）默认拒绝，避免误操作静默进迁移文件 */
  strict: true,
});
