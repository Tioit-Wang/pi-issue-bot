# 契约 · 任务信封 · v1.0

> 上游：`docs/plan.md` v0.4 §5（信封字段）、§6.2（pass/fail 证据）、`docs/tech-plan.md` v1.1 §5.4（写执行器与幂等）、§5.6（写回闸门）、§8.2（`envelope/` 模块）。
> 下游：W1-C/W3-I（`worker/` 校验产出）、W2-G（`http` 不接触信封）、W4-M（技能 `outputs` 的运行期检查）。
> 实现：`packages/envelope/src/**`（JSON Schema + Ajv 2020-12 + 动作白名单/过滤器 + 正反例单测）。
> 校验器：Ajv 2020-12 + ajv-formats，`allErrors: true`、`strict: true`。

---

## 0. 信封是什么、不是什么

- **是**：agent 交给控制面的唯一结构化产出。字段不合规的动作被**丢弃**并记 `parse`，其余动作照常执行。
- **不是**：写操作的授权凭证。`push_branch` 推上去的字节由写回闸门（`declared ∩ actual`）决定，不由信封里的 `paths` 决定——`paths` 只是「声明集」的一半。
- **没有 `confidence`**，这是刻意的（plan §5）：自评分不可核查、没有消费方，最容易被顺手改回阈值。可核查的是 `evidence`。

---

## 1. JSON Schema（draft 2020-12）

`$id = https://pi-issue-bot.local/schemas/envelope-1.json`。下面是与代码逐字对应的紧凑版本
（代码在 `packages/envelope/src/schema.ts`，`ENVELOPE_JSON_SCHEMA`；两者改一处必须同 PR 改另一处）。

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pi-issue-bot.local/schemas/envelope-1.json",
  "type": "object", "additionalProperties": false,
  "required": ["verdict", "actions", "usage"],
  "properties": {
    "verdict": { "$ref": "#/$defs/verdict" },
    "actions": { "type": "array", "maxItems": 8, "items": { "$ref": "#/$defs/action" } },
    "usage":   { "$ref": "#/$defs/usage" }
  },
  "$defs": {
    "verdict": {
      "type": "object", "additionalProperties": false,
      "required": ["kind", "labels", "evidence"],
      "properties": {
        "kind":     { "enum": ["issue", "pr"] },
        "labels":   { "type": "array", "maxItems": 16, "items": { "$ref": "#/$defs/label" } },
        "evidence": { "type": "array", "maxItems": 32, "items": { "$ref": "#/$defs/evidence" } }
      }
    },
    "label": { "type": "string", "minLength": 1, "maxLength": 50, "pattern": "^[^\\u0000-\\u001f\\u007f]+$" },
    "evidence": {
      "type": "object", "additionalProperties": false,
      "required": ["rule", "quote"],
      "properties": {
        "rule":   { "type": "string", "minLength": 1, "maxLength": 120 },
        "quote":  { "type": "string", "minLength": 1, "maxLength": 2000 },
        "passed": { "type": "boolean" }
      }
    },
    "action": {
      "type": "object",
      "oneOf": [
        { "$ref": "#/$defs/commentAction" },
        { "$ref": "#/$defs/labelAction" },
        { "$ref": "#/$defs/createIssueAction" },
        { "$ref": "#/$defs/pushBranchAction" }
      ]
    },
    "commentAction": {
      "type": "object", "additionalProperties": false,
      "required": ["intent", "body"],
      "properties": { "intent": { "const": "comment" }, "body": { "type": "string", "minLength": 1, "maxLength": 60000 } }
    },
    "labelAction": {
      "type": "object", "additionalProperties": false,
      "required": ["intent"], "minProperties": 2,
      "properties": {
        "intent": { "const": "label" },
        "add":    { "type": "array", "maxItems": 10, "items": { "$ref": "#/$defs/label" } },
        "remove": { "type": "array", "maxItems": 10, "items": { "$ref": "#/$defs/label" } }
      }
    },
    "createIssueAction": {
      "type": "object", "additionalProperties": false,
      "required": ["intent", "title", "fingerprint"],
      "properties": {
        "intent":      { "const": "create_issue" },
        "title":       { "type": "string", "minLength": 1, "maxLength": 120 },
        "fingerprint": { "type": "string", "pattern": "^[a-z0-9][a-z0-9:._-]{2,63}$" },
        "body":        { "type": "string", "maxLength": 20000 }
      }
    },
    "pushBranchAction": {
      "type": "object", "additionalProperties": false,
      "required": ["intent", "branch", "paths"],
      "properties": {
        "intent": { "const": "push_branch" },
        "branch": { "type": "string", "pattern": "^bot/[a-z0-9][a-z0-9._-]{1,60}$" },
        "paths": {
          "type": "array", "minItems": 1, "maxItems": 50,
          "items": { "type": "string", "minLength": 1, "maxLength": 400,
                     "pattern": "^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$" }
        },
        "openPr": { "type": "boolean" }
      }
    },
    "usage": {
      "type": "object", "additionalProperties": false,
      "required": ["inputTokens", "outputTokens", "costUsd"],
      "properties": {
        "inputTokens":  { "type": "integer", "minimum": 0 },
        "outputTokens": { "type": "integer", "minimum": 0 },
        "costUsd":      { "type": "number",  "minimum": 0 }
      }
    }
  }
}
```

### 1.1 相对 plan §5 的三处补充（都要记住「为什么」）

| # | 补充 | 为什么 |
|---|---|---|
| 1 | **`push_branch` 必须带 `paths: string[]`**（缺失即该动作不合规被丢弃，`reason = missing-paths`） | tech-plan §5.6：写回闸门的推送集 = `declared ∩ actual`。没有 `declared`，闸门就退化成「推磁盘上的一切」，plan §3 的核心矛盾在最后一步被绕过去。plan §5 没写这一条是因为它属于「怎么实现」，而这里必须落到契约上 |
| 2 | `verdict.evidence[]` 允许可选 `passed: boolean` | plan §6.2 要「每条规则 pass/fail 附原文证据」。**可选**而非必填，所以 plan §5 的原样示例仍然合法 |
| 3 | `label` 动作 `minProperties: 2`（`intent` + `add`/`remove` 至少一个） | 既不加也不删的 label 动作没有意义；不放宽成「空数组也接受」，否则执行器要为无动作写一条审计 |

### 1.2 明确**不在**信封里的东西

| 字段 | 为什么没有 |
|---|---|
| `confidence` | plan §5：自评分不可核查、没有消费方 |
| `open_pr` 作为 intent | 开 PR 是 `push_branch.openPr: true`（plan §5 的字面形状），不是独立动作 |
| `close_issue` | 关闭是控制面的确定性条件（plan §7，只读 `issue_states`），agent 不能声明；它只出现在 `actions.intent` 的**执行器**侧枚举里 |
| `merge` / `approve` | 没有这种能力（plan §7.1：代码层不存在 merge） |
| `token` / `secret` / `env` | 信封是给不可信一侧读写的文本，不允许夹带任何凭证 |

---

## 2. 三个正例

### 2.1 判定 + 打标 + 评论（分类类技能）

```json
{
  "verdict": {
    "kind": "issue",
    "labels": ["bug"],
    "evidence": [
      { "rule": "has-repro-steps", "quote": "1. 打开 /settings 2. 点保存 3. 白屏", "passed": true },
      { "rule": "has-version", "quote": "v1.2.3", "passed": true }
    ]
  },
  "actions": [
    { "intent": "label", "add": ["bug"] },
    { "intent": "comment", "body": "已按仓库报告标准核对：复现步骤与版本号齐备。" }
  ],
  "usage": { "inputTokens": 1200, "outputTokens": 300, "costUsd": 0.0123 }
}
```

### 2.2 主动建 issue（带去重指纹）

```json
{
  "verdict": {
    "kind": "pr",
    "labels": [],
    "evidence": [{ "rule": "dep-vuln-high", "quote": "lodash@4.17.15", "passed": false }]
  },
  "actions": [
    {
      "intent": "create_issue",
      "title": "依赖漏洞：lodash < 4.17.21（由 #128 的审查发现）",
      "fingerprint": "dep-vuln:lodash",
      "body": "`pnpm audit` 报告 `lodash@4.17.15` 命中 CVE-2021-23337。"
    }
  ],
  "usage": { "inputTokens": 5200, "outputTokens": 900, "costUsd": 0.0410 }
}
```

### 2.3 推 bot 分支 + 开 PR（必须带 paths）

```json
{
  "verdict": { "kind": "pr", "labels": ["bug"], "evidence": [{ "rule": "tests-fail", "quote": "1 failed", "passed": false }] },
  "actions": [
    {
      "intent": "push_branch",
      "branch": "bot/t_7f3a-fix-typo",
      "paths": ["src/config.ts", "docs/**"],
      "openPr": true
    },
    { "intent": "comment", "body": "已推 `bot/t_7f3a-fix-typo` 并开 PR。" }
  ],
  "usage": { "inputTokens": 31000, "outputTokens": 4200, "costUsd": 0.2210 }
}
```

---

## 3. 三个反例

### 3.1 `push_branch` 缺 `paths`（tech-plan §5.6 的阻断项）

```json
{
  "verdict": { "kind": "pr", "labels": [], "evidence": [] },
  "actions": [{ "intent": "push_branch", "branch": "bot/t_x-1", "openPr": true }],
  "usage": { "inputTokens": 10, "outputTokens": 5, "costUsd": 0 }
}
```

拒绝理由：`/actions/0` 命中 `required: ["intent","branch","paths"]`，`keyword = required`。
处置：**该动作丢弃**，`reason = missing-paths`；同一封信封里的其它动作照常执行（解析期不整封失败）。

### 3.2 未知 intent（模型自创 `open_pr` / `merge`）

```json
{
  "verdict": { "kind": "pr", "labels": [], "evidence": [] },
  "actions": [{ "intent": "open_pr", "head": "bot/t_x-1", "base": "main" }],
  "usage": { "inputTokens": 10, "outputTokens": 5, "costUsd": 0 }
}
```

拒绝理由：`oneOf` 四个分支全部不匹配（没有任何分支的 `intent: const` 是 `open_pr`），`keyword = oneOf`。
处置：丢弃，`reason = unknown-intent`。**新增动作类型不是配置能做的事**——它意味着绕过写执行器（contract-skill §2 末段）。

### 3.3 空 verdict（缺 `labels` / `evidence` / `kind`）

```json
{
  "verdict": {},
  "actions": [{ "intent": "comment", "body": "看起来还行" }],
  "usage": { "inputTokens": 10, "outputTokens": 5, "costUsd": 0 }
}
```

拒绝理由：`/verdict` 命中 `required: ["kind","labels","evidence"]`。
处置：**整封信封校验失败**，记 `parse` 失败，动作一条都不执行（没有 verdict 的评论等于无证据的自动发言）。
没有 `verdict` 字段、`verdict: null`、`verdict` 写成字符串，后果相同。

---

## 4. 运行期规则的落点（`filterActions`）

信封通过 Ajv 只说明「形状对」；能不能执行还要过一层过滤器。丢弃原因是一个**枚举**（进 `run_events` 与面板详情页）：

| reason | 触发条件 |
|---|---|
| `unknown-intent` | intent 不在 4 类白名单 |
| `malformed-action` | 字段不合规（空 body、空标签集合、标题超长、fingerprint 形状不对…） |
| `not-allowed-by-skill` | 该动作类型不在技能的 `outputs` 允许集里（contract-skill §4.2 运行期） |
| `missing-paths` | `push_branch` 没有 `paths` 或空数组 |
| `path-protected` | `paths` 命中拒收清单：`.git/**`、`.github/workflows/**`、`.gitmodules`、`.github/pi-bot/**`（技能与配置只有人能改） |
| `path-not-allowed` | 绝对路径 / `..` 出仓 / 超过 400 字符 |
| `branch-not-allowed` | 分支名不在 `bot/*`（plan §7：永不强推、永不改写贡献者分支） |
| `push-branch-disabled` | 写回闸门未开启（M4 之前、或 dry-run 档）；**默认关闭** |
| `label-not-allowed` | 标签不在仓库 `.github/pi-bot.yml` 的映射集合里（R4：不发明新标签） |

要点：**逐条丢弃，不牵连整封**。只有「信封整体不合法」（缺 verdict、JSON 解析失败）才升级为 `parse` 失败。
拒收清单里出现技能路径的判定落在 `path-protected`：bot 不许通过写回改自己的技能或配置（contract-skill §1）。
