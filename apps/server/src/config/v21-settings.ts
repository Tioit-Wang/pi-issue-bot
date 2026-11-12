/**
 * v2.1 设置读取助手（`docs/v21-contract.md` §1）：把 `repos.settings`（jsonb，`unknown`）
 * 摊成**判定/执行侧真正要用的那几段值**。
 *
 * 三条设计约束：
 * 1. **纯函数、不查库**：`repos.settings` 由调用方（webhook / dispatcher / 面板）自己读出来传进来。
 *    这样同一份解析在 HTTP 请求里、worker 里、单测里都是同一套行为，不需要为「怎么取 settings」再造一层。
 * 2. **不抛错**：配置写坏了不能把处理链带崩。解析失败一律回退到 `V21_DEFAULTS` 并置 `ok: false`，
 *    由调用方决定记日志还是记告警。真正的「配置非法 → 该仓库不可用」判定仍然在
 *    `repoSettingsSchema`（`config/repo-config.ts` 的 `validateRepoSettings`），不在这里重复。
 * 3. **形状层（`repoSettingsShapeSchema`）解析而不是严格层**：v2.1 的字段对老配置都必须有默认值，
 *    形状层正好是这个语义；严格层的跨字段约束（`managers` 非空、词表两角色…）属于「能不能跑」，
 *    属于 webhook 的仓库可用性判定，不属于「这一段取什么值」。
 *
 * 为什么不把 snake_case 直接透给上层：判定侧读的是 `onlyBodyChanged` 这种业务语义
 * （`issues.edited` 只有正文变了才算一次事件），而 `only_body_changed` 只是配置里的拼写。
 * 只有 `CommentGates` 例外——它整段就是判定条件本身，保持契约里的字段名，避免出现第二套命名。
 */
import {
  DEFAULT_REPO_SETTINGS,
  repoSettingsShapeSchema,
} from '../../../../packages/contract/src/index.ts';
import type {
  AgentExecution,
  CommentConfig,
  CommentGates,
  EventKey,
  EventSwitch,
  LabelStatus,
  RepoSettings,
} from '../../../../packages/contract/src/index.ts';

/* ── 0. 统一的「读一次 settings」 ───────────────────────────────────────────── */

/**
 * 一次 settings 读取的结果。
 *
 * `ok: false` 时 `settings` 是**形状默认值**（`DEFAULT_REPO_SETTINGS`），`error` 是可直接展示的原因。
 * 调用方拿 `ok` 决定要不要记一条告警；拿到的值永远可用（不会抛、不会是 undefined）。
 */
export type V21SettingsRead = {
  /** 输入能否被形状层解析 */
  readonly ok: boolean;
  /** 解析失败的原因（`path: message; …`，已截断）；成功为 `null` */
  readonly error: string | null;
  /** 解析结果；失败时是形状默认值 */
  readonly settings: RepoSettings;
};

/** zod 的 issues → 一行可读错误（与 `validateRepoSettings()` 的风格一致，截到 500 字）。 */
function describeIssues(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
  const parts = issues.map((issue) => {
    const at = issue.path.map((part) => String(part)).join('.');
    return at === '' ? issue.message : `${at}: ${issue.message}`;
  });
  return `settings 不符合 v2.1 形状：${parts.join('; ')}`.slice(0, 500);
}

/**
 * 解析 `repos.settings`（`unknown`，可能来自 jsonb、`null`、面板请求体、单测夹具）。
 *
 * `null` / `undefined` 按 `{}` 处理（等价于「全默认」）：列是 NOT NULL，真出现空值只能是手改库，
 * 这时按默认值继续跑比让整条处理链崩掉更符合「配置坏了也不能把处理带崩」的取舍——
 * 是否允许开工由 `repo-config.ts` 的严格校验决定。
 */
export function readV21Settings(settings: unknown): V21SettingsRead {
  const input = settings ?? {};
  const result = repoSettingsShapeSchema.safeParse(input);
  if (result.success) {
    return { ok: true, error: null, settings: result.data };
  }
  return { ok: false, error: describeIssues(result.error.issues), settings: DEFAULT_REPO_SETTINGS };
}

/* ── 1. 事件触发 ───────────────────────────────────────────────────────────── */

/**
 * 一个事件的生效触发配置（`docs/v21-contract.md` §2 判定的输入）。
 *
 * 字段名是业务语义（camelCase）：判定代码读 `decision.onlyBodyChanged`，
 * 而不是去记「配置里那串叫 `only_body_changed` 的键」。
 */
export type ResolvedEventTrigger = {
  readonly enabled: EventSwitch;
  /** `null` = 用平台内置默认模板 */
  readonly prompt: string | null;
  /** 仅 `issues.edited` 有意义；其余事件恒为 `false`（配置里写了也不用） */
  readonly onlyBodyChanged: boolean;
  /** 仅 `issues.labeled` 有意义；空数组 = 永不触发 */
  readonly labels: readonly string[];
  readonly ok: boolean;
  readonly error: string | null;
};

/**
 * 取某个事件的触发配置。
 *
 * `onlyBodyChanged` 对非 `issues.edited` 事件**恒为 `false`**：它是「只认正文变更」这一个事件的
 * 附加条件，别的开关上写它只会被误读成「其它事件也做正文比对」。
 */
export function resolveEventTrigger(settings: unknown, event: EventKey): ResolvedEventTrigger {
  const read = readV21Settings(settings);
  const trigger = read.settings.triggers.events[event];
  return {
    enabled: trigger.enabled,
    prompt: trigger.prompt,
    onlyBodyChanged: event === 'issues.edited' ? trigger.only_body_changed === true : false,
    labels: [...(trigger.labels ?? [])],
    ok: read.ok,
    error: read.error,
  };
}

/* ── 2. 评论闸门与评论配置 ─────────────────────────────────────────────────── */

/** 四闸门的生效值（字段名沿用契约，见文件头「为什么 CommentGates 例外」）。 */
export type ResolvedCommentGates = CommentGates & {
  readonly ok: boolean;
  readonly error: string | null;
};

/**
 * 取评论事件的四个闸门（FR-2.4）。
 *
 * 闸门跟着事件走（`triggers.events['issue_comment.created'].gates`），不是 `comment` 段；
 * `allow_roles` 的引用合法性由 `repoSettingsSchema` 的 superRefine 保证。
 */
export function resolveCommentGates(settings: unknown): ResolvedCommentGates {
  const read = readV21Settings(settings);
  const gates = read.settings.triggers.events['issue_comment.created'].gates;
  return {
    require_mention: gates.require_mention,
    require_role: gates.require_role,
    allow_roles: [...gates.allow_roles],
    ignore_bot: gates.ignore_bot,
    allow_closed: gates.allow_closed,
    ok: read.ok,
    error: read.error,
  };
}

/** `comment` 段的生效值；`case_sensitive` 一律显式给布尔（缺省按 `false` 补齐）。 */
export type ResolvedCommentConfig = CommentConfig & {
  readonly ok: boolean;
  readonly error: string | null;
};

/**
 * 取评论触发配置（§6.6）：提及关键词 + 角色清单。
 *
 * 为什么在这里就把 `case_sensitive` 补成显式布尔：判定侧（`trigger/mention.ts`）不该再写
 * `?? false` —— 默认值只该有一处，否则「默认不区分大小写」这条会在两个地方各写一遍，
 * 迟早有一处写反。
 */
export function resolveCommentConfig(settings: unknown): ResolvedCommentConfig {
  const read = readV21Settings(settings);
  const comment = read.settings.comment;
  return {
    mentions: comment.mentions.map((mention) => ({
      keyword: mention.keyword,
      case_sensitive: mention.case_sensitive ?? false,
    })),
    roles: comment.roles.map((role) =>
      role.by === 'members'
        ? { name: role.name, by: 'members' as const, members: [...role.members] }
        : { name: role.name, by: 'association' as const, any_of: [...role.any_of] },
    ),
    ok: read.ok,
    error: read.error,
  };
}

/* ── 3. 执行限额 ───────────────────────────────────────────────────────────── */

/** 执行侧的生效值。 */
export type ResolvedAgentExecution = AgentExecution & {
  readonly ok: boolean;
  readonly error: string | null;
};

/**
 * 取执行侧配置（§6.7）。
 *
 * 两条路径的裁决（配置里同名信息存在两处，见 `repoConfigSchema` 的注释）：
 * - `system_prompt`：`agent.system_prompt` **非空**时优先，否则读 `agent.limits.system_prompt`；
 *   两处都是空串 = 用内置默认。
 * - `actions`：任一路径开启即视为开启（三个开关默认全 `false`，所以这条等价于「谁显式开了就开」）。
 *   用「或」而不是「与」：面板写 `agent.actions`，部署/迁移可能只写了 `agent.limits.actions`，
 *   让其中一处失效会变成「配了却没生效」这种最难查的问题。
 */
export function resolveAgentExecution(settings: unknown): ResolvedAgentExecution {
  const read = readV21Settings(settings);
  const agent = read.settings.agent;
  const limits = agent.limits;
  const primaryPrompt = agent.system_prompt.trim();
  return {
    system_prompt: primaryPrompt === '' ? limits.system_prompt : agent.system_prompt,
    concurrency: limits.concurrency,
    daily_quota: limits.daily_quota,
    turn_timeout_minutes: limits.turn_timeout_minutes,
    actions: {
      create_issue: agent.actions.create_issue || limits.actions.create_issue,
      open_pr: agent.actions.open_pr || limits.actions.open_pr,
      close_issue: agent.actions.close_issue || limits.actions.close_issue,
    },
    data_retention_days: limits.data_retention_days,
    ok: read.ok,
    error: read.error,
  };
}

/* ── 4. 标签目录 ───────────────────────────────────────────────────────────── */

/**
 * 标签目录的一项（`docs/v21-contract.md` §1 / FR-5.4）：`managed` 与 `status` **一定补齐**。
 *
 * `meaning: null` 表示没人填过含义——按 §6.5 的保护，这种标签不进自动对齐范围（不该被删）。
 */
export type ManagedCatalogEntry = {
  readonly name: string;
  readonly meaning: string | null;
  readonly group: string | null;
  readonly managed: boolean;
  readonly status: LabelStatus;
};

/**
 * 取标签目录（**全部**条目，`retired` 与 `managed=false` 也返回）。
 *
 * 为什么不在这一层过滤：调用方有两类，要的东西不一样——
 * 写回侧要「可管理集合」（`status==='active'` && `managed!==false` && `meaning` 非空），
 * 面板要「全部目录」（含失效项，否则人看不到自己标过什么）。在这里过滤等于替调用方做了决定。
 *
 * 解析失败时返回空数组（空目录 = 不动任何标签，是安全侧）。需要 `ok` 的调用方用
 * `readV21Settings()` 或任一 `resolve*`（它们都带 `ok`）。
 */
export function resolveManagedCatalog(settings: unknown): readonly ManagedCatalogEntry[] {
  const read = readV21Settings(settings);
  return read.settings.labels.vocabulary.map((entry) => ({
    name: entry.name,
    meaning: entry.meaning ?? null,
    group: entry.group ?? null,
    // 缺省按 v2.1 的语义补齐：老配置（没有这两个键）等价于「参与管理 + 有效」
    managed: entry.managed !== false,
    status: entry.status ?? 'active',
  }));
}
