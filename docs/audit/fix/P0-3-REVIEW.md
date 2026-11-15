# P0-3 独立审查

## 结论

**打回** —— `normalizeForIdempotency` 的口径实现是对的（只做去首尾空白 + 合并连续空行），但漏改了一条**已提交**的旧口径测试：`apps/server` 全量测试现在是红的（1 failed），报告只跑了 6 个选定文件，把这次回归漏在了视野外。

## 逐条核查

### 1 口径符合性

- **结论：符合。** 现实现只有 `text.replace(CONSECUTIVE_BLANK_LINES, '\n\n').trim()` 两步，没有残留任何 `@` 摘除、标点/symbol 删除、代码区蒙版、行内空白压缩、转小写。
- 证据：
  - 源码 `apps/server/src/agent/canonical-text.ts:27-29` 只有一次 `replace` + `trim`。
  - `AT_HANDLE` / `PUNCTUATION_OR_SYMBOL` / `WHITESPACE` / `maskCodeRegions` 的 import 与常量确实全部消失（全仓 `rg` 见下）。
  - 实测：`normalizeForIdempotency('@bot 打个标签！')` → `'@bot 打个标签！'`（不变）；`'打个  标签'` → 不变；`'看这里\n```\nconst a = 1;\n```\n然后再说'` → 不变。
- **但一处口径外残留（不在本文件里）**：mention 路径的 fingerprint 用的是 `stripAliases()` 的产物（`apps/server/src/agent/message.ts:296,310`），而 `stripAliases` 末尾还有 `.replace(/[ \t]{2,}/gu, ' ').trim()`（`canonical-text.ts:47`）。所以 `@pi-bot 打个  标签` 与 `@pi-bot 打个 标签` 在 mention 路径仍是**同一个键** —— 行内空白压缩只是从 `normalizeForIdempotency` 挪到了上游。comment 路径没有这层（`webhook-v21.ts:882` 的 `commentBody` 取 `str(comment,'body')` 原文，再 `commentFingerprint`），因此两条路径口径不一致。报告风险 §4.1 说「`v21MessageFingerprint`（评论路径）直接用原文」这句是**对的**（我核过 `commentBody` 的来源），但报告没说 mention 路径还在压行内空白。

### 2 合并空行的实现是否正确

- **结论：正确（对我们列的 4 类边界全部成立），有 3 处可讨论的边角。**
- 实测（脚本见「我实际执行的验证」，21 组输入，结果全部二次幂等）：

| 输入 | 输出 | 判定 |
|---|---|---|
| `a\n\nb`（1 空行） | `a\n\nb` | ✅ 保留 |
| `a\n\n\nb`（2 空行） | `a\n\nb` | ✅ 合并成一个空行 |
| `a\n\n\n\nb` / 6 空行 | `a\n\nb` | ✅ |
| `a\n   \n \t \nb`（空行含空格/制表） | `a\n\nb` | ✅ |
| `a\n\n \n\nb`（含空格与纯空行混排） | `a\n\nb` | ✅ |
| `a\r\n\r\nb`（CRLF 单空行） | 原样 | ✅ |
| `a\r\n\r\n\r\nb`（CRLF 双空行） | `a\n\nb` | ✅ 合并，但 **CRLF 被改写成 LF**（见问题 3） |
| `a\n\r\n\r\nb`（LF/CRLF 混） | `a\n\nb` | ✅ |
| `a\n\n\n  - item\n    - sub` | `a\n\n  - item\n    - sub` | ✅ 缩进列表的空格没被吃 |
| `  code\n\n\n    indented` | `code\n\n    indented` | ✅ 正文行缩进保住（首行缩进被 trim 去掉是「去首尾空白」的本意） |
| `a\n\u3000\n\u3000\nb`（全角空格空行） | 原样不合并 | ⚠️ 见问题 4 |
| `a\n \n\nb` | `a\n \nb`（单个带空格空行） | ⚠️ 见问题 5 |
| 20 万换行 / 20k 段混合 / 长制表符行 | 3ms / 3ms / 1ms | ✅ 无回溯爆炸 |

- `[ \t]*` 必须紧跟换行这个写法是有效的：它只吃「空行之间」的空白，不吃下一行正文的缩进，上表缩进两例可证。

### 3 是否还有别处依赖被删的常量

- **结论：没有。**
- 证据（`rg -n "maskCodeRegions|AT_HANDLE|PUNCTUATION_OR_SYMBOL|WHITESPACE|normalizeForIdempotency|stripAliasMentions|stripAliases"`，排除 `node_modules` / `docs/audit`）：
  - `AT_HANDLE` / `PUNCTUATION_OR_SYMBOL` / `WHITESPACE`：**0 处引用**（常量定义与所有使用点都已随本次改动消失）。
  - `maskCodeRegions`：仍在 `packages/contract/src/trigger.ts:109` 正常 `export`，`packages/contract/src/skill-mentions.ts:16,71`、`apps/server/src/trigger/mention.ts:16,142`、`apps/server/src/http/webhook-v21.ts:14,415`、`packages/contract/test/trigger.test.ts` 都还在用；被删的只是 `canonical-text.ts` 里那一处 import。
  - `stripAliases` / `stripAliasMentions`：`apps/server/src/agent/index.ts:31` 都还导出，`message.ts:24,296`（`stripAliases`）与 `webhook-v21.ts:35,331`（`stripAliasMentions`）都还在用。
  - `normalizeForIdempotency` 使用点只有 `fingerprint.ts:32`（mention）与 `:64`（comment），没有第二处消费旧行为。

### 4 影响面 / 是否过度放行

- **结论：方向没问题，但有一条真实回归被漏掉；过度放行本身不荒谬。**
- 过度放行（多烧一次 token）确实存在，且是需求要的：只改标点、只挪代码块、只改行内空格、单换行 vs 双空行都会各跑一次。**不会**导致「GitHub 重投就重跑」——重投由投递级去重挡住，`test/e2e-idempotent.test.ts`（同 `X-GitHub-Delivery` 投 20 次 → `deliveries` 1 行 / `tasks` 1 行 / send 1 次）通过可证。
- **测试被放松的检查：没有放松真正的约束。** 被删的两条（`'@bot 打个标签'` / `'@bot  打个标签！'` / `'@bot\n\n 打个标签。 '` 三者相等；围栏块整体被蒙掉）断言的就是缺陷本身，删得对；新增用例把「只做两件事」「不压行内空白」「不摘 @/不去标点/不抹代码区」「只改标点/只换代码内容 → 不同」都正向钉住了，`v21-webhook-integration.test.ts` 的第三组把口径钉到了 webhook 入口。
- **但漏了一条**：`apps/server/test/agent-serial-queue.test.ts:171`（`L-02：归一化等价（多空格 / 标点 / 不同别名）→ 同一条消息`）仍在断言旧口径 —— `postMention('@pi-bot   打个标签！')` 必须 `action === 'duplicate'`。这条**在 HEAD 里就存在**（`git show HEAD:apps/server/test/agent-serial-queue.test.ts` 可见），不是别人新加的；改动后它失败了（见下）。这是本次唯一阻断项。

### 5 测试是否真跑过

- **结论：报告里那 6 个文件的数字属实，但验证范围不足，且「全绿」的印象不成立。**
- 我复跑报告点名的 6 个文件：结果与报告完全一致（89 tests passed）。
- 我另外跑了 `apps/server` 全量 `test/`：**1 failed | 119 passed（120 files）、1 failed | 1525 passed | 2 skipped（1528 tests）**。失败即 `agent-serial-queue.test.ts:171`。
- 失败原文（`npx vitest run test/agent-serial-queue.test.ts -t "L-02"`）：`AssertionError: expected 'enqueued' to be 'duplicate'`，位置 `test/agent-serial-queue.test.ts:174:31`。即：`'@pi-bot   打个标签！'` 现在被正确判成**新内容**，而这条 HEAD 里的用例还要求它被当成重复。
- 报告 §3 说 `pnpm -r typecheck` 在 `src/app/compose.ts(1227,43)` 失败 —— **现在不复现**：`pnpm --filter @pi-issue-bot/server typecheck` 0 error（并行改动已修好那处）。这条是过期信息，不是谎报。
- 2 个 skipped 与本次改动无关（真 git/真 Docker/平台条件类 `skipIf`，如 `doctor-checks.test.ts:802` 的 win32 分支、`git-fixture.test.ts:158` / `git-writeback.test.ts:288` 的 `ctx.skip()`）。

### 6 是否误伤他人改动

- **结论：未见误伤。**
- `canonical-text.ts` 里 `escapeRegExp`、`stripAliases`、`stripAliasMentions`、`aliasPatternsOf` 齐全，`agent/index.ts:31` 的三个导出未变，`agent-message.test.ts` 的 `stripAliases` 4 条用例全绿（`@pi-botx` / `foo@ibot` 边界仍成立）。
- `fingerprint.ts` 的 diff 只有基线里他人那一段 `commentFingerprint`（`git diff` 全 + 行），P0-3 未触碰。
- 局限：基线 `_baseline-fix.txt` 记录的是**工作区快照**而不是 git 对象，且约定禁止 `stash`，所以我**无法机械证明** `stripAliases`/`stripAliasMentions` 与快照逐字相同；只能靠「函数都在、语义合理、测试全绿、diff 里该段改动与拆分重构自洽」佐证。

## 我实际执行的验证

```
# 1 口径与边界（临时脚本，$env:PI_SCRATCH_DIR\probe-norm.mjs，不进仓库）
node $env:PI_SCRATCH_DIR\probe-norm.mjs
→ 21 组边界用例；"不幂等用例数 = 0"
→ 2空行 vs 1空行：true / 3空行 vs 1空行：true
→ 行内双空格 vs 单空格：false / 尾随空格 vs 无：true / @提及差异：false

# 2 报告点名的 6 个文件
cd apps/server; npx vitest run test/agent-message.test.ts test/v21-webhook-integration.test.ts
→ Test Files 2 passed (2) / Tests 41 passed (41)
npx vitest run test/agent-events.test.ts test/e2e-idempotent.test.ts test/agent-skill-wiring.test.ts test/trigger-mention.test.ts
→ Test Files 4 passed (4) / Tests 48 passed (48)      # 合计 89，与报告一致

# 3 apps/server 全量
npx vitest run test/
→ Test Files 1 failed | 119 passed (120)
→ Tests 1 failed | 1525 passed | 2 skipped (1528)
→ FAIL test/agent-serial-queue.test.ts > L-01 / R-02：人消息永久幂等 > L-02：归一化等价（多空格 / 标点 / 不同别名）→ 同一条消息

# 4 静态检查
pnpm lint                                  → 0 errors, 6 warnings（scripts/spike/lib/stub-exec-proxy.mjs）
pnpm --filter @pi-issue-bot/server typecheck → 通过（0 error；报告里的 compose.ts 失败已不复现）

# 5 引用搜索（见 §3）

# 6 性能
node -e "..." 200k 换行 / 20k 混合段 / 长制表符行 → 3ms / 3ms / 1ms
```

## 发现的问题

| 严重度 | 问题 | 位置 | 建议 |
|---|---|---|---|
| **阻断** | 旧口径测试未改，全量测试红：断言 `'@pi-bot   打个标签！'` 与 `'@pi-bot 打个标签'` 同为 `duplicate`。这条在 HEAD 已提交，不是他人新加；报告只跑了 6 个文件，漏了它 | `apps/server/test/agent-serial-queue.test.ts:171-176` | 改数据为「只差首尾空白 / 连续空行」（与 `agent-message.test.ts` 的修法一致），并按同一思路补「只改标点 → `enqueued`」的反例 |
| 中 | mention 路径的 fingerprint 仍经 `stripAliases()`，末尾 `.replace(/[ \t]{2,}/gu,' ').trim()` 把行内多空格压掉 → `打个  标签` 与 `打个 标签` 同键；comment 路径不压。两路径口径不一致，且注释已过时 | `apps/server/src/agent/message.ts:296,306-310`、`canonical-text.ts:46-48` | fingerprint 改用 `stripAliasMentions(input.rawText, ...)`（不动空白），展示用的 `text` 保持 `stripAliases`；顺手改掉 `message.ts:306` 那句「行内空白不动（归一化会压）」 |
| 低 | `\r\n` **只**在被合并的区间里被改写成 `\n`：`A\r\n\r\n\r\nB` 与 `A\n\nB` 同键，而 `A\r\n\r\nB` 与 `A\n\nB` 不同键 —— 同一类「行尾风格」差异在不同上下文结论相反 | `canonical-text.ts:17,29` | 若要一致，可把单空行的行尾也规范化（代价是收窄口径）；或明确接受并在注释里写死「行尾风格只在合并时被抹平」 |
| 低 | 空行里含全角空格 `U+3000` / NBSP 时不算空行，不合并（中文用户从 Word/微信粘贴的「空行」多是这两种） | `canonical-text.ts:17` | 若要覆盖，用 `[ \t\u00a0\u3000]*`；方向安全（只多跑一次），但口径不完整 |
| 低 | 单个空行里带空格（`a\n \nb`）保留空格，2 个空行里带空格却被抹成 `\n\n` —— 同一「带空格空行」在数量不同时结论相反 | `canonical-text.ts:17` | 同上一格一并处理 |
| 低 | `CONSECUTIVE_BLANK_LINES` 是带 `g` 的模块级正则，现在只用 `.replace`（安全，`replace` 会重置 `lastIndex`）；将来若有人用 `.test()` 会踩 `lastIndex` 复用 | `canonical-text.ts:17` | 注释里点一句「只用 replace」，或改成函数内字面量 |
| 低 | mention 路径没有任何用例钉住「只改行内空白 → 不同内容」，而残留的压缩恰好就在这条路径上；`composeAgentMessage` 的等价用例靠 trim 就能过，钉不住空白口径 | `apps/server/test/agent-message.test.ts:184-206` | 补一条 `打个 标签` vs `打个  标签` 断言（修完上一格后应为不同键） |

## 是否误伤他人改动

**没有发现误伤。** `stripAliases` / `stripAliasMentions` / `aliasPatternsOf` / `escapeRegExp` 都在、`agent/index.ts:31` 导出未变、`fingerprint.ts` 只保留基线里他人的 `commentFingerprint` 新增段、`message.ts` 一行未动（只剩一条过时注释）。受限之处：基线是工作区快照而非 git 对象，禁止 `stash`/`checkout`，故只能靠源码比对与全量测试佐证，无法逐字 diff。

（本审查只跑只读命令与 `$env:PI_SCRATCH_DIR` 下的临时脚本；未改任何源码、未 `git add`/`commit`。除本文件外未写入仓库。）
