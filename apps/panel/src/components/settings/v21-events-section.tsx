/**
 * v2.1「事件与模板」分区（`docs/v21-contract.md` §1 / FR-2.1 ~ FR-2.5）。
 *
 * 这一屏回答一个问题：**「哪些事件会叫醒 agent，叫醒时我对它说什么」**。所以每个事件
 * 一行块，块内固定三段：开关（三态）→ 提示词模板 → 该事件特有的附加条件。
 *
 * 三个刻意的取舍：
 * 1. **开关用三态而不是布尔**：`conditional` 与 `off` 的区别是「条件不满足时不处理」与
 *    「永不处理」，两者在留痕（`decision_reason`）里完全不同，布尔表达不了。
 * 2. **`prompt: null` 显示成空输入框 + 一句「留空 = 用内置默认」**：契约里 `null` 表示
 *    「用内置模板」而不是「空模板」，所以界面上不能出现「空着 = 发空指令」的歧义。
 *    因此空串一律写回 `null`（唯一入口，避免出现 `''` 与 `null` 两种「没写」）。
 * 3. **附加条件只在该事件下渲染**：`only_body_changed` 写在 `issues.closed` 上不会生效
 *    （`resolveEventTrigger()` 对非 `issues.edited` 恒返回 `false`），与其渲染一个骗人的
 *    开关，不如不渲染。
 *
 * 所有改动都走 `draft.update()`（草稿层是唯一状态），不做本地 state 双写：保存的是整份
 * `settings`，双写会让「看到的值」与「要提交的值」出现两条真相。
 */
import type { EventKey, EventSwitch, RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { EVENT_PROMPT_MAX_CHARS } from '../../../../../packages/contract/src/index.ts';
import { Section } from '../Section.tsx';
import { cn } from '../../lib/utils.ts';
import { Segmented, SwitchField, TextAreaField, type SegmentedOption } from './form.tsx';
import { CheckboxMultiSelect } from './v21-fields.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';
import type { SettingsDraft } from './use-settings-draft.ts';

/** `settings.triggers.events` 的类型（五个事件的判别联合）。 */
type EventTriggers = RepoSettings['triggers']['events'];

/**
 * 五个事件的中文说明（顺序 = 展示顺序 = 契约 `EVENT_KEYS` 的顺序）。
 *
 * 文案写「什么时候来、意味着什么」，不写「事件名」——事件名已经在同一行的等宽标签里。
 */
const EVENT_META: ReadonlyArray<{ key: EventKey; title: string; description: string }> = [
  {
    key: 'issues.opened',
    title: '新开 issue',
    description: '有人新建 issue。最常见的入口：判定类型、格式化、给出第一轮结论。',
  },
  {
    key: 'issues.edited',
    title: 'issue 被编辑',
    description: '正文或标题被改。默认只认正文变更，避免改个标签就重跑一遍。',
  },
  {
    key: 'issues.labeled',
    title: 'issue 被打标签',
    description: '命中所配标签才触发（标签为空 = 永不触发，这是默认值）。',
  },
  {
    key: 'issues.closed',
    title: 'issue 被关闭',
    description: '默认关：关闭通常不需要 agent 再做什么，开了会消耗配额。',
  },
  {
    key: 'issue_comment.created',
    title: '有人在 issue 里评论',
    description: '要先过四个闸门（提及 / 角色 / 机器人 / 已关闭），全部通过才交给 agent。',
  },
];

/** 开关三态：文案说「会发生什么」，`title` 说细节。 */
const SWITCH_OPTIONS: readonly SegmentedOption<EventSwitch>[] = [
  { value: 'on', label: '直接触发', title: '事件一到就交给 agent，不看附加条件' },
  { value: 'conditional', label: '条件触发', title: '附加条件满足才触发（正文变更 / 命中标签 / 过闸门）' },
  { value: 'off', label: '不触发', title: '收到该事件也不处理，但仍会留痕（decision=ignored）' },
];

const SWITCH_LABEL: Record<EventSwitch, string> = {
  on: '直接触发',
  off: '不触发',
  conditional: '条件触发',
};

/**
 * 改**一个**事件的配置。
 *
 * 为什么中间要过一次 `Record`：`events` 是判别联合（评论事件多一层 `gates`），
 * `{ ...events[key], ...patch }` 在 `key: EventKey` 的位置上会被 TS 摊成
 * 「五个键同时成立」的交叉类型，直接下标赋值过不了类型检查。这里显式说明
 * 「先收成同构记录、写回时再断言回联合」——转换只发生在这一处，调用方拿到的仍是联合类型。
 */
function patchEvent<K extends EventKey>(state: SettingsDraft, event: K, patch: Partial<EventTriggers[K]>): void {
  state.update((current) => {
    const events = current.triggers.events as unknown as Record<EventKey, Record<string, unknown>>;
    const nextEvent: Record<string, unknown> = { ...events[event], ...patch };
    const nextEvents: Record<EventKey, Record<string, unknown>> = { ...events, [event]: nextEvent };
    return {
      ...current,
      triggers: { ...current.triggers, events: nextEvents as unknown as EventTriggers },
    };
  });
}

export function V21EventsSection({ state }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const events = draft.triggers.events;
  const changed = countChangedPaths(state.base, draft).length;

  /** `issues.labeled` 的候选：目录里的标签名（空名不参与，落库会被 schema 拒）。 */
  const labelCandidates = draft.labels.vocabulary
    .map((entry) => entry.name)
    .filter((name) => name.trim() !== '')
    .map((name) => ({ value: name, label: name }));

  /** 闸门 `allow_roles` 的候选：`comment.roles` 里已定义的角色名（引用不能凭空捏造）。 */
  const roleCandidates = draft.comment.roles
    .map((role) => role.name)
    .filter((name) => name.trim() !== '')
    .map((name) => ({ value: name, label: name }));

  const labelWarnings = labelCandidates.length === 0;
  const roleWarnings = roleCandidates.length === 0;

  const tooLong = EVENT_META.find((meta) => (events[meta.key].prompt ?? '').length > EVENT_PROMPT_MAX_CHARS);
  const blockedReason =
    tooLong === undefined
      ? null
      : `「${tooLong.title}」的提示词模板超过 ${String(EVENT_PROMPT_MAX_CHARS)} 字符（服务端会拒收）`;

  const counts = EVENT_META.reduce(
    (acc, meta) => {
      acc[events[meta.key].enabled] += 1;
      return acc;
    },
    { on: 0, off: 0, conditional: 0 } as Record<EventSwitch, number>,
  );

  const editedEvent = events['issues.edited'];
  const labeledEvent = events['issues.labeled'];
  const commentEvent = events['issue_comment.created'];

  const patchGates = (patch: Partial<typeof commentEvent.gates>): void => {
    patchEvent(state, 'issue_comment.created', { gates: { ...commentEvent.gates, ...patch } });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-events">
      <Section
        first
        title="事件与提示词模板"
        description="每个事件独立开关；提示词是「叫醒 agent 时说的第一句话」，留空用内置默认"
        actions={
          <span className="text-2xs text-faint tabular">
            直接 {String(counts.on)} · 条件 {String(counts.conditional)} · 关 {String(counts.off)}
          </span>
        }
      >
        <div className="flex flex-col gap-3">
          {EVENT_META.map((meta) => {
            const trigger = events[meta.key];
            const prompt = trigger.prompt ?? '';
            const promptTooLong = prompt.length > EVENT_PROMPT_MAX_CHARS;
            return (
              <div
                key={meta.key}
                className="flex min-w-0 flex-col gap-2 rounded-md border border-border px-2.5 py-2"
                data-testid={`v21-event-${meta.key}`}
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-xs text-brand">{meta.key}</span>
                      <span className="text-sm font-medium text-foreground">{meta.title}</span>
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{meta.description}</p>
                  </div>
                  <Segmented
                    name={`v21-event-switch-${meta.key}`}
                    value={trigger.enabled}
                    options={SWITCH_OPTIONS}
                    onChange={(next) => {
                      patchEvent(state, meta.key, { enabled: next });
                    }}
                    ariaLabel={`${meta.title}（${meta.key}）的触发方式`}
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                </div>

                <TextAreaField
                  id={`v21-event-prompt-${meta.key}`}
                  label="提示词模板（留空 = 用内置默认）"
                  value={prompt}
                  rows={3}
                  mono
                  placeholder="留空 = 用内置默认"
                  onChange={(next) => {
                    // 空串写回 `null`：契约里只有一种「没写」，落库形状不出现 `''`
                    patchEvent(state, meta.key, { prompt: next === '' ? null : next });
                  }}
                  error={promptTooLong ? `超过 ${String(EVENT_PROMPT_MAX_CHARS)} 字符` : null}
                  hint={
                    trigger.prompt === null
                      ? '当前用内置默认模板；要自定义就直接在这里写'
                      : '支持占位符（如 {{issue.title}}）；不参与压缩'
                  }
                  disabled={readOnly}
                  disabledReason="仓库已归档：只读"
                  footer={
                    <p
                      className={cn('text-2xs tabular', promptTooLong ? 'text-danger-fg' : 'text-faint')}
                      data-testid={`v21-event-prompt-count-${meta.key}`}
                    >
                      {String(prompt.length)} / {String(EVENT_PROMPT_MAX_CHARS)} 字符
                    </p>
                  }
                />

                {meta.key === 'issues.edited' ? (
                  <SwitchField
                    id="v21-event-edited-only-body"
                    label="只在正文变更时触发（only_body_changed）"
                    description="关掉后，改标题或改标签也会触发一次；开着更省配额，但改标题不会重新判定。"
                    checked={editedEvent.only_body_changed !== false}
                    onChange={(next) => {
                      patchEvent(state, 'issues.edited', { only_body_changed: next });
                    }}
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                ) : null}

                {meta.key === 'issues.labeled' ? (
                  <CheckboxMultiSelect
                    id="v21-event-labeled-labels"
                    label="命中的标签（命中任一即触发）"
                    values={labeledEvent.labels ?? []}
                    options={labelCandidates}
                    onChange={(next) => {
                      patchEvent(state, 'issues.labeled', { labels: next });
                    }}
                    emptyText="还没有可选的标签：先去「标签」或「标签目录 v2.1」分区配好词表"
                    hint={
                      (labeledEvent.labels ?? []).length === 0
                        ? '标签为空 = 永不触发（默认值）：勾一个以上才会在这个事件上叫醒 agent'
                        : '只在打了这些标签时才处理；同一 issue 会因多次打标被多次触发，靠去重挡住'
                    }
                    error={
                      labelWarnings && labeledEvent.enabled !== 'off'
                        ? '没有候选标签：这个事件现在永远不会触发'
                        : null
                    }
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                    testId="v21-labeled-targets"
                  />
                ) : null}

                {meta.key === 'issue_comment.created' ? (
                  <div className="flex flex-col gap-2 rounded-md bg-muted px-2.5 py-2">
                    <p className="text-2xs text-faint">
                      四个闸门（按「机器人 → 已关闭 → 提及 → 角色」的顺序判定，任一不通过都不处理，但会留痕）
                    </p>
                    <SwitchField
                      id="v21-gate-require-mention"
                      label="必须先 @ 到关键词（require_mention）"
                      description="关键词清单在「评论触发」分区维护；关掉后任何新评论都会触发（配额消耗会明显变快）。"
                      checked={commentEvent.gates.require_mention}
                      onChange={(next) => {
                        patchGates({ require_mention: next });
                      }}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <SwitchField
                      id="v21-gate-require-role"
                      label="限定角色（require_role）"
                      description="只处理下方所选角色发的评论；角色定义在「评论触发」分区。"
                      checked={commentEvent.gates.require_role}
                      onChange={(next) => {
                        patchGates({ require_role: next });
                      }}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <CheckboxMultiSelect
                      id="v21-allow-roles"
                      label="允许触发的角色（allow_roles）"
                      values={commentEvent.gates.allow_roles}
                      options={roleCandidates}
                      onChange={(next) => {
                        patchGates({ allow_roles: next });
                      }}
                      emptyText="还没有角色：先到「评论触发」分区定义角色，这里才有可选项"
                      hint={
                        commentEvent.gates.require_role
                          ? '只在「限定角色」开启时生效；留空 = 不限定角色，任何通过前面闸门的人都能触发'
                          : '「限定角色」当前是关的，这里选了也不生效'
                      }
                      error={
                        roleWarnings && commentEvent.gates.allow_roles.length > 0
                          ? '选中的角色已被删除：保存会被服务端拒绝，请改到「评论触发」重新配对'
                          : null
                      }
                      disabled={readOnly || roleWarnings}
                      disabledReason={
                        roleWarnings ? '还没有定义任何角色：先到「评论触发」分区定义角色' : '仓库已归档：只读'
                      }
                      testId="v21-allow-roles"
                    />
                    <SwitchField
                      id="v21-gate-ignore-bot"
                      label="忽略机器人自己发的评论（ignore_bot）"
                      description="关掉后 agent 会被自己的评论再次触发（自问自答），一般不要关。"
                      checked={commentEvent.gates.ignore_bot}
                      onChange={(next) => {
                        patchGates({ ignore_bot: next });
                      }}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <SwitchField
                      id="v21-gate-allow-closed"
                      label="已关闭的 issue 也响应（allow_closed）"
                      description="关掉时关闭后的新评论一律不处理（默认）；开着可以在收尾后继续答疑。"
                      checked={commentEvent.gates.allow_closed}
                      onChange={(next) => {
                        patchGates({ allow_closed: next });
                      }}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                  </div>
                ) : null}

                <p className="text-2xs text-faint" data-testid={`v21-event-state-${meta.key}`}>
                  当前：{SWITCH_LABEL[trigger.enabled]} · 模板 {trigger.prompt === null ? '内置默认' : '自定义'}
                </p>
              </div>
            );
          })}
        </div>

        <p className="mt-2 text-2xs leading-relaxed text-faint">
          pull_request.* 事件本期不处理：收到即按未触发留痕（decision_reason=pr-ignored），所以这里没有它的开关。
        </p>
      </Section>

      <SaveBar
        saveLabel="保存事件与模板"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={blockedReason}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-events"
      />
    </div>
  );
}
