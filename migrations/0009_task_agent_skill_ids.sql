-- `tasks.agent_skill_ids`：这条 agent 任务**点名**的技能 id 列表（`["label-triage"]`）。
--
-- 为什么落库而不是让装配层再从文本里猜：
-- webhook 侧组装消息时已经把 `@bot /label-triage ...` 里的 token **从正文删掉**并改写成一句
-- 指令（`agent/message.ts` 的 `findSkillMentions` + `renderSkillDirective`）。于是正文里根本
-- 不再出现 `/label-triage`，装配层（`app/worker-deps.ts`）用正则去文本里找**永远找不到**，
-- 技能正文也就永远不注入 —— 表现为「@bot /技能名 毫无作用」（issue #26 实测）。
--
-- 存 id（不带前导 `/`，与 `agent_messages`、注册表键的规范化口径一致）；空数组 = 没有点名。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agent_skill_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- 同一条信息也要跟着消息走：dispatcher 是从 `agent_messages` 那行读出来再建任务的
-- （`readMessage` → `insertAgentTask`），只在 tasks 上有值的话，中间这一跳会丢。
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "skill_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- 只为「按点名技能回溯任务」这类排查用；写入路径是按主键，加这个索引成本很低。
CREATE INDEX IF NOT EXISTS "tasks_agent_skill_ids_idx"
  ON "tasks" USING gin ("agent_skill_ids");
--> statement-breakpoint
DELETE FROM "skills" WHERE "repo" IS NULL OR btrim("repo") = ''
