/**
 * agent 运行时的常量（S1，`docs/dev-plan-issue-agent.md` §2.1 / §5）。
 *
 * 只放**产品口径**的数字与字符串：改这里就等于改行为，别的文件不许再写一份。
 */

/** dispatcher 的扫描间隔（10s）：`agent_messages` 里每个 issue 最老的一条被投一次。 */
export const AGENT_DISPATCH_INTERVAL_MS = 10_000;

/** 一轮 dispatch 最多处理多少个 issue（防一次性把热点仓库全捞起来）。 */
export const AGENT_DISPATCH_MAX_ISSUES = 20;

/** 进消息正文的 issue 正文上限（与 `webhook.ts::TARGET_BODY_MAX_CHARS` 同级，但更小）。 */
export const AGENT_MAX_BODY_CHARS = 4_000;

/** 标题上限（GitHub 本身限 256；这里再多给一点余量不影响预算）。 */
export const AGENT_MAX_TITLE_CHARS = 300;

/** `project_prompt` 进消息正文的上限（契约里该字段 ≤4000，这里再兜一道）。 */
export const AGENT_MAX_PROJECT_PROMPT_CHARS = 4_000;

/** 目录提示最多列多少条（S2 的上限是 128；提示词里只列其中一段）。 */
export const AGENT_MAX_CATALOG_ENTRIES = 64;

/** fingerprint 的十六进制前缀长度（`sha256(...)` 前 16 位；`agent_messages` 的主键部分）。 */
export const AGENT_FINGERPRINT_LENGTH = 16;

/** 消息种类：`mention` 是人消息（永久幂等），`event` 是模板消息（key 含 `issue.updated_at`）。 */
export const AGENT_MESSAGE_KINDS = ['mention', 'event'] as const;

export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

/** 消息状态：这张表同时是队列。 */
export const AGENT_MESSAGE_STATUSES = ['queued', 'running', 'done', 'failed'] as const;

export type AgentMessageStatus = (typeof AGENT_MESSAGE_STATUSES)[number];

/** 事件模板 id（`issues.opened` / `issues.edited`；`mention` 没有模板）。 */
export const AGENT_TEMPLATE_IDS = ['opened', 'edited'] as const;

export type AgentTemplateId = (typeof AGENT_TEMPLATE_IDS)[number];

/** 非管理员被拒时回的那一句话（同 issue 同 actor 只回一次）。 */
export const AGENT_DENIAL_REPLY =
  '这个仓库的 pi-bot 只接受管理员的消息（`settings.agent.managers`）。这条回复只发一次，之后不再打扰。';

/** `tasks.command` 的前缀：`agent:mention` / `agent:event`（面板与日志按它筛）。 */
export const AGENT_COMMAND_PREFIX = 'agent:';

/** dispatcher 写 `tasks.actor_login` 的值（消息表里没有 actor 列，事件消息也没有人）。 */
export const AGENT_TASK_ACTOR = 'agent';
