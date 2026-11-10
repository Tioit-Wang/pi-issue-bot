-- 0001: 自由问答（`@bot 提问`）要把问题正文带进任务行。
--
-- 为什么单独一列而不是塞进 `tasks.command`：契约里 `command` 是 `max(64)` 的命令名，
-- 面板与 `/api/tasks` 都按这个上限序列化；把 base64 问题正文塞进去会让接口 500
-- （`Response doesn't match the schema`），实测于 2026-11-10。
--
-- `null` 表示不是自由问答任务（`/issue-triage`、`auto:triage` 等都不写这列）。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "prompt_text" text;
