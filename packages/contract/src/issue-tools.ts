/**
 * 执行侧工具面（`docs/requirements.html` §5.5「执行侧可用工具」）。
 *
 * 这份清单是**工具名的唯一事实源**：审批策略（`runtime/approval-policy.ts`）、
 * 技能的 `allowed-tools` 枚举（`enums.ts`）、提示词里的工具目录（`skills/prompt.ts`）、
 * 需求文档的表格都从这里派生。写第二份的后果是「文档说能调、策略直接 deny」，
 * 模型只会回报一个看不懂的拒绝理由。
 *
 * 三个硬约束（对应需求的三条）：
 * 1. **移除的工具不留在任何白名单里**：`mcp__*` / `plugin_*` / `new_context` / `Task` / `TodoWrite`
 *    既不能出现在技能 frontmatter 里，也不能被审批策略放行。
 * 2. **issue 操作全走专用工具**：新增的这一组覆盖创造/读取/评论/标签/状态/检索/关联，
 *    让 agent 不必、也不许退回 shell。
 * 3. **`Bash` 不做 issue 操作**：工具名层面无法禁止 `gh`，所以这条落在
 *    `findShellIssueViolation()` 上——审批策略在放行 `Bash` 前调用它，命中即 deny。
 *
 * 关于「能不能真的调到」：本模块只描述**工具名与语义**。真正把工具注入 host 需要
 * RACP 的 `tools/advertise` + tool relay，而该通道在 `packages/racp-client/src/ops.ts`
 * 的白名单里被明确排除（`docs/tech-plan.md` §4.4 记 `Host 侧 toolRelay: false`）。
 * 所以在执行通道落地之前，这些工具**只出现在提示词与审批矩阵里，不会被 host 真正暴露**，
 * 由 `EXECUTE_CHANNEL_AVAILABLE` 明确标出，提示词据此决定是否宣称它们可用。
 */

/* ── 1. 被移除的工具 ───────────────────────────────────────────────────────── */

/**
 * 命令式移除的工具名（前缀匹配 + 精确匹配两种）。
 *
 * 为什么 `mcp__*` / `plugin_*` 用前缀：这两族的名字由插件与 MCP server 动态产生
 * （`mcp__github__create_issue`、`plugin_pi_todo_todo_manage`），逐个列举永远列不全，
 * 漏掉的那个就成了后门。前缀匹配是这里唯一能闭合的写法。
 */
export const REMOVED_TOOL_PREFIXES = ['mcp__', 'plugin_'] as const;

/**
 * 命令式移除的工具名（精确匹配）。
 *
 * 每一个都要说清为什么移除——它们是 SDK 自带能力，不是拼写错误：
 * - `new_context`：模型主动换窗口。v2.1 的会话按 issue 常驻，压缩时机由平台按 token 水位
 *   决定（`compact/` 那套），让模型自己挑时机会在长任务里把上下文切成互不相连的碎片。
 * - `Task`：派生子代理。执行侧没有子会话通道，派生出去的上下文既不进 `run_events`
 *   也不进审计，等于在留痕之外干活。
 * - `TodoWrite`：长任务拆步。进度已经在 `agent_messages` + `run_events` 里，多一份计划
 *   只会和实际执行分叉，且它不改变仓库状态、对 issue 处理没有净收益。
 */
export const REMOVED_TOOLS = ['new_context', 'Task', 'TodoWrite'] as const;

export type RemovedTool = (typeof REMOVED_TOOLS)[number];

/**
 * 这个工具名是否被移除。
 *
 * 大小写不敏感 + 去空白：Host 侧大小写稳定，但技能 frontmatter 是人写的，
 * `todoWrite` 与 `TodoWrite` 是同一个工具，不该因为拼写差异被当成两个。
 */
export function isRemovedTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized === '') return false;
  if ((REMOVED_TOOLS as readonly string[]).some((tool) => tool.toLowerCase() === normalized)) {
    return true;
  }
  return REMOVED_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/* ── 2. 保留的宿主能力（文件 / 执行） ──────────────────────────────────────── */

/**
 * 保留下来的宿主工具：读文件、写文件、跑命令。
 *
 * 它们**不是** issue 操作工具，而是「看代码、改代码、跑测试」这条通用链路。
 * `Bash` 保留，但带一条新约束：不得用来做 issue 操作（见第 4 节）。
 */
export const HOST_FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
export const HOST_SHELL_TOOL = 'Bash';

/* ── 3. 新增的 issue 工具集（覆盖 issue 全生命周期） ───────────────────────── */

/** 工具分组：读 / 写 / 检索 / 元数据。分组只影响文档排版与提示词分段。 */
export const ISSUE_TOOL_GROUPS = ['read', 'write', 'search', 'meta'] as const;
export type IssueToolGroup = (typeof ISSUE_TOOL_GROUPS)[number];

/**
 * 一个 issue 工具的声明。
 *
 * `write: true` 的工具**不改变「写回只有一条路」这条架构约束**：它们产出的仍是
 * 标准动作信封里的 intent（`comment` / `label` / `create_issue` / `push_branch`），
 * 由平台执行、过写回闸门、进审计。工具只是把这些动作的**参数**说清楚，
 * 而不是让 agent 自己发 HTTP 请求。
 */
export type IssueToolSpec = {
  /** 工具名（模型看到的那个）。 */
  readonly name: string;
  readonly group: IssueToolGroup;
  /** 是否会产生写操作（要过写回闸门与审计）。 */
  readonly write: boolean;
  /** 一句话说明（进提示词与文档表格）。 */
  readonly description: string;
  /** 必填入参名（提示词里给出调用形状）。 */
  readonly required: readonly string[];
  /** 可选入参名。 */
  readonly optional?: readonly string[];
};

/**
 * 覆盖 issue 全生命周期的 19 个工具（需求「每一个生命周期环节都要有专用工具」）。
 *
 * 为什么按生命周期而不是按 GitHub REST 端点排：模型的任务是「把这个 issue 处理明白」，
 * 端点粒度会让它拼出一串没有语义的调用（`GET issue` → `PATCH issue` → `POST comments`）；
 * 生命周期粒度直接对应它要说的话（`IssueGet` → `IssueUpdate` → `IssueCommentCreate`）。
 *
 * 覆盖面的自检清单（缺一个就意味着要退回 shell，或者这件事模型根本表达不出来）：
 * 创建 → `IssueCreate`；读取 → `IssueGet` / `IssueList` / `IssueCommentsList` /
 * `IssueTimeline`；改 → `IssueUpdate` / `IssueClose` / `IssueReopen`；评论 →
 * `IssueCommentCreate` / `IssueCommentReply` / `IssueCommentUpdate` / `IssueCommentDelete`；
 * 表情 → `IssueReactionAdd` / `IssueReactionRemove`；标签 → `IssueLabelAdd` /
 * `IssueLabelRemove` / `IssueLabelSet`；检索 → `IssueSearch`；关联 → `IssueLink`。
 *
 * 三件「不新增工具、而是做进现有工具」的判断，写在对应工具的说明里：
 * - **提及别的 issue / PR** 不做工具：GitHub 的 `#123` 是正文渲染触发的，没有「创建提及」
 *   的端点；它的真实需求是「校验编号 + 别把 @ 发给无关的人」，落在评论类工具的正文处理上。
 * - **回复评论**必须独立成工具：它不是"评论的一个可选字段"，而是**渲染格式被规定死**的
 *   一种产出（引用块 + 定向 @ + 独立槽位）。混进 `IssueCommentCreate` 的 6 个可选参数里，
 *   模型会漏掉它。
 * - **表情**用 `target` 而不是拆成「贴 issue / 贴评论」四个工具：贴哪儿是一个枚举，
 *   不是两种动作；模型选工具的成本高于填一个字段。
 */
export const ISSUE_TOOLS = [
  {
    name: 'IssueGet',
    group: 'read',
    write: false,
    description: '读单个 issue 的完整快照：标题、正文、状态、作者、标签、指派人、里程碑、关联项',
    required: ['number'],
  },
  {
    name: 'IssueList',
    group: 'read',
    write: false,
    description: '按状态 / 标签 / 指派人 / 里程碑列出 issue（分页），用于横向对比同类问题',
    required: [],
    optional: ['state', 'labels', 'assignee', 'milestone', 'cursor', 'limit'],
  },
  {
    name: 'IssueCommentsList',
    group: 'read',
    write: false,
    description:
      '读某个 issue 的评论（分页）：每条都带 `comment_id` / 作者 / 时间 / 正文。贴表情与回复评论都要先拿到这里的 `comment_id`',
    required: ['number'],
    optional: ['cursor', 'limit'],
  },
  {
    name: 'IssueTimeline',
    group: 'read',
    write: false,
    description: '读 issue 时间线：标签变更、状态变更、指派、引用与交叉链接，按时间排序',
    required: ['number'],
    optional: ['cursor', 'limit'],
  },
  {
    name: 'IssueSearch',
    group: 'search',
    write: false,
    description: '按关键词 / 标签 / 状态检索 issue，返回带命中的摘要（补标题索引的不足）',
    required: ['query'],
    optional: ['labels', 'state', 'limit'],
  },
  {
    name: 'IssueCreate',
    group: 'write',
    write: true,
    description: '新建 issue：标题、正文、标签、指派人；受项目动作开关与配额约束',
    required: ['title', 'body'],
    optional: ['labels', 'assignees', 'milestone'],
  },
  {
    name: 'IssueUpdate',
    group: 'write',
    write: true,
    description:
      '改 issue 的标题 / 正文 / 指派人 / 里程碑（不含标签与状态，两者各有专用工具）。改正文属于覆盖写：先读来的 `updated_at` 要作为 `expected_updated_at` 传回，不一致就整条拒绝',
    required: ['number'],
    optional: ['title', 'body', 'assignees', 'milestone', 'expected_updated_at'],
  },
  {
    name: 'IssueClose',
    group: 'write',
    write: true,
    description:
      '关闭 issue，`state_reason` 取 completed / not_planned / duplicate / reopened（duplicate 要同时给 `duplicate_of`）；受项目动作开关约束',
    required: ['number'],
    optional: ['state_reason', 'duplicate_of', 'comment'],
  },
  {
    name: 'IssueReopen',
    group: 'write',
    write: true,
    description: '重新打开已关闭的 issue',
    required: ['number'],
    optional: ['comment'],
  },
  {
    name: 'IssueCommentCreate',
    group: 'write',
    write: true,
    description:
      '发一条评论；走槽位覆盖与去重标记，重复调用不会发两条一样的评论。正文里的 `#123` 与 `@人` 会被校验：编号不存在整条拒绝，@ 只允许作者与本轮触发人',
    required: ['number', 'body'],
  },
  {
    name: 'IssueCommentReply',
    group: 'write',
    write: true,
    description:
      '回复某条评论：平台把原评论渲染成引用块并定向 @ 作者，占独立槽位（GitHub 的 issue 评论没有原生 thread，只能这么回）。`body` 只写正文，不要自己写 `>` 引用块与 @',
    required: ['number', 'comment_id', 'body'],
  },
  {
    name: 'IssueCommentUpdate',
    group: 'write',
    write: true,
    description: '改我们自己发过的评论正文（只允许改本机器人写的，人写的会被拒绝）',
    required: ['comment_id', 'body'],
  },
  {
    name: 'IssueCommentDelete',
    group: 'write',
    write: true,
    description: '删我们自己发过的评论（只允许删本机器人写的）',
    required: ['comment_id'],
  },
  {
    name: 'IssueReactionAdd',
    group: 'write',
    write: true,
    description:
      '给 issue 或某条评论贴表情，`content` 取 +1 / -1 / laugh / confused / heart / hooray / rocket / eyes；`target` 缺省为 issue，贴评论时同时给 `comment_id`',
    required: ['content'],
    optional: ['target', 'comment_id'],
  },
  {
    name: 'IssueReactionRemove',
    group: 'write',
    write: true,
    description: '撤掉本机器人贴过的表情（人打的不会动），参数形状与 `IssueReactionAdd` 相同',
    required: ['content'],
    optional: ['target', 'comment_id'],
  },
  {
    name: 'IssueLabelAdd',
    group: 'write',
    write: true,
    description: '给 issue 加标签；只能加项目标签目录里的名字',
    required: ['number', 'labels'],
  },
  {
    name: 'IssueLabelRemove',
    group: 'write',
    write: true,
    description: '从 issue 移除标签；含义为空的目录标签不参与自动对齐，不会被移除',
    required: ['number', 'labels'],
  },
  {
    name: 'IssueLabelSet',
    group: 'write',
    write: true,
    description: '把 issue 的标签设成指定集合（目标态），平台与实际标签做 diff：多的删、少的加',
    required: ['number', 'labels'],
  },
  {
    name: 'IssueLink',
    group: 'meta',
    write: true,
    description:
      '声明与另一个 issue / PR 的关系。`relation` 取 duplicate（标记重复并指向原 issue）/ blocks / blocked_by / parent（挂成子 issue）/ relates（只在正文留一条关联）；能表达成结构关系就不要只写一句话',
    required: ['number', 'target_number', 'relation'],
  },
] as const satisfies readonly IssueToolSpec[];

export type IssueTool = (typeof ISSUE_TOOLS)[number];
export type IssueToolName = IssueTool['name'];

/** 只要名字的清单（审批矩阵、技能枚举、测试共用）。 */
export const ISSUE_TOOL_NAMES: readonly IssueToolName[] = ISSUE_TOOLS.map((tool) => tool.name);

/**
 * 这个工具名是不是 issue 工具集里的一个。
 *
 * 同样大小写不敏感：技能里写 `issueget` 应当被识别成 `IssueGet`，
 * 而不是掉进「未知工具 → deny」还让人以为工具没实现。
 */
export function isIssueTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return ISSUE_TOOL_NAMES.some((tool) => tool.toLowerCase() === normalized);
}

/** 写类 issue 工具（要过写回闸门与项目动作开关）。 */
export const ISSUE_WRITE_TOOL_NAMES: readonly IssueToolName[] = ISSUE_TOOLS.filter((tool) => tool.write).map(
  (tool) => tool.name,
);

/**
 * issue 工具的**使用规范**（渲染进提示词，位于工具清单之后）。
 *
 * 为什么放在契约而不是提示词里：这些句子决定了「模型会不会用错工具」，和工具名同属
 * 事实源。写成两份的后果是加了个工具却没人告诉模型什么时候该用它——v2.1 的
 * `IssueLink` 就是这么被闲置的（工具在清单里，没有任何一句话说它比评论更合适）。
 *
 * 每条只写**模型该怎么做**，不承诺平台当前能不能做到：能不能执行由
 * `issueToolAvailability()` 单独表达，两者混在一起会让「通道没通」看起来像「语义变了」。
 */
export const ISSUE_TOOL_USAGE_NOTES = [
  '能用表情说清的不要再发评论：`eyes` = 已收到、正在看；`rocket` = 已处理 / 已修复；`confused` = 信息不足，需要补充；`+1` = 认同这个需求。',
  '给某条评论贴表情或回复它之前，先用 `IssueCommentsList` 拿到它的 `comment_id`；这个编号只能来自工具返回值，不许自己编。',
  '回复评论一律用 `IssueCommentReply`：引用块、定向 @ 与去重标记由平台生成，`body` 里只写正文，不要自己写 `>` 引用或 @ 作者。',
  '提及别的 issue / PR 直接写 `#123` 或 `owner/repo#123`（也可写完整链接）；不要编造编号，也不要顺手 @ 与这件事无关的人。',
  '结构性关系用 `IssueLink`，不要只在正文里写一句话：重复用 duplicate（配合 `IssueClose` 的 `state_reason=duplicate` + `duplicate_of`），阻塞用 blocks / blocked_by，拆分用 parent。',
  '标签只能从 `## 项目标签` 里挑，不要发明名字；`IssueLabelSet` 给的是**目标集合**（多的删、少的加），只想加一个就用 `IssueLabelAdd`。',
  '改标题或正文前先读一次拿 `updated_at`，再把它作为 `expected_updated_at` 传回：GitHub 的 issue 更新没有并发保护，不传就是静默覆盖别人的修改。',
] as const;

export type IssueToolUsageNote = (typeof ISSUE_TOOL_USAGE_NOTES)[number];

/* ── 4. issue 操作不得走 shell ─────────────────────────────────────────────── */

/**
 * 判定一条 shell 命令是不是在做 issue 操作。
 *
 * 为什么必须有这道判定：工具名层面只能决定「给不给 Bash」，给不了「Bash 只能用来跑测试」。
 * 而 `gh` 恰恰是把 issue 操作搬出治理链路的最短路径——它跳过槽位覆盖、去重、写回闸门与审计，
 * 还绕开了「agent 不能自己发评论」这条从 v0.3 就立下的边界。所以这里在审批时扫一遍命令，
 * 命中就 deny 并把理由写进审计（模型能看到「该用哪个工具」）。
 *
 * 判据刻意保守（宁可误拒）：命令里出现 `gh` 子命令、或直接打 GitHub REST 即可疑。
 * 只拒绝明确的 issue/PR 写读动作组，不拦 `gh auth status` 这类本地状态查询之外的东西——
 * 但 `gh issue` / `gh pr` / `gh api` / `gh search` 一律拒，因为它们就是这条捷径本身。
 */
export const SHELL_ISSUE_DENY_PATTERNS = [
  // gh issue list / view / create / comment / close / edit …
  /\bgh\s+issue\b/i,
  // gh pr create / view / comment …
  /\bgh\s+pr\b/i,
  // gh api repos/... 或 gh api graphql
  /\bgh\s+api\b/i,
  // gh search issues
  /\bgh\s+search\b/i,
  // 直接打 GitHub REST（curl/wget/xh + api.github.com）
  /\b(?:curl|wget|xh|http)\b[^\n]*api\.github\.com/i,
  // 直接打 GitHub GraphQL
  /\bapi\.github\.com\/(?:graphql|repos)\b/i,
] as const;

/**
 * 命中返回那段命令（用于审计与错误消息），未命中返回 `undefined`。
 *
 * 返回命中的**片段**而不是布尔值：拒绝理由里能写「命令里有 `gh issue`」，
 * 模型下一轮就知道该怎么改，而不是对着「不允许」三个字瞎猜。
 */
export function findShellIssueViolation(command: string): string | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  for (const pattern of SHELL_ISSUE_DENY_PATTERNS) {
    const match = pattern.exec(command);
    if (match !== null) return match[0];
  }
  return undefined;
}

/* ── 5. 执行通道是否可用 ───────────────────────────────────────────────────── */

/**
 * 平台能否真的把这些工具注入 host。
 *
 * 现在是 `false`，理由是可核对的：注入工具需要 RACP 的 `tools/advertise` + tool relay，
 * 而 `packages/racp-client/src/ops.ts` 的白名单明确不含它，`docs/tech-plan.md` §4.4
 * 记录 Host 侧 `toolRelay: false`（ADR 0285 未实现）。
 *
 * 为什么要有这个常量而不是删掉这段代码等通道：工具**语义**（名字、入参、写回口径、
 * 与审批矩阵的对应）必须先冻结，否则通道落地那天要同时改提示词、审批、文档三处。
 * 提示词按这个开关决定措辞——`false` 时只说「这些能力由平台代你执行」，
 * 绝不说「你可以调用 `IssueGet`」，因为后者在当前链路里是**不存在的能力**
 * （`agent/message.ts` 记着 issue #26 的实测：模型照做只能失败）。
 */
export const EXECUTE_CHANNEL_AVAILABLE = false;

/**
 * issue 工具集的**执行投影**：通道不可用时，这些工具以「平台代执行」的能力形式存在。
 *
 * 这个函数的用途是让提示词与文档只有一处措辞来源：通道真通了，改一个常量 + 这里的措辞，
 * 而不是去满仓找「你可以调用」。
 */
export function issueToolAvailability(): 'callable' | 'platform-executed' {
  return EXECUTE_CHANNEL_AVAILABLE ? 'callable' : 'platform-executed';
}
