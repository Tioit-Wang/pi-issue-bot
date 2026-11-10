# 需求分析 · 面板技能管理（上传 zip / CRUD / 动态加载 / AGENTS.md）

> 状态：**待审核**（2026-11-10）。本文只做分析与方案，不含实现。
> 审核通过后，实施切分见 §11；需要你拍板的点集中在 §12。

---

## 0. 结论摘要

1. **现在的技能系统有一半是空转的**：契约、schema、注册表、渲染器都写好了，但 **worker 没接线** ——
   真跑的时候技能正文根本没进提示词（`app/worker-deps.ts:152` 留有 TODO）。所以「面板能上传技能」
   之前，必须先修「技能到底怎么进提示词」这件事，否则上传了也不生效。
2. **上传 + CRUD 会把面板从「只读」变成「可写」**，这是本项目目前最大的架构不变量变更：
   现有 API 全是 GET、鉴权可被 `PI_BOT_PANEL_AUTH=off` 关掉、没有任何 CSRF/写审计链路。
   这一条不解决就不该上线（详见 §8）。
3. **AGENTS.md 与技能是两类东西**：AGENTS.md 是「仓库约定/事实」，随目录树就近覆盖且**总是**进上下文；
   技能是「一套流程」，只在使用时按需展开。两者要分别装配、分别限长，不能混成一个字段。

---

## 1. 现状（代码事实）

| 事项 | 事实 | 位置 |
|---|---|---|
| 技能契约 | frontmatter **strict**：`name` 必须 `^/[a-z][a-z0-9-]{1,30}$`（带前导 `/`）、`description` 单行 10–200、`allowed-tools ⊆ {Read,Write,Edit,Glob,Grep,Bash}`、`outputs ⊆ {comment,labels,issue,pr}`、`timeout ≤30m`、未知名一律拒绝 | `docs/spec/contract-skill.md` |
| 技能来源 | 内置 `skills/builtin/<name>/SKILL.md`（低优先级）+ 仓库 `.github/pi-bot/skills/<name>.md`（高优先级） | `apps/server/src/skills/registry.ts:26,153` |
| 注册表 | `createSkillRegistry({...}).resolve(name)`，读文件、按 name 归一、仓库覆盖内置 | `registry.ts:151,255` |
| 渲染器 | `renderSkillPrompt()` 已有：不可信正文 `sanitizeUntrustedText` + 围栏 + 截断（body 上限 4000 字符） | `skills/prompt.ts:24,99,136,217` |
| **接线缺口** | `buildTaskPrompt` 仍是手写骨架，**没有调用 `renderSkillPrompt`**；真机上技能正文不进提示词 | `app/worker-deps.ts:152`(TODO)、`:185,237` |
| 面板 | 10 条 `/api/*` **全是 GET**；鉴权 `createPanelAuth` 支持 `off`（loopback 缺省关） | `http/api/index.ts`、`app/compose.ts:294` |
| 上传能力 | 依赖里**没有** `@fastify/multipart`；有 `@fastify/static` | `apps/server/package.json` |
| AGENTS.md | **全仓无任何处理**（grep 命中 0） | — |
| 数据库 | 没有 `skills` 表；技能只有「文件」一种存在形式 | `migrations/`、`db/schema.ts` |

---

## 2. 行业做法（已核对原文）与映射

### 2.1 Agent Skills（SKILL.md 目录）

- 一个技能 = **一个目录**：`<skill-name>/SKILL.md` + 可选附带文件（脚本、参考资料、模板）。
- `SKILL.md` 有 YAML frontmatter，最少 `name` + `description`。
- **渐进披露（progressive disclosure）**：启动时只加载 `name` + `description`（决定「要不要用」），
  **正文只在被使用时加载**，附带文件按需读 —— 长参考材料在没用到时几乎不花 token。
- `allowed-tools` 用于预批准工具；技能可以 `/skill-name` 直接调用。
- 对外展示的文本（如 description）会做**控制字符清理与尖括号转义**，防止它模仿宿主内部格式。

**映射到本项目**：我们的契约已经是这个形状（frontmatter + `allowed-tools` + `outputs` + 按名调用）。
缺的是「目录 + 附带文件」与「渐进披露」：现在只有单文件 `*.md`，且没有「先给名字/描述、用时才给正文」的两段式装配。

### 2.2 AGENTS.md

- 定位是「给 agent 看的 README」：构建/测试命令、代码风格、安全注意、提交规范。
- **可嵌套**：把 `AGENTS.md` 放进子目录，agent 读**目录树里最近的那个**，就近者优先
  （原文：*the closest one takes precedence*）；OpenAI 主仓当时有 88 个。
- 事实标准，跨 Codex / Jules / Cursor / Amp / Zed 等。

**映射到本项目**：仓库根 `AGENTS.md` 应当**总是**进上下文（作为「仓库约定」层），
子目录 `AGENTS.md` 只在任务涉及该目录时按需追加。这与我们「技能按需展开」正好互补。

---

## 3. 目标 / 非目标

**目标**
1. 面板能对技能做 CRUD，并能**上传一个 zip**（zip 内容就是行业标准形态的技能目录）来创建/更新技能。
2. 技能**动态生效**：上传即生效，靠**开关**（`enabled`）控制启停，开启后即可 `/xxx` 调用；
   下一次任务即使用，不需要重启进程；已在跑的任务不受影响（入队快照语义）。
3. 加载 **AGENTS.md**（仓库根 + 就近子目录），与技能一起进入提示词，各自有限长与优先级。
4. 全过程可审计：谁、什么时候、传了什么、改了什么、删了什么。

**非目标（本轮不做）**
- 不做市场/共享/从 URL 安装技能（只接受 zip 上传与面板内编辑）。
- 不做技能内代码执行沙箱的扩展：技能里带的脚本仍只能通过 `Bash` 工具、在既有沙箱里跑，工具白名单不变。
- 不做跨租户权限体系（沿用现有单账号/loopback 面板模型）。
- 不做「多技能编排/工作流」：**技能就是独立的一个**，一个 `/命令` 对应一个技能，不串链（用户 2026-11-10 确认）。
- 不做 AGENTS.md 的自动生成/改写（只读加载）。

---

## 4. 需求清单（每条都有验收判据）

### R1 技能列表与详情（读）
- 列表：`name`、`description`、来源（内置/仓库/面板上传）、作用域（全局 / 某仓库）、版本、启用状态、更新时间、大小。
- 详情：frontmatter 表 + 渲染后的正文预览 + 附带文件清单 + 校验结果（是否有 warn/error）。
- 验收：面板能看到现有 3 个内置技能与仓库里的 3 个技能，字段与实际文件一致。

### R2 上传 zip 创建/更新技能
- 上传体：`application/zip`；解包后**必须**能找到 `<something>/SKILL.md`（允许一层包裹目录，忽略 `__MACOSX/`、`.DS_Store`）。
- 一个 zip 里只允许**一个**技能（多技能请分次上传），避免「部分成功」的语义。
- 同 `name` 再次上传 = 新建版本（不覆盖旧版本）。
- 验收：上传合法 zip → 列表立刻出现该技能且 `enabled=true`；同名再传 → 版本 +1，旧版本仍可查。

### R3 校验（上传即校验，失败不入库）
- 契约校验：完全复用 `contract-skill.md` 的 strict frontmatter（含 `name` 正则、`outputs`、`allowed-tools`）。
- zip 安全校验：拒绝绝对路径、`..`、符号链接、单文件 > 512 KB、总解压 > 5 MB、条目数 > 200、压缩比 > 100:1（zip 炸弹）。
- 附带文件白名单：`*.md` / `*.txt` / `*.json` / `*.yaml` / `*.yml` / `*.sh` / `*.py` / `*.js`（其它类型拒绝并说明原因）。
- 验收：对 8 个坏样本（无 SKILL.md / 两个 SKILL.md / `../` / symlink / 超体积 / 超条目 / 高压缩比 / frontmatter 缺字段）逐条返回明确错误码，且库里不产生任何行。

### R4 存储与版本
- 元数据进 PG（`skills` + `skill_versions`，见 §5），内容落盘 `<PI_BOT_DATA_DIR>/skills/<skillId>/<version>/…`。
- 每次上传都写一条不可变版本行（`sha256` 覆盖整个目录树），供回滚与审计。
- 验收：删除技能只软删元数据（`deleted_at`），磁盘文件保留至保留期；能按版本号取回旧内容。

### R5 动态加载（不重启）
- 任务在**入队时**记下「技能快照 id + 版本」，worker 用快照装配提示词；上传/编辑不影响已入队的任务。
- 面板改动后**下一次任务**即生效；进程无需重启（注册表按 `(skillId, version, mtime)` 缓存，命中即复用）。
- 验收：上传新技能 → 在 issue 里 `/新技能` → 该次 run 的提示词里出现它（用 `run_events` 里的 `prompt.assembled` 摘要取证）。

### R6 优先级与冲突
- 建议优先级（**需你确认**）：`面板全局` > `面板-仓库` > `仓库文件(.github/pi-bot/skills)` > `内置`。
- 同名冲突不静默：列表里标出「被 X 覆盖」，`/命令` 解析时把落选来源写进审计。
- 验收：同名三份并存时，`/name` 用的是最高优先级那份，且详情页能看出被谁覆盖。

### R7 AGENTS.md 加载
- 根 `AGENTS.md`：**总是**加载（缺省不影响任务，只是少一段上下文）。
- 就近 `AGENTS.md`：按任务涉及路径（`paths`/报错文件）向上查找最近的若干个，最多 3 个。
- 限长：根 ≤ 4000 字符、每个就近 ≤ 2000 字符、合计 ≤ 6000；超出按「头尾保留 + 中间截断」并标注。
- 验收：仓库放一个根 `AGENTS.md` → 提示词里出现；在 `apps/x/AGENTS.md` 写不同内容、任务涉及 `apps/x` 时出现就近那份。

### R8 提示词装配（统一入口）
- 新增 `assemblePrompt()`：`系统约束 → AGENTS.md 层 → 技能正文（渐进披露）→ 任务上下文（不可信，围栏）→ 输出契约`。
- 技能正文：先只放 `name + description`（决策用），**选中后**才放正文（≤4000）；
  附带文件不整篇塞，只列清单，agent 需要时用 `Read` 去读。
- 验收：一次 run 的提示词长度有上限断言（≤ 24k 字符），且 `run_events.prompt.assembled` 记录各层字符数与截断标记。

### R9 面板 UI（技能页）
- 列表 + 详情 + 「上传 zip」+ 启用/停用 + 删除 + 版本列表/回滚 + 正文在线编辑（只允许改 `description` 与正文，不允许改 `name`）。
- 明确展示：来源、作用域、校验告警、被覆盖关系、最近一次使用时间（来自 `run_events`）。
- 验收：不需要动 git/不需要重启，纯面板完成「上传 → 启用 → 在 issue 里用上 → 回滚」。

### R10 审计与可观测
- 所有写操作进审计（`actions.audit` 或新表 `skills_audit`）：who / 动作 / 目标 / 前后 sha256 / IP / UA。
- 面板「审计」页能看到「技能上传/启用/删除」记录。
- 验收：上传后审计页出现一条，字段齐全。

### R11 写操作的鉴权与 CSRF（**关键**）
- 写接口**必须**要求已认证会话；`PI_BOT_PANEL_AUTH=off` 时，写接口**仍然要求**一个本机 token（或直接禁用写接口，只允许 `session` 模式）：
  建议 `PI_BOT_PANEL_WRITE=off|session`，缺省 `off`，`off` 时上传/编辑/删除一律 403。
- 所有写请求要求 `Origin`/`Sec-Fetch-Site` 校验 + 自定义头（`X-Pi-Bot-CSRF`）双保险；表单上传同样带。
- 验收：`curl -X POST` 无会话/无 CSRF 头 → 403；带齐 → 200。

### R12 能力边界（技能不得升级权限）
- 技能只能**缩小**能力：`allowed-tools`、`outputs` 是上限，实际仍走审批矩阵与写回闸门。
- bot **不允许**写技能文件：`push_branch` 的 `paths` 命中技能目录一律 `writeback_rejected`（现有 §5.6 已覆盖，需加显式清单）。
- 技能正文是不可信输入：走既有 `sanitizeUntrustedText` + 围栏，不解析 Markdown/HTML。
- 验收：上传一个 `outputs: [pr]` 但未声明 `paths` 的技能 → 运行期动作被丢弃并记 `parse`，不是崩溃。

---

## 5. 数据模型（草案）

```sql
-- 技能本体（一个 name 一行；软删）
create table skills (
  id            text primary key,           -- uuid
  name          text not null,              -- 契约：/xxx（见 §12 决策 D2）
  scope         text not null,              -- 'global' | 'repo'
  repo          text,                       -- scope='repo' 时非空
  source        text not null,              -- 'builtin' | 'repo-file' | 'upload'
  enabled       boolean not null default true,
  current_version integer not null default 1,
  description   text not null,
  frontmatter   jsonb not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index skills_name_scope_uidx on skills (name, scope, coalesce(repo, '')) where deleted_at is null;

-- 不可变版本（内容落盘，库里只存清单与哈希）
create table skill_versions (
  skill_id      text not null,
  version       integer not null,
  files         jsonb not null,             -- [{path, bytes, sha256}]
  tree_sha256   text not null,
  validation    jsonb not null,             -- {ok, errors[], warnings[]}
  created_at    timestamptz not null default now(),
  primary key (skill_id, version)
);

-- 写审计（也可复用 actions.audit，看 §12 决策 D6）
create table skills_audit (
  id bigserial primary key,
  skill_id text not null, action text not null, actor text,
  detail jsonb not null, created_at timestamptz not null default now()
);
```

磁盘布局：`<PI_BOT_DATA_DIR>/skills/<skillId>/<version>/{SKILL.md, assets/…}`（只读挂载给容器时不挂，agent 要看内容用我们的工具接口给文本）。

---

## 6. API 草案（写在 `/api/skills` 下，全部需要 R11 的鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/skills` | 列表（含来源/作用域/启用/版本/被覆盖关系） |
| GET | `/api/skills/:id` | 详情（frontmatter + 正文 + 文件清单 + 校验结果） |
| POST | `/api/skills` | 上传 zip（`Content-Type: application/zip`，body 为原始字节；上限 5 MB） |
| POST | `/api/skills/:id/versions` | 上传新版本（同上） |
| PATCH | `/api/skills/:id` | 改 `enabled` / `description` / 正文（**不许改 name/scope**） |
| DELETE | `/api/skills/:id` | 软删（`?hard=1` 仅限 `source='upload'`） |
| POST | `/api/skills/:id/rollback` | 回滚到指定版本（= 新建一个指向旧内容的新版本） |
| GET | `/api/skills/:id/versions` | 版本列表 |

**不引入新依赖**：zip 用「原始二进制 body」接收（`fastify` 的 `application/zip` content-type parser + 50 行内的 zip 中央目录解析，或用 node:zlib 手写 minimal unzip），避免为一次上传引入 `@fastify/multipart` 与它的类型包。
（若你更倾向标准 multipart，则需要 `pnpm add @fastify/multipart` —— 见 §12 决策 D5。）

---

## 7. 加载与装配规则

```
优先级（高 → 低）：面板-仓库 > 面板全局 > 仓库文件 > 内置
同名解析：取最高优先级；落选来源写审计；列表里标「被覆盖」
```

装配顺序（`assemblePrompt`）：

1. 系统约束（既有：不许 merge、动作白名单、输出信封格式）
2. **AGENTS.md 层**：根（≤4000）+ 就近（各 ≤2000，合计 ≤6000）
3. **技能层**：命令 → 选中技能 → 正文（≤4000）+ 附带文件清单（只列名与一句话，不塞内容）
4. 任务上下文：issue 标题/正文/评论（既有 `sanitizeUntrustedText` + 围栏）
5. 输出契约（信封 JSON 示例）

---

## 8. 安全模型

| 风险 | 处置 |
|---|---|
| zip slip（`../`、绝对路径、盘符） | 解包前规范化并断言目标在 `skills/<id>/<ver>/` 之下；不允许 `..` 段 |
| zip 炸弹 | 总解压 ≤5 MB、条目 ≤200、单文件 ≤512 KB、压缩比 ≤100:1；超限直接拒绝 |
| symlink / 设备文件 | 拒绝非普通文件条目（zip 外部属性判定） |
| 可执行内容 | 允许 `.sh/.py/.js` 作为**资源**存在，但不自动执行；执行只能经 `Bash` 工具 + 沙箱 + 审批矩阵 |
| 提示词注入 | 技能正文视为不可信：`sanitizeUntrustedText`（去控制字符、转义尖括号、剥哨兵）+ 围栏 |
| 越权 | `allowed-tools`/`outputs` 是上限；写回闸门独立生效；bot 不能写技能目录 |
| 面板被滥用 | 写接口要求会话 + CSRF 头 + Origin 校验；`PI_BOT_PANEL_WRITE=off` 缺省关闭 |
| 供应链 | 每次上传记 `tree_sha256`；面板展示「谁传的、什么时候」；可回滚 |

---

## 9. 错误码（新增）

`SKILL_ZIP_INVALID`（无/多个 SKILL.md）、`SKILL_ZIP_UNSAFE`（路径/symlink/炸弹）、
`SKILL_FRONTMATTER_INVALID`（契约校验失败，details 带字段路径）、`SKILL_NAME_CONFLICT`（同 scope 同名）、
`SKILL_NOT_FOUND`、`SKILL_WRITE_DISABLED`（`PI_BOT_PANEL_WRITE=off`）、`SKILL_VERSION_NOT_FOUND`。

---

## 10. 测试与门禁

- 单测：zip 解析（10 种畸形样本）、frontmatter 校验（复用契约）、优先级解析、AGENTS.md 就近查找与限长、`assemblePrompt` 的层序与总长上限。
- 真库：`skills` / `skill_versions` upsert 与软删；审计行。
- 端到端（dry-run）：上传 → `/命令` → `run_events.prompt.assembled` 断言出现了该技能与 AGENTS.md 片段。
- 门禁不变：`pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` 串行 exit 0。

---

## 11. 里程碑（审核通过后按此切分派发）

- **M1（必须，先做）**：`assemblePrompt` 接线 —— 把 `renderSkillPrompt` 接进 worker，含 AGENTS.md 层与预算。**没有它，后面全是空转。**
- **M2**：技能存储（表 + 磁盘 + 版本）+ zip 上传与校验 + `GET /api/skills*`（只读）。
- **M3**：写接口 + 面板技能页（上传/启停/删除/回滚）+ 审计。
- **M4**：收尾 —— 文档（`contract-skill.md` / `tech-plan` / 面板页说明）、坏样本回归、真机验收。

---

## 12. 决策（**已定案**，2026-11-10 用户确认）

| # | 决策 | 结论 |
|---|---|---|
| D0 | 技能是否可编排成工作流 | **否**。技能就是独立的一个，一个 `/命令` 对应一个技能 |
| D0 | 上传后是否要审批才生效 | **否**。上传即生效，靠**开关**控制启停；开启即可 `/xxx` 调用 |
| D1 | 面板是否破「只读」 | **破**，新增受控写面。用户明确「面板不会暴露到公网」，所以写面默认 `PI_BOT_PANEL_WRITE=loopback`：只接受本机来源 + 必须带 CSRF 头 + Origin 校验；跨源/带外一律 403 |
| D2 | 技能 `name` 是否必须带 `/` | **宽松入、规范存**：zip 里写 `name: review-pr` 也接受，入库归一成 `/review-pr`，`/review-pr` 亦可 |
| D3 | 上传技能的作用域 | 全局 + 指定仓库，缺省全局 |
| D4 | 优先级 | 面板-仓库 > 面板全局 > 仓库文件 > 内置 |
| D5 | zip 接收方式 | 原始 `application/zip` body（零新依赖） |
| D6 | 审计落在哪 | 新表 `skills_audit`（`actions` 是 run 维度的，技能变更没有 run） |
| D7 | 技能能否带脚本 | 能带、作为资源存放，但**不自动执行**；执行仍走沙箱 + 审批矩阵 |
| D8 | AGENTS.md 就近策略 | 根（总是）+ 就近（最多 3 个，合计限长） |

**由 D0/D1 推出的两条硬约束**（写进验收）：

1. **开关就是唯一的生效开关**：`enabled=false` 的技能不出现在 `/skills` 列表、不参与 `/命令` 解析
   （`resolve()` 返回 `undefined` → 未知命令回复），但内容与版本仍保留、可随时再开。
2. **没有审批流，所以审计必须完整**：谁传的、什么时候、tree_sha256、启用/停用/删除、回滚目标版本，
   一条不落；面板「审计」页对技能变更是可筛的。

---

## 13. 审核结论

§13 原来那三个问题已由用户答复（2026-11-10）：技能独立、上传即生效带开关、面板不公网。
分析部分到此定稿；实施按 §11 的 M1 → M4 推进。
