-- 存量纠正（0009 已在环境上跑过，后续补的修法必须单独成一条迁移，否则不会被应用）。
--
-- 1) `repos.settings.agent.on_opened / on_edited` 的历史默认值 `format-check` 是一个**不存在**
--    的技能 id：每个 issue opened/edited 都在指示模型「先加载 format-check」，模型只能回报
--    「加载不到」，然后去翻退役的 `.github/pi-bot.yml`（issue #26/#27 实测）。
--    契约默认值已改成 `issue-format`，这里把库里已有的旧值一并纠正（只动这一个已知坏值）。
-- 2) 默认技能被早期代码写成了 `source='upload'`，面板因此把它们当成用户上传的副本
--    （`?source=builtin` 查询永远为空）。按名字把这三个纠正回 `builtin`；内容不动。
UPDATE "repos"
   SET "settings" = jsonb_set("settings", '{agent,on_opened}', '"issue-format"')
 WHERE "settings" #>> '{agent,on_opened}' = 'format-check';
--> statement-breakpoint
UPDATE "repos"
   SET "settings" = jsonb_set("settings", '{agent,on_edited}', '"issue-format"')
 WHERE "settings" #>> '{agent,on_edited}' = 'format-check';
--> statement-breakpoint
UPDATE "skills"
   SET "source" = 'builtin'
 WHERE "name" IN ('/issue-format', '/label-triage', '/issue-analysis')
   AND "source" <> 'builtin';
