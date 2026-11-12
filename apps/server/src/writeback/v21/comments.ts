/**
 * `comment` 动作的**槽位**语义（`docs/v21-contract.md` §5 第二行 / FR-5.5）。
 *
 * 一句话：同一个 `(repo, issue, slot)` 在 issue 上**只允许有一条**评论，第二次写就是**覆盖**。
 *
 * 为什么必须有槽位：agent 会被同一个 issue 反复触发（新评论、编辑正文、人工 @）。
 * 如果每次触发都新发一条「处理结果」，一个活跃 issue 会被同一条机器结论刷满。
 * 槽位让「结论」变成位置（`result` 槽）、「失败说明」变成另一个位置（`failure` 槽），
 * 彼此不打架，也不随触发次数增长。
 *
 * 识别靠隐藏标记：正文末尾一行 `<!-- pi-bot:slot <repo>#<issue>:<slot> -->`。
 * 为什么用 HTML 注释而不是标题前缀：注释在 GitHub 渲染结果里不可见，
 * 人读到的仍是干净的结论正文；而标题前缀会污染每一个槽位标题。
 *
 * 为什么还要一个「槽位索引」（`slotStore`）：列表评论是分页的，老 issue 的槽位评论
 * 可能在第 3 页。索引是快路径（少一次列表），列表是兜底（索引丢了还能按标记找回来）。
 * 本文件的纯函数对两者一视同仁 —— 谁给出 `existing` 都行。
 */

/** 槽位标记的前缀（判定「这行是不是我们写的标记」时用它）。 */
export const SLOT_MARKER_PREFIX = 'pi-bot:slot';

/** 槽位键：`(repo, issue, slot)`。 */
export type SlotTarget = {
  readonly repo: string;
  readonly issueNumber: number;
  /** 槽位名（`^[a-z0-9][a-z0-9._-]{0,63}$`，由产出契约保证）。 */
  readonly slot: string;
};

/** 一条评论的最小形状（`id` + `body`，与 `github/types.ts::IssueComment` 结构兼容）。 */
export type SlotComment = {
  readonly id: number;
  readonly body: string | null;
};

/**
 * 标记里 `repo` 的形状：`owner/name`。
 *
 * 不用 `\S+`：`\S+` 会把 `owner/name#12` 整段吞掉，回溯得到的 `#12` 位置依赖于
 * 后面的正则，跨仓库名带 `#`（GitHub 不允许，但别赌）时会解析出错的槽位。
 * 显式两段 + 数字 issue 号，解析结果与 `splitRepo()` 的口径一致。
 */
const SLOT_MARKER_RE =
  /<!--\s*pi-bot:slot\s+([\w.-]+\/[\w.-]+)#(\d+):([a-z0-9][a-z0-9._-]{0,63})\s*-->/gu;

/**
 * 生成标记。
 *
 * 固定「前后各一个空格、结尾一行」的形态，是为了让人在 issue 正文里 `Ctrl+F`
 * 也能一眼认出，且 `parseSlotMarkers()` 与之互为逆运算。
 */
export function buildSlotMarker(input: SlotTarget): string {
  return `<!-- ${SLOT_MARKER_PREFIX} ${input.repo}#${String(input.issueNumber)}:${input.slot} -->`;
}

/**
 * 解析一段正文里出现的全部槽位标记。
 *
 * 允许一条评论里出现多个标记（人把两条评论手工合并时会这样），按出现顺序返回。
 * 正则带 `g` 但每次调用都新建状态：`String.prototype.matchAll` 不共享 `lastIndex`，
 * 所以同一个正则常量被并发调用也是安全的。
 */
export function parseSlotMarkers(body: string | null | undefined): SlotTarget[] {
  if (typeof body !== 'string' || body === '') {
    return [];
  }
  const found: SlotTarget[] = [];
  for (const match of body.matchAll(SLOT_MARKER_RE)) {
    const repo = match[1];
    const issueNumber = match[2];
    const slot = match[3];
    if (repo === undefined || issueNumber === undefined || slot === undefined) {
      continue;
    }
    const parsed = Number.parseInt(issueNumber, 10);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    found.push({ repo, issueNumber: parsed, slot });
  }
  return found;
}

/** 两个槽位键是不是同一个（`repo` 归一化大小写：GitHub 的 owner/name 不区分大小写）。 */
function isSameSlot(a: SlotTarget, b: SlotTarget): boolean {
  return a.issueNumber === b.issueNumber && a.slot === b.slot && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * 在评论列表里按标记找槽位评论。
 *
 * 「精确匹配」的含义是**槽位键相同**，而不是标记字符串逐字相同：
 * 人可能手工编辑过那行注释的空白（`<!--pi-bot:slot  ...-->`），
 * 语义仍然是「这条评论属于这个槽位」。多个命中时取**列表里第一条**（最新的列表顺序由
 * 调用方决定；此处不做「哪条更新」的判断 —— 覆盖第一条即恢复「一槽一条」的不变量）。
 */
export function findSlotComment(
  comments: readonly SlotComment[],
  marker: string,
): SlotComment | null {
  const target = parseSlotMarkers(marker)[0];
  if (target === undefined) {
    return null;
  }
  for (const comment of comments) {
    for (const found of parseSlotMarkers(comment.body)) {
      if (isSameSlot(found, target)) {
        return comment;
      }
    }
  }
  return null;
}

/**
 * 拼出真正要写进 GitHub 的正文：`正文（去首尾空白）` + 空行 + 标记。
 *
 * 顺序是「正文在前、标记在后」而不是反过来：人展开评论时先读到结论，
 * 且折叠长评论时被折叠的是正文而不是标记（标记被折叠掉也不影响解析，
 * 但让人一眼看不到标记更符合「隐藏」的意图）。
 */
export function composeSlotBody(body: string, marker: string): string {
  const trimmed = body.trim();
  if (trimmed === '') {
    return marker;
  }
  return `${trimmed}\n\n${marker}`;
}

/** 一次槽位写回的决策。 */
export type SlotWritePlan =
  | {
      readonly op: 'update';
      readonly commentId: number;
      /** 要写入的完整正文（已含标记）。 */
      readonly body: string;
      readonly marker: string;
      /** 上一次的评论已不存在、这次是重建（用于留痕）。 */
      readonly recreated: boolean;
    }
  | {
      readonly op: 'create';
      readonly body: string;
      readonly marker: string;
      /** 是否「本应更新、但原评论不见了」（索引里有 id、列表里没有）。 */
      readonly recreated: boolean;
    };

/**
 * 决定这次是覆盖还是新建。
 *
 * `historyCommentId` 是槽位索引里记着的评论 id：
 *  - 有 `existing` → 覆盖（`recreated: false`）；
 *  - 没有 `existing`、但有历史 id → 新建，且 `recreated: true`
 *    （人把我们的评论删了或 issue 被转移 —— 面板要能看到「重建了一次」）；
 *  - 两者都没有 → 新建，`recreated: false`（第一次写这个槽位）。
 *
 * 只看 `existing` 是不够的：那样「人删了评论」和「第一次写」在审计里长得一模一样。
 */
export function planSlotWrite(input: {
  /** 按标记/索引找到的现有评论；没有就 `null`。 */
  readonly existing: SlotComment | null;
  /** 原始正文（不含标记）。 */
  readonly body: string;
  /** 槽位标记（`buildSlotMarker()` 的产物）。 */
  readonly marker: string;
  /** 槽位索引里记着的评论 id；省略/`null` = 没有历史。 */
  readonly historyCommentId?: number | null | undefined;
}): SlotWritePlan {
  const body = composeSlotBody(input.body, input.marker);
  if (input.existing !== null) {
    return { op: 'update', commentId: input.existing.id, body, marker: input.marker, recreated: false };
  }
  const history = input.historyCommentId ?? null;
  return { op: 'create', body, marker: input.marker, recreated: history !== null };
}
