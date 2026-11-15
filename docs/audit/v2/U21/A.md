# U21 6.8 供应商与模型角色（全局） · A

> 核查范围：docs/requirements.html 行 1742-1759
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| CFG-8.1 | 未实现 | 全仓没有「供应商记录」实体（无表 / 无契约 / 无接口 / 无界面）；只有一个进程级 env 三元组 `apiKey/baseUrl/name`，且模型 key 不加密存储、无掩码显示、无逐行连通性测试 |
| CFG-8.2 | 未实现 | 契约与库里都没有「模型角色」四档；唯一价目是写死的 DeepSeek 表（仅用于成本归集，界面不展示单价），也没有「429 / 超时降级到兜底模型」链路 |
| CFG-8.3 | 未实现 | 不存在任何全局模型配置（面板全局路由只有 总览/成本/质量/审计/系统）；项目级只有一个自由文本「默认模型」输入框，没有「继承全局（模型名）」态，且该字段全仓无消费方 |

## 逐条

### CFG-8.1
- **状态**：未实现
- **证据**：
  - 实体不存在：`apps/server/src/db/schema.ts:514` 起的 `host_credentials` 是唯一「凭据」表，列只有 `host_id / token_enc / version / expires_at`（`:516-522`）；`migrations/*.sql` 的 `CREATE TABLE` 清单（0000–0011）里没有 `providers` 之类的表。契约侧 `packages/contract/src` 全目录 grep `provider` 只命中 `enums.ts:202` 的 `MODEL_NAME_RE` 注释与 `trigger.ts` 的 `maskCodeRegions`（代码块蒙版，与本条无关）；`openapi/pi-bot.openapi.json` 里 `Provider` 出现 0 次。
  - 现有模型配置是**单一扁平三元组**，不是「一条一行」：`apps/server/src/app/config.ts:173-180`（`model: { apiKey, baseUrl, name }`，三者均可为 `null`），由 `:327-337` 从 `PI_BOT_MODEL_API_KEY / PI_BOT_MODEL_BASE_URL / PI_BOT_MODEL_NAME`（含 `OPENAI_*` 别名）读出，`:410-414` 装配。没有 name/model 列表，没有多供应商并存。
  - 无「可用 model 列表」消费方：唯一会列模型的是 doctor 探针自用，`apps/server/src/doctor/checks/model-endpoint.ts:126-136` 把 `GET <base>/models` 的 id 列表只用于「配置名是否在列表里」的判断，不落库、不进契约、面板拿不到。
  - 掩码显示缺失：`apps/server/src/app/config.ts:463-469` 只产出 `{ baseUrl, name, keyConfigured }` 进**启动日志**（`compose.ts:1488` 调用），没有任何 API 契约字段；面板侧 grep `掩码|已存|未配置|keyConfigured` 在 `apps/panel/src` 命中 0 处（命中的 `未配置` 都是 GitHub/pi-host 文案）。
  - 连通性：有 CLI 预检，但不是「状态点 + 延迟，可手动测试」：`doctor/checks/model-endpoint.ts:82-102` 打 `GET <base>/models` 并用 `ctx.elapsed()` 算毫秒，结果只作为字符串 `detail`（`:140-144`）；该结果进不了面板——`apps/server/src/queries/system.ts:139` 把 `doctor` 硬编码成 `{ status: 'not-run', checkedAt: null, checks: [] }`（注释 `:23` 「doctor 产物未落库（W3-L）」），因此 `apps/panel/src/routes/system.tsx:180-181` 永远渲染「doctor 还没跑过」。
  - 界面上根本没有供应商页：`apps/panel/src/routes.tsx:53-94` 的全局路由只有 `/ /costs /quality /audit /system`；仓库设置只有四个分区 `apps/panel/src/layout/nav.ts:73-78`（通用/事件绑定/标签/执行）。
  - **安全两半的实测结果**（这两项确实成立，但不能救本条）：
    - 「不进容器」成立：容器 Env 白名单写死在 `apps/server/src/sandbox/hostconfig.ts:165-170`（只有 `NODE_OPTIONS/HOME/CI/TERM`，注释即「**不含任何凭证**」），`exec-plan.ts:53-54,88` 的 `docker exec -e` 只透传 `PI_BOT_CMD` 标记。模型 key 只经 `compose.ts:601` 的 `extraEnv: hostModelEnv(config)`（`app/model-env.ts:36-53`）给 pi-host。
    - 「解密失败必须报错」在加解密模块成立：`apps/server/src/runtime/crypto.ts:180-192` 在 `createDecipheriv` 失败时抛 `AppError{code:'CRYPTO_DECRYPT_FAILED', failureClass:'auth'}`，不是返回空串；格式/版本/IV 长度不对也都抛（`:149-178`）。但**解密的唯一对象是 RACP 设备令牌**，唯一调用方是 `runtime/bootstrap.ts:440-449` 的 `readDeviceToken()`；**模型 key 从来不走加解密**——它是 `config.ts:175` 从 env 读出的明文，既不入库也不加密，所以「key 加密存储」这条对模型 key 无从谈起。
- **缺口**：缺的子条件按需求原文逐个点名——(1) 供应商**实体**（表/契约/接口）不存在，因此「一条一行」无从谈起；(2) 名称 / base URL / key 三个字段没有落到任何面板可见的记录上（只有一个部署级 env 三元组）；(3) 无 key **加密存储**（模型 key 明文来自 env，`crypto.ts` 只管设备令牌）；(4) 无掩码与「已存 / 未配置」界面（服务端只有日志里的布尔）；(5) 无「该家可用 model 列表」的展示；(6) 连通性只有 CLI doctor 的字符串 detail，无状态点 / 延迟字段进契约，面板 `/api/system` 恒为 `not-run`，也无「手动测试 / 测试全部」入口；(7) 「OpenAI 兼容自建端点按同一行填写」的承载对象不存在。影响：运维无法在面板里看出「现在用的是哪家、key 存没存、端点通不通、延迟多少」，更换供应商只能改 env 并重启（`.secrets/README.md:55` 明确「环境变量只在进程启动时读一次」）。
- **判定依据**：需求本条的主语是「每个供应商记录」，而全仓既无该记录的表/契约，也无读写它的接口与页面；仅有的一个进程级 env 三元组不构成「一条一行」的记录，也没有掩码、加密、逐行连通性三项子条件。代码里成立的两条（key 不进容器、解密失败抛错）都作用在**设备令牌**这条旁路上，不能算到供应商记录头上，故判未实现而不是部分实现。

### CFG-8.2
- **状态**：未实现
- **证据**：
  - 契约里没有「模型角色」：`packages/contract/src/settings-v21.ts` 全文 grep `model|Model` 命中 0 次；`agentExecutionSchema`（`:231-246`）的字段只有 `system_prompt / concurrency / daily_quota / turn_timeout_minutes / actions / data_retention_days`，没有任何「角色 → 供应商 + 模型」的绑定。
  - 四档角色在运行时也没有落点：`apps/server/src/skills/assemble.ts:66` 确有 `AssembleStage = 'format' | 'classify' | 'agent'`，但它是**提示词装配位置**的枚举，与「绑定哪个模型」无关；`config/v21-settings.ts` 里 grep `model` 命中 0 次，`resolveAgentExecution()` 不产出模型。
  - 全局只有一个模型名：`apps/server/src/app/model-env.ts:36-53` 把 `config.model` 的三个值原样写给 pi-host；要按角色分模型，pi-host 只会收到单一 `PI_BOT_MODEL_NAME`。
  - 单价存在但不是本条要的东西：`apps/server/src/cost/pricing.ts:29-32` 写死 `DEEPSEEK_PRICES`（flash/pro 的 `cacheHit/cacheMiss/output`），`resolveTier()`（`:47-50`）按模型名含 `pro` 分档，`estimateDeepSeekCostUsd()`（`:102-113`）用它算钱；但价目是**代码常量**，不进任何契约/接口，界面拿不到——`packages/contract/src/api.ts:409-419` 的 `costsResponseSchema` 只有 `byModel` 的 token/金额桶，无 `inputPrice/outputPrice`；面板 grep `单价|价格|pricing` 只有 `routes/costs.tsx:172-174` 的 `pricingCoverage` 覆盖率提示。
  - 「429 / 超时降级到兜底模型」不存在：`apps/server/src/queue/retry-policy.ts:156-167` 对 `rate-limit` 的处理是 `mode:'startAfter'` **重投同一个任务**（不换模型）；`:194-196` 对 `model` 类是 `noRetry`（「转异常兜底通知」）；`apps/server/src/worker/fallback.ts:1-22` 的「兜底」是**信封不可信时发一条纯文本评论**，与模型降级无关。run 的模型名只能事后从 pi-host 的 usage 读出来（`worker/run-task.ts:1599-1610` 用 `usage.modelId` 计费），是**观测**而非**选择**。
- **缺口**：缺的子条件——(1) 四档角色 `agent / format / classify / 兜底` 不存在（无契约字段、无配置项、无运行时消费）；(2) 「每档绑定供应商 + 模型」不存在（连同 CFG-8.1 的供应商实体一起缺）；(3) 「每档显示输入 / 输出单价」不存在：价目是写死的 DeepSeek 常量，只有 `cacheHit/cacheMiss/output` 三个价，没有「输入/输出双价 + 档位」的界面或契约字段；(4) 兜底降级链路不存在，429 走的是同模型重投、超时按 §9.1 直接 `noRetry`。影响：无法按任务类型选便宜模型（格式检查也烧 `agent` 模型的价），也无法自动躲开限流，成本页只剩一个「算出来的数」而没有界面依据。
- **判定依据**：本条四个子条件（四档、各绑供应商+模型、各带输入/输出单价、兜底降级）逐条追到消费方，全部为空；仓库里确有价目与成本估算，但它是「按模型名分 flash/pro 算钱」的常量表，既没有档位概念，也不面向界面，无法支撑本条。

### CFG-8.3
- **状态**：未实现
- **证据**：
  - 没有全局模型配置的承载处：`apps/panel/src/routes.tsx:53-59` 的全局导航只有 总览 / 成本 / 质量 / 审计 / 系统，`/system` 页（`routes/system.tsx:134-331`）的内容固定为「版本与协议 / doctor / 队列与保留 / 仓库」，没有模型或供应商块；服务端也没有任何「全局配置」表——`schema.ts` 的 24 张表清单里没有 settings/globals 一类，`runtime_flags`（`:536-557`）是熔断开关。
  - 项目级只有自由文本输入，且不是「继承全局」态：`apps/panel/src/components/settings/v21-agent-section.tsx:261-280` 是一个 `TextField`（id `limits-model`，label「默认模型（provider/model，可留空）」，`placeholder="anthropic/claude-sonnet-4"`），hint 写「留空 = 用部署默认模型」——即「空串 = 继承」，但界面**不显示**被继承的模型名（拿不到全局值），也不是下拉。
  - 该字段本身没有消费方：契约 `packages/contract/src/repo-config.ts:219-220` 有 `model: z.string().regex(MODEL_NAME_RE).optional()`，但全仓 grep `settings.model` / `policy.settings.model` / `resolveAgentExecution(...).model` 均无命中；`worker/run-task.ts` 只读 `settings.labels / .actions / .limits / .agent`（`:1313-1400` 区间），`compose.ts:601` 写 pi-host env 时也只取 `config.model`（部署 env）。所以「项目可覆盖」在运行时也**不生效**——留空与填值对 pi-host 是同一套 env。
  - 技能 frontmatter 的 `model` 同样是死字段：契约 `packages/contract/src/skills.ts:115-116` 定义、`:144` 展示为 `SkillEffectiveConfig.model`、`:178` 展开，但 `apps/server/src/skills/` 与 `agent/` 下 grep `.model` 命中 0 处，`skills/prompt.ts:700-710` 渲染技能段时也不写模型。
- **缺口**：缺的子条件——(1) 「模型角色在全局配置」这一层完全不存在（无全局页、无全局存储、无全局接口）；(2) 项目级「执行」里没有「继承全局（模型名）」的展示态，只有空串的隐式继承且不显示被继承的名字；(3) 「两处不并列摆放可直接选择的模型下拉」这条作为**约束**暂时未被违反（只有一处，且是文本框而非下拉），但代价是本条要求的「全局 + 覆盖」两级结构根本不存在。影响：换模型只能改部署 env 重启，项目级那个输入框会让人以为改了生效（写入 jsonb 但不影响 pi-host），是一处会误导的**死配置**。
- **判定依据**：需求要求的是「全局给默认值 + 项目可覆盖（显示继承值、点开才覆盖）」的两级结构；代码里既无全局层，项目层的那个字段也没有任何消费路径（连「隐式继承」都没接到 pi-host），故整条不成立。

## 本节整体结论
6.8 三条**全部未实现**，且原因同一个：`供应商` 与 `模型角色` 这两类实体在库、契约、接口、面板四处都不存在。现状是「一个部署级 env 三元组（`PI_BOT_MODEL_API_KEY/BASE_URL/NAME`）→ 原样传给 pi-host」，只能表达一个供应商的一个模型。与需求最接近的三处碎片都对不上口：`cost/pricing.ts` 有写死的 DeepSeek 价目但没有档位与界面、`doctor` 有端点预检但其结果进不了面板（`queries/system.ts:139` 恒 `not-run`）、`repo-config.ts:219` 有 `model` 字段但无消费方。安全侧两条（key 不进容器、解密失败抛错）在代码里确实成立，但作用对象是 RACP 设备令牌，不是模型 key；模型 key 至今以明文 env 形式存在，没有「加密存储」。因此本节整体判为**未实现**。

## 核查边界
- 是否执行了命令：执行了只读的 `git status --short`、`git ls-files`、`git grep -n`、`Select-String`（含 `migrations/*.sql` 的 `CREATE TABLE` 清单、`openapi/pi-bot.openapi.json` 里 `provider` 出现次数）；**未**执行 typecheck / lint / 测试，未起 PG / Docker / 真模型，结论均为纯静态取证。
- 未覆盖的条目及原因：无（三条均在本节范围内，均已逐子条件核对）。未做运行时验证的部分：doctor 探针的实际网络行为、pi-host 是否真的只认 `PI_BOT_MODEL_NAME`（后者属 rcaps/pi-host 侧，不在本仓）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **死字段**：`packages/contract/src/repo-config.ts:219-220` 的 `repos.settings.model` 被面板写入（`v21-agent-section.tsx:266-270`）、被契约接受，但全仓无读取方——既不进 pi-host env，也不进 prompt/计费口径。面板 hint 写「留空 = 用部署默认模型；技能可在 frontmatter 里覆盖」，实际两条都不生效。
  2. **技能 `model` 同样无消费方**：`packages/contract/src/skills.ts:115-116,144,178` 定义并展开，`skills/` 与 `agent/` 下零读取，`skills/prompt.ts:700-710` 渲染技能段时不带模型。
  3. **doctor 结果不落库**：`apps/server/src/queries/system.ts:139` 硬编码 `not-run`，导致 `routes/system.tsx:180-181` 的「doctor 逐项检查」在面板上永远为空——包括其中的 `model-endpoint` 探针（含 latency、可用模型数）。这是「面板看不到连通性」的根因，影响范围大于本节。
  4. **面板文案与实现不符**：`v21-agent-section.tsx:239-242` 注释称「v0.3 的 limits 与默认模型并入本分区」，`:276` 的 hint 承诺「技能可在 frontmatter 里覆盖」，均无运行时代码支撑。
