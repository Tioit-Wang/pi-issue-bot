/**
 * 管理员指令的**解析**（`docs/plan-fixed-pipeline.md` §1.2 P6 / §1.7 Q7 / §8 / §12 V20）。
 *
 * 三条指令，全部限 `settings.pipeline.managers` 里的 login 或 `author_association === 'OWNER'`：
 *
 * | 指令 | 语义 |
 * |---|---|
 * | `/recheck` | 重跑当前阶段（`blocked` 时也重跑，但不清 `blocked_reason` 之外的东西） |
 * | `/recheck --force` | 解 `blocked` 后重跑（§8 的门禁回执里就是让人用这一条） |
 * | `/pipeline next` | 进入下一阶段：format → classify → ready；`blocked` 等价解禁 |
 * | `/pipeline prev` | 返回上一阶段：ready → classify → format（逐步重跑） |
 *
 * 为什么解析单独一个文件、且是**纯函数**：
 *  - 指令**不进命令门禁**（§4.5 / §16.1 第 3 条：流水线走独立分支，不受 `commands.enabled` 与白名单约束），
 *    所以它不能挂在 `decideWebhookTask` 的命令分支上；
 *  - 「谁有权限」「解析成什么」「要不要入队」是三件事，前两件都必须能单测逐条摆位
 *    （尤其「非 managers 只打 eyes、不执行、不回复」这条）。
 *
 * 形态与其它命令一致：必须 `@<别名> /指令`（别名由 `resolveTriggerAliases()` 给出）。
 * 不接受裸 `/recheck`：issue 里任何人的一句话都能重跑流水线，代价太高。
 */
import type { RepoSettings } from '../../../../packages/contract/src/index.ts';

/** 一个解析出来的指令。 */
export type PipelineDirective =
  /** 重跑当前阶段；`force` = 同时解 `blocked`（§8 回执里的推荐动作） */
  | { readonly kind: 'recheck'; readonly force: boolean }
  /** 进入下一阶段（§2 `manual-next`） */
  | { readonly kind: 'next' }
  /** 返回上一阶段（§2 `manual-prev`） */
  | { readonly kind: 'prev' };

/** 指令原文（人读日志 / 审计用）。 */
export function describeDirective(directive: PipelineDirective): string {
  switch (directive.kind) {
    case 'recheck':
      return directive.force ? '/recheck --force' : '/recheck';
    case 'next':
      return '/pipeline next';
    case 'prev':
      return '/pipeline prev';
  }
}

/** 转义正则字面量（别名来自配置，不能直接拼进正则）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `@<别名> /recheck [--force]` 或 `@<别名> /pipeline next|prev`。
 *
 * 大小写不敏感（GitHub 上的句柄本来就不分大小写），`/recheck` 与 `/pipeline` 只认第一个参数，
 * 后面的内容一概忽略（「/pipeline next 麻烦看一下」也是合法的）。
 */
function directivePattern(aliases: readonly string[]): RegExp {
  const handles = aliases.map((alias) => escapeRegExp(alias)).join('|');
  return new RegExp(
    `(?:^|\\s)@(?:${handles})\\s+\\/(recheck|pipeline)\\b([^\\n\\r]*)`,
    'iu',
  );
}

/** `--force` 是否出现在参数里（`/recheck --force`；`--force` 之外的参数忽略）。 */
function hasForceFlag(args: string): boolean {
  return /(?:^|\s)--force(?=\s|$)/iu.test(args);
}

/**
 * 解析指令；不是指令返回 `null`（普通评论 / 普通命令一律交回原通道）。
 *
 * 别名必须是**已知别名**：`@other /recheck` 不是指令（否则谁都能重跑）。
 */
export function parsePipelineDirective(
  body: unknown,
  aliases: string | readonly string[],
): PipelineDirective | null {
  if (typeof body !== 'string' || body.trim() === '') {
    return null;
  }
  const list = typeof aliases === 'string' ? [aliases] : aliases;
  if (list.length === 0) {
    return null;
  }
  const match = directivePattern(list).exec(body);
  if (match === null) {
    return null;
  }
  const name = (match[1] ?? '').toLowerCase();
  const args = (match[2] ?? '').trim();

  if (name === 'recheck') {
    return { kind: 'recheck', force: hasForceFlag(args) };
  }
  // `/pipeline <next|prev>`：只有这两个子命令是指令；`/pipeline` 后面跟别的词 = 不是指令
  const sub = args.split(/\s+/u)[0]?.toLowerCase() ?? '';
  if (sub === 'next') {
    return { kind: 'next' };
  }
  if (sub === 'prev') {
    return { kind: 'prev' };
  }
  return null;
}

/** 一次「谁在调用」的判定输入。 */
export type PipelineActor = {
  /** GitHub login（大小写不敏感比较：GitHub 侧也是这个口径） */
  readonly login: string;
  /** `comment.author_association`（`OWNER` 也算管理员，见 §1.7 Q7） */
  readonly association: string | null;
};

/**
 * 是不是流水线管理员：`settings.pipeline.managers` 里的 login，或 `author_association === 'OWNER'`。
 *
 * 为什么 `OWNER` 直接放行：仓库所有者锁死自己的流水线却没把自己写进 managers 是配置疏漏，
 * 不是权限设计——但 managers 才是「等管理员回话」的 `@` 名单（`mention` 不因 OWNER 而扩）。
 */
export function isPipelineManager(
  settings: Pick<RepoSettings, 'pipeline'> | null,
  actor: PipelineActor,
): boolean {
  if ((actor.association ?? '').toUpperCase() === 'OWNER') {
    return true;
  }
  const managers = settings?.pipeline.managers ?? [];
  const login = actor.login.trim().toLowerCase();
  if (login === '') {
    return false;
  }
  return managers.some((manager) => manager.toLowerCase() === login);
}

/**
 * `@` 名单（评论末尾追加的 `/cc @m1 @m2`，§6）。
 *
 * 只取 `managers`（不是 OWNER、也不是评论作者）：模型输出不参与 mention，
 * 服务端只从配置里取人，避免「乱 @ 人」。
 */
export function managerMentions(settings: Pick<RepoSettings, 'pipeline'> | null): string[] {
  const managers = settings?.pipeline.managers ?? [];
  const out: string[] = [];
  for (const manager of managers) {
    const login = manager.trim();
    if (login !== '' && !out.includes(login)) {
      out.push(login);
    }
  }
  return out;
}

/** 评论末尾追加 `@`（`mention_sent_at` 非空时调用方**不要**调它：整个 issue 只 @ 一次，D4）。 */
export function appendMentions(body: string, mentions: readonly string[]): string {
  if (mentions.length === 0) {
    return body;
  }
  const trailer = mentions.map((login) => `@${login}`).join(' ');
  const trimmed = body.trimEnd();
  // 已经有 `/cc` 尾注就不再追加一遍（模型可能自己写了）
  if (/(?:^|\n)\s*(?:\/cc|cc)\s+@/iu.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}\n\n/cc ${trailer}`;
}
