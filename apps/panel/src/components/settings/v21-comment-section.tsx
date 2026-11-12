/**
 * v2.1「评论触发」分区（`docs/v21-contract.md` §1 / §6.6 / FR-2.4 / FR-2.5）。
 *
 * 这一屏只有**两个定义源**：`@` 后面要命中的关键词（`comment.mentions`）与角色清单
 * （`comment.roles`）。它不负责「闸门开不开」——闸门是「评论这个事件怎么判定」，
 * 属于「事件与模板」分区（`v21-events-section.tsx`），这里只提供它引用的**素材**。
 *
 * 三处「看起来是编辑器、其实是契约约束」的地方必须说清：
 * 1. `roles` 是**判别联合**（按 `by` 二选一）：作者关联（七项 `author_association`）或
 *    指定成员（GitHub 个人 login）。不允许出现「两边都没填」的空壳角色，所以界面用
 *    「二选一」的分段控件而不是两组都可填的输入框；
 * 2. 指定成员**只支持个人账号**（不支持组织 / 团队）：组织名不是 `login`，写进去永远匹配不上；
 * 3. 角色名重复、`allow_roles` 引用了不存在的角色，都是**服务端会拒收**的硬错误
 *    （`repoSettingsSchema` 的 superRefine），所以这里直接禁用保存并说明原因，而不是等 400。
 */
import { useState } from 'react';
import type { Association, RepoSettings } from '../../../../../packages/contract/src/index.ts';
import {
  ASSOCIATIONS,
  COMMENT_KEYWORD_MAX_CHARS,
  MAX_COMMENT_KEYWORDS,
  MAX_COMMENT_ROLES,
  MAX_ROLE_MEMBERS,
  MEMBER_LOGIN_RE,
  findDuplicateRoleNames,
  findUnknownAllowRoles,
} from '../../../../../packages/contract/src/index.ts';
import { Section } from '../Section.tsx';
import { cn } from '../../lib/utils.ts';
import { repoSettingsPath } from '../../lib/repo-route.ts';
import { Segmented, SwitchField, TextAreaField, TextField } from './form.tsx';
import { CheckboxMultiSelect } from './v21-fields.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';

/** `settings.comment` 的类型（提及关键词 + 角色清单）。 */
type CommentConfig = RepoSettings['comment'];
type CommentRole = CommentConfig['roles'][number];
type CommentMention = CommentConfig['mentions'][number];

/** 七个作者关联的中文文案（值仍是契约枚举，界面只翻译）。 */
const ASSOCIATION_LABELS: Record<Association, string> = {
  OWNER: 'OWNER（仓库所有者）',
  MEMBER: 'MEMBER（组织成员）',
  COLLABORATOR: 'COLLABORATOR（协作者，有写权限）',
  CONTRIBUTOR: 'CONTRIBUTOR（曾合并过 PR）',
  FIRST_TIME_CONTRIBUTOR: 'FIRST_TIME_CONTRIBUTOR（首次贡献）',
  FIRST_TIMER: 'FIRST_TIMER（首次参与）',
  NONE: 'NONE（其他人）',
};

const ASSOCIATION_OPTIONS = ASSOCIATIONS.map((value) => ({ value, label: ASSOCIATION_LABELS[value] }));

/** 关键词的字符约束：不许空白与 `@`（契约 `commentMentionSchema`）。 */
function keywordError(keyword: string): string | null {
  const text = keyword.trim();
  if (text === '') return '关键词不能为空（没有关键词就永远判不出「被提及」）';
  if (text.length > COMMENT_KEYWORD_MAX_CHARS) return `关键词最长 ${String(COMMENT_KEYWORD_MAX_CHARS)} 个字符`;
  if (/[\s@]/u.test(text)) return '关键词不能包含空白或 @（@ 是前缀，不写进来）';
  return null;
}

/** 两个关键词是否重复（大小写不敏感比，与判定侧口径一致）。 */
function sameKeyword(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** 指定成员输入框里的文本 → login 列表（逗号 / 换行 / 空白分隔）。 */
function parseLogins(text: string): string[] {
  return text
    .split(/[\s,]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * 只改名字、保留判定来源。
 *
 * 为什么不用 `{ ...role, name }`：`CommentRole` 是判别联合，展开联合类型会丢掉「`by` 与
 * 伴随字段的对应关系」，写回去时类型不成立（`members` 与 `any_of` 会同时变成可选）。
 * 显式列两个分支更啰嗦，但它同时保证「换个名字不会把角色的来源改掉」。
 */
function withRoleName(role: CommentRole, name: string): CommentRole {
  return role.by === 'members'
    ? { name, by: 'members', members: role.members }
    : { name, by: 'association', any_of: role.any_of };
}

/* ── 分区 ─────────────────────────────────────────────────────────────────── */

export function V21CommentSection({ state, onNavigate }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const comment = draft.comment;
  const changed = countChangedPaths(state.base, draft).length;

  const gates = draft.triggers.events['issue_comment.created'].gates;
  const duplicateRoles = findDuplicateRoleNames(comment);
  const unknownAllowRoles = findUnknownAllowRoles(comment, gates.allow_roles);

  const emptyKeywordIndex = comment.mentions.findIndex((mention) => mention.keyword.trim() === '');
  const invalidKeywordIndex = comment.mentions.findIndex((mention) => keywordError(mention.keyword) !== null);
  const duplicateMentionIndex = comment.mentions.findIndex((mention, index) =>
    comment.mentions.some((other, at) => at < index && sameKeyword(other.keyword, mention.keyword)),
  );
  const emptyRoleIndex = comment.roles.findIndex((role) => role.name.trim() === '');
  const emptyAnyOfIndex = comment.roles.findIndex((role) => role.by === 'association' && role.any_of.length === 0);
  const emptyMembersIndex = comment.roles.findIndex((role) => role.by === 'members' && role.members.length === 0);
  const badMembersIndex = comment.roles.findIndex(
    (role) => role.by === 'members' && role.members.some((login) => !MEMBER_LOGIN_RE.test(login)),
  );
  const tooManyMembersIndex = comment.roles.findIndex(
    (role) => role.by === 'members' && role.members.length > MAX_ROLE_MEMBERS,
  );

  const blockedReason =
    duplicateRoles.length > 0
      ? `角色名重复：${duplicateRoles.join('、')}（闸门会引用到不确定的那一个）`
      : unknownAllowRoles.length > 0
        ? `「事件与模板」里的允许角色含未定义的名字：${unknownAllowRoles.join('、')}`
        : emptyKeywordIndex >= 0
          ? `第 ${String(emptyKeywordIndex + 1)} 个关键词是空的（服务端会拒收）`
          : duplicateMentionIndex >= 0
            ? `第 ${String(duplicateMentionIndex + 1)} 个关键词与前面的重复（大小写不敏感）`
            : invalidKeywordIndex >= 0
              ? `第 ${String(invalidKeywordIndex + 1)} 个关键词不合法：${keywordError(comment.mentions[invalidKeywordIndex]?.keyword ?? '') ?? ''}`
              : emptyRoleIndex >= 0
                ? `第 ${String(emptyRoleIndex + 1)} 个角色还没有名字`
                : emptyAnyOfIndex >= 0
                  ? `角色「${comment.roles[emptyAnyOfIndex]?.name ?? ''}」至少勾一个作者关联`
                  : emptyMembersIndex >= 0
                    ? `角色「${comment.roles[emptyMembersIndex]?.name ?? ''}」至少填一个成员 login`
                    : badMembersIndex >= 0
                      ? `角色「${comment.roles[badMembersIndex]?.name ?? ''}」里有不是 GitHub 个人 login 的成员`
                      : tooManyMembersIndex >= 0
                        ? `角色「${comment.roles[tooManyMembersIndex]?.name ?? ''}」的成员超过 ${String(MAX_ROLE_MEMBERS)} 个`
                        : null;

  const patchComment = (patch: (current: CommentConfig) => CommentConfig): void => {
    state.update((current) => ({ ...current, comment: patch(current.comment) }));
  };

  const patchMention = (index: number, patch: Partial<CommentMention>): void => {
    patchComment((current) => ({
      ...current,
      mentions: current.mentions.map((mention, at) => (at === index ? { ...mention, ...patch } : mention)),
    }));
  };

  const patchRole = (index: number, next: CommentRole): void => {
    patchComment((current) => ({
      ...current,
      roles: current.roles.map((role, at) => (at === index ? next : role)),
    }));
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-comment">
      <Section
        first
        title="提及关键词"
        description="评论里出现 @关键词 才算「叫了机器人」；至少保留 1 个"
        actions={
          <span className="text-2xs text-faint tabular">
            {String(comment.mentions.length)} / {String(MAX_COMMENT_KEYWORDS)}
          </span>
        }
      >
        <div className="flex flex-col gap-2">
          {comment.mentions.map((mention, index) => {
            const error = keywordError(mention.keyword);
            const display = mention.keyword.trim() === '' ? `第 ${String(index + 1)} 个` : mention.keyword.trim();
            return (
              <div
                key={`mention-${String(index)}`}
                className="grid min-w-0 grid-cols-1 gap-2 rounded-md border border-border p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_auto] md:border-0 md:p-0"
                data-testid={`v21-mention-row-${String(index)}`}
              >
                <TextField
                  id={`v21-mention-keyword-${String(index)}`}
                  label="关键词（@ 后面的名字）"
                  mono
                  value={mention.keyword}
                  placeholder="pi-bot"
                  onChange={(next) => {
                    patchMention(index, { keyword: next });
                  }}
                  error={error}
                  disabled={readOnly}
                  disabledReason="仓库已归档：只读"
                />
                <SwitchField
                  id={`v21-mention-case-${String(index)}`}
                  label={`区分大小写（${display}）`}
                  description="关掉时 @Pi-Bot 与 @pi-bot 等价（默认不区分）。"
                  checked={mention.case_sensitive === true}
                  onChange={(next) => {
                    patchMention(index, { case_sensitive: next });
                  }}
                  disabled={readOnly}
                  disabledReason="仓库已归档：只读"
                />
                <div className="flex items-start md:items-center">
                  <button
                    type="button"
                    aria-label={`移除关键词 ${display}`}
                    disabled={readOnly || comment.mentions.length <= 1}
                    title={
                      readOnly
                        ? '仓库已归档：只读'
                        : comment.mentions.length <= 1
                          ? '至少保留 1 个关键词（没有关键词就永远判不出「被提及」）'
                          : '从清单移除'
                    }
                    onClick={() => {
                      patchComment((current) => ({
                        ...current,
                        mentions: current.mentions.filter((_, at) => at !== index),
                      }));
                    }}
                    className="h-8 rounded-md border border-border px-2 text-xs text-muted-foreground transition-[color,border-color,background-color] duration-[120ms] ease-out-quint hover:border-danger/50 hover:text-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    移除
                  </button>
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="v21-mention-add"
              onClick={() => {
                patchComment((current) => ({ ...current, mentions: [...current.mentions, { keyword: '' }] }));
              }}
              disabled={readOnly || comment.mentions.length >= MAX_COMMENT_KEYWORDS}
              title={
                readOnly
                  ? '仓库已归档：只读'
                  : comment.mentions.length >= MAX_COMMENT_KEYWORDS
                    ? `最多 ${String(MAX_COMMENT_KEYWORDS)} 个关键词`
                    : '加一个空白关键词，填好才能保存'
              }
              className="h-8 rounded-md border border-border px-2 text-xs text-foreground transition-[background-color,color] duration-[120ms] ease-out-quint hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
            >
              添加关键词
            </button>
            <span className="text-2xs text-faint">
              只判「@ + 关键词 + 分隔符」；代码块里的 @ 不算（判定侧统一蒙版）。
            </span>
          </div>
        </div>
      </Section>

      <Section
        title="角色清单"
        description="闸门的 allow_roles 只能引用这里的名字；重名或引用不存在都会被服务端拒收"
        actions={
          <span className="text-2xs text-faint tabular">
            {String(comment.roles.length)} / {String(MAX_COMMENT_ROLES)}
          </span>
        }
      >
        <div className="flex flex-col gap-3">
          {comment.roles.length === 0 ? (
            <p
              className="rounded-md border border-dashed border-border px-2.5 py-3 text-xs text-muted-foreground"
              data-testid="v21-roles-empty"
            >
              还没有角色：「限定角色」闸门现在没有可选项，评论事件只能靠「必须 @」把关。
            </p>
          ) : null}

          {comment.roles.map((role, index) => {
            const display = role.name.trim() === '' ? `第 ${String(index + 1)} 个` : role.name;
            return (
              <div
                key={`role-${String(index)}`}
                className="flex min-w-0 flex-col gap-2 rounded-md border border-border px-2.5 py-2"
                data-testid={`v21-role-row-${String(index)}`}
              >
                <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
                  <div className="min-w-0 max-w-56 flex-1">
                    <TextField
                      id={`v21-role-name-${String(index)}`}
                      label="角色名"
                      value={role.name}
                      placeholder="维护者"
                      onChange={(next) => {
                        patchRole(index, withRoleName(role, next));
                      }}
                      error={role.name.trim() === '' ? '必填' : duplicateRoles.includes(role.name) ? '重名' : null}
                      hint="闸门按这个名字引用；改名后要回「事件与模板」重新选"
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Segmented
                      name={`v21-role-by-${String(index)}`}
                      value={role.by}
                      options={[
                        {
                          value: 'association',
                          label: '作者关联',
                          title: '按评论载荷里的 author_association 判（七项任选）',
                        },
                        {
                          value: 'members',
                          label: '指定成员',
                          title: '按 GitHub 个人账号 login 判（不支持组织 / 团队）',
                        },
                      ]}
                      onChange={(next) => {
                        // 两种来源的语义不同（关联集合 vs login 列表），切换时从空集合重新填
                        patchRole(
                          index,
                          next === 'members'
                            ? { name: role.name, by: 'members', members: [] }
                            : { name: role.name, by: 'association', any_of: ['OWNER'] },
                        );
                      }}
                      ariaLabel={`角色「${display}」的判定来源`}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <button
                      type="button"
                      aria-label={`移除角色 ${display}`}
                      disabled={readOnly}
                      title={readOnly ? '仓库已归档：只读' : '从角色清单移除（引用它的闸门会报错，记得一起改）'}
                      onClick={() => {
                        patchComment((current) => ({
                          ...current,
                          roles: current.roles.filter((_, at) => at !== index),
                        }));
                      }}
                      className="h-8 rounded-md border border-border px-2 text-xs text-muted-foreground transition-[color,border-color,background-color] duration-[120ms] ease-out-quint hover:border-danger/50 hover:text-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      移除
                    </button>
                  </div>
                </div>

                {role.by === 'association' ? (
                  <CheckboxMultiSelect
                    id={`v21-role-assoc-${String(index)}`}
                    label="命中任一作者关联即算该角色"
                    values={role.any_of}
                    options={ASSOCIATION_OPTIONS}
                    onChange={(next) => {
                      patchRole(index, {
                        name: role.name,
                        by: 'association',
                        any_of: next.filter((value): value is Association =>
                          ASSOCIATIONS.some((candidate) => candidate === value),
                        ),
                      });
                    }}
                    error={role.any_of.length === 0 ? '至少勾一项（否则这个角色永远判不出来）' : null}
                    hint="值来自评论载荷的 author_association，不需要额外查成员列表。"
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                    columns={1}
                  />
                ) : (
                  <MembersEditor
                    id={`v21-role-members-${String(index)}`}
                    members={role.members}
                    onChange={(next) => {
                      patchRole(index, { name: role.name, by: 'members', members: next });
                    }}
                    readOnly={readOnly}
                  />
                )}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="v21-role-add"
              onClick={() => {
                // 新角色默认「作者关联 + OWNER」：最不会误伤的一组默认值，改起来也只要一次点击
                patchComment((current) => ({
                  ...current,
                  roles: [...current.roles, { name: '', by: 'association', any_of: ['OWNER'] }],
                }));
              }}
              disabled={readOnly || comment.roles.length >= MAX_COMMENT_ROLES}
              title={
                readOnly
                  ? '仓库已归档：只读'
                  : comment.roles.length >= MAX_COMMENT_ROLES
                    ? `最多 ${String(MAX_COMMENT_ROLES)} 个角色`
                    : '加一个空白角色（默认按「作者关联」判）'
              }
              className="h-8 rounded-md border border-border px-2 text-xs text-foreground transition-[background-color,color] duration-[120ms] ease-out-quint hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
            >
              添加角色
            </button>
            <a
              href={repoSettingsPath(state.repo, 'events')}
              onClick={(event) => {
                // 有未保存改动时先拦一次（与左栏导航同一套拦截），否则跳过去这些改动就丢了
                onNavigate?.(event, 'events');
              }}
              className="text-2xs text-brand underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              去「事件与模板」调闸门 →
            </a>
          </div>

          {unknownAllowRoles.length > 0 ? (
            <p className="text-xs text-danger-fg" role="alert" data-testid="v21-allow-roles-unknown">
              闸门的允许角色里有未定义的名字：{unknownAllowRoles.join('、')}（改名后要回「事件与模板」重新选）
            </p>
          ) : null}
        </div>
      </Section>

      <SaveBar
        saveLabel="保存评论触发"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={blockedReason}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-comment"
      />
    </div>
  );
}

/* ── 指定成员编辑器 ───────────────────────────────────────────────────────── */

/**
 * 成员 login 列表（逗号 / 换行分隔的文本框）。
 *
 * 为什么不复用 `ChipEditor`：那个是「一次加一个」的列表编辑器，而这里人往往是从别处
 * **粘贴一串 login**，逐条回车太慢。所以用文本域 + 即时解析。
 *
 * 本地 `text` 只承载「输入中的原文」：解析后立刻写回草稿；外部值变化（撤销改动、切换角色
 * 来源）时反向同步回输入框。同步前先比一次解析结果，避免把人正在敲的逗号/换行冲掉。
 */
function MembersEditor({
  id,
  members,
  onChange,
  readOnly,
}: {
  id: string;
  members: readonly string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
}) {
  const joined = members.join('\n');
  const [text, setText] = useState(joined);
  const [seen, setSeen] = useState(joined);

  // 外部值与「输入框解析出来的 login 序列」不一致时才回写（`form.tsx` 的 NumberField 同款做法）
  if (seen !== joined) {
    setSeen(joined);
    if (parseLogins(text).join('\n') !== joined) setText(joined);
  }

  const invalid = members.filter((login) => !MEMBER_LOGIN_RE.test(login));

  return (
    <TextAreaField
      id={id}
      label={`成员 GitHub login（逗号或换行分隔，≤ ${String(MAX_ROLE_MEMBERS)} 个）`}
      value={text}
      rows={3}
      mono
      placeholder={'alice\nbob'}
      onChange={(next) => {
        setText(next);
        onChange(parseLogins(next));
      }}
      error={
        members.length === 0
          ? '至少填一个 login（否则这个角色永远判不出来）'
          : invalid.length === 0
            ? null
            : `不是 GitHub 个人 login：${invalid.join('、')}`
      }
      hint="只支持个人账号，不支持组织 / 团队（组织名不是 login，写进去永远匹配不上）。"
      disabled={readOnly}
      disabledReason="仓库已归档：只读"
      footer={
        <p
          className={cn('text-2xs tabular', members.length > MAX_ROLE_MEMBERS ? 'text-danger-fg' : 'text-faint')}
          data-testid={`${id}-count`}
        >
          {String(members.length)} / {String(MAX_ROLE_MEMBERS)} 个成员
        </p>
      }
    />
  );
}
