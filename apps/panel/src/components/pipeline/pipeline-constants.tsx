import type { ReactNode } from 'react';
import type { PromptKind } from '../../lib/contract.ts';
import type { Tone } from '../ui/status.ts';

/**
 * 流水线页的**只读常量与门禁表**（`docs/plan-fixed-pipeline.md` §8 + §4.5 + §1.2）。
 *
 * 为什么放这里而不是从服务端取：
 *  - 系统常量（`PIPELINE_FORMAT_MAX_FAILS` / `SESSION_MAX_TURNS` …）是**编译期常量**，
 *    改它们要发版，`repos.settings` 里没有对应键（V12 的 `.strict()` 会拒收），所以面板只展示；
 *  - 门禁处置表是**行为说明**（代码里 if/else 的判定），不是配置；写成数据是为了让页面
 *    「状态 → 处置 → 理由」三列对齐，而不是三段散文。
 */

/** 命令 / 字段名一律等宽（设计系统 §2）。 */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-foreground">{children}</span>;
}

export type SystemConstant = {
  name: string;
  value: string;
  unit: string;
  /** 口径（为什么是这个数、它管哪一段）——一行，不写句子。 */
  note?: string;
};

export const SYSTEM_CONSTANTS: readonly SystemConstant[] = [
  {
    name: 'PIPELINE_FORMAT_MAX_FAILS',
    value: '5',
    unit: '次',
    note: '格式不通过累计到 5 次 → 自动关 issue（不是 blocked）；第 5 次的评论即最后反馈',
  },
  {
    name: 'PIPELINE_CLOSE_AFTER_HOURS',
    value: '48',
    unit: '小时',
    note: '只扫 format/awaiting_info 等用户补充；classify 等管理员不进扫描',
  },
  {
    name: 'fail_streak → blocked',
    value: '2',
    unit: '次',
    note: '运行失败 / 信封不合法连续 2 次；重跑不限次数，只计失败',
  },
  { name: 'SESSION_MAX_TURNS', value: '30', unit: '轮', note: '达到就轮换：archive 旧会话 + 新建' },
  { name: 'SESSION_MAX_AGE', value: '7', unit: '天' },
  {
    name: 'PROMPT_LIMITS.body',
    value: '4 000',
    unit: '字符',
    note: '只约束 agent 阶段提示词（format_check 另需 {{title}} / {{body}}）',
  },
  {
    name: 'COMMENT_COOLDOWN_SECONDS',
    value: '120',
    unit: '秒',
    note: 'issues.edited 的重跑冷却；120s 内已有评论触发则跳过',
  },
];

/** 四条提示词版本线（§4.4 的 `PROMPT_KINDS`，**顺序即阶段顺序**）。 */
export const PROMPT_KIND_LABEL: Record<PromptKind, string> = {
  project: '项目约定',
  format_check: '格式检查',
  classify: '分类',
  agent: 'Agent',
};

/** 三个阶段各自那条版本线（`project` 是并列的用户设定层，不是阶段）。 */
export const STAGE_PROMPT_KINDS = ['format_check', 'classify', 'agent'] as const;

/** 提示词指针的展示值：`v3 · 项目版本` / `系统默认`。 */
export function promptPointerText(version: number): { text: string; project: boolean } {
  return version > 0 ? { text: `v${String(version)} · 项目版本`, project: true } : { text: '系统默认', project: false };
}

/** 门禁表的一行（§8 的七行，顺序即表顺序）。 */
export type GateRow = {
  key: string;
  status: {
    label: string;
    /** 有 tone → 圆点 + 低饱和徽章；没有 → 中性描边。 */
    tone?: Tone;
    outline?: boolean;
  };
  /** 收到 `@` 时的处置。 */
  action: ReactNode;
  /** 为什么这么处置（`text-faint`，不抢第一列）。 */
  reason: string;
};

export const GATE_ROWS: readonly GateRow[] = [
  {
    key: 'pending',
    status: { label: 'pending / 任意阶段', tone: 'info' },
    action: '只打 eyes，不建任务、不回复',
    reason: '已入队但还没跑：回复是噪音',
  },
  {
    key: 'running',
    status: { label: 'running / 任意阶段', tone: 'info' },
    action: '只打 eyes，不建任务、不回复',
    reason: '避免两个任务并发写同一个会话',
  },
  {
    key: 'awaiting-user',
    status: { label: 'format/awaiting_info · 等用户', tone: 'warn' },
    action: (
      <>
        回一条提醒（<Mono>pipeline:notice</Mono>），每 issue 每小时 1 条
      </>
    ),
    reason: '补信息类普通评论不受此限：先当补充，再触发重跑（评论优先）',
  },
  {
    key: 'awaiting-manager',
    status: { label: 'classify/awaiting_info · 等管理员', tone: 'warn' },
    action: '回一条「已转管理员分类」，不建任务',
    reason: '只有 managers 的评论 / 指令能推进，作者与他人评论只记录',
  },
  {
    key: 'blocked',
    status: { label: 'blocked', tone: 'danger' },
    action: (
      <>
        回一条 <Mono>/recheck --force</Mono> 或 <Mono>/pipeline next</Mono> 提示
      </>
    ),
    reason: '不自动重跑，避免把失败循环放大；同样限速',
  },
  {
    key: 'closed',
    status: { label: 'closed', outline: true },
    action: '静默：不建任务、不回评论',
    reason: 'reopen 由 GitHub 事件重新入队',
  },
  {
    key: 'ready',
    status: { label: '无行 / ready', outline: true },
    action: '正常建任务，进阶段 2 会话',
    reason: '不重跑阶段 0 / 1，已有结论直接复用',
  },
];
