# Issue 处理平台 v2.1 · 开发期接口冻结

> 来源：`docs/requirements.html`（v2.1，2026-11-12）+ `.workbuddy/memory/2026-11-12.md` 的历次拍板。
> 本文只冻结**跨模块接口**，不重复需求正文；需求编号（FR/BR/AC）直接引用原文。
> 并行开发纪律：只改自己名下的文件；需要别人的能力时按本文接口调用，不得顺手改对方的实现。

---

## 0. 本轮范围

| 纳入 | 不纳入 |
|---|---|
| FR-1 事件接入（补判定留痕与应答路径） | 多托管平台、多租户 |
| FR-2 事件触发配置 / 占位符 / 评论闸门 | PR 事件处理（收到按未触发留痕） |
| FR-3 会话协调（常驻、串行、三层幂等） | PR 与 issue 共享上下文 |
| FR-4 提示词下发（四段结构、首次全量后续增量） | 服务端模板渲染用户可见文案 |
| FR-5 执行（七类动作、产出校验、标签目标态、槽位、压缩） | 合并 PR、force push |
| FR-6 记录与查询（对话/工具/token/判定原因/压缩记录） | 面板整体视觉改版 |

**兼容策略**：配置以**新增字段**方式扩展（`triggers.events`、`comment`、`agent.system_prompt/limits/actions`、`labels.vocabulary[].managed/status`），旧字段保留但标记 deprecated；旧的 4-intent 信封继续服务 `source='pipeline'|'command'` 路径，新 7-action 契约服务 `source='agent'` 路径。新路径不读旧字段。

---

## 1. 配置形状（项目级，`repos.settings`）

```ts
type EventKey =
  | 'issues.opened' | 'issues.edited' | 'issues.labeled'
  | 'issues.closed' | 'issue_comment.created';

type EventTrigger = {
  enabled: 'on' | 'off' | 'conditional'; // 默认值见下表
  prompt: string | null;                 // null = 用内置默认模板
  only_body_changed?: boolean;           // 仅 issues.edited，默认 true
  labels?: string[];                     // 仅 issues.labeled，命中所配标签才触发
};

type CommentGates = {
  require_mention: boolean;   // 默认 true
  require_role: boolean;      // 默认 false
  allow_roles: string[];      // 角色名，必须存在于 comment.roles
  ignore_bot: boolean;        // 默认 true
  allow_closed: boolean;      // 默认 false
};

type CommentConfig = {
  mentions: Array<{ keyword: string; case_sensitive?: boolean }>; // 至少 1 个
  roles: Array<
    | { name: string; by: 'association'; any_of: Association[] }
    | { name: string; by: 'members'; members: string[] } // GitHub login，不支持 org/team
  >;
};

type AgentExecution = {
  system_prompt: string;          // 默认内置；每次调用都带，不参与压缩
  concurrency: number;            // 默认 2，1..8
  daily_quota: number;            // 默认 100，1..1000
  turn_timeout_minutes: number;   // 默认 20，1..30
  actions: {                      // FR-5.3 后三类默认关闭
    create_issue: boolean;        // 默认 false
    open_pr: boolean;             // 默认 false
    close_issue: boolean;         // 默认 false
  };
  data_retention_days: number;    // 默认 90
};
```

事件默认值（FR-2.1）：

| 事件 | enabled | 附加默认 |
|---|---|---|
| `issues.opened` | `on` | — |
| `issues.edited` | `on` | `only_body_changed: true` |
| `issues.labeled` | `conditional` | `labels: []`（空 = 不触发） |
| `issues.closed` | `off` | — |
| `issue_comment.created` | `conditional` | 四个闸门取上述默认 |

标签目录（FR-5.4 / 6.5）沿用 `labels.vocabulary`，新增：

```ts
type LabelCatalogEntry = {
  name: string; role: 'requirement'|'defect'|'other';
  meaning?: string; group?: string;
  managed?: boolean;    // false = 不自动管理（BR-11），默认 true
  status?: 'active' | 'retired'; // 默认 active
};
```

**目录即全量**：目标态只允许目录内、`status='active'`、`meaning` 非空、`managed!==false` 的标签。

---

## 2. 事件判定（FR-2.1 ~ FR-2.5 / BR-6）

```ts
type TriggerDecision =
  | { triggered: true; event: EventKey; template: string; reason: 'enabled' | 'conditional-met' }
  | { triggered: false; event: EventKey | 'pull_request.*'; reason:
      | 'switch-off' | 'body-unchanged' | 'label-not-matched'
      | 'not-mentioned' | 'role-denied' | 'bot-self' | 'closed-not-allowed'
      | 'pr-ignored' | 'content-duplicate' | 'daily-quota' | 'repo-disabled' };
```

- **判定顺序**：仓库可用 → 事件开关 → 事件条件 → 评论闸门 → 三层去重 → 日配额。
- **合法提及**（FR-2.5）：`@` + 关键词 + 分隔符（空白 / 换行 / 标点）或字符串结尾；大小写按配置；代码区先蒙版。
- **角色判定**：`by='association'` 用评论载荷的 `author_association`；`by='members'` 用 login（保存时解析 id，匹配以 id 为准）。
- **不触发也留痕**（BR-6）：每次判定写 `webhook_deliveries.decision`（`triggered|ignored`）与 `decision_reason`（上面的 reason）。

---

## 3. 占位符渲染（FR-2.3 / 6.3）

```ts
type RenderContext = {
  repo: string; actor: string; eventAction: string;
  issue: { author: string; number: number; url: string; title: string;
           content: string; labels: string[]; updatedAt: string };
  comment?: { author: string; body: string };
  repoIssues?: () => Promise<string>; // 惰性：只有模板出现 {{repo.issues}} 才调用
};

renderTemplate(template: string, ctx: RenderContext):
  { text: string; unknown: string[] }  // unknown = 原样保留的占位符名
```

规则：
1. 一次遍历替换，替换结果不参与二次替换。
2. 同一占位符出现多次全部替换。
3. 未知占位符原样保留，并返回 `unknown`（调用方记配置告警）。
4. `{{issue.labels}}` = 逗号+空格分隔，空集为空串，保持 GitHub 顺序。
5. `{{repo.issues}}`：仅 open、排除 PR、字段「#编号 [open] 标题」、上限 200（按更新时间倒序截断）、末尾「（共 N 条，仅列最近 M 条）」；项目级缓存 5 分钟；模板未写则不调用。

---

## 4. 产出契约 v2（FR-5.3）

**仅 `tasks.source='agent'` 使用；旧 4-intent 契约不动。**

```ts
type OutputV21 = {
  verdict?: 'pass' | 'fail';      // 纯问答可省
  evidence?: string[];
  actions: ActionV21[];
};

type ActionV21 =
  | { type: 'verdict'; payload: { verdict: 'pass'|'fail'; evidence?: string[] } }
  | { type: 'label'; payload: { desired: string[]; clear?: boolean } }
  | { type: 'comment'; payload: { slot: string; body: string } }
  | { type: 'reaction'; payload: { op: 'add'|'remove'; content: ReactionContent } }
  | { type: 'create_issue'; payload: { title: string; body?: string; labels?: string[]; fingerprint?: string } }
  | { type: 'open_pr'; payload: { branch: string; title: string; body?: string } }
  | { type: 'close_issue'; payload: Record<string, never> };
```

校验（必须整份判定，不逐条丢弃）：
1. 未知 `type` → **拒绝整份产出**，一条都不执行。
2. 缺必填字段 / 形状不合规 → 拒绝整份，错误定位到字段路径。
3. `actions` 为空数组合法（只判定不动作）。
4. 执行按数组顺序，**遇失败即停**；已成功的不回滚，记录中断位置。
5. 后三类动作需项目级开关打开，否则整份产出在**执行前**拒绝（`action-disabled`）。

---

## 5. 写回语义（FR-5.3 ~ FR-5.5 / BR-9 ~ BR-12）

| 动作 | 语义 |
|---|---|
| `label` | 目标态对齐：`add = desired - current`；`remove = current ∩ 可管理目录 - desired`。空集 + `clear!==true` → no-op。`desired.length > max_per_issue` → 整批拒绝。删除写 `actions.audit.owner`（`bot` / `human`）。含义为空、`managed=false`、`status=retired`、目录外 → 不删不加。 |
| `comment` | 槽位键 = `(repo, issue, slot)`。正文末尾写 `<!-- pi-bot:slot repo#issue:slot -->`。找到同标记 → `updateIssueComment`；找不到 → 新建并记 `recreated`。同 issue 同槽位只保留一条。 |
| `reaction` | 幂等：add 前查是否已有自己打的同 content；remove 只删自己打的。 |
| `create_issue` | 指纹去重优先于日配额；配额用尽 → 不执行并记录。 |
| `open_pr` | 只允许 `bot/*` 分支；永不 force push；PR 事件本身不处理。 |
| `close_issue` | 仅项目开关开启 + 该轮 `verdict==='fail'` 且存在确定性关闭条件时执行；不采信模型自评。 |

失败处理（FR-5.5）：单条动作失败 → 停止后续、写后台告警、兜底一条普通评论（不占槽位）；执行侧无产出/超时/不合契约 → **标签与评论保持原状**。

---

## 6. 会话与压缩（FR-3.4 / FR-5.6）

会话状态只有两种：`active`（沙箱存在）/ `idle`（沙箱已回收，下次触发重建）。**没有 ended**。

```ts
type SessionRuntime = {
  repo: string; issueNumber: number; sessionId: string | null;
  state: 'active' | 'idle'; sandboxId: string | null;
  cursor: number; turns: number;
};

type CompactionPlan = {
  needed: boolean; hardLimit: number; autoLimit: number; currentTokens: number;
  generation: number; reason: 'below' | 'auto' | 'hard';
};

type CompactionRecord = {
  repo: string; issueNumber: number; sessionId: string;
  generation: number; beforeTokens: number; afterTokens: number;
  summaryChars: number; fallback: boolean; createdAt: string;
};
```

阈值：`hardLimit = window - max(16_000, min(0.25*window, outputLimit), 0.05*window)`；`autoLimit = 0.9 * hardLimit`。检查点在请求发出前。压缩产物是**追加的 checkpoint**，不改写历史；喂模型视图 = checkpoint + 真实最近窗口；必须剔除孤儿 toolResult。

---

## 7. 文件归属（并行开发不得越界）

| 工作流 | 可改文件 | 交付 |
|---|---|---|
| WS1 契约/配置/DB | `packages/contract/src/**`、`apps/server/src/db/schema.ts`、`apps/server/src/config/v21-settings.ts`、`migrations/0011_v21.sql`、`packages/contract/test/**` | 上述类型 + schema + 迁移 + 单测 |
| WS2 触发/占位符 | `apps/server/src/trigger/**`、`apps/server/src/prompt/render.ts`、`apps/server/src/prompt/repo-issues.ts`、对应 `test/**` | 判定纯函数 + 渲染器 + 缓存 + 单测 |
| WS3 产出/写回 | `packages/envelope/src/v21*.ts`、`apps/server/src/writeback/**`、`apps/server/src/github/types.ts`、`apps/server/src/github/octokit.ts`、对应 `test/**` | 7 动作 schema + 执行器 + updateIssueComment + 单测 |
| WS4 会话/压缩 | `apps/server/src/compact/**`、`apps/server/src/agent/session*.ts`、对应 `test/**` | 压缩引擎 + 会话状态 + 单测 |
| WS5 面板 | `apps/panel/src/components/settings/v21-*.tsx`、`apps/panel/src/routes/repo-settings.tsx`、`apps/panel/src/mocks/**` | 配置 UI（事件矩阵/模板/闸门/角色/目录/限额） |
| WS6 集成 | `apps/server/src/http/webhook.ts`、`apps/server/src/app/compose.ts`、`apps/server/src/worker/**`、`apps/server/src/agent/dispatcher.ts` | 串起 WS1–WS4，端到端用例 |

共享文件（`packages/contract/src/index.ts`、`packages/envelope/src/index.ts`、`db/schema.ts` 的 `ALL_TABLES`）由 WS1 统一改；其他人不要动。

---

## 8. 验收映射（供审查机器人逐项核对）

| 需求 | 落点 | 判定证据 |
|---|---|---|
| FR-2.1 | `triggers.events` + `trigger/decide.ts` | 五个事件默认值 + 开关关闭不触发 |
| FR-2.3 | `prompt/render.ts` | 重复占位符 / 一次替换 / 未知保留 |
| FR-2.5 | `trigger/mention.ts` | 四条合法判定示例 |
| FR-3.3/3.4 | `agent/dispatcher.ts` + `agent/session.ts` | 同 issue 串行 / 关闭回收沙箱 |
| FR-5.3 | `packages/envelope/src/v21.ts` + `writeback/execute.ts` | 未知 type 整份拒绝 / 顺序执行遇错停 |
| FR-5.4 | `writeback/labels.ts` | 空集保护 / 超限整批 / 删除留痕 |
| FR-5.6 | `compact/engine.ts` | 双阈值 / 增量摘要 / 降级链 |
| FR-6.x | 既有 queries/面板 | 对话/工具/token/判定原因可查 |

---

## 附录：实现状态与已知偏离（2026-11-12 收口补记）

> **本附录只做标注，不修改 §1–§8 的任何冻结接口定义与验收映射。** 下面标「口径待拍板」的条目
> 一律**不在本轮擅自统一口径**：改需求还是改实现，由产品/架构决策后再回来改正文。
> 需求编号经核实为 **FR 26 / BR 12 / AC 25**（此前转述的「27 条 FR」是口误）。

**交付状态（最终门禁，`docs/v21-static-review.md` §5.2 实跑）**：v2.1 已完成 WS1–WS6 实现与运行时接线；
`pnpm -r typecheck` 6/6 全绿；`pnpm -r test` 1157 passed / 229 skipped / 3 failed（3 个真失败全是本机
无 PostgreSQL 的 `ECONNREFUSED 127.0.0.1:5432`，属环境性失败）；三份 v2.1 集成测试 42/42 全绿。
但**静态审查 `IS_PASS: NO`（6 条 BLOCKER 未修）**，接线完成不等于语义正确，未放行。

| # | 条目 | 冻结文档口径 | 当前实现 / 状态 |
|---|---|---|---|
| A1 | §5 标签目标态的「空集 + `clear!==true` → no-op」 | 空集且未显式 `clear` 时 no-op（什么都不做） | `packages/envelope/src/v21.ts:140` 与 `apps/server/src/writeback/v21/labels.ts:140` 的注释写「= 拒绝」，`planLabelTargetState()` 实际返回 `ok:false`（**拒绝并抛错**）。QA 判 BLOCKER（B6）。**口径待拍板，实现与契约不一致**；按 `docs/v21-static-review.md` §4.1 的需求口径（BR-9 / FR-5.4）应为 no-op，本轮不改正文也不改实现 |
| A2 | §6「检查点在请求发出前」 | 每次请求发出前算双阈值并按需压缩 | 压缩引擎（阈值 / 增量摘要 / 六阶降级）与单测完备，但 `packages/racp-client` **没有 session/history/compact 操作**；本轮只做到「host 报出的 compaction 事件落 `agent_compactions`」，**请求前自动压缩未接通**。属架构缺口，需产品/架构决策（扩展 RACP 能力或明确降级为非目标），非补 import 可解。见 `docs/v21-static-review.md` §5.5 第 1 条 |
| A3 | §2 / BR-6 的 `webhook_deliveries.decision_reason` | 未触发也写 `reason`；触发侧语义未在本节写明 | **触发侧也写**：`apps/server/src/http/webhook-v21.ts::v21DecisionRowOf` 对 `triggered=true` 写 `enabled` / `conditional-met`，不再留空；未触发侧仍写 §2 列出的各 reason。`apps/server/src/db/schema.ts` 的列注释已同步。此处是补记事实，不是放宽契约 |
| A4 | §3 `{{repo.issues}}` 惰性提供者、§5 `open_pr` 动作 | 需要 `repoIssues` 惰性求值；`open_pr` 需要写回能力 | `openPullRequest` / `listIssues` 已由 WS6-A 补上：`createV21OpenPullRequest()` 与 `createRepoIssuesLister()`（`http/webhook-v21.ts`），经 `app/compose.ts` 注入。**不再是能力缺口**；集成前审查快照里「全仓无实现」的结论已失效 |
| A5 | 7 组需求审查 + 静态审查 | — | 判定表、交叉互证与勘误见 `docs/v21-requirements-summary.md`（标尺）与 `docs/v21-static-review.md`（结论）；后者 §1–§4 是**集成前快照**，§5 为集成落地后的最终执行结果与遗留清单，以 §5 为准 |

**其余待拍板项**（同样不在本附录定调）：BR-11 / AC-15 需求内部语义对立、FR-5.5 兜底评论是否属
「保持原状」的允许例外、`resolveAgentExecution()` 用「或」合并两条动作开关路径的授权面 —— 见
`docs/v21-static-review.md` §4、§5.4。
