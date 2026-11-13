/**
 * 自动审批策略（tech-plan §4.6，plan D8 的落地方式）。
 *
 * 为什么是 `permissionMode: 'ask'` + 自动应答，而不是 `accept-edits` / `auto`：
 * **每一次 allow/deny 都是一条审计条目**。`auto` 会把这些判定一起抹掉，
 * 而 plan §6.5 要审计的恰恰是「它到底做了什么、依据是什么」。
 * 所以本文件是**纯函数**：输入（工具名 + 入参 + worktree 根）→ 输出（决策 + 理由 + 审计条目），
 * 不碰 fs、不碰时钟（时钟可注入），面板与单测拿到的判定完全一致。
 *
 * 策略表逐条落地（v2.1 已完成 issue 工具化的改造）：
 *
 * | 工具 | 决策 | 理由 |
 * |---|---|---|
 * | `Read` `Glob` `Grep` | allow | 只读，路径已由 host-core 限制在 session root |
 * | `Bash` | allow，**但命令不许做 issue 操作** | 已进容器；`gh issue` / `gh api` 这类会被 deny |
 * | `Write` `Edit` | 仅当目标路径在 worktree 内 | 越界写入一律 deny |
 * | issue 工具集（`IssueGet` … `IssueLink`） | 读类 allow，写类由平台执行 | issue 操作的唯一入口 |
 * | `mcp__*` `plugin_*` `new_context` `Task` `TodoWrite` | deny | v2.1 明确移除的能力 |
 * | 其它（网络抓取、任意 exec 桥…） | deny | MVP 不需要，拒绝即最小权限 |
 * | `input/request`（agent 反问） | 应答「无法提供，按现有信息继续」 | 无人可问，但不能让 agent 挂起 |
 *
 * 为什么「issue 操作不许走 shell」要在审批层拦：工具名层面只能决定「给不给 `Bash`」，
 * 给不了「`Bash` 只能跑测试」。`gh` 是把 issue 操作搬出治理链路的最短路径——它跳过槽位覆盖、
 * 去重、写回闸门与审计。判据在契约 `findShellIssueViolation()`，这里只负责调用与记审计，
 * 因为它必须与 `docs/requirements.html` 的表格、面板展示的清单同源。
 *
 * 边界写清（这条策略兜不住的部分）：路径包含关系只能做**字面归一化**比较
 * （`path.resolve` 之后的前缀比较），查不了符号链接与 NTFS reparse point。
 * 真正的强约束在 host-core（`PATH_OUTSIDE_WORKSPACE`），这里是第二道；
 * 一个 `ln -s /etc` 再 `Write` 过去的写法能骗过本函数，但骗不过 host-core 的 session root 限制。
 * 同理，shell 判据是对命令文本的正则匹配：`$(echo gh) issue` 这类拼接能绕过——
 * 但那条路已经在容器里、无 GitHub 凭证，写不回去任何东西。
 */

import { resolve, sep } from 'node:path';

import {
  findShellIssueViolation,
  isIssueTool,
  isRemovedTool,
  ISSUE_WRITE_TOOL_NAMES,
} from '../../../../packages/contract/src/index.ts';
import { previewRedacted } from './deps.ts';

/** `input/request` 的固定应答（§4.6 表最后一行，字面量要稳定，审计要能 grep）。 */
export const INPUT_UNAVAILABLE_ANSWER = '无法提供，按现有信息继续';

/** 只读工具：允许，因为路径已经被 host-core 锁在 session root 内。 */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** 命令类工具：允许，因为命令走 `PI_DESKTOP_BASH` shim 进容器（§4.5）。 */
export const SANDBOXED_TOOLS = ['Bash'] as const;
/** 写类工具：必须逐个校验目标路径。 */
export const WRITE_TOOLS = ['Write', 'Edit'] as const;

/** 入参里可能承载目标路径的键（host-core 各版本用过的写法都收）。 */
export const PATH_INPUT_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'targetPath'] as const;

/** 决策结果。与 RACP 的 `allow-once` / `deny` 是两个词表，用 `racpDecisionFor` 转。 */
export type ApprovalOutcome = 'allow' | 'deny';

/** 规则名（审计与面板按它聚合；字符串稳定，不要随实现改）。 */
export const APPROVAL_RULES = {
  readOnly: 'read-only-tool',
  sandboxed: 'sandboxed-bash',
  writeInsideWorktree: 'write-inside-worktree',
  writeOutsideWorktree: 'write-outside-worktree',
  writeNoTarget: 'write-without-target',
  /** issue 工具：读类放行 / 写类交给平台执行后过写回闸门。 */
  issueToolRead: 'issue-tool-read',
  issueToolWrite: 'issue-tool-write',
  /** `Bash` 命令里出现 issue 操作（`gh issue` / `gh api` / 直接打 api.github.com）。 */
  shellIssueOperation: 'shell-issue-operation',
  /** 已被本版移除的工具（`mcp__*` / `plugin_*` / `new_context` / `Task` / `TodoWrite`）。 */
  removedTool: 'removed-tool',
  unknownTool: 'unknown-tool',
  inputUnavailable: 'input-unavailable',
} as const;
/** 一条审计条目（面板「审计」页与 `actions.audit` 的来源）。 */

export type ApprovalRule = (typeof APPROVAL_RULES)[keyof typeof APPROVAL_RULES];
export interface ApprovalAudit {
  /** ISO 时间（注入时钟，测试可固定）。 */
  readonly at: string;
  /** 判定类型：工具审批 / agent 反问应答。 */
  readonly kind: 'tool' | 'input';
  /** 工具名（`input` 类固定为 `input/request`）。 */
  readonly tool: string;
  readonly rule: ApprovalRule;
  readonly decision: 'allow' | 'deny' | 'answer';
  /** 人可读理由，会进面板。 */
  readonly reason: string;
  /** 本任务的 worktree 根（判定基准，面板能重现判定）。 */
  readonly worktreeRoot: string;
  /** 写类工具的目标路径（归一化后）；其它工具为 `undefined`。 */
  readonly targetPath?: string;
  /** 入参摘要：**已脱敏**且截断，绝不落完整 token/密钥。 */
  readonly inputDigest: string;
  /** `input/request` 的实际应答。 */
  readonly answer?: string;
}

export interface DecideApprovalParams {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** 本任务的 worktree 根（绝对路径）。 */
  readonly worktreeRoot: string;
  /** 注入时钟（默认 `new Date()`）。 */
  readonly now?: () => Date;
}

export interface ApprovalDecision {
  readonly decision: ApprovalOutcome;
  readonly reason: string;
  readonly audit: ApprovalAudit;
}

export interface InputQuestionLike {
  readonly id?: string;
  readonly question?: string;
  readonly options?: readonly string[];
  readonly multiSelect?: boolean;
}

export interface AnswerInputRequestParams {
  readonly questions: readonly InputQuestionLike[];
  readonly worktreeRoot: string;
  readonly now?: () => Date;
}

export interface InputAnswerResult {
  /** 与 `questions` 等长；`null` = 跳过该问题（规范 §5.5 规则 3）。本策略一律给固定应答。 */
  readonly answers: (readonly string[] | null)[];
  readonly audit: ApprovalAudit;
}

function isoNow(now: (() => Date) | undefined): string {
  return (now === undefined ? new Date() : now()).toISOString();
}

/** 入参摘要：只保留键与短值，先 `previewRedacted`（值级脱敏）再截断。 */
function digestInput(input: Record<string, unknown>, limit = 240): string {
  try {
    return previewRedacted(JSON.stringify(input), limit);
  } catch {
    // 循环引用/不可序列化：不因为「记录日志」而让判定失败。
    return '<unserializable input>';
  }
}

/** 工具名比对：Host 侧大小写稳定，但去空白 + 忽略大小写更不容易因为拼写差异误拒。 */
function normalizeTool(tool: string): string {
  return tool.trim().toLowerCase();
}

function isMember(tool: string, list: readonly string[]): boolean {
  return list.some((item) => item.toLowerCase() === tool);
}

/**
 * 目标路径是否落在 worktree 内。
 *
 * 归一化用 `resolve`：`a/../b`、`./x`、`//server/share` 都会被折平，
 * 因此 `../../etc/passwd` 这类逃逸在比较前缀时就露馅。
 * 注意 `worktreeRoot + sep` 的写法：只比较字符串前缀会让 `/jobs/1` 命中 `/jobs/10`。
 */
export function isPathInsideWorktree(target: string, worktreeRoot: string): boolean {
  if (typeof target !== 'string' || target.trim().length === 0) {
    return false;
  }
  const root = resolve(worktreeRoot);
  const resolved = resolve(root, target);
  if (resolved === root) {
    return true;
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return resolved.startsWith(prefix);
}

/** 从工具入参里找目标路径（第一个命中且非空的键）。 */
export function extractTargetPath(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * 判定一次工具审批请求。
 * 每次调用都产出一条审计条目 —— 包括 allow，这正是选 `ask` 而不是 `auto` 的原因（§4.6 末尾）。
 */
export function decideApproval(params: DecideApprovalParams): ApprovalDecision {
  const tool = typeof params.tool === 'string' ? params.tool : '';
  const normalized = normalizeTool(tool);
  const input = params.input ?? {};
  const worktreeRoot = params.worktreeRoot;
  const at = isoNow(params.now);
  const inputDigest = digestInput(input);

  const audit = (
    decision: 'allow' | 'deny',
    rule: ApprovalRule,
    reason: string,
    extra: { targetPath?: string } = {},
  ): ApprovalDecision => ({
    decision,
    reason,
    audit: {
      at,
      kind: 'tool',
      tool: tool.length > 0 ? tool : '<empty>',
      rule,
      decision,
      reason,
      worktreeRoot,
      inputDigest,
      ...(extra.targetPath === undefined ? {} : { targetPath: extra.targetPath }),
    },
  });

  /*
    移除的工具排在最前面判定：它们必须**无论命令长什么样**都被拒。
    放到「未知工具」兜底里也行，但那样审计里的 rule 会写成 `unknown-tool`，
    面板上就看不出「这是本版主动移除的」还是「拼错了」，排查时会白绕一圈。
  */
  if (isRemovedTool(tool)) {
    return audit(
      'deny',
      APPROVAL_RULES.removedTool,
      `工具 ${tool} 已在本版移除（MCP / 插件 / 子代理 / 计划 / 换窗口都不在执行侧开放）；issue 操作请用 Issue* 工具集`,
    );
  }

  if (isMember(normalized, READ_ONLY_TOOLS)) {
    return audit('allow', APPROVAL_RULES.readOnly, '只读工具：路径已由 host-core 限制在 session root 内');
  }

  if (isMember(normalized, SANDBOXED_TOOLS)) {
    /*
      命令放行前先扫一遍：issue 操作只能走 Issue* 工具。
      不扫的话，`gh issue comment` 会把写操作搬出写回闸门、槽位覆盖与审计——
      那正是「agent 不得通过 bash 执行 issue 操作」这条约束要拦的东西。
    */
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    const violation = findShellIssueViolation(command);
    if (violation !== undefined) {
      return audit(
        'deny',
        APPROVAL_RULES.shellIssueOperation,
        `命令里有 issue 操作「${violation}」：issue 读写必须走 Issue* 工具集，不能用 shell（gh / GitHub API 都算）`,
      );
    }
    return audit('allow', APPROVAL_RULES.sandboxed, '命令经 PI_DESKTOP_BASH shim 进容器执行（无凭证/cap-drop/只读根 fs）');
  }

  /*
    issue 工具集：读类直接放行，写类**也放行但只是「让平台去执行」**。
    为什么写类不在这一层拦：这一层判定的是「agent 能不能调这个工具」，
    而写操作真正的两道闸（项目动作开关、写回闸门）在 `writeback/` 里，
    它们需要 issue 的当前状态与项目配置，这里拿不到，硬拦只会拦错。
  */
  if (isIssueTool(tool)) {
    const isWrite = ISSUE_WRITE_TOOL_NAMES.some((name) => name.toLowerCase() === normalized);
    return isWrite
      ? audit(
          'allow',
          APPROVAL_RULES.issueToolWrite,
          'issue 写工具：参数由平台转成标准动作信封，仍要过项目动作开关与写回闸门',
        )
      : audit('allow', APPROVAL_RULES.issueToolRead, 'issue 读工具：只读，平台用自身 App 凭证代理，token 不进沙箱');
  }

  if (isMember(normalized, WRITE_TOOLS)) {
    const target = extractTargetPath(input);
    if (target === undefined) {
      return audit('deny', APPROVAL_RULES.writeNoTarget, '写类工具没有给出目标路径，无法证明在 worktree 内，按最小权限拒绝');
    }
    const resolved = resolve(worktreeRoot, target);
    if (!isPathInsideWorktree(target, worktreeRoot)) {
      return audit('deny', APPROVAL_RULES.writeOutsideWorktree, `目标路径在 worktree 之外：${resolved}`, {
        targetPath: resolved,
      });
    }
    return audit('allow', APPROVAL_RULES.writeInsideWorktree, '目标路径在 worktree 内', { targetPath: resolved });
  }

  return audit(
    'deny',
    APPROVAL_RULES.unknownTool,
    `MVP 不开放工具 ${tool.length > 0 ? tool : '<empty>'}（网络抓取/任意 exec 桥/MCP 一律拒绝，拒即最小权限）`,
  );
}

/**
 * 应答 `input/request`（agent 反问）。
 * 无人可问，但必须给出明确信号而不是让它挂起（§4.6 最后一行）。
 */
export function answerInputRequest(params: AnswerInputRequestParams): InputAnswerResult {
  const questions = params.questions ?? [];
  const answers = questions.map(() => [INPUT_UNAVAILABLE_ANSWER] as readonly string[]);
  const audit: ApprovalAudit = {
    at: isoNow(params.now),
    kind: 'input',
    tool: 'input/request',
    rule: APPROVAL_RULES.inputUnavailable,
    decision: 'answer',
    reason: '无人值守场景：按固定话术应答，让 agent 用现有信息继续',
    worktreeRoot: params.worktreeRoot,
    inputDigest: previewRedacted(
      JSON.stringify(questions.map((question) => question.question ?? question.id ?? '')),
      240,
    ),
    answer: INPUT_UNAVAILABLE_ANSWER,
  };
  return { answers, audit };
}

/**
 * 本策略的决策 → RACP `approval/respond` 的 `decision`。
 * 统一用 `allow-once` 而不是 `allow-session`：一次性授权让「每次越界都会被拦」，
 * `allow-session` 会把这层拦截面在整条 session 上关掉。
 */
export function racpDecisionFor(decision: ApprovalOutcome): 'allow-once' | 'deny' {
  return decision === 'allow' ? 'allow-once' : 'deny';
}
