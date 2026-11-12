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
import { GATED_ACTION_TYPES } from '../../../../../packages/envelope/src/index.ts';
import type { SlotComment } from './comments.ts';
import { buildSlotMarker, findSlotComment, planSlotWrite } from './comments.ts';
import type { CatalogEntry, LabelPlan } from './labels.ts';
import { deletionOwner, planLabelTargetState } from './labels.ts';

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

/** 三类受限动作在不在开关里（开关按 `GatedActionType` 索引）。 */
function gatedActionOf(action: OutputV21Action): GatedActionType | null {
  return (GATED_ACTION_TYPES as readonly string[]).includes(action.type)
    ? (action.type as GatedActionType)
    : null;
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
      return runCloseIssue(input);
  }
}

/* ── 4. 七类动作各自的行为 ───────────────────────────────────────────────── */

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
 */
async function runComment(
  payload: { readonly slot: string; readonly body: string },
  input: ExecuteV21Input,
): Promise<string> {
  const marker = buildSlotMarker({ repo: input.repo, issueNumber: input.issueNumber, slot: payload.slot });
  const slotTarget = { repo: input.repo, issueNumber: input.issueNumber, slot: payload.slot };

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
    body: payload.body,
    marker,
    historyCommentId,
  });

  if (input.dryRun) {
    return plan.op === 'update'
      ? `dry-run: 覆盖槽位 ${payload.slot}（commentId=${String(plan.commentId)}）`
      : `dry-run: 新建槽位 ${payload.slot}${plan.recreated ? '（原评论已不存在，重建）' : ''}`;
  }

  if (plan.op === 'update') {
    try {
      const ref = await input.api.updateIssueComment({
        repo: input.repo,
        commentId: plan.commentId,
        body: plan.body,
      });
      await putSlot(input, slotTarget, ref.id);
      return `覆盖槽位 ${payload.slot}（commentId=${String(ref.id)}）`;
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
      return `槽位 ${payload.slot} 的原评论已不存在，重建（commentId=${String(ref.id)}，${ERROR_SLOT_UNRESOLVED}）`;
    }
  }

  const ref = await input.api.createIssueComment({
    repo: input.repo,
    issueNumber: input.issueNumber,
    body: plan.body,
  });
  await putSlot(input, slotTarget, ref.id);
  return plan.recreated
    ? `槽位 ${payload.slot} 重建（commentId=${String(ref.id)}）`
    : `槽位 ${payload.slot} 首次写入（commentId=${String(ref.id)}）`;
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
  payload: { readonly op: 'add' | 'remove'; readonly content: string },
  input: ExecuteV21Input,
): Promise<string> {
  const target: V21ReactionTarget = { repo: input.repo, issueNumber: input.issueNumber };
  const listed = await input.api.listReactions({ ...target, content: payload.content });
  const mine = listed.filter((entry) => input.api.isOwn(entry.userLogin));

  if (payload.op === 'add') {
    if (mine.length > 0) {
      return `reaction ${payload.content} 已存在（自己打的），跳过`;
    }
    if (input.dryRun) {
      return `dry-run: 会添加 reaction ${payload.content}`;
    }
    const ref = await input.api.addReaction({ ...target, content: payload.content });
    return `添加 reaction ${payload.content}（id=${String(ref.id)}）`;
  }

  if (mine.length === 0) {
    throw new Error(`${ERROR_REACTION_MISSING}: 没有自己打的 ${payload.content} reaction 可撤销`);
  }
  if (input.dryRun) {
    return `dry-run: 会撤销 ${String(mine.length)} 条自己的 ${payload.content} reaction`;
  }
  for (const entry of mine) {
    await input.api.removeReaction({ ...target, reactionId: entry.id });
  }
  return `撤销 reaction ${payload.content} ${String(mine.length)} 条（只删自己打的）`;
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
  if (input.dryRun) {
    return `dry-run: 会从 ${payload.branch} 开 PR「${payload.title}」`;
  }
  const created = await input.api.openPullRequest({
    repo: input.repo,
    head: payload.branch,
    title: payload.title,
    body: payload.body ?? '',
  });
  return `从 ${payload.branch} 开 PR #${String(created.number)}`;
}

/**
 * `close_issue`：**只在 `verdict === 'fail'` 时允许**（§5 第六行）。
 *
 * 「不采信模型自评」的含义就在这里落地：模型说「已解决」不能关，
 * 只有它给出 `fail` 结论（= 确认问题仍然存在/无法处理）才允许关。
 * 这条判定不看 `close_issue` 动作自己的 payload（那里是空对象），
 * 只看整份产出的顶层 `verdict`。
 */
async function runCloseIssue(input: ExecuteV21Input): Promise<string> {
  if (input.output.verdict !== 'fail') {
    throw new Error(
      `${ERROR_CLOSE_WITHOUT_FAIL}: 只有顶层 verdict=fail 才允许关闭（当前 ${input.output.verdict ?? '缺省'}）`,
    );
  }
  if (input.dryRun) {
    return 'dry-run: 会关闭该 issue（reason=not_planned）';
  }
  await input.api.closeIssue({
    repo: input.repo,
    issueNumber: input.issueNumber,
    reason: 'not_planned',
  });
  return '关闭 issue（reason=not_planned）';
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
    isOwn,
  };
}
