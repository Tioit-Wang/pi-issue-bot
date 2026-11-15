# U21 6.8 供应商与模型角色（全局） · B

> 核查范围：docs/requirements.html 行 1742-1759
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa029）

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| CFG-8.1 | 未实现 | 全仓无「供应商」实体（表/契约/面板页都没有），只有一套 env 单端点；key 明文来自 env、无加密与解密失败路径，面板不显示 key 掩码/连通性点/延迟/手动测试/模型列表 |
| CFG-8.2 | 未实现 | 没有四档角色绑定，只有「一个模型」；价目是按 deepseek flash/pro 两档写死在服务端常量里、面板不展示；429/超时后不换模型，`model` 类失败直接 noRetry |
| CFG-8.3 | 未实现 | 项目级 `model` 字段存在但全仓无消费方（死字段），面板也没有「继承全局（模型名）」这一形态，只有自由文本输入 |

## 逐条
### CFG-8.1
- **状态**：未实现
- **证据**：
  - `apps/server/src/db/schema.ts:146`、`apps/server/src/db/schema.ts:514` — 全表清单共 24 张 `pgTable`（webhook_deliveries / repos / tasks / runs / run_events / envelopes / actions / bot_labels / issue_fingerprints / issue_states / usage_costs / degeneracy_hits / metrics_daily / host_credentials / runtime_flags / panel_sessions / issue_feedback / label_decisions / quota_counters / agent_sessions / agent_messages / agent_denials / comment_slots / agent_compactions），**没有 providers / models / model_roles 任何一张**，也没有「供应商」字段。
  - `apps/server/src/app/config.ts:173` — 模型配置只有三元组 `model: { apiKey, baseUrl, name }`（`null` = 未配），即**一条端点**；来源是 `apps/server/src/app/config.ts:89` 的 `PI_BOT_MODEL_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` 环境变量，不是库里的多行记录。
  - `apps/server/src/app/model-env.ts:36` — `hostModelEnv()` 把 apiKey/baseUrl/name 白名单式塞给 pi-host 子进程；「key 不进容器」这一子条件是**满足**的（注释 `apps/server/src/app/model-env.ts:8` 明确沙箱不拿凭证）。
  - `apps/server/src/runtime/crypto.ts:186` — 唯一的 AES-256-GCM 解密在失败时抛 `decryptFailed`；但调用点只有 `apps/server/src/runtime/bootstrap.ts:449`（`host_credentials.token_enc` → RACP **设备令牌**，见 `apps/server/src/db/schema.ts:513`）。模型 key 这条链**没有加解密层**，所以「key 加密存储 / 解密失败必须报错」对模型 key 无从谈起。
  - `apps/panel/src/layout/nav.ts:23` — 面板导航只有 总览 / 成本 / 质量 / 审计 / 系统，没有任何「供应商 / 模型」页；`apps/panel/src/components/settings/v21-agent-section.tsx:264` 是全仓唯一与模型有关的输入（自由文本）。
  - `apps/server/src/queries/system.ts:139` — `/api/system` 的 `doctor` 固定返回 `{ status: 'not-run', checkedAt: null, checks: [] }`（文件头 `apps/server/src/queries/system.ts:23` 自述 doctor 产物未落库），面板 `apps/panel/src/routes/system.tsx:181` 因此只能显示「doctor 还没跑过」→ 状态点/延迟在面板上**不可见**；探测本身只在 CLI 侧存在（`apps/server/src/doctor/checks/model-endpoint.ts:91` 与 `:102` 计算 `elapsedMs`）。
  - 「手动测试」：`apps/server/src/http/api/index.ts` 的路由全集为 GET `/api/overview|tasks|costs|quality/reverts|audit|system|issues|repos` + PUT `/api/repos` + POST `/api/repos`，**没有**任何模型连通性测试端点。
- **缺口**：缺的是一整块主体——（1）多条供应商的存储实体与读模型；（2）面板按「名称 / base URL / key 掩码（已存·未配置）/ 连通性点+延迟 / 可用模型列表」一条一行的界面；（3）手动测试入口；（4）模型 key 的加密存储与「解密失败报错」。现状是「换供应商改 env」的单端点（`apps/server/src/app/config.ts:92` 注释），与需求的多家并列不是同一形状。
- **判定依据**：需求四要素（多行供应商、掩码展示、面板连通性、可手动测试）无一存在；env 单端点在形态上只能覆盖「一家」，且面板不展示它。故不能算部分实现。
- **反证过程**：
  1. 先假设「有供应商实体，只是名字不同」→ 遍历 `schema.ts` 全部 24 个 `pgTable`，并搜 `apps/server/src`、`apps/panel/src` 的 `provider|providers|model_roles`：命中项全是 fastify 的 type provider、GitHub 的 token provider、repoIssues provider、以及注释里的「provider 口径 token」。**无实体**。
  2. 假设「有加密，只是没搜到调用方」→ 追 `decryptSecret` 的调用链：`runtime/crypto.ts:146` 定义 → `runtime/index.ts:38` 导出 → 唯一实调用 `runtime/bootstrap.ts:449` 解 `tokenEnc`（设备令牌）。若把这条算作 CFG-8.1 达标，就是张冠李戴。
  3. 假设「掩码/连通性在面板某处」→ 搜面板 `已存|未配置|延迟|测试`：`pricingCoverage`/doctor 分组是别的需求项；`describeAppConfig`（`apps/server/src/app/config.ts:465`）确实给 `keyConfigured` 布尔值，但它只进日志（文件头 `:442` 自述「存在性可以出现，值永远不出现」），**不是界面**。
  4. 假设「doctor 的 `/models` 探测等于连通性+延迟+模型列表」→ 该项只在 CLI `doctor` 里跑，结果不落库（`queries/system.ts:139`），且模型列表只取前 5 个当前缀提示（`doctor/checks/model-endpoint.ts:134`），不是可选的可用模型列表。
  5. 结论：**完全没有**，不是「有一半」。

### CFG-8.2
- **状态**：未实现
- **证据**：
  - 角色绑定：`apps/server/src/app/config.ts:173` 的模型配置没有 role 维度；`apps/server/src/app/model-env.ts:47` 只把**一个** `name` 写进宿主环境；`apps/server/src/{runtime,agent,skills}` 下对 `model` 的引用只有 `apps/server/src/skills/bundle.ts:354`（校验 skill frontmatter 的 `provider/model` 格式），**没有任何按角色选模型的代码**。
  - 单价：`apps/server/src/cost/pricing.ts:29` 的 `DEEPSEEK_PRICES` 是按 `flash | pro` **两档**（cacheHit/cacheMiss/output）写死的常量，`apps/server/src/cost/pricing.ts:47` 用模型名里是否含 `pro` 分档；这是「按模型名猜档」的价目，不是「四个角色各自带输入/输出单价」。面板侧无任何单价展示：`apps/panel/src/routes/costs.tsx:172` 只显示金额与 `pricingCoverage`。
  - 兜底降级：`apps/server/src/queue/retry-policy.ts:194` — `FAILURE_CLASS.model` 直接 `noRetry`；`apps/server/src/queue/retry-policy.ts:163` — 429 走 `mode: 'start-after'` 重投**同一个 job / 同一个模型**；`apps/server/src/worker/run-task.ts:1265` 的 `postFallbackComment` 是「信封不可用时的兜底评论」，与模型降级无关。
  - 缺第二模型配置：`apps/server/src/app/config.ts:89` 起的 env 键里没有 fallback / format / classify 任何一档。
- **缺口**：缺四档角色与「角色 → 供应商+模型」的映射，缺每档的输入/输出单价展示，缺 429/超时后的换模型降级实现。现有的只是「单模型 + 服务端写死两档价目」。
- **判定依据**：需求的三个子条件（四档绑定、每档单价、兜底降级）无一有执行路径；写死常量 + 面板不展示，按任务规范直接判未实现。
- **反证过程**：
  1. 假设「角色只是没被叫 role」→ 搜 `MODEL_FORMAT|MODEL_CLASSIFY|MODEL_FALLBACK|lightModel|fastModel`：零命中；再看 env 键全集（`apps/server/src/app/config.ts:89-98`），只有 key/baseUrl/name 三个槽。
  2. 假设「价目表可按模型分档，等于按角色分档」→ `pricing.ts:29` 的档位是 `flash/pro`，由 `resolveTier()`（`:47`）从**模型名**推断，与 agent/format/classify/兜底四个角色无映射关系；且档位表里没有「角色」概念。**写死常量 + 面板不展示 = 未实现**。
  3. 假设「429 会让队列换个模型再试」→ 读 `retry-policy.ts:150-168`：429 的决策是 `startAfter` 重投，job 的 `args` 不变（模型来自宿主 env，bot 侧根本没有换模型的手段）；`retry-policy.ts:196` 对 model 类失败明确「转异常兜底通知」。**只有重试，没有降级**。
  4. 假设「`fallback` 这个词出现在 run-task 里就是降级」→ 打开 `worker/run-task.ts:1263-1286`：`fallback` 指写回失败时发一条兜底评论，事件名 `writeback.fallback`。是**写回**兜底，不是模型兜底。
  5. 结论：**完全没有**。

### CFG-8.3
- **状态**：未实现
- **证据**：
  - 字段与界面存在：`packages/contract/src/repo-config.ts:220` — `model: z.string().regex(MODEL_NAME_RE).optional()`（自由文本 `provider/model`）；面板 `apps/panel/src/components/settings/v21-agent-section.tsx:262` 是一个 `TextField`，`hint`（`:276`）写「留空 = 用部署默认模型；技能可在 frontmatter 里覆盖」。
  - 无消费方：`apps/server/src` 里所有 `.model` 读取点是 `apps/server/src/app/config.ts:410`/`:465`（部署 env）、`apps/server/src/app/model-env.ts:37`、`apps/server/src/cost/pricing.ts:110`、`apps/server/src/worker/run-task.ts:1599` 与 `:1602`（后者的模型名来自 pi-host 上报的 `usage.modelId`）。**没有一处读 `repos.settings.model`**；`runtime/`、`agent/`、`skills/` 目录内搜 `model` 只有 `skills/bundle.ts:354` 的格式校验。契约注释 `packages/contract/src/repo-config.ts:219` 自称「只影响成本归集」，但成本归集写的是 `usage.modelId`（`worker/run-task.ts:1602`），该注释与代码不符。
  - 无「继承全局（模型名）」形态：面板拿不到「全局模型名」——`packages/contract/src/api.ts:646` 的 `systemResponseSchema` 里没有 model 字段，`apps/panel/src/layout/nav.ts:23-27` 也没有全局模型入口；项目级只有一个自由文本输入，不是「显示继承值、点开才覆盖」的控件。
- **缺口**：项目级模型覆盖是**死字段**（写进 jsonb、面板可编辑，但运行期无人读，改了不改变任何行为），且缺少「继承全局（模型名）」的展示与「点开才覆盖」的交互。需求要的「全局给默认值」这一层在面板上根本不存在（默认值只在 env）。
- **判定依据**：任务规范明确「字段存在但全仓无人读 = 死字段」，按未实现处理；同时「继承态」形态与文案也不存在，两项缺口叠加。
- **反证过程**：
  1. 假设「读它的是装配层，用括号取值所以搜不到 `.model`」→ 补搜 `['model']` / `["model"]` / `modelName` / `repoModel`：命中全部落在 env 解析（`app/config.ts:97`）与 doctor（`doctor/checks/model-endpoint.ts:64`），**无 jsonb 路径**。
  2. 假设「技能 frontmatter 的 model 会覆盖它，所以间接生效」→ `packages/contract/src/skills.ts:178` 把 `frontmatter.model` 放进 skill 的 effective config，但同样没有 runtime 读取（`runtime/`、`agent/` 内 `model` 零命中，`apps/server/src/app/model-env.ts` 只读部署 env）。所以连「技能覆盖」那条 hint 也是空的——这是第二个死字段（见「额外问题」）。
  3. 假设「面板那个输入框其实是继承态」→ 读 `v21-agent-section.tsx:262-279`：`value={draft.model ?? ''}` + `placeholder="anthropic/claude-sonnet-4"`，没有任何全局模型名的读取与「继承全局」文案；需求要求「两处不并列摆放可直接选择的模型下拉」，而这里连下拉都没有（自由文本）。
  4. 结论：字段在、消费方零 → **未实现**，不是部分实现。

## 本节整体结论
6.8 明确不可判为「已实现」。供应商（CFG-8.1）在数据层、契约层、面板层都不存在，现状是「一套 env 单端点 + 换供应商改环境变量」；模型角色（CFG-8.2）没有角色概念，价目是服务端写死的 deepseek 两档、面板不展示，429/超时也没有换模型降级；全局默认与项目覆盖（CFG-8.3）只有一个无人读取的自由文本字段。三条均为**未实现**，且缺口是结构性的（缺实体、缺界面、缺执行路径），不是补文案能收口的。

## 核查边界
- 是否执行了命令：执行了只读检索——`git log --oneline -1`（HEAD = fbfa029，与 baseline 一致）、`Select-String` 全仓扫 `provider|baseUrl|model_roles|429|fallback|单价|pricing|AES|decryptSecret|['model']` 等模式、`Get-ChildItem` 列 `apps/*/src` 目录。**未执行** typecheck / test / build，结论为纯静态核查。
- 未覆盖的条目及原因：无（CFG-8.1/8.2/8.3 三条均已核）。「面板实际渲染效果」未在浏览器验证，只按源码判断；这不影响三条的结论（组件不存在 / 文本输入形态可读）。
- 发现的额外问题（不属本节范围）：
  1. `apps/server/src/skills/bundle.ts` 与 `packages/contract/src/skills.ts:178` 让技能 frontmatter 带 `model`，但运行期无消费方 —— 技能级模型同样是死字段（属 6.7 范围）。
  2. `packages/contract/src/repo-config.ts:219` 的注释「只影响成本归集」与代码不符（成本归集用 `usage.modelId`，见 `apps/server/src/worker/run-task.ts:1602`）——注释在此处是**第二处真相**，建议改写或删掉。
  3. `apps/server/src/app/config.ts:341` 只在「配了 key 但缺模型名」时报错；「配了 baseUrl + name 但没有 key」不报错，doctor 只在 `/models` 返回 401/403 时才 fail（`doctor/checks/model-endpoint.ts:104`），启动期可带着无 key 的端点跑起来。
