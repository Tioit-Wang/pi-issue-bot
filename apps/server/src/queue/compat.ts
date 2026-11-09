/**
 * 编译期契约：**真实的 `pg.Pool` / `PgBoss` 必须能直接喂给本仓库的注入点**。
 *
 * 为什么要这个文件：`db/` 与 `queue/` 的函数都吃「结构性最小接口」（`TransactionalPool` /
 * `SqlExecutor` / `QueueBoss` / `WorkBoss` / `QueueAdminBoss` / `ScheduleAdminBoss`），
 * 好处是单测能塞假对象；代价是**接口与真实库的兼容性只由类型检查保证**。
 * 一旦 pg 或 pg-boss 的类型变了（比如 `send` 的重载改了），不写这些断言的后果是：
 * 单测全绿，直到 `worker/` 接线那天才在别处报一个看不懂的错。
 *
 * 所以这里用纯类型断言把它们钉住：`Assert<... extends ... ? true : false>` 编译不过就说明漂移了。
 * 没有运行时副作用（全是 type），也不导出任何值。
 */
import type { Pool as PgPool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { SqlExecutor, TransactionalPool } from '../db/pool.ts';
import type { QueueAdminBoss, ScheduleAdminBoss } from './definitions.ts';
import type { QueueBoss, WorkBoss } from './boss.ts';

type Assert<T extends true> = T;

/** `createPool()` 的产物可以直接用于 `withTransaction` / `ping` / `migrate` */
type PgPoolIsTransactionalPool = Assert<PgPool extends TransactionalPool ? true : false>;
type PgPoolIsSqlExecutor = Assert<PgPool extends SqlExecutor ? true : false>;

/** `createBoss()` 的产物可以直接用于入队、取消、建队列、注册定时任务、注册 worker */
type PgBossIsQueueBoss = Assert<PgBoss extends QueueBoss ? true : false>;
type PgBossIsQueueAdmin = Assert<PgBoss extends QueueAdminBoss ? true : false>;
type PgBossIsScheduleAdmin = Assert<PgBoss extends ScheduleAdminBoss ? true : false>;
type PgBossIsWorkBoss = Assert<PgBoss extends WorkBoss ? true : false>;

/** 汇总导出，便于在需要时被引用（也让上面这些别名不算「未使用」）。 */
export type DbQueueCompatibilityChecks = [
  PgPoolIsTransactionalPool,
  PgPoolIsSqlExecutor,
  PgBossIsQueueBoss,
  PgBossIsQueueAdmin,
  PgBossIsScheduleAdmin,
  PgBossIsWorkBoss,
];
