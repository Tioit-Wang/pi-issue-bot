/**
 * 契约注册表：`名字 → zod schema`。
 *
 * 用途只有两个：`scripts/gen-openapi.ts` 生成 `openapi/pi-bot.openapi.json`，
 * 以及单测里「所有导出的 schema 都能生成合法 JSON Schema」的兜底断言。
 * 名字一旦发布就是 OpenAPI 的组件名，**只许加，不许改名**（dev-plan §7 契约冻结规则）。
 */
import type { z } from 'zod';
import {
  addRepoRequestSchema,
  auditQuerySchema,
  auditResponseSchema,
  costsQuerySchema,
  costsResponseSchema,
  issueFeedbackEventSchema,
  issueSessionParamsSchema,
  issueSessionResponseSchema,
  issuesListResponseSchema,
  issuesQuerySchema,
  overviewQuerySchema,
  overviewResponseSchema,
  qualityQuerySchema,
  repoSummarySchema,
  repoSettingsResponseSchema,
  reposResponseSchema,
  revertsResponseSchema,
  saveRepoSettingsRequestSchema,
  systemQuerySchema,
  systemRepoSchema,
  systemResponseSchema,
  taskDetailResponseSchema,
  tasksQuerySchema,
  tasksResponseSchema,
  webhookAcceptedResponseSchema,
} from './api.ts';
import { errorBodySchema } from './common.ts';
import { labelsConfigSchema, repoSettingsSchema } from './repo-config.ts';
import { skillFrontmatterSchema } from './skills.ts';
import { triggersConfigSchema } from './trigger.ts';

/** 响应体 schema（OpenAPI `components.schemas` 的成员）。 */
export const responseSchemas = {
  ErrorBody: errorBodySchema,
  OverviewResponse: overviewResponseSchema,
  TasksResponse: tasksResponseSchema,
  TaskDetailResponse: taskDetailResponseSchema,
  CostsResponse: costsResponseSchema,
  RevertsResponse: revertsResponseSchema,
  AuditResponse: auditResponseSchema,
  SystemResponse: systemResponseSchema,
  WebhookAcceptedResponse: webhookAcceptedResponseSchema,
  /** 按 issue 的会话视图（`docs/spec/ux-issue-sessions.md` §3）。 */
  IssuesListResponse: issuesListResponseSchema,
  IssueSessionResponse: issueSessionResponseSchema,
  /** 无感反馈与打标判定的两个子形状（W3-H：面板统计/详情要用，单列出来便于引用）。 */
  IssueFeedbackEvent: issueFeedbackEventSchema,
  /** 仓库配置（`repos.settings` 的 jsonb 形状）与它的子段：面板要展示字段说明，一并发布。 */
  RepoSettings: repoSettingsSchema,
  RepoLabels: labelsConfigSchema,
  /** 触发体系（`triggers` 段）：面板要展示字段说明。 */
  TriggersConfig: triggersConfigSchema,
  SkillFrontmatter: skillFrontmatterSchema,
  /**
   * 仓库写面（`/api/repos/*`，W3-H 补的契约）。
   *
   * `SaveRepoSettingsRequest` 是 `RepoSettings` 的**别名**（请求体就是 settings 本身）：
   * 组件里会生成 `{$ref: '#/components/schemas/RepoSettings'}`，不复制第二份形状。
   */
  RepoSummary: repoSummarySchema,
  ReposResponse: reposResponseSchema,
  RepoSettingsResponse: repoSettingsResponseSchema,
  SaveRepoSettingsRequest: saveRepoSettingsRequestSchema,
  AddRepoRequest: addRepoRequestSchema,
  /** `SystemResponse.repos[]` 的行（`repos` 表的投影 + 老字段别名）。 */
  SystemRepo: systemRepoSchema,
} as const satisfies Record<string, z.ZodType>;

/** 查询参数 schema（OpenAPI 的 `parameters` 由它推导，不手写第二份）。 */
export const querySchemas = {
  overviewQuery: overviewQuerySchema,
  tasksQuery: tasksQuerySchema,
  costsQuery: costsQuerySchema,
  qualityQuery: qualityQuerySchema,
  auditQuery: auditQuerySchema,
  /** `/api/issues` 的筛选与分页（`kind` 默认 `issue`、`limit` 默认 30）。 */
  issuesQuery: issuesQuerySchema,
  /** `/api/system` 的 `?repo=`（只收窄 `repos` 与 `flags`）。 */
  systemQuery: systemQuerySchema,
} as const satisfies Record<string, z.ZodType>;

/**
 * 路径参数 schema（OpenAPI 的 `in: path` 由它推导）。
 *
 * 单独一张表：这些 schema **不能**放进 `querySchemas`——那里的约定是「空对象也必须合法」
 * （`packages/contract/test/contract.test.ts` 逐个断言 `safeParse({})`），而路径参数是必填的。
 */
export const paramsSchemas = {
  issueSessionParams: issueSessionParamsSchema,
} as const satisfies Record<string, z.ZodType>;

export type ResponseSchemaName = keyof typeof responseSchemas;
export type QuerySchemaName = keyof typeof querySchemas;
export type ParamSchemaName = keyof typeof paramsSchemas;
