/**
 * 「执行」分区（`docs/v21-contract.md` §1 / §6.7 / FR-5.3）。
 *
 * 这一屏是**执行侧**的旋钮，合并了两套限额：
 *  - `agent.limits`：一次会话怎么跑（并发 / 日配额 / 单轮超时 / 保留期）；
 *  - `limits`：任务本身跑多快（每小时评论上限 / 单次动作上限 / 单任务墙钟 / 仓库级并发 / 排队闸门）。
 * 两套以前分在两个分区，数字互相看不全；现在同屏，且每项只写一句「超了会怎样」。
 *
 * 三个契约细节决定了这里的形状：
 * 1. `system_prompt` 在契约里存了两处（`agent.system_prompt` 与 `agent.limits.system_prompt`），
 *    服务端按「前者非空则优先」裁决。面板**两边一起写**，否则「清空」会被旧值绕回去。
 * 2. 后三类动作（建 issue / 开 PR / 关 issue）同样存两处，服务端按**或**裁决。同理两边一起写。
 * 3. 数值范围写死在契约 schema 里；越界只会在运行时变成事故，所以这里直接禁用保存。
 */
import { useState } from 'react';
import type { AgentActions, RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { SaveBar } from './save-bar.tsx';
import { DEFAULT_SYSTEM_PROMPT, MODEL_NAME_RE, SYSTEM_PROMPT_MAX_CHARS } from '../../../../../packages/contract/src/index.ts';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Section } from '../Section.tsx';
import { cn } from '../../lib/utils.ts';
import { NumberField, SwitchField, TextAreaField, TextField } from './form.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';

type AgentConfig = RepoSettings['agent'];
type AgentExecution = AgentConfig['limits'];

/** 数值字段的展示配置（label / 范围 / 「调大它会换来什么风险」）。 */
const LIMIT_FIELDS: ReadonlyArray<{
  key: 'concurrency' | 'daily_quota' | 'turn_timeout_minutes' | 'data_retention_days';
  label: string;
  min: number;
  max: number;
  hint: string;
}> = [
  {
    key: 'concurrency',
    label: '并发会话数（1–8）',
    min: 1,
    max: 8,
    hint: '同一项目同时最多几个会话在跑；超出的排队等待，不丢弃。调大 = 成本与 GitHub rate limit 压力同比上升。',
  },
  {
    key: 'daily_quota',
    label: '日配额（1–1000 个事件）',
    min: 1,
    max: 1000,
    hint: '每天最多处理多少个事件；超出的拒绝处理并记录原因（可在审计里查）。用完当天不再处理，次日恢复。',
  },
  {
    key: 'turn_timeout_minutes',
    label: '单轮超时（1–30 分钟）',
    min: 1,
    max: 30,
    hint: '单轮执行的最长时长；超时终止并记 timed-out，不自动重试（避免卡在一轮里无限烧钱）。',
  },
  {
    key: 'data_retention_days',
    label: '数据保留天数（1–365）',
    min: 1,
    max: 365,
    hint: '对话 / 工具 / token 明细的保留天数；聚合指标永久保留（口径不变）。',
  },
];


/** v0.3 `limits` 的五个数字（并入「执行」分区，字段名保持契约原样）。 */
const LEGACY_LIMIT_FIELDS: ReadonlyArray<{
  key: keyof RepoSettings['limits'];
  label: string;
  min: number;
  max: number;
  hint: string;
}> = [
  {
    key: 'max_comments_per_hour',
    label: '每小时评论上限（1–200）',
    min: 1,
    max: 200,
    hint: '超了本仓库这一小时不再发评论。',
  },
  {
    key: 'max_actions_per_run',
    label: '单次运行动作上限（1–8）',
    min: 1,
    max: 8,
    hint: '一封信封里最多执行几个动作（打标/评论/reaction 合计）。',
  },
  {
    key: 'max_task_minutes',
    label: '单任务上限（1–30 分钟）',
    min: 1,
    max: 30,
    hint: '超时按失败收尾（confused reaction + 审计记 timeout）。',
  },
  {
    key: 'concurrency_per_repo',
    label: '仓库级并发（1–8）',
    min: 1,
    max: 8,
    hint: '同时跑几个本仓库的任务。',
  },
  {
    key: 'queue_wait_minutes',
    label: '排队闸门（1–120 分钟）',
    min: 1,
    max: 120,
    hint: '排队超过这个时长就取消（任务记为 cancelled_queue，不发评论）。',
  },
];
/** 三类写回动作：默认全关，每个开关旁写清「会改变仓库里什么可见状态」。 */
const ACTION_FIELDS: ReadonlyArray<{ key: keyof AgentActions; label: string; risk: string }> = [
  {
    key: 'create_issue',
    label: '允许 agent 新建 issue',
    risk: '会在仓库里真的建出 issue（对外可见）：判定跑偏时会污染 issue 列表，需要人清理。',
  },
  {
    key: 'open_pr',
    label: '允许 agent 开 PR',
    risk: '会推分支并开 PR（对外可见）：合并仍需人做（本期不合并 PR），但分支与通知已经发出去了。',
  },
  {
    key: 'close_issue',
    label: '允许 agent 关闭 issue',
    risk: '会改变 issue 状态（对外可见）：关错后要人工重开，且评论里的结论已经发出去了。',
  },
];

/** 数值越界的说明（`null` = 合法）。 */
function limitError(value: number, min: number, max: number): string | null {
  if (!Number.isInteger(value)) return '必须是整数';
  if (value < min) return `不能小于 ${String(min)}`;
  if (value > max) return `不能大于 ${String(max)}`;
  return null;
}

export function V21AgentSection({ state }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const agent = draft.agent;
  const execution = agent.limits;
  const changed = countChangedPaths(state.base, draft).length;

  const promptTooLong = agent.system_prompt.length > SYSTEM_PROMPT_MAX_CHARS;
  const outOfRange = LIMIT_FIELDS.map((field) => ({
    label: field.label,
    error: limitError(execution[field.key], field.min, field.max),
  })).find((item) => item.error !== null);
  const enabledActions = ACTION_FIELDS.filter((field) => agent.actions[field.key]).length;

  const blockedReason = promptTooLong
    ? `系统提示词超过 ${String(SYSTEM_PROMPT_MAX_CHARS)} 字符（每次调用都带，太长会把上下文窗口吃掉一半）`
    : outOfRange === undefined
      ? null
      : `${outOfRange.label}越界：${outOfRange.error ?? ''}`;

  const patchAgent = (patch: (current: AgentConfig) => AgentConfig): void => {
    state.update((current) => ({ ...current, agent: patch(current.agent) }));
  };

  /** 只改 `limits` 里的一个字段（`system_prompt` / `actions` 要两处同写，不走这里）。 */
  const patchExecution = (patch: Partial<AgentExecution>): void => {
    patchAgent((current) => ({ ...current, limits: { ...current.limits, ...patch } }));
  };

  /**
   * 改一个数值字段。
   *
   * 为什么用显式分支而不是 `{ [field.key]: next }`：`limits` 里既有数字也有字符串
   * （`system_prompt`）与布尔（`actions`），计算属性名会把整个对象写成「索引签名」类型，
   * 赋值回 `AgentExecution` 时不成立；四个分支一眼能看出只动了数值字段。
   */
  const patchNumber = (key: (typeof LIMIT_FIELDS)[number]['key'], value: number): void => {
    if (key === 'concurrency') patchExecution({ concurrency: value });
    else if (key === 'daily_quota') patchExecution({ daily_quota: value });
    else if (key === 'turn_timeout_minutes') patchExecution({ turn_timeout_minutes: value });
    else patchExecution({ data_retention_days: value });
  };

  /**
   * 系统提示词：`agent.system_prompt`（面板主路径）与 `agent.limits.system_prompt`
   * （迁移/部署可能只写这一处）**同时写**，否则「清空」会被服务端的
   * 「前者非空优先」规则绕回旧值。
   */
  const setSystemPrompt = (next: string): void => {
    patchAgent((current) => ({
      ...current,
      system_prompt: next,
      limits: { ...current.limits, system_prompt: next },
    }));
  };

  /** 动作开关：两处同时写（服务端按「或」裁决，只写一处会让另一处看起来失效）。 */
  const setAction = (key: keyof AgentActions, value: boolean): void => {
    patchAgent((current) => {
      const actions: AgentActions = {
        create_issue: key === 'create_issue' ? value : current.actions.create_issue,
        open_pr: key === 'open_pr' ? value : current.actions.open_pr,
        close_issue: key === 'close_issue' ? value : current.actions.close_issue,
      };
      const limitActions: AgentActions = {
        create_issue: key === 'create_issue' ? value : current.limits.actions.create_issue,
        open_pr: key === 'open_pr' ? value : current.limits.actions.open_pr,
        close_issue: key === 'close_issue' ? value : current.limits.actions.close_issue,
      };
      return { ...current, actions, limits: { ...current.limits, actions: limitActions } };
    });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-execution">
      <Section first title="系统提示词">
        <SystemPromptField stored={agent.system_prompt} readOnly={readOnly} onChange={setSystemPrompt} />
      </Section>

      <Section title="执行限额">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
          {LIMIT_FIELDS.map((field) => (
            <NumberField
              key={field.key}
              id={`v21-execution-${field.key}`}
              label={field.label}
              value={execution[field.key]}
              min={field.min}
              max={field.max}
              onChange={(next) => {
                // 清空输入框不该把合法配置变成非法：保留最后一次的数值
                if (next === undefined) return;
                patchNumber(field.key, next);
              }}
              error={limitError(execution[field.key], field.min, field.max)}
              hint={field.hint}
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
            />
          ))}
          {/*
            v0.3 的 `limits`（评论上限 / 动作上限 / 任务墙钟 / 仓库并发 / 排队闸门）与默认模型
            并入本分区：它们与上面的 `agent.limits` 都是「跑起来会掐断任务」的数字，
            分两页只会让人来回对照。字段名仍是契约原样，不做改名。
          */}
          {LEGACY_LIMIT_FIELDS.map((field) => (
            <NumberField
              key={field.key}
              id={`limits-${field.key}`}
              label={field.label}
              value={draft.limits[field.key]}
              min={field.min}
              max={field.max}
              hint={field.hint}
              onChange={(next) => {
                if (next === undefined) return;
                state.update((current) => ({ ...current, limits: { ...current.limits, [field.key]: next } }));
              }}
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
            />
          ))}
        </div>
        <div className="mt-3 max-w-md">
          <TextField
            id="limits-model"
            label="默认模型（provider/model，可留空）"
            mono
            value={draft.model ?? ''}
            placeholder="anthropic/claude-sonnet-4"
            onChange={(next) => {
              state.update((current) => ({ ...current, model: next.trim() === '' ? undefined : next.trim() }));
            }}
            error={
              draft.model !== undefined && !MODEL_NAME_RE.test(draft.model)
                ? '形式必须是 provider/model（小写）'
                : null
            }
            hint="留空 = 用部署默认模型；技能可在 frontmatter 里覆盖。"
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />
        </div>
      </Section>

      <Section
        title="写回动作（后三类）"
        description="默认全关：这三类会外溢到仓库可见状态，前四类（结论 / 标签 / 评论 / reaction）只作用于当前 issue"
        actions={
          <span className="text-2xs text-faint tabular" data-testid="v21-execution-actions-count">
            已开 {String(enabledActions)} / {String(ACTION_FIELDS.length)}
          </span>
        }
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-col divide-y divide-border">
            {ACTION_FIELDS.map((field) => (
              <SwitchField
                key={field.key}
                id={`v21-execution-action-${field.key}`}
                label={field.label}
                description={field.risk}
                checked={agent.actions[field.key]}
                onChange={(next) => {
                  setAction(field.key, next);
                }}
                disabled={readOnly}
                disabledReason="仓库已归档：只读"
              />
            ))}
          </div>

          <Alert tone="warn" data-testid="v21-execution-actions-note">
            <AlertDescription>
              这三个开关会改变仓库的可见状态（多出 issue / 分支 / 被关闭的单）。关闭「写回 GitHub」时
              它们仍会被跳过；上线前建议先只开「建 issue」做灰度。
            </AlertDescription>
          </Alert>
        </div>
      </Section>

      <SaveBar
        saveLabel="保存执行设置"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={blockedReason}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-execution"
      />
    </div>
  );
}

/**
 * 系统提示词输入框：**未自定义时显示内置默认值**，但保留用户正在编辑的内容。
 *
 * 与事件模板同一个坑：直接受控在 `stored || 默认值` 上时，清空会被立刻填回来。
 */
function SystemPromptField({
  stored,
  readOnly,
  onChange,
}: {
  stored: string;
  readOnly: boolean;
  onChange: (next: string) => void;
}) {
  const fallback = DEFAULT_SYSTEM_PROMPT;
  const external = stored.trim() === '' ? fallback : stored;
  const [text, setText] = useState(external);
  const [seen, setSeen] = useState(external);
  // 同 TemplateField：清空（→ '' → 显示默认）不能被自己的回写立刻填回来
  const equivalent = text.trim() === '' || text === fallback ? fallback : text;
  if (seen !== external) {
    setSeen(external);
    if (external !== equivalent) setText(external);
  }

  const tooLong = text.length > SYSTEM_PROMPT_MAX_CHARS;
  return (
    <TextAreaField
      id="v21-agent-system-prompt"
      label="项目级系统提示词"
      value={text}
      rows={8}
      placeholder="留空 = 用内置默认"
      onChange={(next) => {
        setText(next);
        // 与内置默认逐字相同 = 「没自定义」，写回空串（服务端据此回落默认）
        onChange(next === DEFAULT_SYSTEM_PROMPT ? '' : next);
      }}
      error={tooLong ? `超过 ${String(SYSTEM_PROMPT_MAX_CHARS)} 字符` : null}
      hint="写这个仓库的规矩（技术栈、命令、评审口径）；每次调用都带、不参与压缩。"
      disabled={readOnly}
      disabledReason="仓库已归档：只读"
      footer={
        <p
          className={cn('text-2xs tabular', tooLong ? 'text-danger-fg' : 'text-faint')}
          data-testid="v21-agent-system-prompt-count"
        >
          {String(text.length)} / {String(SYSTEM_PROMPT_MAX_CHARS)} 字符
        </p>
      }
    />
  );
}
