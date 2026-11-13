/**
 * 事件判定（FR-2.1 ~ FR-2.5 / BR-6，接口见 `docs/v21-contract.md` §2）。
 *
 * 一个纯函数回答一个问题：**这次 webhook 该不该进会话；不该的话，原因是什么。**
 *
 * 为什么必须是纯函数（不查库、不读时钟、不写库）：
 *  - 「不触发也留痕」（BR-6）要求每条投递都有一条 `decision + decision_reason`。判定与落库分开，
 *    落库那侧（WS6）才能在同一个事务里既记判定又建任务，不会出现「记了触发但任务没建成」；
 *  - 面板的「这条评论会不会触发」预览、单测、线上必须是同一套分支顺序。
 *
 * **判定顺序是需求的一部分**（§2 / FR-2.4 优先级），不可调换：
 * 仓库可用 → 事件开关 → 事件附加条件 → 评论闸门 → 三层去重 → 日配额。
 * 顺序错了会产生误导性的留痕原因：例如开关关着却记成 `not-mentioned`，
 * 运维会跑去改关键词（真正的病因是开关）。
 */
import {
  DEFAULT_EVENT_TEMPLATES as CONTRACT_DEFAULT_EVENT_TEMPLATES,
  defaultEventTemplate as contractDefaultEventTemplate,
} from '../../../../packages/contract/src/index.ts';
import type { EventKey } from '../../../../packages/contract/src/index.ts';
import { resolveCommentConfig, resolveCommentGates, resolveEventTrigger } from '../config/v21-settings.ts';
import { findLegalMention } from './mention.ts';
import { matchCommentRole } from './roles.ts';

/* ── 1. 判定结果（严格按 §2 的联合类型） ────────────────────────────────────── */

/** 触发时的原因：`enabled` = 开关直接放行；`conditional-met` = 条件事件的条件已满足。 */
export type TriggeredReason = 'enabled' | 'conditional-met';

/** 未触发的原因（可直接写进 `webhook_deliveries.decision_reason`）。 */
export type SkippedReason =
  | 'switch-off'
  | 'body-unchanged'
  | 'label-not-matched'
  | 'not-mentioned'
  | 'role-denied'
  | 'bot-self'
  | 'closed-not-allowed'
  | 'pr-ignored'
  | 'content-duplicate'
  | 'daily-quota'
  | 'repo-disabled'
  /**
   * 验签失败（401）。
   *
   * 为什么必须与 `repo-disabled` 分开：两条路径都「不入队」，但病因完全不同——
   * 前者是仓库真的被停用，后者是 webhook secret 对不上（配置问题）。
   * 混成一个 reason 的后果是实测踩过的：issue #30 明明被 401 拒了，
   * 审计里写着 `repo-disabled`，而 `repos.enabled` 是 `true`，排查时白绕一圈。
   */
  | 'signature-invalid';

export type TriggeredDecision = {
  readonly triggered: true;
  readonly event: EventKey;
  /** 本次要发给 agent 的指令模板（项目配置优先，缺省用内置默认） */
  readonly template: string;
  readonly reason: TriggeredReason;
};

export type SkippedDecision = {
  readonly triggered: false;
  readonly event: EventKey | 'pull_request.*';
  readonly reason: SkippedReason;
};

export type TriggerDecision = TriggeredDecision | SkippedDecision;

/** PR 事件的判定常量：本期不处理（§0「不纳入」），收到即按未触发留痕。 */
export type PullRequestDecision = {
  readonly triggered: false;
  readonly event: 'pull_request.*';
  readonly reason: 'pr-ignored';
};

/* ── 2. 内置默认模板（已下沉到契约） ──────────────────────────────────────── */

/**
 * 内置默认模板：**定义已下沉到契约**（`packages/contract/src/settings-v21.ts`）。
 *
 * 面板要把同一份填进输入框、服务端用它渲染，两处各写一份就会出现「看到 A、实际发 B」；
 * 这里只做再导出。四段顺序（技能触发词 / `#编号` / 链接 / 正文快照）由契约保证。
 */
export const DEFAULT_EVENT_TEMPLATES: Readonly<Record<EventKey, string>> = CONTRACT_DEFAULT_EVENT_TEMPLATES;

/** 取某事件的内置默认模板（面板「恢复默认模板」与测试共用）。 */
export function getDefaultEventTemplate(event: EventKey): string {
  return contractDefaultEventTemplate(event);
}

/* ── 3. 判定入参 ───────────────────────────────────────────────────────────── */

/** 评论载荷里判定需要的最小信息（与 GitHub 的 comment 对象无关，便于单测构造）。 */
export type DecideComment = {
  readonly body: string;
  readonly authorAssociation: string | null;
  readonly authorLogin: string | null;
};

export type DecideEventInput = {
  readonly event: EventKey;
  /** `opened` / `edited` / `labeled` / `closed` / `created`（随判定一起留痕，判定本身不看它） */
  readonly action: string;
  /** 原始 `repos.settings`（解析失败由 `resolve*` 兜默认值，这里不重复校验） */
  readonly settings: unknown;
  /** `issues.edited`：GitHub payload 的 `changes` 键（`['body']` / `['title','body']`） */
  readonly changedFields?: readonly string[] | undefined;
  /** `issues.labeled`：本次新增的标签名 */
  readonly addedLabel?: string | null | undefined;
  /** issue 当前状态（评论闸门的 `allow_closed` 要它） */
  readonly issueState?: 'open' | 'closed' | null | undefined;
  /** 评论人是不是机器人（`ignore_bot` 闸门要它；由 webhook 侧按 `user.type === 'Bot'` 判断） */
  readonly actorIsBot?: boolean | undefined;
  /** 评论载荷（仅 `issue_comment.created` 使用） */
  readonly comment?: DecideComment | null | undefined;
  /** 上游三层去重的结果：已判定为重复内容 */
  readonly contentDuplicate?: boolean | undefined;
  /** 项目当日配额已用尽 */
  readonly dailyQuotaExceeded?: boolean | undefined;
  /** 仓库不可用（配置非法 / 已停用 / 无权访问） */
  readonly repoDisabled?: boolean | undefined;
  /** 验签失败（401）：与 `repoDisabled` 分开记，病因是 secret 对不上而非仓库停用 */
  readonly signatureInvalid?: boolean | undefined;
};

/* ── 4. 判定 ──────────────────────────────────────────────────────────────── */

function skip(event: EventKey, reason: SkippedReason): SkippedDecision {
  return { triggered: false, event, reason };
}

/**
 * 事件附加条件（开关之后的第二道）。
 *
 * 只有两个事件有条件：
 * - `issues.edited`：`only_body_changed` 打开时，`changes` 里没有 `body` 就算「只改了标题/标签」，
 *   不触发（FR-2.1）。载荷没给 `changes` 时**按未变更处理**——不知道就别干活，
 *   比重复跑一轮格式评审更安全。
 * - `issues.labeled`：只有命中所配标签才触发；`labels` 为空数组 = 永不触发（§1 默认值表）。
 */
function checkEventCondition(
  input: DecideEventInput,
  trigger: { readonly labels: readonly string[]; readonly onlyBodyChanged: boolean },
): SkippedDecision | null {
  if (input.event === 'issues.edited') {
    if (trigger.onlyBodyChanged) {
      const changed = input.changedFields ?? [];
      if (!changed.includes('body')) {
        return skip(input.event, 'body-unchanged');
      }
    }
    return null;
  }
  if (input.event === 'issues.labeled') {
    const added = input.addedLabel ?? null;
    if (added === null || added.trim() === '') {
      return skip(input.event, 'label-not-matched');
    }
    const wanted = added.trim().toLowerCase();
    const matched = trigger.labels.some((label) => label.trim().toLowerCase() === wanted);
    return matched ? null : skip(input.event, 'label-not-matched');
  }
  return null;
}

/**
 * 评论闸门（FR-2.4）：四个闸门按固定顺序判，先命中先返回。
 *
 * 顺序理由：`ignore_bot` 与 `allow_closed` 是**环境性**拒绝（谁 @ 都没用），
 * 放在 `require_mention` / `require_role` 之前，留痕原因才指向真正的病因
 * （否则机器人自己在已关闭 issue 下的评论会被记成 `not-mentioned`）。
 */
function checkCommentGates(input: DecideEventInput): SkippedDecision | null {
  const gates = resolveCommentGates(input.settings);
  if (gates.ignore_bot && input.actorIsBot === true) {
    return skip(input.event, 'bot-self');
  }
  if (!gates.allow_closed && input.issueState === 'closed') {
    return skip(input.event, 'closed-not-allowed');
  }
  if (gates.require_mention) {
    const { mentions } = resolveCommentConfig(input.settings);
    const body = input.comment?.body ?? '';
    if (findLegalMention(body, mentions) === null) {
      return skip(input.event, 'not-mentioned');
    }
  }
  if (gates.require_role) {
    const { roles } = resolveCommentConfig(input.settings);
    const match = matchCommentRole({
      roles,
      allowRoles: gates.allow_roles,
      authorAssociation: input.comment?.authorAssociation ?? null,
      authorLogin: input.comment?.authorLogin ?? null,
    });
    if (!match.allowed) {
      return skip(input.event, 'role-denied');
    }
  }
  return null;
}

/**
 * 判定一次事件投递（§2 的完整顺序）。
 *
 * 返回的 `template` 只在 `triggered: true` 时给出：未触发时不该有模板，
 * 否则调用方很容易「反正有模板就发一条」把 BR-6 的留痕变成真实打扰。
 */
export function decideEvent(input: DecideEventInput): TriggerDecision {
  const { event } = input;

  /*
    ⓪ 验签失败（401）排在仓库可用性之前：这条投递压根没被信任，
    病因是「secret 对不上」，记成 `repo-disabled` 会让人去查仓库开关（实测踩过）。
  */
  if (input.signatureInvalid === true) {
    return skip(event, 'signature-invalid');
  }

  // ① 仓库可用性：配置非法 / 已停用 / 无权访问时，后面所有判定都没有意义。
  if (input.repoDisabled === true) {
    return skip(event, 'repo-disabled');
  }

  // ② 事件开关（FR-2.1）：`off` 直接不触发，**且闸门一律不生效**（FR-2.4 优先级）。
  const trigger = resolveEventTrigger(input.settings, event);
  if (trigger.enabled === 'off') {
    return skip(event, 'switch-off');
  }

  // ③ 事件附加条件（edited 的只认正文 / labeled 的标签命中）
  const conditionSkipped = checkEventCondition(input, trigger);
  if (conditionSkipped !== null) {
    return conditionSkipped;
  }

  // ④ 评论闸门（仅评论事件有）
  if (event === 'issue_comment.created') {
    const gateSkipped = checkCommentGates(input);
    if (gateSkipped !== null) {
      return gateSkipped;
    }
  }

  // ⑤ 三层去重（投递级由上游先挡；这里只接内容级结论）
  if (input.contentDuplicate === true) {
    return skip(event, 'content-duplicate');
  }

  // ⑥ 日配额
  if (input.dailyQuotaExceeded === true) {
    return skip(event, 'daily-quota');
  }

  // 配置模板为空串/空白 = 等同 `null`（用内置默认）：
  // 面板允许清空输入框，若把空串当成「发一条空指令」，agent 会在没有触发词的情况下瞎跑。
  const rawPrompt = trigger.prompt ?? '';
  const template = rawPrompt.trim() === '' ? DEFAULT_EVENT_TEMPLATES[event] : rawPrompt;

  return {
    triggered: true,
    event,
    template,
    reason: trigger.enabled === 'on' ? 'enabled' : 'conditional-met',
  };
}

/**
 * PR 事件的判定（§0「不纳入」/ FR-2.1 的 `pull_request.*` 一行）。
 *
 * 永远不触发，且**没有模板**：PR 属于另一个会话域，本期连留痕原因都固定为 `pr-ignored`，
 * 免得有人从「空白模板」推断出「配个模板就能处理 PR」。
 */
export function decidePullRequest(): PullRequestDecision {
  return { triggered: false, event: 'pull_request.*', reason: 'pr-ignored' };
}
