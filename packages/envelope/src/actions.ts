/**
 * 动作白名单与「不合规动作丢弃」的纯函数（plan §5 / tech-plan §5.6 / contract-skill §4.2 运行期）。
 *
 * 三个必须落在这里的规则：
 * 1. **intent 白名单只有 plan §5 那 4 类**；`open_pr` 不是 intent（是 `push_branch.openPr`），
 *    `close_issue` 由控制面的确定性条件触发，agent 永远不能声明。
 * 2. **`push_branch` 必须带 `paths`**，且路径不许绝对、不许 `..` 出仓、不许命中拒收清单
 *    （`.git/`、`.github/workflows/**`、`.gitmodules`、技能文件）。
 * 3. 丢弃的原因是**结构化枚举**，因为它要进 `run_events` 与面板详情页，
 *    不能让每个调用点自己编字符串。
 */
import type { EnvelopeAction, EnvelopeActionIntent, TaskEnvelope } from './schema.ts';
import { BRANCH_RE, FINGERPRINT_RE, MAX_COMMENT_BODY } from './schema.ts';

/** 信封允许的 intent（plan §5 的字面 4 类）。 */
export const ACTION_INTENTS = ['comment', 'label', 'create_issue', 'push_branch'] as const;

/** 丢弃原因（进审计与面板，改动即契约变更）。 */
export const DROP_REASONS = [
  'unknown-intent', // 不在 4 类白名单（例如模型自创 `open_pr` / `close_issue`）
  'malformed-action', // 字段形状不合规（缺 body、空标签集合、标题超长…）
  'not-allowed-by-skill', // 技能 `outputs` 不含该动作类型
  'missing-paths', // push_branch 没有 paths（tech-plan §5.6）
  'path-protected', // paths 命中拒收清单
  'path-not-allowed', // 绝对路径 / `..` 出仓 / 超长
  'branch-not-allowed', // 分支名不在 `bot/*`
  'push-branch-disabled', // 写回闸门未开启（M4 之前 / dry-run 档）
  'label-not-allowed', // 标签不在仓库配置的映射集合里（R4：不发明新标签）
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** 拒收清单（硬编码，不可配置放宽；tech-plan §5.6 + contract-skill §1）。 */
export const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/, // .git/ 下任何路径，含 hooks 与 config
  /^\.github\/workflows(\/|$)/, // CI 定义：容器里的代码不许改流水线
  /(^|\/)\.gitmodules$/, // submodule 会拉起额外的执行
  /^\.github\/pi-bot(\/|$)/, // 机器人自己的配置与技能文件（只有人提交能改）
];

/** 判断一个未知值是不是合法 intent。 */
export function isActionIntent(value: unknown): value is EnvelopeActionIntent {
  return typeof value === 'string' && (ACTION_INTENTS as readonly string[]).includes(value);
}

/** 判断一条路径是否命中拒收清单。 */
export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export interface ActionFilterOptions {
  /** 技能 `outputs` 允许的 intent 集合；缺省 = 4 类全部允许。 */
  allowedIntents?: readonly EnvelopeActionIntent[];
  /** 是否允许 `push_branch`（写回闸门未开启时传 false）；缺省允许。 */
  allowPushBranch?: boolean;
  /** 仓库配置映射出的标签集合；给定则只接受其中的标签。 */
  allowedLabels?: readonly string[];
}

export interface DroppedAction {
  /** 在 `envelope.actions` 里的下标（审计要能定位到原文）。 */
  index: number;
  /** 原始 intent（未知时是原始字符串）。 */
  intent: string;
  reason: DropReason;
  /** 人可读的一句话，进 `run_events.payload`。 */
  detail: string;
}

export interface FilteredActions {
  accepted: EnvelopeAction[];
  dropped: DroppedAction[];
}

/** 校验 paths 数组，返回丢弃原因或 null。 */
function checkPaths(paths: unknown): { reason: DropReason; detail: string } | null {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { reason: 'missing-paths', detail: 'push_branch 必须带 paths（至少 1 条，相对仓库根）' };
  }
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) {
      return { reason: 'path-not-allowed', detail: `非法路径：${JSON.stringify(raw)}` };
    }
    if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
      return { reason: 'path-not-allowed', detail: `不接受绝对路径：${raw}` };
    }
    if (raw.split('/').includes('..')) {
      return { reason: 'path-not-allowed', detail: `不接受出仓路径：${raw}` };
    }
    if (isProtectedPath(raw)) {
      return { reason: 'path-protected', detail: `命中拒收清单：${raw}` };
    }
  }
  return null;
}

/**
 * 过滤一封信封的动作。
 *
 * 语义是「**逐个丢弃**」而不是「整封信封失败」：一个好动作不该被一个坏动作连累
 * （contract-skill §4.2 运行期）。只有信封整体校验失败才记 `parse` 失败。
 */
export function filterActions(envelope: TaskEnvelope, options: ActionFilterOptions = {}): FilteredActions {
  const accepted: EnvelopeAction[] = [];
  const dropped: DroppedAction[] = [];
  const rawActions: unknown[] = Array.isArray(envelope.actions) ? envelope.actions : [];

  rawActions.forEach((raw, index) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const intent = typeof record['intent'] === 'string' ? record['intent'] : '<missing>';
    const drop = (reason: DropReason, detail: string) => {
      dropped.push({ index, intent, reason, detail });
    };

    if (!isActionIntent(record['intent'])) {
      drop('unknown-intent', `intent 不在白名单（${ACTION_INTENTS.join(' / ')}）：${intent}`);
      return;
    }
    const known = record['intent'];

    if (options.allowedIntents !== undefined && !options.allowedIntents.includes(known)) {
      drop('not-allowed-by-skill', `技能的 outputs 不允许 ${known}`);
      return;
    }

    switch (known) {
      case 'comment': {
        const body = record['body'];
        if (typeof body !== 'string' || body.trim().length === 0) {
          drop('malformed-action', 'comment 缺非空 body');
          return;
        }
        if (body.length > MAX_COMMENT_BODY) {
          drop('malformed-action', `comment body 超长：${body.length} > ${MAX_COMMENT_BODY}`);
          return;
        }
        accepted.push({ intent: 'comment', body });
        return;
      }
      case 'label': {
        const add = record['add'];
        const remove = record['remove'];
        if (add === undefined && remove === undefined) {
          drop('malformed-action', 'label 动作既没有 add 也没有 remove');
          return;
        }
        if (add !== undefined && !Array.isArray(add)) {
          drop('malformed-action', 'label.add 不是数组');
          return;
        }
        if (remove !== undefined && !Array.isArray(remove)) {
          drop('malformed-action', 'label.remove 不是数组');
          return;
        }
        const addList = (add ?? []) as unknown[];
        const removeList = (remove ?? []) as unknown[];
        if (addList.length === 0 && removeList.length === 0) {
          drop('malformed-action', 'label 的 add/remove 都是空集合');
          return;
        }
        const labels = [...addList, ...removeList];
        if (labels.some((label) => typeof label !== 'string' || label.length === 0 || label.length > 50)) {
          drop('malformed-action', 'label 里有非法标签名');
          return;
        }
        if (options.allowedLabels !== undefined) {
          const allowed = options.allowedLabels;
          const outside = (labels as string[]).filter((label) => !allowed.includes(label));
          if (outside.length > 0) {
            drop('label-not-allowed', `标签不在仓库配置的映射集合里：${outside.join(', ')}`);
            return;
          }
        }
        const action: EnvelopeAction = { intent: 'label' };
        if (addList.length > 0) {
          action.add = addList as string[];
        }
        if (removeList.length > 0) {
          action.remove = removeList as string[];
        }
        accepted.push(action);
        return;
      }
      case 'create_issue': {
        const title = record['title'];
        const fingerprint = record['fingerprint'];
        if (typeof title !== 'string' || title.trim().length === 0 || title.length > 120) {
          drop('malformed-action', 'create_issue 的 title 缺失或超长（≤120）');
          return;
        }
        if (typeof fingerprint !== 'string' || !new RegExp(FINGERPRINT_RE).test(fingerprint)) {
          drop('malformed-action', 'create_issue 的 fingerprint 形状不合规（^[a-z0-9][a-z0-9:._-]{2,63}$）');
          return;
        }
        const body = record['body'];
        if (body !== undefined && (typeof body !== 'string' || body.length > 20_000)) {
          drop('malformed-action', 'create_issue 的 body 不是字符串或超长（≤20000）');
          return;
        }
        const action: EnvelopeAction = { intent: 'create_issue', title, fingerprint };
        if (typeof body === 'string') {
          action.body = body;
        }
        accepted.push(action);
        return;
      }
      case 'push_branch': {
        if (options.allowPushBranch === false) {
          drop('push-branch-disabled', '写回闸门未开启（M4 之前 / dry-run），push_branch 不执行');
          return;
        }
        const branch = record['branch'];
        if (typeof branch !== 'string' || !new RegExp(BRANCH_RE).test(branch)) {
          drop('branch-not-allowed', `分支名必须在 bot/* 且为小写：${String(branch)}`);
          return;
        }
        const pathCheck = checkPaths(record['paths']);
        if (pathCheck !== null) {
          drop(pathCheck.reason, pathCheck.detail);
          return;
        }
        const action: EnvelopeAction = { intent: 'push_branch', branch, paths: record['paths'] as string[] };
        if (typeof record['openPr'] === 'boolean') {
          action.openPr = record['openPr'];
        }
        accepted.push(action);
        return;
      }
      default: {
        // `isActionIntent` 之后不可达；留作类型收敛的兜底。
        drop('unknown-intent', `未处理的 intent：${known as string}`);
      }
    }
  });

  return { accepted, dropped };
}

/** 丢弃原因的中文文案（面板详情页与异常兜底通知共用）。 */
export const DROP_REASON_TEXT: Readonly<Record<DropReason, string>> = {
  'unknown-intent': '动作类型不在允许的 4 类内',
  'malformed-action': '动作字段不合规',
  'not-allowed-by-skill': '技能未声明该类产出',
  'missing-paths': '推分支缺 paths 声明',
  'path-protected': '声明的路径命中拒收清单',
  'path-not-allowed': '声明的路径越界',
  'branch-not-allowed': '分支名不在 bot/*',
  'push-branch-disabled': '推分支闸门未开启',
  'label-not-allowed': '标签不在仓库映射里',
};
