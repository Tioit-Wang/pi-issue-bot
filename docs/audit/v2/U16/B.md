# U16 6.3 占位符清单 · B

> 核查范围：docs/requirements.html 行 1481-1557
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| PH-1 十二个占位符逐个存在 | 已实现 | — |
| PH-2 标签列表格式/空串/不排序/快照 | 已实现 | — |
| PH-3 `{{repo.issues}}` 规模控制 | 部分实现 | 只取 2 页原始条目（含 PR）后才过滤，截断窗口既不按更新时间取（未传 `sort=updated`），总数行又用「页数×perPage」的近似值且含 PR |

## 逐条

### PH-1
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:420-433` — `PROMPT_PLACEHOLDERS` 12 项：`issue.author / issue.number / issue.url / issue.content / issue.labels / issue.title / repo.issues / comment.author / comment.body / repo / actor / event.action`，与需求表格 12 行逐字对上。
  - `apps/server/src/prompt/render.ts:132-162` — `resolvePlaceholder()` 的 switch 覆盖同 12 个名字（`repo` 134、`actor` 136、`event.action` 138、`issue.*` 140-152、`comment.*` 153-156、`repo.issues` 157），无 `default` 兜底名字漏项。
  - `apps/server/src/http/webhook-v21.ts:315-337` — 每个占位符都有**载荷取值**：`actor` ← `sender.login`、`event.action` ← `eventAction`、`issue.title` ← `issue.title`、`repo` ← `input.repo`、`issue.labels` ← `payload.issue.labels`、`repo.issues` ← `provider.render(repo)`。
  - `apps/server/src/http/webhook-v21.ts:1007-1019` → `apps/server/src/http/webhook.ts:1260-1283` — `buildV21AgentMessage()` 在真实 webhook 分支里被调用并落 `agent_messages.comment_body`（`webhook-v21.ts:1029-1037`），不是死代码。
  - 测试：`apps/server/test/prompt-render.test.ts:41-43`（`PLACEHOLDER_NAMES` 长度 12）、`:45-53`（逐个渲染非 unknown）、`:55-74`（12 个名字逐个断言取值）。
- **缺口**：无
- **判定依据**：清单、取值函数、生产上下文映射三处齐全，且渲染结果是真实发送正文；「存在」与「生效」都成立。
- **反证过程**：逐个假设「这个名字其实只加进了文档」——
  1. `{{actor}}`：假设未接载荷。查 `webhook-v21.ts:315` 取 `str(sender, 'login')`，`:1011` 传 `rt.action ?? ''` 之外的 action 也来自 `webhook.ts:1260-1283` 的真实 `action`；`prompt-render.test.ts:68` 断言 `carol`。反证失败（已实现）。
  2. `{{event.action}}`：假设渲染成空。`render.ts:138-139` 有 case，`webhook-v21.ts:316` 由 `input.eventAction` 供值，`:1011` 由 `rt.action`（webhook 载荷的 `action` 字段）供值；`prompt-render.test.ts:69` 断言 `opened`。反证失败。
  3. `{{issue.title}}`：假设只加了文档行（需求行 1496 是后排补充）。`render.ts:146-147` case 存在，`webhook-v21.ts:321` 取 `issue.title`，测试 `:63` 断言实际标题。反证失败。
  4. `{{repo}}`：假设文档有、代码无。`render.ts:134-135` + `webhook-v21.ts:314`（`repo: input.repo`）+ 测试 `:67`。反证失败。
  5. `{{issue.content}}` / `{{issue.url}}` / `{{issue.number}}` / `{{issue.author}}` / `{{comment.author}}` / `{{comment.body}}` / `{{issue.labels}}`：同上逐项在 `render.ts:140-156` 与 `webhook-v21.ts:317-333` 找到 case 与取值，测试 `:58-66` 逐条断言。
  6. 反向检查「有没有第 13 个只在代码里、不在需求里的占位符」：`render.ts:132-161` 的 case 标签集合与 `settings-v21.ts:420-433` 完全一致，未发现多余项。
  7. 检查「是否有第二套渲染器导致某些占位符只在某个入口生效」：`webhook-v21.ts:451-493` 项目模板与内置默认模板都收敛到 `renderTemplateAsync()`（`:464-476`），无分叉。
  8. 唯一残留：`webhook-v21.ts:1011` 的 `rt.action ?? ''` 让缺 action 的载荷渲染出空串（而非原样保留）。这不是「没实现」，且 §6.3 表格未规定该情形的落值，不据此降级，仅记入额外问题。反证结论：PH-1 的「未实现」假设无法成立。

### PH-2
- **状态**：已实现
- **证据**：
  - 格式（逗号+空格）：`apps/server/src/prompt/render.ts:150-152` — `.map(...).join(', ')`；测试 `apps/server/test/prompt-render.test.ts:62` 断言 `bug, needs-info`。
  - 无标签空串：`render.ts:152` 对空数组 `join` 得 `''`（不填「无」）；测试 `prompt-render.test.ts:121-124` 断言 `[{{issue.labels}}]` → `[]`（括号内为空，即空串）。
  - 不排序：`render.ts:40-41` 类型注释与实现均未排序；全仓 grep `\.sort\(` 在 `prompt/`、`http/`、`agent/` 下只有 `repo-issues.ts:122`（issue 列表）与 `agent/canonical-text.ts:74`（触发别名），**无任何标签列表排序**。测试 `prompt-render.test.ts:126-129` 断言传入 `['needs-info','bug']` 输出 `needs-info, bug`（保持传入顺序）。
  - 事件时快照：`apps/server/src/http/webhook-v21.ts:307-310` — 标签来自 `payload.issue.labels`（本次事件载荷）而非事后调 GitHub 重取；`:323` 交给渲染上下文后无二次取数路径。
- **缺口**：无
- **判定依据**：四条子条件各有独立实现点与断言，且「不排序」「空串」都是 B 视角重点怀疑项，反向搜索后未找到反例。
- **反证过程**：
  1. 「不排序」：假设某处偷偷 sort 了。全仓（`apps/server/src`）搜 `.sort(` / `sort=` 命中仅 `canonical-text.ts:74`（别名去重排序，与标签无关）与 `repo-issues.ts:122`（issue 列表按 updatedAt）。`webhook-v21.ts:308-310` 只做 `map`+`filter`，不改顺序。反证失败。
  2. 「空串」：假设返回「无」/「（无）」/「-」。`render.ts:152` 直接 `join`，无分支；`render.ts:97-103` 的 `stringify` 对 `null/undefined` 返回 `''`，也不产生占位词。测试 `:123` 用 `[{{issue.labels}}]` 包起来断言 `[]`，能区分「空串」与「无」。反证失败。
  3. 「快照」：假设渲染时重新调 GitHub 取当前标签（那样 agent 跑完一会儿标签就变了）。`webhook-v21.ts:301-310` 全部字段取自 `payload`；`prompt/repo-issues.ts` 的 provider 只服务 `{{repo.issues}}`，不产出标签。反证失败。
  4. 「快照的完整性」：假设只取了标签名的一部分（如只取前 20 个）。`webhook-v21.ts:308-310` 无截断，`filter` 仅剔除空名。反证失败。
  5. 「分隔符是否可配」：需求行 1518 说默认为逗号、可改。`render.ts:152` 硬编码 `', '`，无可配参数——但该行属「边界」说明（"届时按项目配置指定"），不是本期可判定的子条件，不作为缺口；记入额外问题。
  6. 结论：PH-2 的四条子条件均可推翻「未实现」假设。

### PH-3
- **状态**：部分实现
- **证据**：
  - 仅索引字段 + 渲染形态：`apps/server/src/prompt/repo-issues.ts:17-27`（`RepoIssueEntry` 只有 number/title/state/updatedAt/isPullRequest）、`:81-84`（`#1942 [open] 标题`）、`:130`（`lines.join('\n')`）。
  - 仅 open：`repo-issues.ts:110` 请求固定 `state: 'open'`；测试 `apps/server/test/prompt-repo-issues.test.ts:59-64` 断言请求参数。
  - 上限 200：`repo-issues.ts:38` `REPO_ISSUES_MAX_ITEMS = 200`，`:123` `.slice(0, REPO_ISSUES_MAX_ITEMS)`；测试 `:91-104` 断言行数 = 201 且末行为说明行。
  - 排除 PR：`apps/server/src/http/webhook-v21.ts:578` `isPullRequest: row.pull_request !== undefined && row.pull_request !== null`，`repo-issues.ts:121` `.filter((entry) => !entry.isPullRequest)`；测试 `:66-74`。
  - 惰性：`apps/server/src/prompt/render.ts:93-95`、`:193-198`（模板无该占位符则不 `await` 源）；调用侧双闸 `webhook-v21.ts:465`（`needsRepoIssues(template)` 为假时连 provider 都不取）；测试 `prompt-render.test.ts:153-175`。
  - 5 分钟缓存 + 项目维度 key：`repo-issues.ts:47` `5 * 60 * 1000`，`:93` TTL 默认，`:141-145` key 为仓库全名（`repo.trim()`）；provider 单例化 `webhook-v21.ts:257-276`（WeakMap 按 deps 复用）、`apps/server/src/app/compose.ts:831-835`（进程内只建一份）；测试 `prompt-repo-issues.test.ts:122-151`（TTL 边界、不同仓库各自一份）。
  - 索引非全文：`repo-issues.ts:17-27` 不含正文；agent 需要正文时另有工具读单条 `apps/server/src/runtime/issue-read-tools.ts:191`。
- **缺口**：
  1. **截断发生在 PR 过滤之前**：`repo-issues.ts:109-123` 最多取 `REPO_ISSUES_MAX_PAGES(2) × REPO_ISSUES_PER_PAGE(100)` = 200 条**原始条目（含 PR）**，之后才 `.filter(!isPullRequest)` 与 `.slice(0,200)`。若前 200 条里有 30 个 PR，列表只剩 170 条 issue 却仍会打印「仅列最近 200 条」——需求「上限 200 条」指的是 issue，不是「issue+PR」。
  2. **截断集合不是「最近更新的 200 条」**：`webhook-v21.ts:564-570` 的请求参数只有 `state / per_page / page`，**没有 `sort`**（GitHub 默认 `sort=created&direction=desc`），因此取回的是「最近创建的 200 条」；`repo-issues.ts:122` 的 `byUpdatedAtDesc` 只是在这批数据内部重排。需求行 1530「超出按更新时间倒序截断」在全局意义上不成立。
  3. **总数行口径错**：`webhook-v21.ts:536-551` `totalFromLink()` 用 `lastPage × perPage` 估算（1243 条会输出 1300），且该 total 统计的是含 PR 的全部条目，而列表已排除 PR——`repo-issues.ts:127-129` 的「（共 N 条…）」与实际列出内容不是同一口径；需求行 1530 要求的是「说明总数」。
- **判定依据**：主体（索引字段、仅 open、200 上限常量、排除 PR、惰性、5 分钟项目级缓存）都在且有调用方与断言，属「主体在」；但需求明写的三个子条件——「按更新时间倒序截断」「总数说明」与「排除 PR 后的 200 条 issue」——在实现上不成立，按模板 §二 必须点名缺哪一项，故判**部分实现**而非已实现，也不构成「与需求冲突」（过滤、排序、截断三个动作确实都在，只是顺序与取数窗口错）。
- **反证过程**：
  1. **排除 PR**：假设代码把 PR 当 issue 列了出来。`webhook-v21.ts:520-526` 的 `RawIssue` 含 `pull_request`，`:578` 把它转成 `isPullRequest`，`repo-issues.ts:121` 过滤；测试 `prompt-repo-issues.test.ts:66-74` 断言 PR 不进结果行。反证失败（该项成立）。
  2. **上限 200**：假设常量与需求数字不符。`repo-issues.ts:38` = 200，测试 `:98` 用同一常量断言行数，`:101` 断言说明行文本含 200。反证失败（数字一致）。但继续追「200 是谁的 200」：`:44`/`:109-118` 的「最多翻 2 页 × 每页 100」把 200 额度先花在**含 PR 的原始条目**上，`:121` 才剔 PR，导致 issue 实际不足 200——这是第 1 个缺口。
  3. **倒序**：假设按 `created_at` 或默认顺序。`repo-issues.ts:70-78` 确实是 `updatedAt` 倒序；但追数据来源发现 `:110` 的请求参数里没有 `sort`，`webhook-v21.ts:564-570` 也无 `sort=updated`，即分页窗口由 GitHub 默认（created desc）决定。这是第 2 个缺口。
  4. **总数说明**：假设截断后忘了补总数行。`repo-issues.ts:127-129` 有条件 `lines.push`，条件为 `total > 200`，测试 `:101` 断言文本。行确实追加了；但追 total 来源发现 `webhook-v21.ts:536-551` 是 `lastPage × perPage` 的近似值且含 PR，与「排除 PR」口径不一致，这是第 3 个缺口（不是「未追加」，是「追加的数不对」）。
  5. **惰性**：假设渲染前无条件预取。`webhook-v21.ts:465` 先用 `needsRepoIssues(template)` 决定要不要取 provider，`render.ts:198` 二次判断才 `await`；测试 `prompt-render.test.ts:156-160` 断言没写占位符时 factory 零调用。反证失败（成立）。
  6. **5 分钟缓存**：假设 TTL 常量不是 5 分钟，或缓存 key 不含项目维度（不同项目共用）。TTL `repo-issues.ts:47` = 300000ms，测试 `:129-130` 用 `TTL-1` 仍命中、`:140` `TTL+1` 失效；key 为 `repo.trim()`（`:141`），测试 `:145-151` 断言 `org/a` 与 `org/b` 各自请求。反证失败（成立）。另查 provider 是否被单例复用（否则缓存形同虚设）：`webhook-v21.ts:257-276` WeakMap + `compose.ts:831-835` 单份，成立。
  7. **索引非全文**：假设列表里带了正文。`repo-issues.ts:18-27` 类型无 body 字段，`:81-84` 只拼三段；`webhook-v21.ts:574-580` 映射时丢弃 `body`。反证失败（成立）。
  8. 结论：7 条子条件里 4 条经反证成立、3 条（200 名额口径 / 排序窗口 / 总数口径）证伪，故整体落在「部分实现」。

## 本节整体结论
本节不能判为「已实现」。PH-1 与 PH-2 经逐项反证均站得住：12 个占位符在契约清单、渲染 switch 与生产上下文映射三处齐全，标签列表的「逗号+空格 / 空串 / 不排序 / 事件快照」四条也都能定位到实现与断言。PH-3 的骨架在（索引字段、仅 open、200 常量、排除 PR、惰性、5 分钟项目级缓存、非全文），但三处子条件与需求不符：取数窗口未按 `updated_at`（请求未传 `sort`）、PR 在取满 200 条之后才过滤（issue 实际可能少于 200）、总数行用近似值且含 PR。整体状态：**部分实现**，需按缺口 1-3 修 `prompt/repo-issues.ts` 与 `webhook-v21.ts` 的 lister。

## 核查边界
- 是否执行了命令：未执行，纯静态核查（未跑 `pnpm test`、未调真 GitHub API；GitHub issues 接口默认 `sort=created` 属外部接口约定，未在本仓库代码内验证）。
- 未覆盖的条目及原因：无（PH-1 / PH-2 / PH-3 均已覆盖）；「标签分隔符可配置」（需求行 1518）不在本次待核条目内，未作判定。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/http/webhook-v21.ts:1011` 传 `rt.action ?? ''`，缺 action 的载荷会让 `{{event.action}}` 渲染成空串而非原样保留（与 `render.ts:71-76` 对「未准备数据」的处理哲学不一致）。
  2. `apps/server/src/prompt/render.ts:152` 标签分隔符硬编码 `', '`，需求行 1518 预留的「按项目配置改分隔符」无对应配置位。
  3. `repo-issues.ts:115` 的提前 `break` 只看 `collected.length >= 200`，不考虑 PR 占比，使缺口 1 在最坏情况（前两页几乎全是 PR）下退化成「列表接近空但声称列了 200 条」。
  4. `repo-issues.ts:127` 判断用 `total > 200`，而 `total` 是近似值：当真实总数略小于 200（如 195）但 `lastPage×perPage` 算出 200 时不补说明行；反之真实 1243 会写成 1300。
