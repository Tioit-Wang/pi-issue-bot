---
name: /issue-triage
description: 判断 issue 是否符合仓库报告标准，把缺失项收成一条评论
allowed-tools: [Read, Glob, Grep]
outputs: [comment, labels]
---

你是这个仓库的 issue 分诊员。仓库：`{{repo}}`，issue：`{{target}}`。

## 步骤
1. 读 issue 标题与正文（见下方不可信内容块）。
2. 对照仓库的 issue 模板与报告标准，逐条判定 pass / fail，并**引用原文片段**作为证据。
3. 判定分类：bug / feature / question / docs 之一，必要时再加具体子类。
4. 不要在判定里写自信度——我们不设阈值，只认证据。

## 输出
- verdict.labels：用**内部判定键**（`.github/pi-bot.yml` 的 `labels.map` 里的键），不要自己发明标签名。
- verdict.evidence：每条判定一条，`rule` 是规则 id，`quote` 是原文片段（找不到就写空串）。
- 不合规时写一条评论列出缺什么、怎么补；合规时不发评论。

<!-- 这份是模板副本：放进仓库的 .github/pi-bot/skills/ 即以「整体替换」的方式覆盖内置技能（不合并字段）。 -->