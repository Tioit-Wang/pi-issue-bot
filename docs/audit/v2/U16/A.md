# U16 6.3 占位符清单 · A

> 核查范围：docs/requirements.html 行 1481-1557
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| PH-1 十二个占位符逐个存在 | 已实现 | — |
| PH-2 标签列表格式与边界 | 已实现 | — |
| PH-3 `{{repo.issues}}` 规模控制 | 已实现 | 取数未带 `sort=updated`，「最近 200 条」只对已抓到的两页成立（见额外问题 1） |

## 逐条

### PH-1
- **状态**：已实现
- **证据**：
  - 清单定义：`packages/contract/src/settings-v21.ts:420` — `PROMPT_PLACEHOLDERS` 逐项列 12 条（`issue.author` / `issue.number` / `issue.url` / `issue.content` / `issue.labels` / `issue.title` / `repo.issues` / `comment.author` / `comment.body` / `repo` / `actor` / `event.action`，行 421-432），`settings-v21.ts:446` 派生 `PLACEHOLDER_NAMES`，`:455` 派生 `PLACEHOLDER_NAME_SET` 供面板判未知。
  - 取值实现逐个到位：`apps/server/src/prompt/render.ts:132` `resolvePlaceholder()` 的 switch，`case 'repo'`(:134)、`'actor'`(:136)、`'event.action'`(:138)、`'issue.author'`(:140)、`'issue.number'`(:142)、`'issue.url'`(:144)、`'issue.title'`(:146)、`'issue.content'`(:148)、`'issue.labels'`(:150)、`'comment.author'`(:153)、`'comment.body'`(:155)、`'repo.issues'`(:157) —— 12 个 case 齐全，`default` 返回 `null`（= 未知原样保留，:159-160）。
  - 取值有数据来源（不是空壳）：`apps/server/src/http/webhook-v21.ts:293` `v21RenderContextOf()` 从 webhook 载荷取值 —— `:314` repo、`:315` actor=`sender.login`、`:316` eventAction、`:318` `issue.user.login`、`:319` `issue.number`、`:320` `issue.html_url`、`:321` `issue.title`、`:322` `issue.body`、`:323` labels、`:330-331` `comment.user.login` 与 `comment.body`。
  - 渲染器有生产调用方：`webhook-v21.ts:1007` `handleV21Webhook()` → `buildV21AgentMessage()`（`:450`）→ `:476` `renderV21AgentText()` → `render.ts:193` `renderTemplateAsync()`；结果 `webhook-v21.ts:1034` 作为 `body` 落 `agent_messages.comment_body`。
  - 测试断言具体：`apps/server/test/prompt-render.test.ts:42` `PLACEHOLDER_NAMES` 长度 `toBe(12)`；`:45-53` 12 个名字逐个渲染后 `unknown` 为空且非原文；`:55-74` 逐项断言取值，其中 `:64` `repo.issues` → `#1942 [open] 导出闪退`。
- **判定依据**：清单（契约）、取值（render.ts switch）、数据源（payload → ctx）、生产消费方（webhook-v21 落库）四段链路都有 `file:line`，且 12 个名字一一对应无缺项，满足「存在且生效」而非仅「有定义」。非评论事件的 `comment.*` 渲染成空串（`render.ts:129-131` 注释所述，`:154`/`:156` 走 `stringify(undefined)`→`''`），这与需求表格「可用事件=评论」一致，不算缺项。

### PH-2
- **状态**：已实现
- **证据**：
  - 分隔符与空集：`apps/server/src/prompt/render.ts:152` — `(ctx.issue.labels ?? []).map(...).join(', ')`，空集 join 结果为空串，代码中无「无 / 暂无」之类兜底词。
  - 不排序：`render.ts:150-152` 直接按数组顺序 map，无 `sort()`；`render.ts:40-41` 的类型注释也声明 `labels` 保持 GitHub 顺序。全仓 `apps/server/src` 内检索 `labels.{0,40}sort` 与 `sort.{0,40}labels` 均为 0 命中。
  - 顺序来源仅过滤不重排：`webhook-v21.ts:308-310` 对 `issue.labels` 做 `map(entry => entry.name).filter(name => name !== '')`，只丢空名，不改变相对顺序。
  - 快照口径：`webhook-v21.ts:307` 读的是**本次 webhook 载荷**里的 `issue.labels`（`:302` `payload['issue']`），而非渲染时再去调 GitHub 读当前标签，因此 agent 运行期标签被改不影响本轮。
  - 测试：`prompt-render.test.ts:121-124` 空集渲染为 `'[]'`（即空串）；`:126-129` 传入 `['needs-info','bug']` 断言输出 `'needs-info, bug'`（保序，未排序）；`apps/server/test/v21-webhook-integration.test.ts:402` 断言默认模板渲染出 `当前标签：缺陷`，`:403` 断言占位符已被替换。
- **判定依据**：三个子条件（逗号加空格 / 空集空串 / 不排序 / 事件时快照）各有独立代码行与独立断言，且快照来自载荷而非二次读 API，符合「取本次事件发生时」的要求。需求 1518 行提到的「标签名含逗号时按项目配置改分隔符」是未来边界条款（「届时」），当前无该配置不构成本条缺口。

### PH-3
- **状态**：已实现
- **证据**：
  - 字段仅编号+状态+标题：`apps/server/src/prompt/repo-issues.ts:81-84` `renderLine()` 只拼 `#${number} [${state}] ${title}`；`RepoIssueEntry` 中的 `isPullRequest`/`updatedAt`（`:18-27`）只用于过滤与排序，不进输出文本。
  - 仅 open：`repo-issues.ts:110` 请求固定 `state: 'open'`；类型层 `:32` 把 `state` 收窄成字面量 `'open'`，调用方无法传别的值。测试 `apps/server/test/prompt-repo-issues.test.ts:59-64` 断言 `state:'open', perPage:100, page:1`。
  - 上限 200：`repo-issues.ts:38` `REPO_ISSUES_MAX_ITEMS = 200`；`:123` `.slice(0, REPO_ISSUES_MAX_ITEMS)`。
  - 更新时间倒序截断：`repo-issues.ts:71-78` `byUpdatedAtDesc()`（`updatedAt` 解析失败按 0，相同时按编号倒序保证稳定）；`:122` 排序在 `:123` 截断之前。
  - 末尾总数说明：`repo-issues.ts:127-129` — 仅当 `total > 200` 时追加 ``（共 ${total} 条，仅列最近 200 条）``，未超限不加。总数来源 `webhook-v21.ts:536-551` `totalFromLink()` 读 `Link` 头 `rel="last"` × `perPage`，读不到时按已取条数估算（不编数）。
  - 排除 PR：`repo-issues.ts:121` `.filter(entry => !entry.isPullRequest)`；PR 判据由适配器落：`webhook-v21.ts:578` `isPullRequest: row.pull_request !== undefined && row.pull_request !== null`，`:556-557` 注释明确走 `/issues` 接口（不是 search）以保留 `pull_request` 字段。测试 `prompt-repo-issues.test.ts:66-73`。
  - 渲染形态：`repo-issues.ts:83` 输出与需求 1538-1541 行示例同形；测试 `:99` `'#200 [open] issue 200'`、`prompt-repo-issues.test.ts:101` 断言说明行文案与需求逐字一致。
  - 惰性（没写就不拉）：`webhook-v21.ts:465` `needsRepoIssues(template) ? repoIssuesProviderOf(...) : undefined` 是第一道闸（连 provider 都不取）；`render.ts:93-95` `needsRepoIssues()` 只判 `includes('{{repo.issues}}')`，`render.ts:198` 只在为真时 `await source()` 是第二道闸。测试 `prompt-render.test.ts:154-158`（没写 → 取数函数零调用）、`v21-webhook-integration.test.ts:466-489`（`listIssuesCalls` 为空数组）。
  - 按项目缓存默认 5 分钟：`repo-issues.ts:47` `REPO_ISSUES_DEFAULT_TTL_MS = 5 * 60 * 1000`；缓存键是仓库全名（`:141` key = `repo.trim()`，`:95` `Map<string, CacheEntry>`），命中判据 `:143-145`；同波并发只发一次见 `:146-160`（in-flight 复用 + 代数防旧值回写 `:133-135`）。生产唯一一份 provider 由装配层建：`apps/server/src/app/compose.ts:831-835`（`:834` 注释「只建一份」），经 `:983` 注入 `v21`，`webhook-v21.ts:259-276` 用 `WeakMap` 按 deps 复用，防每次投递新建导致缓存永不命中。测试 `prompt-repo-issues.test.ts:123-131`（TTL 内第二次零请求）、`:134-142`（过期重拉）、`:153-164`（并发只一次）。
  - 是索引不是全文：`repo-issues.ts:6` 声明 + 实际输出仅三字段（`:83`）；取正文另有工具路径 `apps/server/src/runtime/issue-read-tools.ts:176`（单条正文经只读工具取），与「索引不塞正文」配套。
- **判定依据**：PH-3 列出的 8 个开关（字段 / 仅 open / 200 / 倒序 / 总数说明 / 排除 PR / 惰性 / 5 分钟缓存）在代码里各有独立常量或独立语句，且每个都有针对性断言（不是只有「返回 200」这种弱断言）；两个数字常量 200 与 5 分钟与需求表格字面一致，未发现「与需求冲突」的数字偏差。

## 本节整体结论
6.3 的 12 个占位符在契约清单、取值 switch、webhook 载荷映射、生产落库四段链路上完整闭环，无一缺项；标签列表的格式（`, `）、空集空串、不排序、事件时快照四点均按需求字面实现且有独立用例钉住。`{{repo.issues}}` 的字段裁剪、仅 open、200 条上限、更新时间倒序截断、总数说明行、排除 PR、惰性两道闸、按仓库 5 分钟缓存全部落地，两个关键数字与需求完全一致。因此本节可判为「已实现」。唯一需要下游注意的不是缺项而是取数顺序口径（见额外问题 1），它影响「最近」二字的准确度，不影响本条列出的任何子条件。

## 核查边界
- 是否执行了命令：执行了 `npx vitest run apps/server/test/prompt-render.test.ts apps/server/test/prompt-repo-issues.test.ts`，结果 2 文件 / 30 用例全绿（17 + 13）。未执行集成用例（`v21-webhook-integration` 等需装配环境），其断言仅按源码阅读认定「存在且具体」，未声明其为绿。
- 未覆盖的条目及原因：无遗漏条目。真实 GitHub 分页行为（`Link` 头、`total` 口径、PR 混入比例）无法在无网络凭证环境下验证，相关结论只到「适配器按此实现」层面；该部分判为已实现的依据是代码路径，不依赖真跑。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **取数未按更新时间请求**：`webhook-v21.ts:559-570` 只传 `state/per_page/page`，未传 `sort=updated&direction=desc`。GitHub `/issues` 默认按 created 倒序，因此 `repo-issues.ts:122-123` 的「按 `updatedAt` 倒序截断」实际是在「最近创建的两页（≤200 条）」内部排序，对 open 数远超 200 的仓库，说明行说的「仅列最近 200 条」并非全量中最久未动排除后的最近 200 条。属口径偏差，不是需求子条件缺失。
  2. **PR 在截断前占额度**：`repo-issues.ts:120-123` 是先收集（含 PR）再 `filter` 再 `slice`，若前两页里 PR 多，最终行数会少于 200，而说明行的 `total`（`Link` 头算出）含 PR，二者不可对齐；`prompt-repo-issues.test.ts` 没有覆盖这种混合场景。
  3. **`{{repo.issues}}` 在无 GitHub client 时降级**：`compose.ts:831-833` 无 client 时 provider 为 `undefined`，占位符进 `unknown` 原样保留（`webhook-v21.ts:504-517` 与 `:504-B` 用例），行为是「不伪造」，但与「可用事件=全部」存在部署前置条件。
  4. **仅 open 与分隔符的「项目可配置」均无落点**：需求 1529 / 1518 行的「按项目配置改」在契约 `packages/contract/src/settings-v21.ts` 与 `repo-issues.ts` 中都没有对应字段（检索 `repoIssues|issueList|includeClosed|delimiter|separator` 均 0 命中），当前是硬编码默认值。
