/**
 * 查询层的类型入口：**只从契约取类型，不手抄 DTO**（E8）。
 *
 * 为什么是相对路径而不是 `@pi-issue-bot/contract`：
 * 本机 pnpm 安装没有为 workspace 包建立链接（`apps/server/node_modules/@pi-issue-bot` 不存在），
 * 而 session 不允许 `pnpm add` / `pnpm install`。用相对路径引入同一个源文件，
 * 语义与包名完全一致（`exports` 指向 `src/index.ts`），PM 补齐依赖后可以一行换回包名。
 *
 * `z.infer` 在这里是**类型运算**：`import type` + `typeof` 不会产生运行时代码，
 * 因此 `queries/` 运行期只依赖 `pg`（`CONTRACT_VERSION` 这个唯一运行时值单独值导入）。
 */
import type { z } from 'zod';
import type {
  auditQuerySchema,
  auditResponseSchema,
  costsQuerySchema,
  costsResponseSchema,
  deliveriesQuerySchema,
  deliveriesResponseSchema,
  issueTraceResponseSchema,
  overviewQuerySchema,
  overviewResponseSchema,
  qualityQuerySchema,
  revertsResponseSchema,
  systemQuerySchema,
  systemResponseSchema,
  taskDetailResponseSchema,
  tasksQuerySchema,
  tasksResponseSchema,
} from '../../../../packages/contract/src/index.ts';

/* ── 查询入参（与 `*QuerySchema` 一一对应，名字只去掉 Schema 后缀） ─────────────── */
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;
export type TasksQuery = z.infer<typeof tasksQuerySchema>;
export type CostsQuery = z.infer<typeof costsQuerySchema>;
export type QualityQuery = z.infer<typeof qualityQuerySchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
/** `/api/system` 的查询参数（`repo` 只收窄 repos / flags）。 */
export type SystemQuery = z.infer<typeof systemQuerySchema>;

/**
 * `/api/repos/{owner}/{name}/deliveries` 的筛选与分页（仓库在路径里）。
 *
 * 索引签名与 `*QuerySchema` 一一对应，**唯一放宽的字段是 `limit`**：`pageLimitSchema` 带
 * `.default(50)`，`z.infer`（输出类型）把它变成必填，而「调用方没传就按默认值」本来就是契约的意思。
 * 放宽后 http 路由（Fastify 校验后的 query 是输出类型，可赋给这个类型）与测试都能只给关心的字段；
 * 实现里用 `query.limit ?? 50` 兜底，不依赖调用方补齐。
 */
export type DeliveriesQuery = Omit<z.infer<typeof deliveriesQuerySchema>, 'limit'> & {
  readonly limit?: number | undefined;
};

/* ── 响应类型（返回值必须能被同名 `*ResponseSchema.parse()` 通过） ──────────────── */
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type TasksResponse = z.infer<typeof tasksResponseSchema>;
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;
export type CostsResponse = z.infer<typeof costsResponseSchema>;
export type RevertsResponse = z.infer<typeof revertsResponseSchema>;
export type AuditResponse = z.infer<typeof auditResponseSchema>;
export type SystemResponse = z.infer<typeof systemResponseSchema>;
/** 投递留痕列表（BR-6：未触发的投递也要能在后台查到原因）。 */
export type DeliveriesResponse = z.infer<typeof deliveriesResponseSchema>;

/* ── 响应里被反复引用的子类型 ──────────────────────────────────────────────── */
export type TaskListItem = TaskDetailResponse['task'];
export type RunSummary = TaskDetailResponse['runs'][number];
export type RunEventRecord = TaskDetailResponse['events'][number];
export type EnvelopeRecord = TaskDetailResponse['envelopes'][number];
export type ActionRecord = TaskDetailResponse['actions'][number];
export type TaskDiff = TaskDetailResponse['diff'];
export type AuditRow = AuditResponse['items'][number];
export type CostBucket = CostsResponse['byRepo'][number];
export type RevertBucket = RevertsResponse['byCommand'][number];
export type DeliveryRow = DeliveriesResponse['items'][number];
/** 一个 issue 的完整链路响应（FR-6.1/6.2/6.3 + FR-6.4③ + NFR-6）。 */
export type IssueTraceResponse = z.infer<typeof issueTraceResponseSchema>;
export type IssueTraceRun = IssueTraceResponse['runs'][number];
export type IssueTraceToolCall = IssueTraceRun['toolCalls'][number];
export type IssueTraceAction = IssueTraceRun['actions'][number];
