/**
 * `@pi-issue-bot/contract` —— 契约叶子包（只依赖 zod）。
 *
 * 内容：
 * - `enums.ts`   状态 / 结果 / 失败分类 / 动作 intent / 改回方式 / 事件 kind / 错误码 / `source='agent'`
 * - `common.ts`  全局标量约定（时间、金额、比例、耗时、分页、错误体）
 * - `api.ts`     接口的响应与查询 schema
 * - `repo-config.ts`  `repos.settings`（`settings.agent`）
 * - `skills.ts`       技能 frontmatter（`docs/spec/contract-skill.md`）
 * - `schemas.ts`      名字 → schema 注册表（OpenAPI 生成的输入）
 *
 * - `trigger.ts`      触发别名 / 蒙版 / 命令解析（纯函数，webhook 与面板共用）
 * - `skill-mentions.ts` 技能命中（`/名字`，纯函数；webhook 与面板预览共用）
 * 使用方：`apps/server/src/{http,queries,config,skills}` 与 `apps/panel`（后者只取类型）。
 * 硬约束：本包不得 import `apps/*` 或其它 workspace 包（lint 的 `no-restricted-paths` 强制）。
 */
export * from './enums.ts';
export * from './common.ts';
export * from './api.ts';
export * from './repo-config.ts';
export * from './trigger.ts';
export * from './skill-mentions.ts';
export * from './skills.ts';
export * from './schemas.ts';

/**
 * 契约版本：`openapi/pi-bot.openapi.json` 的 `info.version` 与 `/api/system` 的
 * `version.contract` 都取它。**改字段就升它**，让面板能在启动时发现「后端换了契约」。
 */
export const CONTRACT_VERSION = '1.0.0';
