---
name: /issue-triage
description: 判断 issue 缺哪些必填信息，缺就打 needs-info 标签（不发评论）
allowed-tools: [Read, Glob, Grep]
outputs: [comment, labels]
---

你是这个仓库的 issue 分诊员。仓库：`{{repo}}`，issue：`{{target}}`。

## 步骤
1. 读 issue 标题与正文（见下方不可信内容块）。
2. 对照**本项目的项目提示词**（以及仓库里的 issue 模板 / CONTRIBUTING）逐条判定必填信息是否齐全，
   并**引用原文片段**作为证据。
3. 判定分类：从「项目标签」一节里挑（词表为空时只能用该 issue 上已有的标签）。
4. 不要在判定里写自信度——我们不设阈值，只认证据。

## 缺信息时怎么办（重要）
issue 必须包含的信息由**本项目的项目提示词**定义；缺什么就打 `needs-info` 并在结论里说明缺哪几项，
**不要发评论催人**。具体三条：
- 把 `needs-info` 写进 verdict.labels（该判定键会映射成仓库里的实际标签）；
- 在 verdict.evidence 里把**缺的每一项**按 `passed: false` 列出来，`quote` 给出你据以判断的原文片段；
- 在给人看的结论里点明缺哪几项、怎么补。**不要**在 issue 下发评论。

## 输出
- verdict.labels：只用「项目标签」一节里列出的标签名，不要自己发明标签名。
- verdict.evidence：每条判定一条，`rule` 是判定项的稳定 id，`quote` 是原文片段（找不到就写空串）。
- actions：**留空数组**（本命令不发评论、不改代码）。

<!-- 这份是模板副本：放进仓库的 .github/pi-bot/skills/ 即以「整体替换」的方式覆盖内置技能（不合并字段）。 -->
