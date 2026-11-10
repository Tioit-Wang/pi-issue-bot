/**
 * 写执行器骨架（B12；tech-plan §5.4「写执行器与幂等」、§5.6「写回闸门」、plan §6/§7）。
 *
 * 本文件的定位：**agent 只交信封，动作由控制面执行**。所以这里全是「判定 + 分派」的纯逻辑，
 * 每个有副作用的动作只通过**注入的 client 方法**（`GithubWriteApi`）发生，
 * 于是单测可以用假实现记录调用，绝不打网络。
 *
 * 动作的幂等策略（tech-plan §5.4 那张表，逐条落到函数）：
 *  - `comment`      → 隐藏标记 `<!-- pi-bot:<repo>#<target>:<intent>:<body-hash> -->`
 *                     （`buildMarker`/`findExisting`/`shouldPost`）。**只有人工通道**
 *                     （`@bot /命令`、`@bot 提问`：intent 是 `comment` / `fallback`）才靠标记去重；
 *                     打标 / 反馈类评论（`triage` / `compliance` …）不再发评论，万一被调用也只发正文、
 *                     不查重、不带标记（见 `usesMarkerDedupe()`）。
 *  - `label`        → 只增删 `bot_labels` 记过的标签（`planLabelDelta`）
 *  - `create_issue` → 去重键 `(repo, fingerprint)` + 日配额（`decideCreateIssue`）
 *  - `push_branch`  → 必须带 `paths: string[]`（`validatePushBranch`）；真实 push 归 `git/` owner
 *  - `open_pr`      → 只到 `bot/*` 分支（`validateOpenPr`）；真实开 PR 同上归 `git/` owner
 *  - `close_issue`  → **不在这里判定**：只接受外部传入的「确定性条件已满足」（`shouldCloseIssue`）
 *  - `reaction.add` / `reaction.remove` → 无感反馈（W2-D）。同 content 重复 POST 幂等，
 *                     所以加了就直接信任返回值；删只删自己打的（`pickOwnReactionIds`）
 *
 * 「没有合并权限」在代码层的落点：本文件与整个 `github/` 目录**没有任何合并动作**，
 * 连方法名都不存在。plan §7.1 的三层保险里，这一层是「代码层不存在」，
 * 另两层（分支保护、写操作审计对账）不在代码里。
 */
import { createHash } from 'node:crypto';
import type {
  CommentRef,
  GithubReactionApi,
  GithubWriteApi,
  IssueComment,
  ReactionContent,
  ReactionEntry,
} from './types.ts';
import { classifyGithubError, toGithubError } from './errors.ts';

/** 隐藏标记前缀（tech-plan §5.4）。 */
export const MARKER_PREFIX = 'pi-bot';

/** `bot/*` 分支前缀：永不 force push、永不改贡献者分支（plan §7）。 */
export const BOT_BRANCH_PREFIX = 'bot/';

/** `create_issue` 的日配额默认值（plan §6.3：10 个/仓库）。 */
export const DEFAULT_DAILY_ISSUE_QUOTA = 10;

/** 标记里 body-hash 的长度（sha256 hex 前 16 位）。 */
export const BODY_HASH_LENGTH = 16;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const INTENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MARKER_PATTERN_SOURCE =
  '<!--\\s*pi-bot:([\\w.-]+\\/[\\w.-]+)#(\\d+):([a-z0-9][a-z0-9._-]*):([0-9a-f]{16})\\s*-->';

/** 标记的四个构成要素（与技术无关的那三件事 + 正文字节）。 */
export type CommentMarker = {
  readonly repo: string;
  readonly target: number;
  readonly intent: string;
  readonly bodyHash: string;
};

/** `buildMarker()` 的入参。**刻意没有 taskId 字段**（理由见下方 `buildMarker` 注释）。 */
export type CommentMarkerInput = {
  readonly repo: string;
  readonly target: number;
  readonly intent: string;
  readonly body: string;
};

/**
 * 正文归一化：让「同一条意见」在字节层面可比。
 *
 * 做四件事：统一换行、去掉行尾空白、把 3 个以上连续换行压成 2 个、去掉首尾空白；
 * 另外**先剥掉已有的 pi-bot 标记**——否则「我们发出去的正文」再次进来时会带标记，
 * 归一化结果与原正文不同，同一个意见就会被判成新内容而重复发。
 *
 * 刻意不做的事：不改大小写、不删表情、不重排列表。
 * 归一化只该消除「渲染上不可见」的差异，任何语义改动都算「正文变了」。
 */
export function normalizeCommentBody(body: string): string {
  const withoutMarkers = body.replace(new RegExp(MARKER_PATTERN_SOURCE, 'g'), '');
  return withoutMarkers
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** 正文归一化后的 sha256 前 16 位（十六进制）。 */
export function hashCommentBody(body: string): string {
  return createHash('sha256')
    .update(normalizeCommentBody(body), 'utf8')
    .digest('hex')
    .slice(0, BODY_HASH_LENGTH);
}

/**
 * 生成隐藏标记。
 *
 * 格式：`<!-- pi-bot:<repo>#<target>:<intent>:<body-hash> -->`
 *
 * **为什么标记里没有 task id（tech-plan §5.4 的 F7）**：事件重算、`/retry`、超时重跑
 * 都会生成新的 taskId。带 task id 的标记在新任务里搜不到旧评论，于是同一条意见会被发第二遍。
 * 去重只该依赖「对谁说、说什么类型、说什么内容」这三件与任务实例无关的事。
 * 副作用是有意的：正文变了就是新评论（改稿不算重复），正文没变则永不重复。
 */
export function buildMarker(input: CommentMarkerInput): string {
  const repo = assertRepo(input.repo);
  const target = assertTarget(input.target);
  const intent = assertIntent(input.intent);
  const bodyHash = hashCommentBody(input.body);
  return `<!-- ${MARKER_PREFIX}:${repo}#${String(target)}:${intent}:${bodyHash} -->`;
}

/** 从任意正文里解析出所有 pi-bot 标记（`/api/audit` 与 reconcile 归因要用）。 */
export function parseMarkers(body: string): readonly CommentMarker[] {
  const pattern = new RegExp(MARKER_PATTERN_SOURCE, 'g');
  const found: CommentMarker[] = [];
  for (const matched of body.matchAll(pattern)) {
    const repo = matched[1];
    const target = matched[2];
    const intent = matched[3];
    const bodyHash = matched[4];
    if (repo === undefined || target === undefined || intent === undefined || bodyHash === undefined) {
      continue;
    }
    found.push({ repo, target: Number.parseInt(target, 10), intent, bodyHash });
  }
  return found;
}

/** 组合最终发出去的评论正文：正文 + 空行 + 标记。 */
export function composeCommentBody(body: string, marker: string): string {
  const trimmed = body.trim();
  return trimmed === '' ? marker : `${trimmed}\n\n${marker}`;
}

/** 在已注入的评论列表里按「target + intent + body-hash」找既有评论。 */
export function findExisting(
  input: CommentMarkerInput,
  comments: readonly IssueComment[],
): IssueComment | undefined {
  const marker = buildMarker(input);
  return comments.find((comment) => comment.body !== null && comment.body.includes(marker));
}

/** 幂等判定：没有同标记的评论才发。 */
export function shouldPost(
  input: CommentMarkerInput,
  comments: readonly IssueComment[],
): boolean {
  return findExisting(input, comments) === undefined;
}

/**
 * 靠隐藏标记去重的评论意图（**只有人工通道**）。
 *
 * 为什么要有这张表（`docs/impl-multi-repo.md` §0.4 / W2-D 第 4 条）：
 * 「打标 / 反馈」类评论已经整体退役 —— 自动通道只留 reaction + 标签，零评论。
 * 那些路径若还有残留调用，它们**不该**再依赖隐藏标记：标记的存在意义是
 * 「同一句人读的话不重复催第二次」，而已经不存在的话没有第二次可言。
 * 只有 `@bot /命令`、`@bot 提问` 的最终回答（intent `comment`）与兜底回答
 * （intent `fallback`）需要去重，且必须去重（重投 / `/retry` 会再来一遍）。
 */
export const MARKER_DEDUPE_INTENTS = ['comment', 'fallback'] as const;

/** 这个 intent 是否靠隐藏标记去重（不在表里 → 直接发正文、不查重、不带标记）。 */
export function usesMarkerDedupe(intent: string): boolean {
  return (MARKER_DEDUPE_INTENTS as readonly string[]).includes(intent);
}

/** `comment` 动作的判定结果。 */
export type CommentDecision =
  | { readonly action: 'post'; readonly marker: string; readonly body: string }
  | { readonly action: 'skip'; readonly marker: string; readonly existingCommentId: number };

/** 纯判定：给定既有评论，返回「发 or 跳过」。 */
export function planComment(
  input: CommentMarkerInput,
  comments: readonly IssueComment[],
): CommentDecision {
  const marker = buildMarker(input);
  const existing = findExisting(input, comments);
  if (existing === undefined) {
    return { action: 'post', marker, body: composeCommentBody(input.body, marker) };
  }
  return { action: 'skip', marker, existingCommentId: existing.id };
}

/** `comment` 动作的执行结果。 */
export type CommentOutcome = {
  readonly action: 'posted' | 'skipped';
  /** 发出去的隐藏标记；`dedupe: 'none'` 时是空串（没写标记）。 */
  readonly marker: string;
  readonly commentId: number | null;
  /** 去重方式：`marker` = 人工通道（隐藏标记），`none` = 打标/反馈类（不去重）。 */
  readonly dedupe: 'marker' | 'none';
};

/**
 * 执行 `comment`。
 *
 * 两种形态，按 `usesMarkerDedupe()` 分：
 *  1. **人工通道**（`comment` / `fallback`）：「先查再写」——GitHub 的评论接口没有幂等键，
 *     重复发的后果是用户看到两遍同样的话（plan §6.2「同一句话不催第二次」）；
 *  2. **其它 intent**（打标 / 反馈类）：直接发正文，**不列评论、不加标记**
 *     （W2-D 第 4 条：这类评论不再存在，万一残留调用也不该把标记当幂等键）。
 */
export async function executeComment(
  api: GithubWriteApi,
  input: CommentMarkerInput,
): Promise<CommentOutcome> {
  if (!usesMarkerDedupe(input.intent)) {
    const plain = await api.createIssueComment({
      repo: input.repo,
      issueNumber: input.target,
      body: input.body.trim(),
    });
    return { action: 'posted', marker: '', commentId: plain.id, dedupe: 'none' };
  }
  const comments = await api.listIssueComments({ repo: input.repo, issueNumber: input.target });
  const decision = planComment(input, comments);
  if (decision.action === 'skip') {
    return {
      action: 'skipped',
      marker: decision.marker,
      commentId: decision.existingCommentId,
      dedupe: 'marker',
    };
  }
  const created = await api.createIssueComment({
    repo: input.repo,
    issueNumber: input.target,
    body: decision.body,
  });
  return { action: 'posted', marker: decision.marker, commentId: created.id, dedupe: 'marker' };
}

/** 标签增删计划：只碰自己打过的（plan §6.1）。 */
export type LabelDelta = {
  /** 需要新增的标签（desired 有、当前没有）。 */
  readonly add: readonly string[];
  /** 需要移除的标签（当前有、desired 没有、且是 bot 打过的）。 */
  readonly remove: readonly string[];
  /** 当前有、desired 没有、但不是 bot 打的 → **不动**（人打的标签）。 */
  readonly retainHumanOwned: readonly string[];
};

/**
 * 算出标签差集。
 *
 * 三条规则，对应 plan §6.1「只增删自己打过的标签，人打过的不动」：
 *  1. `desired` 里有、当前没有 → 加（不管是谁删的，用户想让它存在）；
 *  2. `desired` 里没有、当前有、且在 `botLabels` 里 → 删（这是我们打的，可以撤）；
 *  3. `desired` 里没有、当前有、且**不在** `botLabels` 里 → 留下并报出来（人打的）。
 *
 * 比较用的是标签名的精确匹配（GitHub 标签名区分大小写展示，但实际去重不分大小写；
 * 这里与 `.github/pi-bot.yml` 里的字面量保持一致，不做大小写折叠）。
 */
export function planLabelDelta(
  current: readonly string[],
  botLabels: readonly string[],
  desired: readonly string[],
): LabelDelta {
  const currentSet = new Set(current);
  const botSet = new Set(botLabels);
  const desiredSet = new Set(desired);

  const add = [...desiredSet].filter((label) => !currentSet.has(label)).sort();
  const remove = [...currentSet]
    .filter((label) => !desiredSet.has(label) && botSet.has(label))
    .sort();
  const retainHumanOwned = [...currentSet]
    .filter((label) => !desiredSet.has(label) && !botSet.has(label))
    .sort();

  return { add, remove, retainHumanOwned };
}

/**
 * `bot_labels` 表的写入面（tech-plan §7.2 的 `bot_labels`）。
 *
 * 本层不碰数据库：`bot_labels` 的 owner 是 db session。执行器只负责「按计划调用它」，
 * 于是「我们打过哪些标签」这件事有唯一事实源，而不是靠读 issue 现状反推。
 */
export type BotLabelLedger = {
  recordApplied(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly labels: readonly string[];
  }): void | Promise<void>;
  recordRemoved(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly labels: readonly string[];
  }): void | Promise<void>;
};

/** `label` 动作的执行结果。 */
export type LabelOutcome = {
  readonly delta: LabelDelta;
  readonly added: readonly string[];
  readonly removed: readonly string[];
};

/** 执行标签计划：先加后删，成功才记账。 */
export async function executeLabelPlan(
  api: GithubWriteApi,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly current: readonly string[];
    readonly botLabels: readonly string[];
    readonly desired: readonly string[];
  },
  ledger?: BotLabelLedger,
): Promise<LabelOutcome> {
  const delta = planLabelDelta(input.current, input.botLabels, input.desired);

  if (delta.add.length > 0) {
    await api.addLabels({
      repo: input.repo,
      issueNumber: input.issueNumber,
      labels: delta.add,
    });
    await ledger?.recordApplied({
      repo: input.repo,
      issueNumber: input.issueNumber,
      labels: delta.add,
    });
  }

  const removed: string[] = [];
  for (const label of delta.remove) {
    await api.removeLabel({ repo: input.repo, issueNumber: input.issueNumber, label });
    removed.push(label);
  }
  if (removed.length > 0) {
    await ledger?.recordRemoved({
      repo: input.repo,
      issueNumber: input.issueNumber,
      labels: removed,
    });
  }

  return { delta, added: delta.add, removed };
}

/** `create_issue` 的三态判定（plan §6.3）。 */
export type CreateIssueDecisionAction = 'create' | 'comment_only' | 'quota_exceeded';

/** `create_issue` 的判定结果。 */
export type CreateIssueDecision = {
  readonly action: CreateIssueDecisionAction;
  readonly reason: string;
};

/** `create_issue` 的判定入参（三个事实都由调用方查库后传入）。 */
export type CreateIssueDecisionInput = {
  readonly repo: string;
  readonly fingerprint: string;
  /** `issue_fingerprints` 里是否已有 `(repo, fingerprint)`。 */
  readonly fingerprintKnown: boolean;
  /** 该仓库「今天已创建」的 issue 数（按自然日，UTC 由调用方决定）。 */
  readonly createdToday: number;
  /** 日配额；默认 10（plan §6.3）。 */
  readonly dailyQuota?: number;
};

/**
 * 判定「新建 / 只追加评论 / 超配额写待办」。
 *
 * 顺序有意为之：**去重优先于配额**。命中指纹说明「这个问题已经有一个 issue 了」，
 * 此时追加评论是正确的动作，与今天的配额无关；如果把配额判在前面，
 * 同一个问题在配额用尽当天会被静默吞掉。
 */
export function decideCreateIssue(input: CreateIssueDecisionInput): CreateIssueDecision {
  if (input.fingerprint.trim() === '') {
    throw new Error('create_issue: fingerprint 不能为空（去重键 (repo, fingerprint) 是唯一防线）');
  }
  const quota = input.dailyQuota ?? DEFAULT_DAILY_ISSUE_QUOTA;

  if (input.fingerprintKnown) {
    return {
      action: 'comment_only',
      reason: `去重键 (${input.repo}, ${input.fingerprint}) 已命中 issue_fingerprints：追加评论而不新开（plan §6.3）`,
    };
  }
  if (input.createdToday >= quota) {
    return {
      action: 'quota_exceeded',
      reason: `该仓库今日已创建 ${String(input.createdToday)} 个 issue，达到配额 ${String(quota)}：写入待办队列而不创建（plan §6.3）`,
    };
  }
  return {
    action: 'create',
    reason: `去重键未命中且今日配额未满（${String(input.createdToday)}/${String(quota)}）：新建 issue`,
  };
}

/** `create_issue` 的执行结果。 */
export type CreateIssueOutcome = {
  readonly decision: CreateIssueDecision;
  readonly issueNumber: number | null;
  readonly commentedOn: number | null;
};

/**
 * 执行 `create_issue`。
 *
 * 三种结果分别对应：真建了 / 在既有 issue 上追加了评论 / 什么都没做（配额）。
 * 配额耗尽时**不抛错**——它是正常业务状态，调用方据此写待办队列。
 *
 * 指纹落表（`issue_fingerprints`）由调用方在「create 成功」后写：
 * 本层拿不到事务边界，写早了会留下假去重（见 tech-plan §7.2 的 UPSERT 说明）。
 */
export async function executeCreateIssue(
  api: GithubWriteApi,
  input: CreateIssueDecisionInput & {
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
    /** 命中指纹时，要在哪个既有 issue 上追加评论（由调用方查 `issue_fingerprints` 得到）。 */
    readonly existingIssueNumber?: number | undefined;
  },
): Promise<CreateIssueOutcome> {
  const decision = decideCreateIssue(input);

  if (decision.action === 'create') {
    const created = await api.createIssue({
      repo: input.repo,
      title: input.title,
      body: input.body,
      ...(input.labels === undefined ? {} : { labels: [...input.labels] }),
    });
    return { decision, issueNumber: created.number, commentedOn: null };
  }

  if (decision.action === 'comment_only' && input.existingIssueNumber !== undefined) {
    await api.createIssueComment({
      repo: input.repo,
      issueNumber: input.existingIssueNumber,
      body: input.body,
    });
    return { decision, issueNumber: null, commentedOn: input.existingIssueNumber };
  }

  return { decision, issueNumber: null, commentedOn: null };
}

/** 动作合规性判定结果。 */
export type ActionCompliance = {
  readonly compliant: boolean;
  readonly reasons: readonly string[];
};

/** `push_branch` 的判定入参（tech-plan §5.6 的对信封补充）。 */
export type PushBranchInput = {
  readonly repo: string;
  readonly branch: string;
  readonly paths: readonly string[];
};

const UNSAFE_PATH_PREFIXES = ['/', '\\', '~'];

/**
 * 校验 `push_branch` 动作。
 *
 * 硬性要求（tech-plan §5.6 最后一段）：`paths: string[]` **必须存在且非空**，
 * 否则该动作判为不合规、直接丢弃。理由：写回闸门是 `declared ∩ actual`，
 * 没有 `declared` 就只剩「容器里磁盘上变了什么」，那正是 F2 要堵的口子。
 *
 * 另外三条属于同一个闸门的静态部分（不通过就整次写回失败，不是跳过那个文件）：
 *  - 路径不能是绝对路径或 `~` 开头（不能指到仓库外）；
 *  - 路径不能含 `..` 段（不能借相对路径逃出仓库根）；
 *  - 分支必须 `bot/` 开头（plan §7：永不改写贡献者分支）。
 *
 * 这里的校验只保证「声明的形状正确」；「磁盘上到底变了什么」必须由 `git/` owner
 * 用 `git status --porcelain` 现场算，声明不能代替实际（tech-plan §5.6 的反面教材）。
 */
export function validatePushBranch(input: PushBranchInput): ActionCompliance {
  const reasons: string[] = [];

  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    reasons.push('push_branch 必须声明非空的 paths: string[]（tech-plan §5.6），missing paths → 判为不合规');
  } else {
    for (const path of input.paths) {
      if (typeof path !== 'string' || path.trim() === '') {
        reasons.push('paths 里存在空路径或非字符串项');
        continue;
      }
      if (UNSAFE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        reasons.push(`paths 里存在绝对路径：${path}`);
      }
      if (path.split(/[\\/]/u).includes('..')) {
        reasons.push(`paths 里存在 ".." 段：${path}`);
      }
      if (path.includes('\u0000')) {
        reasons.push('paths 里存在 NUL 字符');
      }
    }
  }

  if (!isBotBranch(input.branch)) {
    reasons.push(`分支必须 ${BOT_BRANCH_PREFIX} 开头（plan §7：只到 bot/* 分支），收到：${input.branch}`);
  }

  return { compliant: reasons.length === 0, reasons };
}

/** `open_pr` 的判定入参。 */
export type OpenPrInput = {
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
};

/** 校验 `open_pr`：head 必须是 `bot/*` 分支，base 不能等于 head。 */
export function validateOpenPr(input: OpenPrInput): ActionCompliance {
  const reasons: string[] = [];
  if (!isBotBranch(input.head)) {
    reasons.push(`open_pr 的 head 必须是 ${BOT_BRANCH_PREFIX} 分支，收到：${input.head}`);
  }
  if (input.base.trim() === '') {
    reasons.push('open_pr 的 base 不能为空');
  }
  if (input.base === input.head) {
    reasons.push('open_pr 的 head 与 base 不能相同');
  }
  if (input.title.trim() === '') {
    reasons.push('open_pr 的 title 不能为空');
  }
  return { compliant: reasons.length === 0, reasons };
}

/**
 * `push_branch` / `open_pr` 的分派结果：**本层不执行**，只交出「交给谁」。
 *
 * 真实 push 与开 PR 属于 `apps/server/src/git/**`（W4 / session N）的写回闸门：
 * 那里才有 worktree、临时 index、`declared ∩ actual`、拒收清单。
 * 本层若自己 `git push`，写回闸门就被绕过了（tech-plan §5.6 的整段理由）。
 *
 * TODO(owner: git/ 写回闸门 session)：接住这里的 plan，执行 §5.6 的临时 index 流程。
 */
export type DelegatedPlan =
  | {
      readonly kind: 'push_branch';
      readonly owner: 'git';
      readonly repo: string;
      readonly branch: string;
      readonly declaredPaths: readonly string[];
      readonly compliance: ActionCompliance;
    }
  | {
      readonly kind: 'open_pr';
      readonly owner: 'git';
      readonly repo: string;
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly compliance: ActionCompliance;
    };

/** 把 `push_branch` 变成交给 `git/` owner 的计划（不合规也返回，`compliance` 里说明原因）。 */
export function planPushBranch(input: PushBranchInput): DelegatedPlan {
  return {
    kind: 'push_branch',
    owner: 'git',
    repo: input.repo,
    branch: input.branch,
    declaredPaths: [...(input.paths ?? [])],
    compliance: validatePushBranch(input),
  };
}

/** 把 `open_pr` 变成交给 `git/` owner 的计划。 */
export function planOpenPr(input: OpenPrInput): DelegatedPlan {
  return {
    kind: 'open_pr',
    owner: 'git',
    repo: input.repo,
    head: input.head,
    base: input.base,
    title: input.title,
    compliance: validateOpenPr(input),
  };
}

/**
 * `close_issue` 的判定入参。
 *
 * **边界（tech-plan §7.2 最后一段）**：关闭判定唯一的事实源是 `issue_states` 表
 * （`needs-info` 在标签里 ∧ `missing_set_hash IS NOT NULL` ∧ `first_seen_at` 超过 48h
 * ∧ 之后无人工回复 ∧ `closed_at IS NULL`）。那段 SQL 归数据库 owner，
 * 本层**不重算、不查任何 GitHub 请求、不看 `actions` 历史**——只接一个布尔值。
 *
 * 为什么把判定压在外面：关闭是 plan 里唯一不可回收的自动动作，判定链越短越好核。
 * 如果执行器自己再判一遍，就会出现两份「真相」，两处不一致时无法判断谁对。
 */
export type CloseIssueInput = {
  readonly repo: string;
  readonly issueNumber: number;
  /** 由 `issue_states` 侧算好并传入；本层不重新计算。 */
  readonly deterministicConditionSatisfied: boolean;
  readonly reason?: 'completed' | 'not_planned' | undefined;
};

/** `close_issue` 的判定结果。 */
export type CloseIssueDecision =
  | { readonly action: 'close'; readonly reason: string }
  | { readonly action: 'skip'; readonly reason: string };

/** 纯判定：条件不成立就什么都不做（dev-plan §6 M4「关闭路径不误触发」）。 */
export function decideCloseIssue(input: CloseIssueInput): CloseIssueDecision {
  if (!input.deterministicConditionSatisfied) {
    return {
      action: 'skip',
      reason: 'issue_states 的确定性条件未满足：不关闭（plan §7 的关闭是唯一不可回收的自动动作）',
    };
  }
  return {
    action: 'close',
    reason: 'issue_states 的确定性条件已满足（needs-info + 缺失项 48h 未变 + 无人工回复）：关闭',
  };
}

/** 执行关闭：条件不成立时**不发任何请求**。 */
export async function executeCloseIssue(
  api: GithubWriteApi,
  input: CloseIssueInput,
): Promise<CloseIssueDecision> {
  const decision = decideCloseIssue(input);
  if (decision.action === 'skip') {
    return decision;
  }
  await api.closeIssue({
    repo: input.repo,
    issueNumber: input.issueNumber,
    reason: input.reason ?? 'not_planned',
  });
  return decision;
}

/* reaction：无感反馈的判定与执行（W2-D）。 */

/** 一次 reaction 请求（commentId 给了就打评论级，否则打主贴）。 */
export type ReactionRequest = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly content: ReactionContent;
  readonly commentId?: number | null;
};

/** reaction 动作的执行结果。 */
export type ReactionOutcome = {
  /** added = 加成功；removed = 删成功；skipped = 没有可删的（本来就没有自己的）。 */
  readonly action: 'added' | 'removed' | 'skipped';
  readonly content: ReactionContent;
  /** 加上去的 reaction id（added 时有值，落 issue_feedback.reaction_id）。 */
  readonly reactionId: number | null;
  /** 删掉的 reaction id 列表（终态先删 eyes 用的）。 */
  readonly removed: readonly number[];
  readonly reason: string;
};

/**
 * 这个 login 是不是「本 App 自己」。
 *
 * GitHub 把 App 身份显示成 `<slug>[bot]`，而 GET .../reactions 返回的 user.login
 * 就是这个串。判据取「以 [bot] 结尾」或「等于配置里的 App slug（含 [bot] 后缀）」：
 * 只认这两条，人打的 reaction 一条都不会被删。
 */
export function isOwnReactionLogin(
  login: string | null | undefined,
  appSlug?: string | null,
): boolean {
  if (login === null || login === undefined) {
    return false;
  }
  const lowered = login.trim().toLowerCase();
  if (lowered === '') {
    return false;
  }
  if (lowered.endsWith('[bot]')) {
    return true;
  }
  const slug = (appSlug ?? '').trim().toLowerCase();
  if (slug === '') {
    return false;
  }
  return lowered === slug || lowered === `${slug}[bot]`;
}

/** 从一次列表结果里挑出「自己打的」reaction id（删之前必须过这一层）。 */
export function pickOwnReactionIds(
  entries: readonly ReactionEntry[],
  appSlug?: string | null,
): readonly number[] {
  return entries
    .filter((entry) => isOwnReactionLogin(entry.userLogin, appSlug))
    .map((entry) => entry.id);
}

/**
 * 加一个 reaction。**不做「先查再写」**：同 content 重复 POST 是幂等的
 * （实测第一次 201、第二次 200，返回同一个 id），查一次只会多打一次 API。
 */
export async function executeAddReaction(
  api: GithubReactionApi,
  input: ReactionRequest,
): Promise<ReactionOutcome> {
  const ref = await api.addReaction({
    repo: input.repo,
    issueNumber: input.issueNumber,
    ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
    content: input.content,
  });
  return {
    action: 'added',
    content: input.content,
    reactionId: ref.id,
    removed: [],
    reason: `已打 ${input.content} reaction（id=${String(ref.id)}）`,
  };
}

/**
 * 删掉「自己打的」某个 content 的 reaction。
 *
 * 先 GET ...?content=&per_page=100 再按 user.login 过滤，只删自己的
 * （plan §5「只碰自己的 reaction」）。一条都没删到不算失败：幂等重跑时它本该不存在。
 */
export async function executeRemoveOwnReactions(
  api: GithubReactionApi,
  input: ReactionRequest & { readonly appSlug?: string | null },
): Promise<ReactionOutcome> {
  const entries = await api.listReactions({
    repo: input.repo,
    issueNumber: input.issueNumber,
    ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
    content: input.content,
    perPage: 100,
  });
  const own = pickOwnReactionIds(entries, input.appSlug);
  if (own.length === 0) {
    return {
      action: 'skipped',
      content: input.content,
      reactionId: null,
      removed: [],
      reason: `没有自己打的 ${input.content} reaction（列表 ${String(entries.length)} 条，都属他人）`,
    };
  }
  const removed: number[] = [];
  for (const reactionId of own) {
    await api.removeReaction({
      repo: input.repo,
      issueNumber: input.issueNumber,
      ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
      reactionId,
    });
    removed.push(reactionId);
  }
  return {
    action: 'removed',
    content: input.content,
    reactionId: null,
    removed,
    reason: `已删自己打的 ${input.content} reaction（${String(removed.length)} 条）`,
  };
}

/** 429 / 5xx / 网络抖动 → 值得再试一次（docs/impl-multi-repo.md W2-D 第 6 条）。 */
export function isTransientGithubFailure(info: {
  readonly status: number | null;
  readonly class: string;
}): boolean {
  if (info.status === 429) {
    return true;
  }
  if (info.status !== null && info.status >= 500) {
    return true;
  }
  return info.class === 'network';
}

/**
 * 有限重试：**最多 1 次**（attempts 默认 2 = 首次 + 1 次重试），只对 429/5xx/网络抖动生效。
 *
 * 为什么不再深入：reaction 是「无感反馈」，为它阻塞或重投整轮任务不值得。
 * 403（权限不足）**不重试**：那是 App 少了权限，重试多少次都一样，由调用方降级
 * （置 runtime_flags{key:'reactions_disabled'} 并留 actions(applied_at=null)）。
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: {
    readonly attempts?: number;
    readonly now?: () => number;
    readonly onRetry?: (info: { readonly status: number | null; readonly attempt: number }) => void;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const now = options.now ?? ((): number => Date.now());
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const info = classifyGithubError(error, now());
      if (
        attempt >= attempts ||
        !isTransientGithubFailure({ status: info.status, class: info.class })
      ) {
        throw toGithubError(error, now());
      }
      options.onRetry?.({ status: info.status, attempt });
    }
  }
  throw new Error('withTransientRetry: 不可达');
}
/**
 * 写回执：`actions` 表一行的最小内容（tech-plan §7.2 的 `actions`）。
 *
 * 由 worker 在动作执行后落库；本层只负责生成，不写库。
 */
export type ActionReceipt = {
  readonly intent: string;
  readonly repo: string;
  readonly target: number | null;
  readonly externalRef: string | null;
  readonly audit: Readonly<Record<string, unknown>>;
};

/** 动作分派：`writeAction` 的联合类型（对应信封里的动作白名单）。 */
export type WriteAction =
  | {
      readonly kind: 'comment';
      readonly repo: string;
      readonly target: number;
      readonly intent: string;
      readonly body: string;
    }
  | {
      readonly kind: 'label';
      readonly repo: string;
      readonly target: number;
      readonly current: readonly string[];
      readonly botLabels: readonly string[];
      readonly desired: readonly string[];
    }
  | {
      readonly kind: 'create_issue';
      readonly repo: string;
      readonly fingerprint: string;
      readonly fingerprintKnown: boolean;
      readonly createdToday: number;
      readonly dailyQuota?: number | undefined;
      readonly title: string;
      readonly body: string;
      readonly labels?: readonly string[] | undefined;
      readonly existingIssueNumber?: number | undefined;
    }
  | { readonly kind: 'push_branch'; readonly repo: string; readonly branch: string; readonly paths: readonly string[] }
  | { readonly kind: 'open_pr'; readonly repo: string; readonly head: string; readonly base: string; readonly title: string }
  | {
      readonly kind: 'close_issue';
      readonly repo: string;
      readonly target: number;
      readonly deterministicConditionSatisfied: boolean;
      readonly reason?: 'completed' | 'not_planned' | undefined;
    }
  | {
      readonly kind: 'reaction.add';
      readonly repo: string;
      readonly target: number;
      readonly content: ReactionContent;
      readonly commentId?: number | null | undefined;
    }
  | {
      readonly kind: 'reaction.remove';
      readonly repo: string;
      readonly target: number;
      readonly content: ReactionContent;
      readonly commentId?: number | null | undefined;
      readonly appSlug?: string | null | undefined;
    };

/** 分派结果：一类是「已执行的写操作」，一类是「交给 git/ owner 的计划」。 */
export type DispatchResult =
  | { readonly kind: 'comment'; readonly outcome: CommentOutcome }
  | { readonly kind: 'label'; readonly outcome: LabelOutcome }
  | { readonly kind: 'create_issue'; readonly outcome: CreateIssueOutcome }
  | { readonly kind: 'close_issue'; readonly decision: CloseIssueDecision }
  | { readonly kind: 'reaction'; readonly outcome: ReactionOutcome }
  | { readonly kind: 'delegated'; readonly plan: DelegatedPlan };

/**
 * 把动作分派到具体执行路径。
 *
 * `push_branch` / `open_pr` 只产出委托计划，**不执行**（见 `DelegatedPlan` 的说明）；
 * `close_issue` 只接受外部判定结果；`reaction.*` 走独立的 `reactions` 注入点。
 * 其余动作经注入的 `api` 执行。
 */
export async function dispatchWriteAction(
  action: WriteAction,
  deps: {
    readonly api: GithubWriteApi;
    readonly ledger?: BotLabelLedger | undefined;
    /** reaction 的写面（W2-D）；不注入时 `reaction.*` 明确失败，不静默跳过。 */
    readonly reactions?: GithubReactionApi | undefined;
  },
): Promise<DispatchResult> {
  switch (action.kind) {
    case 'comment': {
      const outcome = await executeComment(deps.api, {
        repo: action.repo,
        target: action.target,
        intent: action.intent,
        body: action.body,
      });
      return { kind: 'comment', outcome };
    }
    case 'label': {
      const outcome = await executeLabelPlan(
        deps.api,
        {
          repo: action.repo,
          issueNumber: action.target,
          current: action.current,
          botLabels: action.botLabels,
          desired: action.desired,
        },
        deps.ledger,
      );
      return { kind: 'label', outcome };
    }
    case 'create_issue': {
      const outcome = await executeCreateIssue(deps.api, action);
      return { kind: 'create_issue', outcome };
    }
    case 'push_branch': {
      return { kind: 'delegated', plan: planPushBranch(action) };
    }
    case 'open_pr': {
      return { kind: 'delegated', plan: planOpenPr(action) };
    }
    case 'close_issue': {
      const decision = await executeCloseIssue(deps.api, {
        repo: action.repo,
        issueNumber: action.target,
        deterministicConditionSatisfied: action.deterministicConditionSatisfied,
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      });
      return { kind: 'close_issue', decision };
    }
    case 'reaction.add': {
      const reactions = requireReactionApi(deps.reactions);
      const outcome = await executeAddReaction(reactions, {
        repo: action.repo,
        issueNumber: action.target,
        content: action.content,
        ...(action.commentId === undefined ? {} : { commentId: action.commentId }),
      });
      return { kind: 'reaction', outcome };
    }
    case 'reaction.remove': {
      const reactions = requireReactionApi(deps.reactions);
      const outcome = await executeRemoveOwnReactions(reactions, {
        repo: action.repo,
        issueNumber: action.target,
        content: action.content,
        ...(action.commentId === undefined ? {} : { commentId: action.commentId }),
        ...(action.appSlug === undefined ? {} : { appSlug: action.appSlug }),
      });
      return { kind: 'reaction', outcome };
    }
  }
}

/** 生成 `actions` 表的写回执（供 worker 落库；本层不写库）。 */
export function buildCommentReceipt(
  input: CommentMarkerInput,
  outcome: CommentOutcome,
): ActionReceipt {
  return {
    intent: 'comment',
    repo: input.repo,
    target: input.target,
    externalRef: outcome.commentId === null ? null : String(outcome.commentId),
    audit: {
      marker: outcome.marker,
      dedupeAction: outcome.action,
      intentName: input.intent,
      bodyHash: hashCommentBody(input.body),
    },
  };
}

/** 生成评论回执时用到的类型（对外导出，方便 worker 侧断言）。 */
export type CommentRefLike = CommentRef;

function assertRepo(repo: string): string {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`标记里的 repo 必须是 "owner/name" 形式，收到：${JSON.stringify(repo)}`);
  }
  return repo;
}

function assertTarget(target: number): number {
  if (!Number.isInteger(target) || target <= 0) {
    throw new Error(`标记里的 target 必须是正整数（issue/PR 号），收到：${JSON.stringify(target)}`);
  }
  return target;
}

function assertIntent(intent: string): string {
  if (!INTENT_PATTERN.test(intent)) {
    throw new Error(
      `标记里的 intent 只允许 [a-z0-9._-]，且不能以符号开头（':' 是分隔符），收到：${JSON.stringify(intent)}`,
    );
  }
  return intent;
}

function isBotBranch(branch: string): boolean {
  return branch.startsWith(BOT_BRANCH_PREFIX) && branch.length > BOT_BRANCH_PREFIX.length;
}

/** 取 reaction 写面：没注入就明确抛错（`writeback` 会把它转成 failed 信号并留痕）。 */
function requireReactionApi(api: GithubReactionApi | undefined): GithubReactionApi {
  if (api === undefined) {
    throw new Error('reaction 写面未注入（TaskRunnerDeps.feedback.reactions / GithubReactionApi）');
  }
  return api;
}
