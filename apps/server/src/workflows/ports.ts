/**
 * `workflows/` 的注入面（worker 的窄接口 + SQL 端口）。
 *
 * 这一层刻意**不**装配任何东西：workflows 只在「已经有人在跑任务」之后做确定性判定，
 * 所以它只需要两件能力——「把这批输入交给 worker 跑一趟」和「读/写这两张表」。
 *
 * 为什么不直接 import `worker/` 的具体类型做依赖：`TaskRunReport` 有 20 多个字段，
 * 但 workflows 真正用到的只有 4 个。用结构子集做端口，单测就能给一个 4 行对象，
 * 不必伪造整份报告；而 `createTaskRunner()` 的返回值**结构上就满足**这个端口，
 * 生产接线时直接把 runner 传进来即可，不需要适配层。
 */
import type { ActionOutcome, PreparedEnvelope, TaskRunInput } from '../worker/types.ts';

/** 一次 run 里 workflows 需要看到的部分（`TaskRunReport` 的结构子集）。 */
export type RunSummary = {
  /** `RunOutcome`：`succeeded` / `failed` / `timed-out` / `cancelled` / `degenerate-output`。 */
  readonly outcome: string;
  /** 信封装配结果；没找到信封时为 `null`。 */
  readonly envelope: PreparedEnvelope | null;
  /** 写执行器的逐条结果（workflows 不看它，但审计需要一起传下去）。 */
  readonly actions: readonly ActionOutcome[];
  /** 最高优先级的失败分类；成功为 `null`。 */
  readonly failureClass: string | null;
};

/**
 * 「跑一趟任务拿信封」的端口。`TaskRunner`（`worker/index.ts` 的 `createTaskRunner`）满足它。
 */
export type EnvelopeRunner = {
  runTask(input: TaskRunInput): Promise<RunSummary>;
};

/** 一条 SQL 的结果（只需要 `rows` 与可选的 `rowCount`）。 */
export type SqlResult = {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
};

/**
 * 最小 SQL 端口。
 *
 * 与 `config/repo-config.ts::SqlRunner` 同形（那边是 `.github/pi-bot.yml` 的落库端口）。
 * 不用 `pg.Pool` 的具体类型：workflows 的单测里既有真池也有记录调用的假实现，
 * 而这一层对数据库的全部要求就是「跑这条带参数的 SQL」。
 */
export type SqlRunner = {
  query(text: string, values?: readonly unknown[]): Promise<SqlResult>;
};

/** `pg.Pool` 能满足的最小形状（只为让 `toSqlRunner()` 有明确入参类型）。 */
export type PgLikePool = {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: unknown[]; readonly rowCount?: number | null }>;
};

/** 把真池包成 `SqlRunner`（`readonly unknown[]` → `unknown[]` 的一次性转换）。 */
export function toSqlRunner(pool: PgLikePool): SqlRunner {
  return {
    query: (text, values) => pool.query(text, values === undefined ? undefined : [...values]),
  };
}

/** 记录调用的假实现（单测用；生产不用它）。 */
export type RecordedQuery = { readonly text: string; readonly values: readonly unknown[] };