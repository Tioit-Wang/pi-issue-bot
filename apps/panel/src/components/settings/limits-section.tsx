/**
 * `limits` 分区：5 个会**直接掐断任务**的数字 + 默认模型。
 *
 * 每个字段的 hint 写的是后果（「超了会怎样」），不是技术名词：
 * 限额页真正要回答的是「我调大它会换来什么风险」。
 */
import { MODEL_NAME_RE } from '../../../../../packages/contract/src/index.ts';
import { Section } from '../Section.tsx';
import { NumberField, TextField } from './form.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';

type LimitKey = keyof SettingsSectionProps['state']['draft']['limits'];

const LIMIT_FIELDS: ReadonlyArray<{ key: LimitKey; label: string; min: number; max: number; hint: string }> = [
  {
    key: 'max_comments_per_hour',
    label: '每小时评论上限（1–200）',
    min: 1,
    max: 200,
    hint: '超了本仓库这一小时不再发评论：判定类静默跳过，命令类回一条「已限流」说明，不入队。',
  },
  {
    key: 'max_actions_per_run',
    label: '单次运行的动件上限（1–8）',
    min: 1,
    max: 8,
    hint: '一封信封里最多执行几个动作（打标/评论/reaction 合计）；信封自身也限 8，两处取小。',
  },
  {
    key: 'max_task_minutes',
    label: '单任务上限（1–30 分钟）',
    min: 1,
    max: 30,
    hint: '墙钟硬上限：超时按失败收尾（confused reaction + 审计记 timeout）。技能只能更短，不能更长。',
  },
  {
    key: 'concurrency_per_repo',
    label: '仓库级并发（1–8）',
    min: 1,
    max: 8,
    hint: '同时跑几个本仓库的任务。全局并发仍由部署常量兜底，两处取小。',
  },
  {
    key: 'queue_wait_minutes',
    label: '排队闸门（1–120 分钟）',
    min: 1,
    max: 120,
    hint: '排队超过这个时长就取消：任务记为 cancelled_queue + confused reaction，不发评论（无感反馈）。',
  },
];

export function LimitsSection({ state }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const limits = draft.limits;
  const model = draft.model ?? '';
  const modelError =
    model !== '' && !MODEL_NAME_RE.test(model) ? '形式必须是 provider/model（小写，例如 anthropic/claude-sonnet-4）' : null;
  const changed = countChangedPaths(state.base, draft).length;

  return (
    <div className="flex flex-col gap-6" data-testid="settings-limits">
      <Section
        first
        title="运行限额"
      >
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
          {LIMIT_FIELDS.map((field) => (
            <NumberField
              key={field.key}
              id={`limits-${field.key}`}
              label={field.label}
              value={limits[field.key]}
              min={field.min}
              max={field.max}
              hint={field.hint}
              onChange={(next) => {
                // 清空输入框不该把合法配置变成非法：保留最后一次的数值
                if (next === undefined) return;
                state.update((current) => ({ ...current, limits: { ...current.limits, [field.key]: next } }));
              }}
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
            />
          ))}
        </div>
      </Section>

      <Section title="默认模型" description="技能可以在自己的 frontmatter 里覆盖">
        <div className="max-w-md">
          <TextField
            id="limits-model"
            label="model（provider/model，可留空）"
            mono
            value={model}
            placeholder="anthropic/claude-sonnet-4"
            onChange={(next) => {
              state.update((current) => ({ ...current, model: next.trim() === '' ? undefined : next.trim() }));
            }}
            error={modelError}
            hint="留空 = 用部署默认模型（面板不改部署默认）。示例：anthropic/claude-sonnet-4、openai/gpt-5.1。"
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />
        </div>
      </Section>

      <SaveBar
        saveLabel="保存限额"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={modelError}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-limits"
      />
    </div>
  );
}