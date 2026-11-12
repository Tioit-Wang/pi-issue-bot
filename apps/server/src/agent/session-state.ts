/**
 * 会话状态机（FR-3.4 / Q-3 / AC-23）。
 *
 * 需求把这件事钉得很死：**会话没有「结束」这个状态**。issue 随时可能被重开，
 * 任何归档动作都会让重开的 issue 失去上下文。所以：
 *
 *  - 运行状态只有两种：`active`（沙箱存在）/ `idle`（沙箱已回收，下次触发时重建）；
 *  - issue 关闭 → **只回收沙箱**（资源动作），会话行与全部记录保留（数据动作不做）；
 *  - issue 重开 → 直接复用原会话（不重建会话），沙箱按需重建；
 *  - 任何输入都**不得**返回删除/归档会话的动作 —— 这一点靠类型强制：
 *    `SessionAction` 里根本没有 `delete` / `archive` / `end` 这些取值。
 *
 * 为什么是纯函数：这一段是「回收变丢历史」这类事故的唯一入口，必须能用一张输入矩阵
 * 逐格断言（见 `test/agent-session-state.test.ts`）。真正的 sandbox 销毁/创建在
 * `sandbox/lifecycle.ts` 与 WS6 的装配层做。
 */

/** 会话状态取值（与 `db/schema.ts` 的 `AGENT_SESSION_STATE` 同口径）。 */
export const SESSION_STATES = ['active', 'idle'] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/**
 * 事件全集。
 *
 * 与 `packages/contract` 的 `EventKey` **结构一致但刻意各写一份**：
 * server 不依赖 `@pi-issue-bot/contract`（见 `db/schema.ts` 头注释的同类取舍），
 * 这里只需要五个字符串；跨包引契约反而会把两边的发布节奏绑在一起。
 */
export const SESSION_EVENT_KEYS = [
  'issues.opened',
  'issues.edited',
  'issues.labeled',
  'issues.closed',
  'issue_comment.created',
] as const;

export type SessionEventKey = (typeof SESSION_EVENT_KEYS)[number];

/** issue 当前状态（以 GitHub 的实时状态为准，不是事件载荷里的旧值）。 */
export type IssueState = 'open' | 'closed';

/**
 * `agent_sessions` 的一行 —— 本模块只读这六个字段。
 *
 * 与 `agent/store.ts` 的 `AgentSessionRow`（sessionId/cursor/turns/startedAt）不同名不冲突：
 * 那边是「会话的行」，这里是「会话 + 沙箱的运行时快照」。WS1 已给表加了
 * `state` / `sandbox_id` / `closed_at`，这里的形状与列一一对应。
 */
export type AgentSessionRow = {
  readonly repo: string;
  readonly issueNumber: number;
  /** RACP 会话 id；`null` = 还没开过会话（罕见：行先建、会话后建） */
  readonly sessionId: string | null;
  readonly state: SessionState;
  /** 当前沙箱 id；`state='idle'` 时必为 `null` */
  readonly sandboxId: string | null;
  /** 该会话已用轮数 */
  readonly turns: number;
  /** `events/subscribe` 的游标（防重放） */
  readonly cursor: number;
};

/**
 * 允许的三种动作。
 *
 * 没有 `end` / `archive` / `delete`：这不是「暂时没用上」，而是**永远不允许存在**（FR-3.4）。
 */
export const SESSION_ACTIONS = ['create', 'reuse', 'recycle-sandbox'] as const;

export type SessionAction = (typeof SESSION_ACTIONS)[number];

/** 状态迁移的结论。装配层据此调 sandbox 的创建/销毁，**不据此删任何数据**。 */
export type SessionTransition = {
  readonly action: SessionAction;
  /** 事件处理完之后会话应处的状态 */
  readonly state: SessionState;
  /** 是否保留原会话（`create` 时没有可保留的会话，为 `false`；其余一律 `true`） */
  readonly keepSession: boolean;
  /** 是否需要（重新）拉起沙箱 */
  readonly rebuildSandbox: boolean;
  /** 判定原因，用于留痕与排障（与 BR-6「不触发也留痕」同风格） */
  readonly reason: string;
};

export type PlanSessionOnEventInput = {
  /** 现有会话行；`null` = 该 issue 还没有会话 */
  readonly session: AgentSessionRow | null;
  /** issue 的实时状态 */
  readonly issueState: IssueState;
  /** 触发本轮的事件 */
  readonly event: SessionEventKey;
};

/**
 * 判定「这次事件之后会话该怎么动」。
 *
 * 判定顺序（顺序本身就是需求，别随手续写）：
 *  1. 没有会话 → 新建（`create`，状态 `active`，必须拉沙箱）；
 *  2. 事件是 `issues.closed` 且 issue 确实已关闭 → **只回收沙箱**（`idle`，会话保留）；
 *     若事件说关了、实时状态还是 open（GitHub 重开与事件乱序的竞态），按「未关」处理，
 *     不能因为一条过期的关闭事件把活跃会话的沙箱砸了；
 *  3. `issues.opened` 且已有会话 → 重开，复用会话但**沙箱要重建**（关闭时已被回收）；
 *  4. issue 已关闭但事件不是 `issues.closed`（评论打到关闭的 issue 上等）→ 复用会话、
 *     重建沙箱；处理完仍是 `active`（不因为「issue 关着」就把刚拉起的沙箱标回 idle）；
 *  5. 其余（issue open 的普通事件）→ 复用会话，沙箱缺失才重建。
 */
export function planSessionOnEvent(input: PlanSessionOnEventInput): SessionTransition {
  const { session, issueState, event } = input;

  // ① 没有会话：新建，且必须把沙箱拉起来
  if (session === null) {
    return {
      action: 'create',
      state: 'active',
      keepSession: false,
      rebuildSandbox: true,
      reason: 'no-session',
    };
  }

  // ② issue 关闭：只回收沙箱，会话与记录全留下（AC-23）
  if (event === 'issues.closed' && issueState === 'closed') {
    return {
      action: 'recycle-sandbox',
      state: 'idle',
      keepSession: true,
      rebuildSandbox: false,
      reason: 'issue-closed',
    };
  }

  // ③ issue 重开：复用原会话，沙箱重建（历史上下文仍在）
  if (event === 'issues.opened') {
    return {
      action: 'reuse',
      state: 'active',
      keepSession: true,
      rebuildSandbox: true,
      reason: 'issue-reopened',
    };
  }

  // ④ 已关闭的 issue 上来了别的触发（评论等）：复用会话 + 重建沙箱
  if (issueState === 'closed') {
    return {
      action: 'reuse',
      state: 'active',
      keepSession: true,
      rebuildSandbox: true,
      reason: 'closed-issue-trigger',
    };
  }

  // ⑤ 常规：复用会话；`idle` 或沙箱 id 丢了才重建（沙箱可能被运维 sweep 掉）
  const needsRebuild = session.state === 'idle' || session.sandboxId === null;
  return {
    action: 'reuse',
    state: 'active',
    keepSession: true,
    rebuildSandbox: needsRebuild,
    reason: needsRebuild ? 'idle-sandbox' : 'active-sandbox',
  };
}

/** 类型守卫：任意字符串是否合法状态（读库回来时校验用）。 */
export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value);
}
