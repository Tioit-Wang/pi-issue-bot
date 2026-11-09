/**
 * 命令门禁（plan §6.4 / tech-plan §5.3 第 6 步、§7.2 的 F9）。
 *
 * 三件事，缺一件都会出问题：
 *
 * 1. **谁能触发**：`author_association ∈ {OWNER, MEMBER, COLLABORATOR}` 或 `commands.allow_users` 白名单。
 *    机器人账号（`user.type === 'Bot'`）**无论 association 一律忽略**——否则两个 bot 互相 @ 就是死循环。
 * 2. **同一 `head_sha` 重跑是空操作**：幂等键的 anchor 取 `head_sha`
 *    （`queue/idempotency.ts` 的 `anchorFor`），落到 `tasks.idempotency_key` 的唯一索引上。
 *    这里的判定是「已经处理过这个 sha 了就不入队」，与数据库那一层是同一条件的两次表达：
 *    内存这次判定负责**省掉一次回复**，唯一索引负责**兜住并发**。
 * 3. **10 秒应答**：不在这一层。它发生在 `http/webhook.ts` 入队成功之后（打 eyes reaction），
 *    因为门禁可能因为权限被拒——被拒的命令不该先给一个「已收到」再回「你没权限」。
 *
 * 这一层是纯函数：不读库、不发请求。`lastProcessedHeadSha` 由调用方查出来传进来。
 */
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';
import { buildIdempotencyKey } from '../queue/idempotency.ts';

/** 触发者。字段都来自 webhook payload，一律当不可信输入。 */
export type CommandActor = {
  readonly login: string;
  /** GitHub 的 `user.type`：`Bot` / `User`。 */
  readonly type?: string | null;
  /** `comment.author_association`（或 issue 的 `author_association`）。 */
  readonly authorAssociation: string;
};

export type CommandGateInput = {
  readonly repo: string;
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly actor: CommandActor;
  /** PR 的 head 提交；issue 场景为 `null`（issue 判定类用 `missing_set_hash` 做锚）。 */
  readonly headSha?: string | null;
  /**
   * 该目标上**本命令**上一次处理过的 head_sha。
   * 调用方从 `tasks`（同 repo/target/command 的最近一条）读出来；读不到传 `null`。
   */
  readonly lastProcessedHeadSha?: string | null;
  /** 归一化命令名（`/review-pr`）。 */
  readonly command: string;
  readonly config: RepoConfig['commands'];
  /** 注册表里的技能状态（由 `skills/` 提供；`null` = 未知命令）。 */
  readonly skill?: { readonly enabled: boolean; readonly detail?: string | null } | null;
};

export type CommandGateRejectReason =
  | 'commands-disabled'
  | 'bot-actor'
  | 'association-not-allowed'
  | 'actor-not-allowlisted'
  | 'unknown-command'
  | 'skill-unavailable'
  | 'duplicate-head-sha';

export type CommandGateDecision =
  | {
      readonly allowed: true;
      /** 入队用的幂等键（`sha256([kind, repo, target, head_sha, actor])[:32]`）。 */
      readonly idempotencyKey: string;
      /** 键里的 kind（`command:/review-pr`），审计与面板按它分组。 */
      readonly kind: string;
    }
  | {
      readonly allowed: false;
      readonly reason: CommandGateRejectReason;
      /** 面向人的一句话（回评论用；被拒的命令也要说清为什么）。 */
      readonly message: string;
      /**
       * `true` 表示「什么都不做」：机器人账号与重复 sha 都不该回评论
       * （回评论会让两个 bot 互相触发，或让重复触发刷屏）。
       */
      readonly noop: boolean;
    };

/** 幂等键里的 kind（tech-plan §7.2：`command:/review-pr`）。 */
export function commandKind(command: string): string {
  return `command:${command.trim().toLowerCase()}`;
}

/** 目标串（`issue#7` / `pr#12`），与 `runs`/`actions` 的 target 口径一致。 */
export function targetOf(kind: 'issue' | 'pr', number: number): string {
  return `${kind}#${number}`;
}

/** 本命令的幂等键。 */
export function commandIdempotencyKey(input: {
  readonly command: string;
  readonly repo: string;
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly headSha?: string | null;
  readonly triggerActor: string;
}): { readonly key: string; readonly kind: string } {
  const kind = commandKind(input.command);
  return {
    kind,
    key: buildIdempotencyKey({
      kind,
      repo: input.repo,
      target: targetOf(input.targetKind, input.targetNumber),
      headSha: input.headSha ?? null,
      triggerActor: input.triggerActor,
    }),
  };
}

function deny(reason: CommandGateRejectReason, message: string, noop: boolean): CommandGateDecision {
  return { allowed: false, reason, message, noop };
}

/**
 * 门禁判定。顺序 = 「先便宜的、先致命的」：
 * 仓库开关 → 机器人 → 权限 → 命令是否存在/可用 → 重复 sha。
 *
 * 权限放在「命令是否存在」之前是有意的：不该让无权限的人通过报错差异探测
 * 「这个仓库装了哪些命令」。
 */
export function evaluateCommandGate(input: CommandGateInput): CommandGateDecision {
  const { config, actor } = input;

  if (!config.enabled) {
    return deny('commands-disabled', '本仓库已关闭命令功能（`commands.enabled: false`）。', true);
  }

  if ((actor.type ?? '').toLowerCase() === 'bot') {
    // 机器人账号连回复都不给：两个 bot 互相回复会无限循环。
    return deny('bot-actor', '机器人账号的提及一律忽略。', true);
  }

  const association = actor.authorAssociation.toUpperCase();
  const allowedAssociations = config.author_associations.map((item) => item.toUpperCase());
  const allowlisted = config.allow_users.some((login) => login.toLowerCase() === actor.login.toLowerCase());
  if (!allowedAssociations.includes(association) && !allowlisted) {
    return deny(
      'association-not-allowed',
      `只有仓库成员才能使用命令（当前 author_association=${association}）。`,
      false,
    );
  }

  if (input.skill === undefined || input.skill === null) {
    return deny('unknown-command', `未知命令 \`${input.command}\`。`, false);
  }
  if (!input.skill.enabled) {
    return deny(
      'skill-unavailable',
      `\`${input.command}\` 当前不可用${input.skill.detail === undefined || input.skill.detail === null ? '' : `：${input.skill.detail}`}`,
      false,
    );
  }

  const headSha = input.headSha ?? null;
  const lastSha = input.lastProcessedHeadSha ?? null;
  if (headSha !== null && lastSha !== null && headSha === lastSha) {
    // plan §6.4「同一 head_sha 重跑是空操作」：不入队、不回复。
    return deny('duplicate-head-sha', `\`${input.command}\` 在提交 ${headSha.slice(0, 7)} 上已经跑过，重跑是空操作。`, true);
  }

  const { key, kind } = commandIdempotencyKey({
    command: input.command,
    repo: input.repo,
    targetKind: input.targetKind,
    targetNumber: input.targetNumber,
    headSha,
    triggerActor: actor.login,
  });
  return { allowed: true, idempotencyKey: key, kind };
}