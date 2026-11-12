/**
 * v2.1「执行与限额」分区（`docs/v21-contract.md` §1 / §6.7 / FR-5.3）。
 *
 * 这一屏是**执行侧**的旋钮，不属于「什么事件叫我」（那是「事件与模板」），也不属于
 * v0.3 的 `limits`（每小时的评论上限、单任务墙钟上限那一套）——两套限额并存，各有各的
 * 作用域：`agent.limits` 是「一次会话怎么跑」，`limits` 是「流水线跑多快」。
 *
 * 三个契约细节决定了这里的形状：
 * 1. `system_prompt` 在契约里存了两处（`agent.system_prompt` 与 `agent.limits.system_prompt`），
 *    服务端的 `resolveAgentExecution()` 按「前者非空则优先，否则读后者」裁决。面板**两边一起写**：
 *    只写一处会出现「清空后旧的 `limits.system_prompt` 又被读回来」这种最难查的错。
 * 2. 后三类动作（建 issue / 开 PR / 关 issue）同样存两处，服务端按**或**裁决。同理两边一起写。
 * 3. 数值范围（并发 1–8、日配额 1–1000、单轮 1–30 分钟、保留 1–365 天）写死在契约 schema 里；
 *    越界的值只会在运行时变成事故，所以这里直接禁用保存并说明是哪一项越界。
 */
import type { AgentActions, RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { SYSTEM_PROMPT_MAX_CHARS } from '../../../../../packages/contract/src/index.ts';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Section } from '../Section.tsx';
import { cn } from '../../lib/utils.ts';
import { NumberField, SwitchField, TextAreaField } from './form.tsx';
import { SaveBar } from './save-bar.tsx';
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
      <Section
        first
        title="系统提示词"
        description="常驻角色设定：每次调用都带、不参与压缩；留空 = 用内置默认"
      >
        <div className="flex flex-col gap-2">
          <TextAreaField
            id="v21-agent-system-prompt"
            label="项目级系统提示词"
            value={agent.system_prompt}
            rows={8}
            placeholder="留空 = 用内置默认"
            onChange={setSystemPrompt}
            error={promptTooLong ? `超过 ${String(SYSTEM_PROMPT_MAX_CHARS)} 字符` : null}
            hint="写「这个仓库的规矩」（技术栈、命令、评审口径），不要写单次任务的指令——那属于事件模板。"
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
            footer={
              <p
                className={cn('text-2xs tabular', promptTooLong ? 'text-danger-fg' : 'text-faint')}
                data-testid="v21-agent-system-prompt-count"
              >
                {String(agent.system_prompt.length)} / {String(SYSTEM_PROMPT_MAX_CHARS)} 字符
              </p>
            }
          />
          <p className="text-2xs leading-relaxed text-faint">
            它不参与上下文压缩：写太长会让每一轮都变贵，也会挤掉真正要看的 issue 正文。
          </p>
        </div>
      </Section>

      <Section title="执行限额" description="超限时的行为都写在提示里；数值越界服务端会拒收">
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
              这三个开关会改变仓库的可见状态（多出 issue / 分支 / 被关闭的单）。干跑仓库
              （dry_run=true）下它们仍会被跳过，但开关本身照常保存；真正上线前建议先只开
              「建 issue」做灰度，确认产出质量再开另外两项。
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
