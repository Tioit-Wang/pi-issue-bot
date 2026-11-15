# 需求完全实现 · 总计划

> 目标：把 `docs/requirements.html` 里 116 项未达成条目全部实现（16 未实现 + 22 冲突 + 78 部分实现）
> 基线：`docs/audit/v2/_unimplemented.md`（缺口清单）+ `_adjudication.md`（终裁）
> 流程：**每个工作包 = 1 个实现 session + 1 个独立 Review session**，串行或按依赖并行

---

## 一、为什么必须分批

116 项里存在硬依赖链，顺序错了会返工：

1. **契约先行**：`packages/contract/src/` 是唯一事实源。面板、查询层、校验都从它派生。改契约必须先做，否则后面全部重做。
2. **P0-1 依赖 P0-5**：会话永不轮换（已改）→ 上下文无限增长 → 必须有压缩。**压缩必须先于或同批于会话常驻上线**。
3. **面板依赖契约**：AC-27/28/29/32 缺的是契约字段，不是 UI。
4. **标签三件套同一根因**：`current` 取自 `bot_labels` 台账 → 改这一处可同时修 FR-5.4、BR-11、LD-1、LD-2。

---

## 二、工作包划分（12 个包，覆盖 116 项）

| 包 | 名称 | 覆盖条目 | 依赖 | 改动面 |
|---|---|---|---|---|
| **WP1** | 留痕可查 | BR-6、FR-6.4③ | 无 | queries + api + contract |
| **WP2** | 会话域隔离 | BR-5、FR-3.1 | 无（需迁移） | schema + 迁移 + store |
| **WP3** | 标签三件套 | FR-5.4、BR-11、LD-1、LD-2、AC-15、FR-5.5 | 无 | writeback + workflows + compose |
| **WP4** | 增量投喂 | FR-4.2、BR-4、SB-4、FR-4.1 | 无 | contract 模板 + prompt |
| **WP5** | 压缩接线 | FR-5.6、AC-24、AC-25 | **WP3 无关，但 blocking P0-1** | runtime + compact + prompt |
| **WP6** | 记录完整性 | FR-6.1、FR-6.2、FR-6.3、NFR-6 | 契约 | schema + queries + contract |
| **WP7** | 执行限额 | SL-1、SL-2、SL-3、SL-4 | 无 | config + compose + queue + schema |
| **WP8** | 评论配置 | CC-3、CC-4、CC-1 | 需 GitHub API | schema + contract + api |
| **WP9** | 供应商与模型角色 | CFG-8.1/8.2/8.3、CFG-9.1/9.2、AC-32 | 需新实体 + 迁移 | schema + 迁移 + config + api |
| **WP10** | 产出契约与工具 | FR-5.1、FR-5.3、Q-6、TOOL-3、TOOL-5 | 契约 | contract + runtime + skills |
| **WP11** | 面板重构 | FR-7.1~7.5、AC-26~AC-33、Q-7、Q-8、Q-9 | **WP1/WP6 契约字段** | panel |
| **WP12** | 收尾项 | AC-23 残余、AC-27~31 面板元素、FR-3.2 残余 | WP11 | 面板 |

---

## 三、执行顺序（按依赖 + 风险）

```
阶段 A（可并行，互不冲突）
├─ WP1 留痕可查          ← 最便宜，先摘
├─ WP2 会话域隔离        ← 需迁移，独立
└─ WP4 增量投喂          ← 纯契约+prompt

阶段 B（WP3 根因修复，影响面大）
└─ WP3 标签三件套

阶段 C（解除 P0-1 阻塞）
└─ WP5 压缩接线

阶段 D（契约扩展）
├─ WP6 记录完整性
└─ WP7 执行限额

阶段 E（新实体）
├─ WP8 评论配置
└─ WP9 供应商与模型角色

阶段 F（契约收口）
└─ WP10 产出契约与工具

阶段 G（面板）
├─ WP11 面板重构
└─ WP12 收尾项
```

---

## 四、每个工作包的执行标准

### 实现 session 必须满足
1. 只改本包范围内的文件，不碰其他包
2. 遵守 AGENTS.md（无 `any`、无 `@ts-ignore`、中文注释写「为什么」）
3. 有测试：新行为必须有断言可观察事实的用例
4. 跑 `tsc --noEmit` + 相关测试，贴命令与结果
5. 不改需求文档（需求是标准）
6. **不 `git add` / `git commit`**

### Review session 必须满足
1. **默认假设实现有问题**，主动找反证
2. 逐条对照需求原文
3. 实际跑测试与类型检查，核报告是否属实
4. 检查是否误伤他人改动
5. 检查是否超出本包范围
6. 结论三态：通过 / 有条件通过 / 打回

### 编排侧（我）必须满足
1. Review 打回 → 我亲自判断并修
2. Review 说越界 → 我回退越界部分
3. 每批完成后跑全量测试
4. 记录每项的最终状态

---

## 五、进度追踪

| 阶段 | 包 | 实现 | Review | 编排处置 | 最终 |
|---|---|---|---|---|---|
| - | P0-1 会话常驻 | ✅ | 有条件通过 | 加前置条件 | ✅ |
| - | P0-2 失败放行 | ✅ | 越界 | 回退越界 | ✅ |
| - | P0-3 去重口径 | ✅ | 打回 | 补修测试 | ✅ |
| A | WP1 留痕可查 | ✅ | 有条件通过 | 已修 C2/C3 | ✅ |
| A | WP2 会话域隔离 | 进行中 | — | — | — |
| A | WP4 增量投喂 | ✅ | 有条件通过 | 已修 S1/S3，S2 部分 | 🔄 |
| B | WP3 标签三件套 | 进行中 | — | — | — |
| C | WP5 压缩接线 | ✅ | **打回** | 已修 3.2/3.3，交给 WP5-R | 🔄 |
| D | WP6 记录完整性 | 进行中 | — | — | — |
| D | WP7 执行限额 | ✅ | 进行中（Review2） | — | 🔄 |
| E | WP8 评论配置 | 进行中 | — | — | — |
| E | WP9 供应商与模型角色 | 进行中 | — | — | — |
| F | WP10 产出契约与工具 | 进行中 | — | — | — |
| G | WP11 面板重构 | 进行中 | — | — | — |
| G | WP12 收尾项 | 待派 | — | — | — |

---

## 六、当前并发（2026-11-14 19:0x）

| Session | 包 | 独占面 |
|---|---|---|
| `8f5241d3` | WP5-R 压缩重建 | `compact/**`、`runtime/turn-driver.ts` |
| `708e50c3` | WP6 记录完整性 | `queries/**`、`contract/api.ts`、`http/api/index.ts` |
| `916fec1e` | WP3 标签三件套 | `writeback/**`、`workflows/**`、标签行 |
| `f6ad5441` | WP2 会话域隔离 | `agent/store.ts`、`agent_sessions` 表、迁移 0013 |
| `9a557f48` | WP9 供应商与模型角色 | 新表、`github-auth.ts`、`cost/pricing.ts` |
| `23cae0de` | WP4-R 增量投喂收口 | `settings-v21.ts` 模板段、`prompt/render.ts`、`apps/panel/**` |
| `f03729b2` | WP7-R 限额收口 | `queue/**`、`config/v21-settings.ts`、`trigger/decide.ts` |
| `cf9af68c` | WP11 面板重构 | **`apps/panel/**`** |
| `e87b875b` | WP10 产出契约与工具 | `envelope/**`、`skills/**`、`issue-tools.ts` |
| `0860de17` | WP8 评论配置 | 角色成员段、`workflows/roles.ts` |
| `cbdbb5c3` | Review WP7 需求契合 | 只读 |
| `2d0e5d46` | Review WP1 C2/C3 闭合 | 只读 |

**已知冲突点（须由编排侧裁决，不许两边各改一份）**：
- `apps/panel/**` 同时被 WP4-R（S4 说明文案）与 WP11（整体重构）认领 → 见 §七。
- `packages/contract/src/settings-v21.ts` 被 WP4-R（模板段）与 WP8（角色成员段）/WP9（供应商段）同时动 → 按注释锚点分段，改动不得越界。
- `apps/server/src/app/compose.ts` 被 4 个包各自只改「自己那几行」→ 靠锚点隔离，不许整段重写。

## 八、全部工作包交付状态（2026-11-15 05:0x 更新）

| 包 | 报告 | 状态 | 关键结论 / 残余 |
|---|---|---|---|
| P0-1/2/3 | `SUMMARY-P0.md` | ✅ | 会话常驻、失败放行、去重口径收窄 |
| WP1 留痕可查（读） | `WP1.md` + `WP1-REVIEW.md` + `WP1-REVIEW2.md` | ✅ | C2/C3 已闭合（复审做了变异实测）；C1/C4 转 WP1-R |
| WP1-R 留痕（写） | `WP1-R.md` | ✅ | `out-of-scope`、`signature-missing`、rowCount 校验、病因分开记、`content-duplicate` 可达 |
| WP2 会话域隔离 | `WP2.md` | ✅ | 主键 `(repo,domain,issue_number)`；迁移 `0014`；同号两域两行互不影响 |
| WP3 标签三件套 | `WP3.md` + `WP3-REVIEW.md` | ✅ / 复核中 | I4 与 FR-5.4 的裁决待复核裁定 |
| WP4 增量投喂 | `WP4.md` + `WP4-REVIEW.md` + `WP4-R.md` | ✅ | S1/S2/S3/S5 闭合；S4 转 WP11 落地 |
| WP5 压缩 | `WP5.md` + `WP5-REVIEW.md` + `WP5-R.md` | ✅ | 前缀→**换会话重建**；硬边界守真包；**AC-24 仍未实现**（缺摘要模型） |
| WP6 记录完整性 | `WP6.md` | ✅ | `/trace` 一次给全四段；修 `runs.outcome` 静默失配 |
| WP7 执行限额 | `WP7.md` + `WP7-REVIEW.md` + `WP7-R.md` | ✅ | **SL-1 未实现（协议阻塞）**；F1/F2 两个致命 bug 已修；SL-2/3/4/5 已实现 |
| WP8 评论配置 | `WP8.md` | ✅ | CC-3/CC-4 已实现（id 匹配 + 保存校验）；CC-1 面板侧待接线 |
| WP9 供应商与角色 | `WP9.md` | ✅ | CFG-8.1/8.2/8.3/9.1/9.2 已落地；迁移 `0013` |
| WP10 产出契约与工具 | `WP10.md` | ✅ | FR-5.1 兜底评论**整层移除**；FR-5.3 12→7；Q-6 删映射表；TOOL-3/5 |
| WP11 面板重构 | `WP11.md` | ✅ | 五页删除、三左栏 320/300/30/28/3、首屏四段 |
| WP12 契约补字段 | `WP12.md` | ✅ | C1~C4 已补并验到真库；C5 后端就绪 |
| WP13 面板接线 | `WP13.md` | ✅ | C3 全量计数（`null` 不冒 0）、C4 信封折叠块（4000 字符截断）、C5 供应商/四档单价进系统模态框 |

### 全量验证（编排侧实跑，最终轮）
```
cd apps/server; npx tsc --noEmit        → exit 0
pnpm -r typecheck                       → 6/6 Done
cd apps/server; npx vitest run          → 139 files / 1763 passed / 2 skipped / 0 failed
pnpm -r test                            → server 1763 / panel 177 / contract 152 / racp-client 89 / shared 30，全绿
pnpm lint                               → 0 error（6 warning 在 scripts/spike，既有）
```

### 仍然未达成的（诚实清单，不许含糊）
1. **AC-24**：压缩两次后复述目标与硬约束 —— 默认无摘要模型时兜底摘要的「约束与偏好」恒为空 → **未实现**。缺：摘要模型通道（RACP 或 provider 客户端），或兜底摘要的规则化约束抽取（产品决策）。
2. **AC-25 的「后台能看到」**：数据落库 ✅、原文一条不少 ✅，但 HTTP 路由与面板展示此前缺失（`queries/compactions.ts` 未登记）。WP11/WP12 后需再核一次。
3. **SL-1「每次调用都带」**：协议层只有 `session/create` 带 `systemPrompt` → **未实现（协议阻塞）**。需 RACP 给 `turn/start` 加 system 槽位。
4. **CC-1 面板侧 `case_sensitive`** 被抹掉 → WP13 面。
5. **OpenAPI 缺多段路径端点**：生成器 `Endpoint.pathParam` 只支持单参数，`/api/repos/{owner}/{name}/deliveries` 与 `/api/issues/{...}/trace` 写不进产物（`openapi-typescript` 生成失败是同一缺口，AGENTS §8.4 已记录）。

## 七、编排侧裁决（WP4-R vs WP11 的 `apps/panel` 冲突）

`apps/panel/**` **归 WP11**（它要整体重构导航与三左栏，改动面大）。
WP4-R 的 S4 只做一件事：**不要改面板代码**，改为在 `docs/audit/fix/WP4-R.md` 里写清「面板应如何说明首轮/后续轮模板分支」的具体文案与位置，由 WP11 落地。
后续 `apps/panel/**` 移交 WP13（面板接线收尾）。
