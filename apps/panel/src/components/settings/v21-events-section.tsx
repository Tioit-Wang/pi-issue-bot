/**
 * 「事件绑定设置」分区（`docs/v21-contract.md` §1 / FR-2.1 ~ FR-2.5）。
 *
 * 这一屏回答一个问题：**「哪些事件会叫醒 agent，叫醒时我对它说什么」**。
 *
 * 布局是「标签页 + 满高编辑区」，四条都是需求直接要求的：
 * 1. **五个事件改成标签页**：一次只看一个事件，避免五个模板框纵向堆在一起（原来的写法
 *    让每个框都只有 3 行高，改长模板要不停地滚）；
 * 2. **提示词编辑区吃掉标签页之外的剩余高度**：一屏能看到尽量多的模板；
 * 3. **整页不出现滚动条**：外壳（`AppLayout`）与本页都用 `h-full + min-h-0` 把高度锁在
 *    视口内，滚动只发生在该滚的地方；
 * 4. **模板内容多了只在文本框内滚**（`TextAreaField fill`）。
 *
 * 未开启的事件（`off`）：标签置灰、面板内容整体不可编辑，**只有开关能点**——
 * 一个关掉的事件调模板是纯粹的无效劳动，而保留开关可点是因为「关掉」这个状态本身
 * 要能改回来。
 *
 * 三个保留的取舍：
 * 1. **开关仍是三态**（`on` / `conditional` / `off`）：`conditional` 与 `off` 的区别是
 *    「条件不满足时不处理」与「永不处理」，留痕（`decision_reason`）里完全不同，
 *    布尔表达不了。
 * 2. **模板框里直接显示生效内容**：未自定义时填内置默认模板（契约 `DEFAULT_EVENT_TEMPLATES`）。
 * 3. **附加条件只在该事件下渲染**：`only_body_changed` 写在其它事件上不会生效，
 *    与其渲染一个骗人的开关，不如不渲染。
 *
 * 所有改动都走 `draft.update()`（草稿层是唯一状态），不做本地 state 双写。
 */
import { useState } from 'react';
import type { EventKey, EventSwitch, RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { DEFAULT_EVENT_TEMPLATES, EVENT_PROMPT_MAX_CHARS, PROMPT_PLACEHOLDERS } from '../../../../../packages/contract/src/index.ts';
import { cn } from '../../lib/utils.ts';
import { ChipEditor, Segmented, SwitchField, TextAreaField, TextField, type SegmentedOption } from './form.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import { TriggerAdvanced } from './triggers-section.tsx';
import { CheckboxMultiSelect } from './v21-fields.tsx';
import type { SettingsDraft } from './use-settings-draft.ts';
import type { SettingsSectionProps } from './section-props.ts';

/** `settings.triggers.events` 的类型（五个事件的判别联合）。 */
type EventTriggers = RepoSettings['triggers']['events'];

/** 五个事件的标题（顺序 = 契约 `EVENT_KEYS`）。 */
const EVENT_META: ReadonlyArray<{ key: EventKey; title: string; short: string }> = [
  { key: 'issues.opened', title: '新开 issue', short: '新开' },
  { key: 'issues.edited', title: 'issue 被编辑', short: '编辑' },
  { key: 'issues.labeled', title: 'issue 被打标签', short: '打标签' },
  { key: 'issues.closed', title: 'issue 被关闭', short: '关闭' },
  { key: 'issue_comment.created', title: 'issue 有新评论', short: '新评论' },
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
 * 「五个键同时成立」的交叉类型，直接下标赋值过不了类型检查。
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

  const [activeKey, setActiveKey] = useState<EventKey>(EVENT_META[0]?.key ?? 'issues.opened');
  const active = EVENT_META.find((meta) => meta.key === activeKey) ?? EVENT_META[0]!;
  const activeTrigger = events[active.key];
  /** 关掉的事件：面板整体锁住，只有开关可点（需求：置灰 + 不可编辑）。 */
  const activeOff = activeTrigger.enabled === 'off';

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

  /** 提及关键词（`settings.comment.mentions`）：与评论闸门同一屏维护。 */
  const mentions = draft.comment.mentions.map((mention) => mention.keyword);
  const setMentions = (next: string[]): void => {
    if (next.length === 0) return;
    state.update((current) => ({
      ...current,
      comment: {
        ...current.comment,
        // 空数组在契约里非法（min 1）：ChipEditor 的最后一个删除动作被这里挡掉
        mentions: next.map((keyword) => ({ keyword })),
      },
    }));
  };

  return (
    /*
高度链：本页 `h-full` 撑满外壳的 content 区（外壳已改为视口高度、`main` 为滚动容器），
再往下每一层都带 `min-h-0`，否则 flex 子项的最小内容高度会把容器撑破 → 页面出现滚动条。
这是「整页无滚动条」的实现骨架，不是样式微调。
*/
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3" data-testid="settings-events">
      {/*
标签栏：下划线式（与 `ui/tabs.tsx` 的选区语言一致）。这里不复用那个组件，
因为它把 tablist 与 tabpanel 包在一个 `flex-col gap-3` 里、面板高度由内容决定；
本页需要「标签栏定高、面板吃剩余高度」，并且每个标签要能表达「未开启」的置灰态。
键盘行为照抄同一套：←/→ 切换 + roving tabindex。
*/}
      <div
        role="tablist"
        aria-label="事件绑定"
        className="flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-border"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          const index = EVENT_META.findIndex((meta) => meta.key === activeKey);
          if (index < 0) return;
          event.preventDefault();
          const next =
            event.key === 'ArrowRight' ? (index + 1) % EVENT_META.length : (index - 1 + EVENT_META.length) % EVENT_META.length;
          const target = EVENT_META[next];
          if (target === undefined) return;
          setActiveKey(target.key);
          const button = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next];
          button?.focus();
        }}
      >
        {EVENT_META.map((meta) => {
          const selected = meta.key === activeKey;
          const enabled = events[meta.key].enabled;
          const off = enabled === 'off';
          return (
            <button
              key={meta.key}
              type="button"
              role="tab"
              id={`v21-event-tab-${meta.key}`}
              aria-selected={selected}
              aria-controls="v21-event-panel"
              tabIndex={selected ? 0 : -1}
              data-testid={`v21-event-tab-${meta.key}`}
              data-off={off ? 'true' : 'false'}
              title={`${meta.title}（${meta.key}）· ${SWITCH_LABEL[enabled]}`}
              onClick={() => {
                setActiveKey(meta.key);
              }}
              className={cn(
                'relative -mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-1.5 py-1.5 text-sm font-medium whitespace-nowrap',
                'transition-[color,border-color,opacity] duration-[120ms] ease-out-quint',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                selected ? 'border-brand' : 'border-transparent',
                /*
置灰用文字色 + 一个状态点，不整体 `opacity-50`：标签上还有「未开启」这个信息，
整块半透明会让它和「禁用」混淆，而它其实是**可点的**（点开看配置，只是不能编辑）。
*/
                off ? 'text-faint hover:text-muted-foreground' : selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {meta.short}
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  off ? 'bg-subtle' : enabled === 'on' ? 'bg-success' : 'bg-warn',
                )}
              />
              <span className="sr-only">{off ? '未开启' : SWITCH_LABEL[enabled]}</span>
            </button>
          );
        })}
      </div>

      {/*
面板：`flex-1 min-h-0` 吃剩余高度，内部再分「定高的头部 + 吃剩余的编辑区」。
`aria-labelledby` 指向当前标签，读屏时知道这一块属于哪个事件。
*/}
      <div
        role="tabpanel"
        id="v21-event-panel"
        aria-labelledby={`v21-event-tab-${active.key}`}
        className="flex min-h-0 flex-1 flex-col gap-2"
        data-testid={`v21-event-${active.key}`}
        data-off={activeOff ? 'true' : 'false'}
      >
        {/* 头部：事件名 + 开关（**唯一**在未开启时仍可点的控件） */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-foreground">{active.title}</span>
            <span className="font-mono text-xs text-brand">{active.key}</span>
            <span className="text-2xs text-faint" data-testid={`v21-event-state-${active.key}`}>
              {SWITCH_LABEL[activeTrigger.enabled]} · 模板 {activeTrigger.prompt === null ? '内置默认' : '自定义'}
            </span>
          </p>
          <Segmented
            name={`v21-event-switch-${active.key}`}
            value={activeTrigger.enabled}
            options={SWITCH_OPTIONS}
            onChange={(next) => {
              patchEvent(state, active.key, { enabled: next });
            }}
            ariaLabel={`${active.title}（${active.key}）的触发方式`}
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />
        </div>

        {activeOff ? (
          <p className="shrink-0 text-2xs text-faint" data-testid="v21-event-off-note">
            这个事件当前不触发：把右上角改成「直接触发」或「条件触发」才能编辑下面的内容。
          </p>
        ) : null}

        {/*
可编辑区：未开启时套 `inert`（不可聚焦、不可点、读屏跳过），并盖上「未开启」的说明。
`inert` 而不是逐个 `disabled`：这里子控件有十来个（含评论闸门、角色清单），
逐个传 `disabled` 一定会漏，漏掉的那个就成了「关着也能改」。
视觉上用 `opacity-60` 置灰，与 `inert` 一起表达同一个状态。
*/}
        <div
          className={cn('flex min-h-0 flex-1 flex-col gap-2', activeOff && 'pointer-events-none opacity-60')}
          inert={activeOff || undefined}
          aria-hidden={activeOff || undefined}
          data-testid="v21-event-editable"
        >
          <TemplateField
            eventKey={active.key}
            stored={activeTrigger.prompt}
            readOnly={readOnly}
            onChange={(next) => {
              /*
                与内置默认「逐字相同」（换行归一化后）视为「没自定义」，写回 null：
                契约里只有一种「没写」，空串与 null 不能两种都存在。
                换行要归一化：浏览器 textarea 提交的是 \n，但粘贴源可能是 \r\n。
              */
              const normalize = (value: string): string => value.replace(/\r\n/gu, '\n');
              const isDefault = normalize(next) === normalize(DEFAULT_EVENT_TEMPLATES[active.key]);
              patchEvent(state, active.key, { prompt: next === '' || isDefault ? null : next });
            }}
          />

          {active.key === 'issues.edited' ? (
            <SwitchField
              id="v21-event-edited-only-body"
              label="正文变更才触发"
              description="开启后只认正文变化；关闭后改标题或标签也会触发。"
              checked={events['issues.edited'].only_body_changed !== false}
              onChange={(next) => {
                patchEvent(state, 'issues.edited', { only_body_changed: next });
              }}
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
            />
          ) : null}

          {active.key === 'issues.labeled' ? (
            <CheckboxMultiSelect
              id="v21-event-labeled-labels"
              label="命中的标签（命中任一即触发）"
              values={events['issues.labeled'].labels ?? []}
              options={labelCandidates}
              onChange={(next) => {
                patchEvent(state, 'issues.labeled', { labels: next });
              }}
              emptyText="还没有可选的标签：先在「标签」分区配好词表"
              hint={
                (events['issues.labeled'].labels ?? []).length === 0
                  ? '未选标签 = 该事件永不触发'
                  : '只有打了这些标签才处理'
              }
              error={
                labelWarnings && events['issues.labeled'].enabled !== 'off'
                  ? '没有候选标签：这个事件现在永远不会触发'
                  : null
              }
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
              testId="v21-labeled-targets"
            />
          ) : null}

          {/*
            评论事件的完整配置：提及关键词 + 角色清单 + 四个闸门。
            它们本来就是同一个事件的配置，所以留在同一个标签页里，不另开分区。
          */}
          {active.key === 'issue_comment.created' ? (
            <CommentEventConfig
              draft={draft}
              readOnly={readOnly}
              onUpdate={state.update}
              onMentions={setMentions}
              mentions={mentions}
              roleWarnings={roleWarnings}
            />
          ) : null}
        </div>
      </div>

      {/* 原「触发」分区：别名 + 命中预览。放可折叠区，避免它把编辑区挤扁。 */}
      <TriggerAdvanced state={state} />

      <SaveBar
        saveLabel="保存事件设置"
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

/**
 * 评论事件的全部配置：提及关键词 + 角色清单 + 四个闸门。
 *
 * 抽成组件而不是塞在 `V21EventsSection` 里：这一块有十来个字段，混在主渲染函数里
 * 会让「标签页骨架」这一层被淹掉；而它只读 `draft.comment` 与自己的闸门，边界清楚。
 */
function CommentEventConfig({
  draft,
  readOnly,
  onUpdate,
  mentions,
  onMentions,
  roleWarnings,
}: {
  draft: RepoSettings;
  readOnly: boolean;
  onUpdate: (patch: (current: RepoSettings) => RepoSettings) => void;
  mentions: readonly string[];
  onMentions: (next: string[]) => void;
  roleWarnings: boolean;
}) {
  const commentEvent = draft.triggers.events['issue_comment.created'];
  const roleCandidates = draft.comment.roles
    .map((role) => role.name)
    .filter((name) => name.trim() !== '')
    .map((name) => ({ value: name, label: name }));

  const patchGates = (patch: Partial<typeof commentEvent.gates>): void => {
    onUpdate((current) => ({
      ...current,
      triggers: {
        ...current.triggers,
        events: {
          ...current.triggers.events,
          'issue_comment.created': {
            ...current.triggers.events['issue_comment.created'],
            gates: { ...current.triggers.events['issue_comment.created'].gates, ...patch },
          },
        },
      },
    }));
  };

  return (
    /*
      这一块内容最多，所以它自己也滚：模板框吃剩余高度，闸门区按内容高度排，
      两者加起来超过面板高度时只在这一块里滚，不动外层（需求：整页无滚动条）。
    */
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-md bg-muted px-2.5 py-2">
      <ChipEditor
        id="v21-comment-mentions"
        label="提及关键词（@ 后面的名字）"
        values={mentions}
        onChange={onMentions}
        accept={(raw) => {
          const keyword = raw.replace(/^@/u, '').trim();
          if (keyword === '') return { error: '关键词不能为空' };
          if (keyword.length > 50) return { error: '关键词最长 50 字符' };
          if (mentions.includes(keyword)) return { error: '已经在清单里' };
          return { value: keyword };
        }}
        placeholder="pi-bot"
        hint="只有 @关键词 才触发；关键词后必须跟空格 / 标点或结尾"
        disabled={readOnly}
        disabledReason="仓库已归档：只读"
        emptyText="（至少需要一个关键词）"
      />

      <RoleEditor draft={draft} readOnly={readOnly} onUpdate={onUpdate} />

      <div className="flex flex-col divide-y divide-border rounded-md bg-card px-2.5 py-1">
        <SwitchField
          id="v21-gate-require-mention"
          label="必须 @ 到关键词"
          description="开启后只有合法提及的评论才触发；关闭后任何新评论都会触发。"
          checked={commentEvent.gates.require_mention}
          onChange={(next) => {
            patchGates({ require_mention: next });
          }}
          disabled={readOnly}
          disabledReason="仓库已归档：只读"
        />
        <SwitchField
          id="v21-gate-require-role"
          label="限定角色"
          description="开启后只处理下方所选角色发的评论。"
          checked={commentEvent.gates.require_role}
          onChange={(next) => {
            patchGates({ require_role: next });
          }}
          disabled={readOnly}
          disabledReason="仓库已归档：只读"
        />
        <CheckboxMultiSelect
          id="v21-allow-roles"
          label="允许触发的角色"
          values={commentEvent.gates.allow_roles}
          options={roleCandidates}
          onChange={(next) => {
            patchGates({ allow_roles: next });
          }}
          emptyText="还没有角色：先在上方新增角色"
          hint={
            commentEvent.gates.require_role
              ? '留空 = 不限定角色，任何通过前面闸门的人都能触发'
              : '「限定角色」未开启时这项不生效'
          }
          error={
            roleWarnings && commentEvent.gates.allow_roles.length > 0
              ? '选中的角色已被删除：保存会被服务端拒绝'
              : null
          }
          disabled={readOnly || roleWarnings}
          disabledReason={roleWarnings ? '还没有定义任何角色' : '仓库已归档：只读'}
          testId="v21-allow-roles"
        />
        <SwitchField
          id="v21-gate-ignore-bot"
          label="忽略机器人自己的评论"
          description="开启后 agent 不会被自己的评论再次触发。"
          checked={commentEvent.gates.ignore_bot}
          onChange={(next) => {
            patchGates({ ignore_bot: next });
          }}
          disabled={readOnly}
          disabledReason="仓库已归档：只读"
        />
        <SwitchField
          id="v21-gate-allow-closed"
          label="已关闭的 issue 也响应"
          description="开启后关闭的 issue 下新评论仍会处理。"
          checked={commentEvent.gates.allow_closed}
          onChange={(next) => {
            patchGates({ allow_closed: next });
          }}
          disabled={readOnly}
          disabledReason="仓库已归档：只读"
        />
      </div>
    </div>
  );
}

/**
 * 角色清单编辑：列出已有角色 + 一个「新增」输入框。
 *
 * 为什么新增输入框要本地 state：它是**草稿之外**的临时输入（按回车才落到配置里），
 * 受控在草稿上会让每个按键都往 `settings` 里写一个半截角色名。
 */
function RoleEditor({
  draft,
  readOnly,
  onUpdate,
}: {
  draft: RepoSettings;
  readOnly: boolean;
  onUpdate: (patch: (current: RepoSettings) => RepoSettings) => void;
}) {
  const [name, setName] = useState('');
  const roles = draft.comment.roles;

  const addRole = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || roles.some((role) => role.name === trimmed)) return;
    // 角色成员只支持个人 login；默认取项目管理员（面板不在这里新建成员，避免凭空造出不存在的 login）。
    const members = draft.agent.managers.filter((login) => login.trim() !== '');
    onUpdate((current) => ({
      ...current,
      comment: {
        ...current.comment,
        roles: [...current.comment.roles, { name: trimmed, by: 'members', members: members.length === 0 ? [''] : members }],
      },
    }));
    setName('');
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs text-faint">角色清单（供「限定角色」引用，成员取项目管理员）</p>
      {roles.length === 0 ? (
        <p className="text-2xs text-faint">还没有角色。</p>
      ) : (
        <ul className="flex flex-wrap gap-1" data-testid="v21-comment-roles">
          {roles.map((role) => (
            <li key={role.name} className="flex items-center gap-1 text-2xs">
              <span className="rounded-full bg-card px-2 py-0.5 font-mono text-foreground">{role.name}</span>
              <button
                type="button"
                aria-label={`移除角色 ${role.name}`}
                disabled={readOnly}
                className="text-muted-foreground transition-colors hover:text-danger-fg disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  onUpdate((current) => ({
                    ...current,
                    comment: {
                      ...current.comment,
                      roles: current.comment.roles.filter((item) => item.name !== role.name),
                    },
                    // 顺手把它从闸门白名单里摘掉，否则保存会被服务端拒（引用了不存在的角色）
                    triggers: {
                      ...current.triggers,
                      events: {
                        ...current.triggers.events,
                        'issue_comment.created': {
                          ...current.triggers.events['issue_comment.created'],
                          gates: {
                            ...current.triggers.events['issue_comment.created'].gates,
                            allow_roles: current.triggers.events['issue_comment.created'].gates.allow_roles.filter(
                              (item) => item !== role.name,
                            ),
                          },
                        },
                      },
                    },
                  }));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <TextField
        id="v21-comment-role-add"
        label="新增角色（回车添加）"
        value={name}
        placeholder="维护者"
        onChange={setName}
        onEnter={addRole}
        hint="角色名给人看；成员只在闸门判定时用"
        disabled={readOnly}
        disabledReason="仓库已归档：只读"
      />
    </div>
  );
}

/**
 * 事件模板输入框。
 *
 * 为什么需要本地 state：**未自定义时框里要显示内置默认模板**（需求：未自定义也要有可用内容）。
 * 但如果直接把 `stored ?? 默认模板` 当受控值，用户按退格清空时它会立刻被默认模板填回去，
 * 根本改不了。所以这里维护一份「正在编辑的值」：外部值变化时同步一次，之后以本地值为准。
 *
 * `fill`：这一块要吃掉标签页之外的剩余高度，内容多了只在框内滚（需求 3/4/5）。
 */
function TemplateField({
  eventKey,
  stored,
  readOnly,
  onChange,
}: {
  eventKey: EventKey;
  stored: string | null;
  readOnly: boolean;
  onChange: (next: string) => void;
}) {
  const fallback = DEFAULT_EVENT_TEMPLATES[eventKey];
  const external = stored ?? fallback;
  const [text, setText] = useState(external);
  const [seen, setSeen] = useState(external);
  /*
    外部值变了：只有当它不是「我们自己刚提交出去的那个值」时才覆盖输入框。
    否则清空（→ null → 显示默认模板）会被立刻填回来，用户根本改不了。
  */
  const equivalent = text === '' || text === fallback ? fallback : text;
  if (seen !== external) {
    setSeen(external);
    if (external !== equivalent) setText(external);
  }

  const tooLong = text.length > EVENT_PROMPT_MAX_CHARS;
  return (
    <TextAreaField
      id={`v21-event-prompt-${eventKey}`}
      label="提示词模板"
      value={text}
      fill
      mono
      placeholder="留空 = 用内置默认"
      onChange={(next) => {
        setText(next);
        onChange(next);
      }}
      error={tooLong ? `超过 ${String(EVENT_PROMPT_MAX_CHARS)} 字符` : null}
      tokens={PROMPT_PLACEHOLDERS}
      hint={stored === null ? '当前是内置默认模板；直接改这里即可自定义' : undefined}
      disabled={readOnly}
      disabledReason="仓库已归档：只读"
      footer={
        <p
          className={cn('text-2xs tabular', tooLong ? 'text-danger-fg' : 'text-faint')}
          data-testid={`v21-event-prompt-count-${eventKey}`}
        >
          {String(text.length)} / {String(EVENT_PROMPT_MAX_CHARS)} 字符
        </p>
      }
    />
  );
}
