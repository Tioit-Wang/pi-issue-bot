/**
 * `writeback/v21/` 的公开出口。
 *
 * 三个模块各管一段，互不 import（`execute.ts` 是唯一把它们拼起来的地方）：
 *  - `labels.ts`：`label` 动作的目标态对齐（纯函数）；
 *  - `comments.ts`：`comment` 动作的槽位标记/覆盖判定（纯函数）；
 *  - `execute.ts`：七类动作的顺序执行器（依赖注入，不 import `github/*`）。
 *
 * 装配层只从这里 import（`docs/v21-contract.md` §7 的 WS3 交付面）。
 */
export * from './labels.ts';
export * from './comments.ts';
export * from './execute.ts';
