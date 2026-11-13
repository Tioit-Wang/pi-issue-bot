/**
 * 产出契约 v2 的**执行器**（`docs/v21-contract.md` §4 校验第 4/5 条 + §5 / FR-5.3~FR-5.5）。
 *
 * 三条与旧写回路径（`worker/writeback.ts`）**刻意不同**的语义，改之前请先读这一段：
 *
 *  1. **顺序执行，遇失败即停**（§4 第 4 条）。旧路径是「逐个动作独立、失败不拖累下一个」；
 *     v2 的动作之间有依赖（先 `verdict` 再 `comment` 再说 `close_issue`），
 *     一个动作失败后继续执行会让后续动作基于错误的前提动手，所以必须停。
 *     已成功的不回滚 —— 回滚需要幂等的逆操作，而 GitHub 的删除回答不了「原来有没有」。
 *  2. **后三类动作的开关在「执行前」整份拒绝**（§4 第 5 条）。不是「跳过那一条」：
 *     模型产出了一条 `open_pr`，说明它对任务的理解包含了开 PR；静默跳过会让人以为
 *     「开 PR 那步做完了」。整份拒绝 + `action-disabled` 才能让人去改配置或改提示词。
 *  3. **dry-run 只算不写**：任何写方法都不调用，但 `executed` 里仍然逐条给出计划
 *     （`detail` 以 `dry-run` 开头），面板因此能展示「如果执行会做什么」。
 *
 * 依赖注入到底：本文件不 import 任何 `github/*`，也不 import `db/*`。
 * 端口 `V21GithubPort` 就是它需要的最小能力集，于是单测可以用 20 行假端口覆盖全部分支。
 * 真实装配走 `createV21PortFromGithub()`（文件末尾），它把既有写面/reaction 面/开 PR 面
 * 拼成一个端口。
 */
import type { OutputV21, OutputV21Action, GatedActionType } from '../../../../../packages/envelope/src/index.ts';
import { gatedActionOf } from '../../../../../packages/envelope/src/index.ts';
import type { SlotComment } from './comments.ts';
import { buildSlotMarker, findSlotComment, planSlotWrite } from './comments.ts';
import type { CatalogEntry, LabelPlan } from './labels.ts';
import { deletionOwner, planLabelTargetState } from './labels.ts';
import {
  buildLinkNote,
  findIssueReferences,
  neutralizeClosingKeywords,
  neutralizeMentions,
  renderReplyBody,
} from './markup.ts';

/* ── 0. 端口（执行器认识的唯一外部形状）──────────────────────────────────── */

/** 一条 reaction（判「是不是我自己打的」只需要这三项）。 */
export type V21ReactionEntry = {
  readonly id: number;
  readonly content: string;
  readonly userLogin: string | null;
};

/** reaction 的目标：`commentId` 给了就打评论级，否则打主贴（与 `github/types.ts` 同口径）。 */
export type V21ReactionTarget = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly commentId?: number | null;
};

/** 一条评论的详情（`reply_to` 认作者、`update_comment` / `delete_comment` 判归属）。 */
export type V21IssueCommentDetail = {
  readonly id: number;
  readonly authorLogin: string | null;
  readonly body: string | null;
};

/**
 * issue 编辑面（写类 issue 工具的端口形状）。
 *
 * 为什么在这里**再声明一遍**而不是 import `github/types.ts` 的同名接口：
 * 本文件刻意不 import `github/*`（见文件头），端口是「执行器认识的最小能力集」，
 * 真实实现在 `github/octokit.ts`，两者由 `createV21PortFromGithub()` 对接。
 * 两边的形状逐字兼容（`GithubIssueEditApi` 可直接赋给本类型），所以装配处不需要适配层。
 */
export type V21IssueEditPort = {
  updateIssue(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly assignees?: readonly string[] | undefined;
    readonly milestone?: number | null | undefined;
  }): Promise<{ readonly updatedAt: string }>;
  getIssueUpdatedAt(input: { readonly repo: string; readonly issueNumber: number }): Promise<string>;
  reopenIssue(input: { readonly repo: string; readonly issueNumber: number }): Promise<void>;
  closeIssueWithReason(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly reason: 'completed' | 'not_planned' | 'duplicate';
    readonly duplicateOf?: number | undefined;
  }): Promise<void>;
  getIssueComment(input: { readonly repo: string; readonly commentId: number }): Promise<V21IssueCommentDetail>;
  deleteIssueComment(input: { readonly repo: string; readonly commentId: number }): Promise<void>;
  getIssueId(input: { readonly repo: string; readonly issueNumber: number }): Promise<number>;
  issueExists(input: { readonly repo: string; readonly issueNumber: number }): Promise<boolean>;
  addBlockedBy(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly blockedByIssueId: number;
  }): Promise<void>;
  addSubIssue(input: {
    readonly repo: string;
    readonly parentNumber: number;
    readonly subIssueId: number;
  }): Promise<void>;
};

/**
 * 执行器依赖的 GitHub 端口。
 *
 * 为什么不用 `GithubWriteApi`：那个接口是**旧路径的**写面（还带着 push_branch 时代的形状），
 * 而 v2 需要 reaction 与开 PR 两项它没有的能力。硬塞进去会把「旧路径的假实现」
 * 全部改一遍，收益为零。端口单独声明后，两者用 `createV21PortFromGithub()` 对接。
 */
export type V21GithubPort = {
  listIssueComments(input: { readonly repo: string; readonly issueNumber: number }): Promise<readonly SlotComment[]>;
  createIssueComment(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly body: string;
  }): Promise<{ readonly id: number }>;
  updateIssueComment(input: {
    readonly repo: string;
    readonly commentId: number;
    readonly body: string;
  }): Promise<{ readonly id: number }>;
  addLabels(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly labels: readonly string[];
  }): Promise<void>;
  removeLabel(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly label: string;
  }): Promise<void>;
  createIssue(input: {
    readonly repo: string;
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
  }): Promise<{ readonly number: number }>;
  closeIssue(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly reason?: 'completed' | 'not_planned';
  }): Promise<void>;
  /** 开 PR（分支只允许 `bot/*`，由执行器判，端口不重复校验）。 */
  openPullRequest(input: {
    readonly repo: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }): Promise<{ readonly number: number }>;
  listReactions(
    input: V21ReactionTarget & { readonly content: string },
  ): Promise<readonly V21ReactionEntry[]>;
  addReaction(input: V21ReactionTarget & { readonly content: string }): Promise<{ readonly id: number }>;
  removeReaction(input: V21ReactionTarget & { readonly reactionId: number }): Promise<void>;
  /**
   * issue 编辑面（写类 issue 工具：回复 / 关单 / 重开 / 改 issue / 改删评论 / 关联）。
   *
   * 为什么是**必填**而不是可选：执行器的十二条分支里有一半只能走它，
   * 可选会让每个调用点都写一遍 `?.` 与「没注入」分支。缺能力时不在这里判空，
   * 而是由 `createV21PortFromGithub()` 提供一个「调用即抛 missingCapability」的占位，
   * 于是错误消息能点名缺的是 `issueEdit.getIssueComment` 而不是一句笼统的 undefined。
   */
  issueEdit: V21IssueEditPort;
  /** 这个 login 是不是我们自己（App slug / bot login）。`null` 恒为 false。 */
  isOwn(login: string | null): boolean;
};

/**
 * 槽位索引（`(repo, issue, slot) → commentId`）。
 *
 * 可选：没有索引时执行器退化成「每次列评论按标记找」，语义完全一致，只是多一次 GET。
 * 这样「面板/迁移还没建表」不会让写回失效。
 */
export type V21SlotStore = {
  get(input: { readonly repo: string; readonly issueNumber: number; readonly slot: string }): Promise<number | null>;
  put(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly slot: string;
    readonly commentId: number;
  }): Promise<void>;
  delete(input: { readonly repo: string; readonly issueNumber: number; readonly slot: string }): Promise<void>;
};

/** 三类受限动作的开关（`resolveAgentExecution().actions`，三个默认全 `false`）。 */
export type V21ActionSwitches = Readonly<Record<GatedActionType, boolean>>;

/**
 * `create_issue` 的去重/配额闸门（§5 第四行：指纹去重**优先于**日配额）。
 *
 * 由装配层注入：指纹表与配额计数都在 DB 里，执行器不认识 DB。
 * 省略 = 不做任何闸门（等价于 `'create'`，只在没有 DB 的场景/单测里出现）。
 */
export type V21CreateIssueGuard = (input: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly fingerprint: string | null;
  readonly labels: readonly string[];
}) => Promise<'create' | 'duplicate' | 'quota'>;

export type ExecuteV21Input = {
  readonly output: OutputV21;
  readonly repo: string;
  readonly issueNumber: number;
  /** 预演模式：不调任何写方法，只产出计划。 */
  readonly dryRun: boolean;
  readonly actionsEnabled: V21ActionSwitches;
  /** issue 当前标签（判定 `label` 的差集用；调用方读一次传进来）。 */
  readonly currentLabels: readonly string[];
  /** 我们历史上打过的标签（决定删除的 `owner`）。 */
  readonly botLabels: readonly string[];
  readonly catalog: readonly CatalogEntry[];
  /** `labels.max_per_issue`。 */
  readonly maxPerIssue: number;
  readonly api: V21GithubPort;
  /**
   * 允许被 `@` 到的 login（issue 作者 + 本轮触发人）。
   *
   * 正文里的其它 `@` 会被插零宽空格中和（`markup.ts::neutralizeMentions`）：
   * agent 随手 `@` 一整排人是打扰，而删掉 `@` 会让正文读起来像漏字。
   * 缺省空数组 = 「谁都不许 @」（最保守的一侧；装配层能拿到触发人就应当填）。
   */
  readonly allowedMentions?: readonly string[] | undefined;
  /**
   * 单条正文里允许出现的 issue 引用（`#12` / `o/r#12` / 完整 URL）上限，缺省 5。
   *
   * 超过就整条失败而不是截断：引用一多通常是模型在「顺手列一堆相关 issue」，
   * 那些编号大概率是编的，执行前逐条校验的代价也会线性上涨。
   */
  readonly maxRefsPerBody?: number | undefined;
  readonly slotStore?: V21SlotStore | undefined;
  readonly createIssueGuard?: V21CreateIssueGuard | undefined;
  /** 注入时钟（审计/耗时用）。 */
  readonly now?: (() => number) | undefined;
};

/** 一条动作的执行结果。`outcome='ok'` 包含「按规则无事可做」与「dry-run 计划」。 */
export type V21ActionOutcome = {
  readonly index: number;
  readonly type: string;
  readonly outcome: 'ok' | 'failed';
  readonly detail?: string;
};

/** 一条动作的错误（进 `run_events` 与面板详情）。 */
export type V21ActionError = {
  readonly index: number;
  readonly type: string;
  readonly message: string;
};

export type ExecuteV21Result = {
  readonly ok: boolean;
  readonly executed: readonly V21ActionOutcome[];
  /** 中断位置（**下标**）；`null` = 没有中断。整份前置拒绝时也是 `null`（一条都没开始）。 */
  readonly stoppedAt: number | null;
  readonly errors: readonly V21ActionError[];
  /** 结束时刻（毫秒）：给审计与耗时分桶用，契约 §4 未要求，属于本执行器的附加字段。 */
  readonly finishedAtMs: number;
};

/* ── 1. 错误消息的构造（统一前缀，便于面板分组）──────────────────────────── */

const ERROR_ACTION_DISABLED = 'action-disabled';
const ERROR_CLOSE_WITHOUT_FAIL = 'close-without-fail';
const ERROR_BRANCH_NOT_ALLOWED = 'branch-not-allowed';
const ERROR_REACTION_MISSING = 'reaction-not-found';
const ERROR_LABEL_PLAN = 'label-plan-rejected';
const ERROR_CREATE_ISSUE_QUOTA = 'create-issue-quota';
const ERROR_SLOT_UNRESOLVED = 'slot-unresolved';
const ERROR_TOO_MANY_REFS = 'too-many-refs';
const ERROR_REF_NOT_FOUND = 'ref-not-found';
const ERROR_UPDATE_CONFLICT = 'update-conflict';
const ERROR_UPDATE_EMPTY = 'update-empty';
const ERROR_COMMENT_NOT_OWN = 'comment-not-own';
const ERROR_CLOSE_INVALID = 'close-invalid';
const ERROR_REACTION_TARGET = 'reaction-target-invalid';

/** 单条正文允许的 issue 引用上限（`ExecuteV21Input.maxRefsPerBody` 的缺省值）。 */
const DEFAULT_MAX_REFS_PER_BODY = 5;

/** 关闭时附带说明用的固定槽位（同 issue 同槽位只保留一条，不随触发次数增长）。 */
const CLOSE_COMMENT_SLOT = 'close';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 判断一个错误是不是「404 已不存在」。
 *
 * 槽位写回必须区分两种 update 失败：评论被人删了（→ 重建一条，正常路径）与
 * 网络/权限问题（→ 直接失败，不能悄悄再发一条）。`github/errors.ts` 的 `GithubError`
 * 把状态码放在 `status` / `httpStatus` 上，这里两种都认，再兜底看消息里的 `404`。
 */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  for (const key of ['status', 'httpStatus', 'code']) {
    if (record[key] === 404) {
      return true;
    }
  }
  const info = record['info'];
  if (typeof info === 'object' && info !== null && (info as Record<string, unknown>)['status'] === 404) {
    return true;
  }
  const message = record['message'];
  return typeof message === 'string' && (/\b404\b/u.test(message) || /not found/iu.test(message));
}

/*
 * 「这三类动作受哪个开关约束」由**契约包**决定（`gatedActionOf()`）：
 * `link` + `relation='duplicate'` 在语义上就是关单，必须被 `close_issue` 开关挡住，
 * 否则换个工具名就能绕过闸门。口径只有一份，执行器直接用契约里的那个。
 */

/**
 * 正文里 issue 引用的校验（`docs/plan-issue-tools.md` §2 第 1 条）。
 *
 * 为什么必须真的问一次 GitHub：模型编造 `#123` 是最常见的失败形态，而 GitHub 对不存在的
 * 编号什么都不会发生 —— 人看到的是「它说关联了 #123，但那里没有东西」。整条失败而不是
 * 悄悄删掉那个编号，是为了让模型拿到「这个编号不存在」这个信号去改产出。
 *
 * 校验范围刻意收窄：只查**本仓库**（`repo === null` 或等于当前 repo）。指向别的仓库的引用
 * 一律跳过 —— 我们既没有那个仓库的权限，也没必要为它多发一次请求。
 *
 * dry-run 完全不发这些 GET：预演模式只算不写，也不该产生调用（面板据此展示「会做什么」）。
 */
async function assertRefsResolvable(body: string, input: ExecuteV21Input): Promise<void> {
  const refs = findIssueReferences(body);
  if (refs.length === 0) {
    return;
  }
  const limit = input.maxRefsPerBody ?? DEFAULT_MAX_REFS_PER_BODY;
  if (refs.length > limit) {
    throw new Error(
      `${ERROR_TOO_MANY_REFS}: 正文里出现 ${String(refs.length)} 个 issue 引用（上限 ${String(limit)} 个），请精简后重试`,
    );
  }
  if (input.dryRun) {
    return;
  }
  for (const ref of refs) {
    if (ref.repo !== null && ref.repo !== input.repo) {
      continue;
    }
    const exists = await input.api.issueEdit.issueExists({ repo: input.repo, issueNumber: ref.number });
    if (!exists) {
      throw new Error(`${ERROR_REF_NOT_FOUND}: ${ref.raw} 在本仓库不存在（请核对编号后重试）`);
    }
  }
}

/** 允许清单 + 这条动作自己必须 @ 到的人（回复目标的作者）。 */
function withMention(
  allowed: readonly string[] | undefined,
  login: string | null | undefined,
): readonly string[] {
  const merged = [...(allowed ?? [])];
  if (typeof login === 'string' && login !== '') {
    merged.push(login);
  }
  return merged;
}

/**
 * 读一条评论并断言它是**我们自己**写的。
 *
 * 归属判定放在读之后而不是靠调用方传入：`update_comment` / `delete_comment` 的 payload
 * 里只有 id，唯一可靠的作者来源就是那条评论本身。别人的评论一律拒绝（BR-12 的同一条原则：
 * 机器人只动自己写过的东西），不做「先礼后兵」式的尝试。
 */
async function requireOwnComment(commentId: number, input: ExecuteV21Input): Promise<V21IssueCommentDetail> {
  const comment = await input.api.issueEdit.getIssueComment({ repo: input.repo, commentId });
  if (!input.api.isOwn(comment.authorLogin)) {
    throw new Error(
      `${ERROR_COMMENT_NOT_OWN}: 只能改/删本机器人写的评论（comment ${String(commentId)} 的作者是 ${comment.authorLogin ?? '未知'}）`,
    );
  }
  return comment;
}

/* ── 2. 前置检查：开关 ───────────────────────────────────────────────────── */

/**
 * 执行前扫一遍开关（§4 第 5 条）。
 *
 * 返回**全部**不合规的下标而不是第一条：配置一次只让人改一个开关，是纯浪费。
 */
function preflightSwitches(output: OutputV21, switches: V21ActionSwitches): V21ActionError[] {
  const errors: V21ActionError[] = [];
  output.actions.forEach((action, index) => {
    const gated = gatedActionOf(action);
    if (gated === null || switches[gated]) {
      return;
    }
    errors.push({
      index,
      type: action.type,
      message: `${ERROR_ACTION_DISABLED}: 项目开关 agent.actions.${gated} 未开启，本次产出整份拒绝（一条都不执行）`,
    });
  });
  return errors;
}

/* ── 3. 主流程 ───────────────────────────────────────────────────────────── */

/**
 * 执行一份 v2 产出。
 *
 * 返回值永远不抛：所有失败都变成 `ok:false` + `errors`，调用方据此落库与告警
 * （抛出去会让「动作失败」和「执行器自己崩了」在调用点长得一样）。
 */
export async function executeV21(input: ExecuteV21Input): Promise<ExecuteV21Result> {
  const now = input.now ?? Date.now;
  const executed: V21ActionOutcome[] = [];
  const errors: V21ActionError[] = [];

  // 第 1 步：整份前置拒绝（不执行任何一条）。
  const disabled = preflightSwitches(input.output, input.actionsEnabled);
  if (disabled.length > 0) {
    return {
      ok: false,
      executed: [],
      stoppedAt: null,
      errors: disabled,
      finishedAtMs: now(),
    };
  }

  // 第 2 步：顺序执行，遇失败即停。
  let stoppedAt: number | null = null;
  for (let index = 0; index < input.output.actions.length; index += 1) {
    const action = input.output.actions[index];
    if (action === undefined) {
      continue;
    }
    try {
      const detail = await runAction(action, input);
      executed.push({ index, type: action.type, outcome: 'ok', detail });
    } catch (error) {
      const message = errorText(error);
      executed.push({ index, type: action.type, outcome: 'failed', detail: message });
      errors.push({ index, type: action.type, message });
      stoppedAt = index;
      break;
    }
  }

  return {
    ok: errors.length === 0,
    executed,
    stoppedAt,
    errors,
    finishedAtMs: now(),
  };
}

/**
 * 执行**一条**动作。
 *
 * 返回 `detail`（人读的一句话，进 `executed` 与 `actions.audit.detail`）；
 * 失败一律 `throw new Error('<code>: ...')` —— 主流程只做「记录 + 中断」。
 */
async function runAction(action: OutputV21Action, input: ExecuteV21Input): Promise<string> {
  switch (action.type) {
    case 'verdict':
      return runVerdict(action.payload, input);
    case 'label':
      return runLabel(action.payload, input);
    case 'comment':
      return runComment(action.payload, input);
    case 'reaction':
      return runReaction(action.payload, input);
    case 'create_issue':
      return runCreateIssue(action.payload, input);
    case 'open_pr':
      return runOpenPr(action.payload, input);
    case 'close_issue':
      return runCloseIssue(action.payload, input);
    case 'reopen_issue':
      return runReopenIssue(input);
    case 'update_issue':
      return runUpdateIssue(action.payload, input);
    case 'update_comment':
      return runUpdateComment(action.payload, input);
    case 'delete_comment':
      return runDeleteComment(action.payload, input);
    case 'link':
      return runLink(action.payload, input);
  }
}

/* ── 4. 十二类动作各自的行为 ─────────────────────────────────────────────── */

/** `verdict`：纯记录。它不写 GitHub，只是给「这一轮出了什么结论」留一个可审计的落点。 */
function runVerdict(
  payload: { readonly verdict: 'pass' | 'fail'; readonly evidence?: readonly string[] | undefined },
  input: ExecuteV21Input,
): string {
  const evidenceCount = payload.evidence?.length ?? 0;
  const conflict =
    input.output.verdict !== undefined && input.output.verdict !== payload.verdict
      ? `（注意：顶层 verdict=${input.output.verdict} 与本动作不一致，以本动作为准）`
      : '';
  return `verdict=${payload.verdict}，evidence ${String(evidenceCount)} 条${conflict}`;
}

/**
 * `label`：目标态对齐。
 *
 * 拒绝时不写任何标签（`planLabelTargetState` 一次算出整批），
 * 所以「超限」与「目录外」都不会留下半套标签。
 */
async function runLabel(
  payload: { readonly desired: readonly string[]; readonly clear?: boolean | undefined },
  input: ExecuteV21Input,
): Promise<string> {
  const plan: LabelPlan = planLabelTargetState({
    current: input.currentLabels,
    desired: payload.desired,
    clear: payload.clear,
    catalog: input.catalog,
    maxPerIssue: input.maxPerIssue,
    botLabels: input.botLabels,
  });

  if (!plan.ok) {
    throw new Error(`${ERROR_LABEL_PLAN}: ${plan.reason} ${plan.detail}`);
  }

  const owners: Record<string, 'bot' | 'human'> = {};
  for (const label of plan.remove) {
    owners[label] = deletionOwner(label, input.botLabels);
  }
  const summary = describeLabelDelta(plan, owners);

  if (input.dryRun) {
    return `dry-run: ${summary}`;
  }
  if (plan.add.length === 0 && plan.remove.length === 0) {
    return `已是目标态（无需改动）：${summary}`;
  }

  // 先加后删：先加能保证「改名」类操作期间 issue 上始终至少有一个相关标签；
  // 反过来（先删后加）会有一瞬间两个都没有，而 webhook 的 `issues.labeled` 触发点
  // 可能正好落在那一瞬间。
  if (plan.add.length > 0) {
    await input.api.addLabels({
      repo: input.repo,
      issueNumber: input.issueNumber,
      labels: plan.add,
    });
  }
  for (const label of plan.remove) {
    await input.api.removeLabel({ repo: input.repo, issueNumber: input.issueNumber, label });
  }
  return summary;
}

/** 标签差集的一句话（含每个删除项的 `owner`）。 */
function describeLabelDelta(plan: Extract<LabelPlan, { ok: true }>, owners: Readonly<Record<string, 'bot' | 'human'>>): string {
  const parts: string[] = [];
  parts.push(plan.add.length === 0 ? '不加' : `加 [${plan.add.join(', ')}]`);
  if (plan.remove.length === 0) {
    parts.push('不删');
  } else {
    parts.push(`删 [${plan.remove.map((label) => `${label}/${owners[label] ?? 'human'}`).join(', ')}]`);
  }
  if (plan.skipped.length > 0) {
    parts.push(`保留 [${plan.skipped.map((item) => `${item.label}/${item.reason}`).join(', ')}]`);
  }
  return parts.join(' ');
}

/**
 * `comment`：槽位写回（覆盖而非新增）。
 *
 * 找现有评论的顺序：**索引优先**（一次 GET 都不用），索引没有才列评论按标记找。
 * 两条路径都拿不到 → 新建；索引里有 id 但评论不见了 → 新建并标 `recreated`。
 *
 * v2.2 的两条前置处理都作用在**最终正文**上，顺序不能反：
 *  1. `reply_to` → 读回原评论，渲染成「引用块 + 定向 @作者」（issue 评论没有 thread，
 *     「回复」只能这样表达；格式由 `markup.ts::renderReplyBody` 规定死）；
 *  2. 提及中和：允许清单 = 装配层给的（issue 作者 / 本轮触发人）+ 本条回复的作者。
 *     渲染出来的 `@作者` 因此不会被中和，而模型顺手 @ 的其他人会被插零宽空格。
 * 槽位语义（标记 / 覆盖判定）一行都没改：它只关心 `(repo, issue, slot)`。
 */
async function runComment(
  payload: { readonly slot: string; readonly body: string; readonly reply_to?: number | undefined },
  input: ExecuteV21Input,
): Promise<string> {
  const marker = buildSlotMarker({ repo: input.repo, issueNumber: input.issueNumber, slot: payload.slot });
  const slotTarget = { repo: input.repo, issueNumber: input.issueNumber, slot: payload.slot };

  const replySource =
    payload.reply_to === undefined
      ? null
      : await input.api.issueEdit.getIssueComment({ repo: input.repo, commentId: payload.reply_to });

  const rendered =
    replySource === null
      ? payload.body
      : renderReplyBody({
          authorLogin: replySource.authorLogin,
          originalBody: replySource.body,
          body: payload.body,
        });
  const neutralized = neutralizeMentions(
    rendered,
    withMention(input.allowedMentions, replySource?.authorLogin ?? null),
  );
  const body = neutralized.body;
  await assertRefsResolvable(body, input);

  const notes: string[] = [];
  if (replySource !== null) {
    notes.push(
      `回复评论 ${String(payload.reply_to)}${replySource.authorLogin === null ? '' : `（@${replySource.authorLogin}）`}`,
    );
  }
  if (neutralized.neutralized.length > 0) {
    notes.push(`已中和 ${String(neutralized.neutralized.length)} 个不被允许的提及（${neutralized.neutralized.join(', ')}）`);
  }
  const suffix = notes.length === 0 ? '' : `；${notes.join('；')}`;

  const historyCommentId = input.slotStore === undefined ? null : await input.slotStore.get(slotTarget);

  // 索引只给 id，正文由我们自己拼（槽位是覆盖语义，不需要读回旧正文）。
  const existing: SlotComment | null =
    historyCommentId !== null
      ? { id: historyCommentId, body: null }
      : findSlotComment(
          await input.api.listIssueComments({ repo: input.repo, issueNumber: input.issueNumber }),
          marker,
        );

  const plan = planSlotWrite({
    existing,
    body,
    marker,
    historyCommentId,
  });

  if (input.dryRun) {
    return plan.op === 'update'
      ? `dry-run: 覆盖槽位 ${payload.slot}（commentId=${String(plan.commentId)}）${suffix}`
      : `dry-run: 新建槽位 ${payload.slot}${plan.recreated ? '（原评论已不存在，重建）' : ''}${suffix}`;
  }

  if (plan.op === 'update') {
    try {
      const ref = await input.api.updateIssueComment({
        repo: input.repo,
        commentId: plan.commentId,
        body: plan.body,
      });
      await putSlot(input, slotTarget, ref.id);
      return `覆盖槽位 ${payload.slot}（commentId=${String(ref.id)}）${suffix}`;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      // 评论被人删了：按「重建」处理（不是失败 —— 槽位语义要求「有一个最新版本」）。
      const ref = await input.api.createIssueComment({
        repo: input.repo,
        issueNumber: input.issueNumber,
        body: plan.body,
      });
      await putSlot(input, slotTarget, ref.id);
      return `槽位 ${payload.slot} 的原评论已不存在，重建（commentId=${String(ref.id)}，${ERROR_SLOT_UNRESOLVED}）${suffix}`;
    }
  }

  const ref = await input.api.createIssueComment({
    repo: input.repo,
    issueNumber: input.issueNumber,
    body: plan.body,
  });
  await putSlot(input, slotTarget, ref.id);
  return plan.recreated
    ? `槽位 ${payload.slot} 重建（commentId=${String(ref.id)}）${suffix}`
    : `槽位 ${payload.slot} 首次写入（commentId=${String(ref.id)}）${suffix}`;
}

/** 落槽位索引（索引没注入 / 写失败都不翻这一轮：标记本身就是兜底真相）。 */
async function putSlot(
  input: ExecuteV21Input,
  slotTarget: { readonly repo: string; readonly issueNumber: number; readonly slot: string },
  commentId: number,
): Promise<void> {
  if (input.slotStore === undefined) {
    return;
  }
  try {
    await input.slotStore.put({ ...slotTarget, commentId });
  } catch {
    // 静默：评论已经写成功，索引只是快路径；下一轮会退回「按标记找」。
  }
}

/**
 * `reaction`：幂等的表情反馈。
 *
 *  - `add`：先查有没有**自己打的**同 content，有就跳过（GitHub 的 POST 本身也幂等，
 *    但跳过能少一次写调用，也避免在审计里多一条「又加了一次」）；
 *  - `remove`：只删自己打的（BR-12：不动人的 reaction）。一条都没有 → 失败
 *    （`reaction-not-found`）：这说明模型想撤销一件没发生的事，值得让人看见。
 */
async function runReaction(
  payload: {
    readonly op: 'add' | 'remove';
    readonly content: string;
    readonly target?: 'issue' | 'comment' | undefined;
    readonly comment_id?: number | undefined;
  },
  input: ExecuteV21Input,
): Promise<string> {
  // 目标判定的两条来源：显式 `target='comment'`，或**给了** `comment_id`。
  // 后者是为了迁就「只说 id、不说 target」的写法：给了评论 id 却打到主贴上，
  // 是彻底的静默错误（人只会看到主贴多了一个表情）。
  const onComment = payload.target === 'comment' || payload.comment_id !== undefined;
  if (onComment && payload.comment_id === undefined) {
    throw new Error(`${ERROR_REACTION_TARGET}: target=comment 时必须给 comment_id（说明打在哪条评论上）`);
  }
  const target: V21ReactionTarget = {
    repo: input.repo,
    issueNumber: input.issueNumber,
    ...(payload.comment_id === undefined ? {} : { commentId: payload.comment_id }),
  };
  const where = payload.comment_id === undefined ? '主贴' : `评论 ${String(payload.comment_id)}`;
  const listed = await input.api.listReactions({ ...target, content: payload.content });
  const mine = listed.filter((entry) => input.api.isOwn(entry.userLogin));

  if (payload.op === 'add') {
    if (mine.length > 0) {
      return `reaction ${payload.content} 已存在（自己打的，${where}），跳过`;
    }
    if (input.dryRun) {
      return `dry-run: 会在${where}添加 reaction ${payload.content}`;
    }
    const ref = await input.api.addReaction({ ...target, content: payload.content });
    return `添加 reaction ${payload.content}（${where}，id=${String(ref.id)}）`;
  }

  if (mine.length === 0) {
    throw new Error(`${ERROR_REACTION_MISSING}: ${where}没有自己打的 ${payload.content} reaction 可撤销`);
  }
  if (input.dryRun) {
    return `dry-run: 会撤销${where} ${String(mine.length)} 条自己的 ${payload.content} reaction`;
  }
  for (const entry of mine) {
    await input.api.removeReaction({ ...target, reactionId: entry.id });
  }
  return `撤销 reaction ${payload.content} ${String(mine.length)} 条（${where}，只删自己打的）`;
}

/** `create_issue`：指纹去重优先于配额（§5 第四行）。 */
async function runCreateIssue(
  payload: {
    readonly title: string;
    readonly body?: string | undefined;
    readonly labels?: readonly string[] | undefined;
    readonly fingerprint?: string | undefined;
  },
  input: ExecuteV21Input,
): Promise<string> {
  const labels = payload.labels ?? [];
  const fingerprint = payload.fingerprint ?? null;

  const decision =
    input.createIssueGuard === undefined
      ? 'create'
      : await input.createIssueGuard({
          repo: input.repo,
          issueNumber: input.issueNumber,
          title: payload.title,
          fingerprint,
          labels,
        });

  if (decision === 'duplicate') {
    // 重复不创建也不失败：去重命中是正常路径（同一个缺陷被反复报告）。
    return `指纹已存在，跳过创建（去重命中${fingerprint === null ? '' : `：${fingerprint}`}）`;
  }
  if (decision === 'quota') {
    throw new Error(`${ERROR_CREATE_ISSUE_QUOTA}: 今日新建 issue 配额已用尽，本条不执行`);
  }
  if (input.dryRun) {
    return `dry-run: 会新建 issue「${payload.title}」（labels ${String(labels.length)} 个）`;
  }
  const created = await input.api.createIssue({
    repo: input.repo,
    title: payload.title,
    body: payload.body ?? '',
    labels,
  });
  return `新建 issue #${String(created.number)}「${payload.title}」`;
}

/** `open_pr`：只允许 `bot/*` 分支（§5 第五行）。 */
async function runOpenPr(
  payload: { readonly branch: string; readonly title: string; readonly body?: string | undefined },
  input: ExecuteV21Input,
): Promise<string> {
  if (!/^bot\/[a-z0-9][a-z0-9._-]{1,60}$/u.test(payload.branch)) {
    throw new Error(`${ERROR_BRANCH_NOT_ALLOWED}: 分支必须是 bot/* 形式，收到 ${payload.branch}`);
  }
  // PR 正文里的 closing keyword 一律中和：`fixes #12` 会在 PR 合并时自动关 issue，
  // 而合不合并是人决定的 —— 模型一句话把「人肉合并」变成「自动关单」，等于绕过
  // 「关单只发生在 verdict=fail」这条闸门（§5 第六行）。
  const body = neutralizeClosingKeywords(payload.body ?? '');
  await assertRefsResolvable(body, input);
  if (input.dryRun) {
    return `dry-run: 会从 ${payload.branch} 开 PR「${payload.title}」`;
  }
  const created = await input.api.openPullRequest({
    repo: input.repo,
    head: payload.branch,
    title: payload.title,
    body,
  });
  return `从 ${payload.branch} 开 PR #${String(created.number)}`;
}

/**
 * `close_issue`：**只在 `verdict === 'fail'` 时允许**（§5 第六行）。
 *
 * 「不采信模型自评」的含义就在这里落地：模型说「已解决」不能关，
 * 只有它给出 `fail` 结论（= 确认问题仍然存在/无法处理）才允许关。
 * 这条判定看整份产出的顶层 `verdict`，不看 `close_issue` 动作自己的 payload。
 *
 * v2.2 起还多两件事：
 *  - `state_reason` 由产出给（缺省 `not_planned`，与 v2.0 的固定值逐字一致）；
 *  - `comment` 走**同一个槽位写回**（slot 固定 `close`）：与 `comment` 动作共用
 *    「同 issue 同槽位只保留一条」的语义，省掉一条会随触发次数增长的散评论。
 */
async function runCloseIssue(
  payload: {
    readonly state_reason?: 'completed' | 'not_planned' | 'duplicate' | undefined;
    readonly duplicate_of?: number | undefined;
    readonly comment?: string | undefined;
  },
  input: ExecuteV21Input,
): Promise<string> {
  if (input.output.verdict !== 'fail') {
    throw new Error(
      `${ERROR_CLOSE_WITHOUT_FAIL}: 只有顶层 verdict=fail 才允许关闭（当前 ${input.output.verdict ?? '缺省'}）`,
    );
  }
  const reason = payload.state_reason ?? 'not_planned';
  if (reason === 'duplicate' && payload.duplicate_of === undefined) {
    // 契约（`semanticIssuesOf`）已经挡过一遍；这里再挡是为了「不经校验直接调执行器」的路径。
    throw new Error(`${ERROR_CLOSE_INVALID}: state_reason=duplicate 必须给 duplicate_of（原 issue 的编号）`);
  }
  const reasonText =
    reason === 'duplicate'
      ? `reason=duplicate，duplicate_of=#${String(payload.duplicate_of ?? 0)}`
      : `reason=${reason}`;

  const parts: string[] = [];
  if (payload.comment !== undefined) {
    parts.push(await runComment({ slot: CLOSE_COMMENT_SLOT, body: payload.comment }, input));
  }
  if (input.dryRun) {
    parts.push(`dry-run: 会关闭该 issue（${reasonText}）`);
    return parts.join('；');
  }
  // 说明评论由 GitHub 层在 `reason=duplicate` 时补发（那里与 `link(duplicate)` 共用，
  // 执行器不再补一条 —— 两处都发就等于发两条）。
  await input.api.issueEdit.closeIssueWithReason({
    repo: input.repo,
    issueNumber: input.issueNumber,
    reason,
    ...(payload.duplicate_of === undefined ? {} : { duplicateOf: payload.duplicate_of }),
  });
  parts.push(`关闭 issue（${reasonText}）`);
  return parts.join('；');
}

/** `reopen_issue`：无参数，目标就是当前 issue。 */
async function runReopenIssue(input: ExecuteV21Input): Promise<string> {
  if (input.dryRun) {
    return 'dry-run: 会重新打开该 issue';
  }
  await input.api.issueEdit.reopenIssue({ repo: input.repo, issueNumber: input.issueNumber });
  return '重新打开 issue';
}

/**
 * `update_issue`：改标题 / 正文 / 指派人 / 里程碑。
 *
 * 乐观锁（`expected_updated_at`）是 GitHub 上唯一可行的并发检测手段：issue 的 PATCH
 * 没有 `If-Match`，两个人同时改正文就是静默覆盖。拿到期望值就先读一次 `updated_at` 比对，
 * 不等就整条失败（`update-conflict`），让模型重读再决定 —— 而不是把别人的改动盖掉。
 */
async function runUpdateIssue(
  payload: {
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly assignees?: readonly string[] | undefined;
    readonly milestone?: number | null | undefined;
    readonly expected_updated_at?: string | undefined;
  },
  input: ExecuteV21Input,
): Promise<string> {
  const fields: string[] = [];
  if (payload.title !== undefined) {
    fields.push('title');
  }
  if (payload.body !== undefined) {
    fields.push('body');
  }
  if (payload.assignees !== undefined) {
    fields.push('assignees');
  }
  if (payload.milestone !== undefined) {
    fields.push(payload.milestone === null ? 'milestone=清空' : 'milestone');
  }
  if (fields.length === 0) {
    throw new Error(`${ERROR_UPDATE_EMPTY}: 至少要改一个字段（title / body / assignees / milestone）`);
  }

  const expected = payload.expected_updated_at?.trim();
  if (expected !== undefined && expected !== '') {
    const current = (
      await input.api.issueEdit.getIssueUpdatedAt({
        repo: input.repo,
        issueNumber: input.issueNumber,
      })
    ).trim();
    if (current !== expected) {
      throw new Error(
        `${ERROR_UPDATE_CONFLICT}: issue 在读取之后被改过（当前 updated_at=${current === '' ? '未知' : current}），请重读后再改`,
      );
    }
  }

  if (payload.body !== undefined) {
    await assertRefsResolvable(payload.body, input);
  }

  if (input.dryRun) {
    return `dry-run: 会更新 issue 字段 [${fields.join(', ')}]`;
  }
  // 只传给了的字段：`milestone: null` 是「清空」，所以只判 `undefined`。
  const updated = await input.api.issueEdit.updateIssue({
    repo: input.repo,
    issueNumber: input.issueNumber,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    ...(payload.body === undefined ? {} : { body: payload.body }),
    ...(payload.assignees === undefined ? {} : { assignees: payload.assignees }),
    ...(payload.milestone === undefined ? {} : { milestone: payload.milestone }),
  });
  return `更新 issue 字段 [${fields.join(', ')}]（updated_at=${updated.updatedAt === '' ? '未知' : updated.updatedAt}）`;
}

/** `update_comment`：只改自己写过的评论（归属由 `requireOwnComment()` 判）。 */
async function runUpdateComment(
  payload: { readonly comment_id: number; readonly body: string },
  input: ExecuteV21Input,
): Promise<string> {
  await requireOwnComment(payload.comment_id, input);
  if (input.dryRun) {
    return `dry-run: 会改写评论 ${String(payload.comment_id)}`;
  }
  const ref = await input.api.updateIssueComment({
    repo: input.repo,
    commentId: payload.comment_id,
    body: payload.body,
  });
  return `改写评论 ${String(ref.id)}`;
}

/** `delete_comment`：同样只删自己写过的（删完不留痕，所以归属判定必须先做）。 */
async function runDeleteComment(
  payload: { readonly comment_id: number },
  input: ExecuteV21Input,
): Promise<string> {
  await requireOwnComment(payload.comment_id, input);
  if (input.dryRun) {
    return `dry-run: 会删除评论 ${String(payload.comment_id)}`;
  }
  await input.api.issueEdit.deleteIssueComment({ repo: input.repo, commentId: payload.comment_id });
  return `删除评论 ${String(payload.comment_id)}`;
}

/**
 * `link`：与另一个 issue / PR 的结构关系（v2.2）。
 *
 * 五种 relation 各落到不同的原生能力上：
 *  - `duplicate`：`state_reason=duplicate` 关单（指向原 issue 的说明评论由 GitHub 层发，
 *    执行器**不再补发**，否则同一个关系会出现两条）；
 *  - `relates`：GitHub 没有原生「相关」结构 → 一条带标记的评论（`buildLinkNote`）；
 *  - `blocked_by`：当前 issue 被 target 阻塞 → `addBlockedBy(issueNumber=当前, blockedByIssueId=target 的 id)`；
 *  - `blocks`：当前 issue 阻塞 target。GitHub 只有「谁被我阻塞」这一个写端点，
 *    所以要把语义反过来发：`addBlockedBy(issueNumber=target, blockedByIssueId=当前 的 id)`；
 *  - `parent`：当前 issue 成为 target 的子 issue → `addSubIssue(parentNumber=target, subIssueId=当前 的 id)`。
 *
 * `duplicate` 等价于关单，因此受 `close_issue` 开关约束（契约的 `gatedActionOf()` 已判）。
 * dry-run 一条写方法都不调：`getIssueId` 这类 GET 也跳过，预演只需要计划。
 */
async function runLink(
  payload: {
    readonly relation: 'duplicate' | 'blocks' | 'blocked_by' | 'parent' | 'relates';
    readonly target_number: number;
  },
  input: ExecuteV21Input,
): Promise<string> {
  const target = payload.target_number;
  if (input.dryRun) {
    return `dry-run: 会建立 ${payload.relation} 关联（目标 #${String(target)}）`;
  }
  switch (payload.relation) {
    case 'relates': {
      const ref = await input.api.createIssueComment({
        repo: input.repo,
        issueNumber: input.issueNumber,
        body: buildLinkNote({
          relation: 'relates',
          repo: input.repo,
          issueNumber: input.issueNumber,
          targetNumber: target,
        }),
      });
      return `写入关联评论（relates #${String(target)}，commentId=${String(ref.id)}）`;
    }
    case 'duplicate': {
      /*
        `duplicate` 就是关单，因此继承 `close_issue` 的那条前置条件（§5 第六行：
        只有顶层 `verdict=fail` 才允许关闭）。少了这一步，`close_issue` 的
        「不采信模型自评」就有一个等价后门：同样一件事换个动作名（link + duplicate）
        就能在 `verdict=pass` 的产出里把 issue 关掉。
      */
      if (input.output.verdict !== 'fail') {
        throw new Error(
          `${ERROR_CLOSE_WITHOUT_FAIL}: link(duplicate) 等价于关单，只有顶层 verdict=fail 才允许（当前 ${input.output.verdict ?? '缺省'}）`,
        );
      }
      await input.api.issueEdit.closeIssueWithReason({
        repo: input.repo,
        issueNumber: input.issueNumber,
        reason: 'duplicate',
        duplicateOf: target,
      });
      return `按重复关闭（duplicate_of=#${String(target)}）`;
    }
    case 'blocked_by': {
      const blockedByIssueId = await input.api.issueEdit.getIssueId({
        repo: input.repo,
        issueNumber: target,
      });
      await input.api.issueEdit.addBlockedBy({
        repo: input.repo,
        issueNumber: input.issueNumber,
        blockedByIssueId,
      });
      return `登记依赖：本 issue 被 #${String(target)} 阻塞`;
    }
    case 'blocks': {
      const ownId = await input.api.issueEdit.getIssueId({
        repo: input.repo,
        issueNumber: input.issueNumber,
      });
      await input.api.issueEdit.addBlockedBy({
        repo: input.repo,
        issueNumber: target,
        blockedByIssueId: ownId,
      });
      return `登记依赖：#${String(target)} 被本 issue 阻塞`;
    }
    case 'parent': {
      const ownId = await input.api.issueEdit.getIssueId({
        repo: input.repo,
        issueNumber: input.issueNumber,
      });
      await input.api.issueEdit.addSubIssue({
        repo: input.repo,
        parentNumber: target,
        subIssueId: ownId,
      });
      return `把本 issue 挂成 #${String(target)} 的子 issue`;
    }
  }
}

/* ── 5. 真实装配：既有 GitHub 面 → 端口 ─────────────────────────────────── */

/** `createV21PortFromGithub()` 的入参（每个能力单独注入，缺谁就只在用到时失败）。 */
export type V21PortSources = {
  readonly write: {
    listIssueComments(input: { readonly repo: string; readonly issueNumber: number }): Promise<readonly SlotComment[]>;
    createIssueComment(input: {
      readonly repo: string;
      readonly issueNumber: number;
      readonly body: string;
    }): Promise<{ readonly id: number }>;
    updateIssueComment(input: {
      readonly repo: string;
      readonly commentId: number;
      readonly body: string;
    }): Promise<{ readonly id: number }>;
    addLabels(input: {
      readonly repo: string;
      readonly issueNumber: number;
      readonly labels: readonly string[];
    }): Promise<void>;
    removeLabel(input: {
      readonly repo: string;
      readonly issueNumber: number;
      readonly label: string;
    }): Promise<void>;
    createIssue(input: {
      readonly repo: string;
      readonly title: string;
      readonly body: string;
      readonly labels?: readonly string[];
    }): Promise<{ readonly number: number }>;
    closeIssue(input: {
      readonly repo: string;
      readonly issueNumber: number;
      readonly reason?: 'completed' | 'not_planned';
    }): Promise<void>;
  };
  readonly reactions?: {
    addReaction(input: V21ReactionTarget & { readonly content: string }): Promise<{ readonly id: number }>;
    listReactions(
      input: V21ReactionTarget & { readonly content: string; readonly perPage?: number },
    ): Promise<readonly V21ReactionEntry[]>;
    removeReaction(input: V21ReactionTarget & { readonly reactionId: number }): Promise<void>;
  } | undefined;
  /**
   * 开 PR 的能力。
   *
   * 单独注入而不是塞进写面：v2.1 之前没有任何代码路径会开 PR（`push_branch` 只交计划），
   * 所以这一层没有既有实现。装配层（WS6）用 `POST /repos/{owner}/{repo}/pulls` 接上即可；
   * 不给时 `open_pr` 动作会在调用点失败并留下明确原因（不是静默跳过）。
   */
  readonly openPullRequest?: ((input: {
    readonly repo: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<{ readonly number: number }>) | undefined;
  /** 判定「这个 login 是不是我」。缺省只看 `*[bot]` 结尾（GitHub App 的 login 形态）。 */
  readonly isOwn?: ((login: string | null) => boolean) | undefined;
  /**
   * issue 编辑面（`github/octokit.ts::createGithubIssueEditApi()`）。
   *
   * 与 `reactions` 同一个套路：单独一个可选能力组。不给时端口仍然是完整的对象，
   * 只是每个方法一被调用就抛「缺少能力 issueEdit.xxx」—— 用到才失败，
   * 不用（比如只跑 `label` / `comment`）的部署照常工作。
   */
  readonly issueEdit?: V21IssueEditPort | undefined;
};

/** 缺能力时抛的错误（消息里点名缺的是哪一项，便于装配排错）。 */
function missingCapability(name: string): Error {
  return new Error(`v2 执行端口缺少能力：${name}（装配层未注入）`);
}

/**
 * 把既有的 GitHub 写面 / reaction 面 / 开 PR 面拼成 `V21GithubPort`。
 *
 * 为什么用「有对象就直接转发、没有就在调用时抛」而不是在装配期校验：
 * 开关关闭时 `open_pr` 根本不会被调用，一个没接开 PR 能力的部署仍然可以跑
 * `comment` / `label` / `reaction`。装配期硬校验会让「用不到的能力」变成启动失败。
 */
export function createV21PortFromGithub(sources: V21PortSources): V21GithubPort {
  const isOwn =
    sources.isOwn ??
    ((login: string | null): boolean => login !== null && /\[bot\]$/u.test(login));

  /** 取 issue 编辑面；没注入就抛「缺 issueEdit.<method>」（错误消息用于装配排错）。 */
  const editOrThrow = (method: string): V21IssueEditPort => {
    const source = sources.issueEdit;
    if (source === undefined) {
      throw missingCapability(`issueEdit.${method}`);
    }
    return source;
  };

  return {
    listIssueComments: (input) => sources.write.listIssueComments(input),
    createIssueComment: (input) => sources.write.createIssueComment(input),
    updateIssueComment: (input) => sources.write.updateIssueComment(input),
    addLabels: (input) => sources.write.addLabels(input),
    removeLabel: (input) => sources.write.removeLabel(input),
    createIssue: (input) => sources.write.createIssue(input),
    closeIssue: (input) => sources.write.closeIssue(input),
    openPullRequest: async (input) => {
      const open = sources.openPullRequest;
      if (open === undefined) {
        throw missingCapability('openPullRequest');
      }
      return open(input);
    },
    listReactions: async (input) => {
      const reactions = sources.reactions;
      if (reactions === undefined) {
        throw missingCapability('reactions.listReactions');
      }
      return reactions.listReactions(input);
    },
    addReaction: async (input) => {
      const reactions = sources.reactions;
      if (reactions === undefined) {
        throw missingCapability('reactions.addReaction');
      }
      return reactions.addReaction(input);
    },
    removeReaction: async (input) => {
      const reactions = sources.reactions;
      if (reactions === undefined) {
        throw missingCapability('reactions.removeReaction');
      }
      return reactions.removeReaction(input);
    },
    /**
     * issue 编辑面：每个方法独立判「有没有注入」，错误消息点名缺的是哪一个
     * （`issueEdit.getIssueComment` 比一句 `undefined is not a function` 有用得多）。
     */
    issueEdit: {
      updateIssue: async (input) => editOrThrow('updateIssue').updateIssue(input),
      getIssueUpdatedAt: async (input) => editOrThrow('getIssueUpdatedAt').getIssueUpdatedAt(input),
      reopenIssue: async (input) => editOrThrow('reopenIssue').reopenIssue(input),
      closeIssueWithReason: async (input) => {
        const source = sources.issueEdit;
        if (source !== undefined) {
          return source.closeIssueWithReason(input);
        }
        // 没有 issueEdit 但写面本来就会关单（v2.0 的能力）：非 `duplicate` 的理由退回去用它，
        // 这样「只接写面的部署」跑 `close_issue` 不会因为缺新能力而失败（行为与 v2.0 一致）。
        // `duplicate` 必须由 issueEdit 发（要 `duplicate_of` 与说明评论），缺了就点名。
        if (input.reason !== 'duplicate') {
          return sources.write.closeIssue({
            repo: input.repo,
            issueNumber: input.issueNumber,
            reason: input.reason,
          });
        }
        throw missingCapability('issueEdit.closeIssueWithReason');
      },
      getIssueComment: async (input) => editOrThrow('getIssueComment').getIssueComment(input),
      deleteIssueComment: async (input) => editOrThrow('deleteIssueComment').deleteIssueComment(input),
      getIssueId: async (input) => editOrThrow('getIssueId').getIssueId(input),
      issueExists: async (input) => editOrThrow('issueExists').issueExists(input),
      addBlockedBy: async (input) => editOrThrow('addBlockedBy').addBlockedBy(input),
      addSubIssue: async (input) => editOrThrow('addSubIssue').addSubIssue(input),
    },
    isOwn,
  };
}
