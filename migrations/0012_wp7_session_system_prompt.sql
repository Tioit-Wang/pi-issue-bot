-- 需求 §6.7 SL-1（系统提示词）：会话实际使用的身份说明**可查**。
--
-- 为什么需要这一列：RACP 只有 `session/create` 带 `systemPrompt`（`turn/start` 的载荷是
-- `input.{messageId,text}`，`session/attach` 只吃 `sessionId`），所以复用轮次里做不到「每次调用都带」。
-- 能做的是把「这条会话用的是哪一份身份说明」落下来，让面板与排查不必拿当前项目配置去猜
-- （配置随时会变，历史会话不跟着变）。
--
-- 只加列、不改任何旧列，也不回填：NULL = 还没有任何一次触发记录过（例如投递全被拒绝）。
-- 语句带 IF NOT EXISTS（同 0009/0010/0011 的处理：本仓库的迁移在目标机上可能被人手跑过一遍）。

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "system_prompt" text;
