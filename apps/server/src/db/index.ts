/**
 * `db/` 的公共出口。**依赖方向**：`queries/`、`worker/`、`http/` 只能经这个 barrel 用数据层
 * （tech-plan §8.2：http/api → queries → db），不要各自伸手去点 `./schema.ts` 之外的文件。
 *
 * 这里同时导出常用行的推断类型（`TaskRow` 等）：后续 queries/worker 写 SQL 时不用重复推字段，
 * 也不需要在 `@pi-issue-bot/contract` 里手抄 DTO——契约层另有一份 zod（E8），两者各管一头。
 */
export {
  ALL_TABLE_NAMES,
  ALL_TABLES,
  actions,
  botLabels,
  degeneracyHits,
  envelopes,
  FAILURE_CLASS,
  hostCredentials,
  issueFingerprints,
  issueStates,
  metricsDaily,
  panelSessions,
  repos,
  RUNTIME_FLAG_KEY,
  runEvents,
  runs,
  runtimeFlags,
  TARGET_KIND,
  TASK_SOURCE,
  TASK_STATUS,
  tasks,
  usageCosts,
  webhookDeliveries,
} from './schema.ts';

export { closePool, createPool, describeTarget, ping, withTransaction } from './pool.ts';
export type {
  CreatePoolOptions,
  PoolClient,
  SqlExecutor,
  SqlResult,
  TransactionalPool,
  TransactionClient,
} from './pool.ts';

export {
  LEDGER_DDL,
  MIGRATION_LEDGER_TABLE,
  MIGRATION_SEQ_BLOCKS,
  STATEMENT_BREAKPOINT,
  checksumOf,
  createPgMigrationExecutor,
  migrate,
  parseMigrationFileName,
  planMigrations,
  readMigrationsFromDir,
  runMigrations,
  splitSqlStatements,
  toMigrationFile,
} from './migrate.ts';
export type {
  AppliedMigration,
  MigrationExecutor,
  MigrationFile,
  MigrationLogger,
  MigrationPlan,
  MigrationRunResult,
} from './migrate.ts';

/* ── 常用行的推断类型（drizzle 的 $inferSelect / $inferInsert） ─────────────── */

import type {
  actions as actionsTable,
  botLabels as botLabelsTable,
  envelopes as envelopesTable,
  issueStates as issueStatesTable,
  metricsDaily as metricsDailyTable,
  repos as reposTable,
  runEvents as runEventsTable,
  runs as runsTable,
  tasks as tasksTable,
  usageCosts as usageCostsTable,
  webhookDeliveries as webhookDeliveriesTable,
} from './schema.ts';

export type WebhookDeliveryRow = typeof webhookDeliveriesTable.$inferSelect;
export type NewWebhookDeliveryRow = typeof webhookDeliveriesTable.$inferInsert;
export type RepoRow = typeof reposTable.$inferSelect;
export type TaskRow = typeof tasksTable.$inferSelect;
export type NewTaskRow = typeof tasksTable.$inferInsert;
export type RunRow = typeof runsTable.$inferSelect;
export type NewRunRow = typeof runsTable.$inferInsert;
export type RunEventRow = typeof runEventsTable.$inferSelect;
export type NewRunEventRow = typeof runEventsTable.$inferInsert;
export type EnvelopeRow = typeof envelopesTable.$inferSelect;
export type NewEnvelopeRow = typeof envelopesTable.$inferInsert;
export type ActionRow = typeof actionsTable.$inferSelect;
export type NewActionRow = typeof actionsTable.$inferInsert;
export type BotLabelRow = typeof botLabelsTable.$inferSelect;
export type IssueStateRow = typeof issueStatesTable.$inferSelect;
export type UsageCostRow = typeof usageCostsTable.$inferSelect;
export type MetricsDailyRow = typeof metricsDailyTable.$inferSelect;
export type NewMetricsDailyRow = typeof metricsDailyTable.$inferInsert;
