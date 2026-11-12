/**
 * v2.1 配置契约（`packages/contract/src/settings-v21.ts`）的测试。
 *
 * 钉住四件事，任一条被改回来都会在这里红掉：
 * 1. **默认值表**（FR-2.1）：opened `on` / edited `on` + 只认正文 / labeled `conditional` + 空标签 /
 *    closed `off` / comment `conditional` + 四闸门默认；
 * 2. **`.strict()`**：拼错的键必须报错（配置写错了不能静默忽略）；
 * 3. **引用完整性**（§6.6）：`allow_roles` 只能引用 `comment.roles` 里定义过的角色；
 * 4. **向后兼容**：v0.3 的老配置（没有 v2.1 的任何键）照样解析成功，且拿到的是 v2.1 默认值。
 */
import { describe, expect, it } from 'vitest';

import type { CommentRole } from '../src/index.ts';
import {
  ASSOCIATIONS,
  EVENT_KEYS,
  LOGIN_RE,
  MEMBER_LOGIN_RE,
  SYSTEM_PROMPT_MAX_CHARS,
  V21_DEFAULTS,
  V21_DEFAULT_AGENT_EXECUTION,
  V21_DEFAULT_COMMENT,
  V21_DEFAULT_COMMENT_GATES,
  V21_DEFAULT_EVENT_TRIGGERS,
  agentExecutionSchema,
  commentConfigSchema,
  commentEventTriggerSchema,
  commentGatesSchema,
  eventTriggerSchema,
  eventTriggersSchema,
  findDuplicateRoleNames,
  findUnknownAllowRoles,
  labelCatalogEntryV21Schema,
  labelRoleSchema,
  parseRepoSettings,
  repoSettingsSchema,
  repoSettingsShapeSchema,
} from '../src/index.ts';

/** 一份**合法**的 v0.3 配置（`managers` 非空 + 词表含 requirement/defect）：老配置的基线。 */
const LEGACY_OK = {
  agent: { managers: ['alice'] },
  labels: {
    vocabulary: [
      { name: '需求', role: 'requirement' },
      { name: '缺陷', role: 'defect' },
    ],
  },
} as const;

describe('五个事件的默认值表（FR-2.1）', () => {
  it('opened=on、edited=on+只认正文、labeled=conditional+空标签、closed=off、comment=conditional', () => {
    const events = eventTriggersSchema.parse({});
    expect(Object.keys(events).sort()).toEqual([...EVENT_KEYS].sort());

    expect(events['issues.opened'].enabled).toBe('on');
    expect(events['issues.opened'].prompt).toBeNull();

    expect(events['issues.edited'].enabled).toBe('on');
    expect(events['issues.edited'].only_body_changed).toBe(true);

    expect(events['issues.labeled'].enabled).toBe('conditional');
    // 空标签表 = 永不触发（FR-2.1「命中所配标签才触发」，什么都没配就没人能命中）
    expect(events['issues.labeled'].labels).toEqual([]);

    expect(events['issues.closed'].enabled).toBe('off');

    expect(events['issue_comment.created'].enabled).toBe('conditional');
    expect(events['issue_comment.created'].gates).toEqual({
      require_mention: true,
      require_role: false,
      allow_roles: [],
      ignore_bot: true,
      allow_closed: false,
    });
  });

  it('V21_DEFAULT_EVENT_TRIGGERS 与 schema 默认值同源（不是第二份手写表）', () => {
    expect(V21_DEFAULT_EVENT_TRIGGERS).toEqual(eventTriggersSchema.parse({}));
    expect(V21_DEFAULTS.events).toBe(V21_DEFAULT_EVENT_TRIGGERS);
    expect(V21_DEFAULTS.comment).toBe(V21_DEFAULT_COMMENT);
    expect(V21_DEFAULTS.agent).toBe(V21_DEFAULT_AGENT_EXECUTION);
    expect(V21_DEFAULTS.gates).toBe(V21_DEFAULT_COMMENT_GATES);
  });

  it('只给一个事件时其余事件仍取默认值（prefault 逐键生效）', () => {
    const events = eventTriggersSchema.parse({ 'issues.closed': { enabled: 'on' } });
    expect(events['issues.closed'].enabled).toBe('on');
    expect(events['issues.opened'].enabled).toBe('on');
    expect(events['issues.edited'].only_body_changed).toBe(true);
    expect(events['issue_comment.created'].gates.require_mention).toBe(true);
  });

  it('prompt 可为 null（用内置模板），留空字符串则原样保留', () => {
    const parsed = eventTriggerSchema.parse({ prompt: null });
    expect(parsed.prompt).toBeNull();
    expect(eventTriggerSchema.parse({}).prompt).toBeNull();
    expect(eventTriggerSchema.parse({ prompt: '' }).prompt).toBe('');
    expect(eventTriggerSchema.safeParse({ prompt: 'x'.repeat(4001) }).success).toBe(false);
  });
});

describe('.strict()：拼错的键一律拒绝', () => {
  it('五个 schema 都拒绝未知键', () => {
    expect(eventTriggerSchema.safeParse({ enable: 'on' }).success).toBe(false);
    expect(commentGatesSchema.safeParse({ require_mentions: true }).success).toBe(false);
    expect(commentEventTriggerSchema.safeParse({ gate: {} }).success).toBe(false);
    expect(agentExecutionSchema.safeParse({ concurrent: 2 }).success).toBe(false);
    expect(labelCatalogEntryV21Schema.safeParse({ name: 'bug', role: 'defect', manage: true }).success).toBe(false);
    expect(commentConfigSchema.safeParse({ mentions: [{ keyword: 'pi-bot' }], role: [] }).success).toBe(false);
  });
});

describe('评论配置（§6.6）：提及关键词 + 角色清单', () => {
  it('默认只有一个关键词 pi-bot、没有角色', () => {
    expect(V21_DEFAULT_COMMENT).toEqual({ mentions: [{ keyword: 'pi-bot' }], roles: [] });
  });

  it('mentions 至少 1 个：空数组不是合法配置', () => {
    expect(commentConfigSchema.safeParse({ mentions: [] }).success).toBe(false);
    expect(commentConfigSchema.safeParse({}).success).toBe(false);
    // 中文关键词是合法的（§6.6 的示例就同时有 pi-bot 与 小豆）
    expect(commentConfigSchema.safeParse({ mentions: [{ keyword: '小豆' }] }).success).toBe(true);
    // 关键词不能含空白或 @
    expect(commentConfigSchema.safeParse({ mentions: [{ keyword: 'pi bot' }] }).success).toBe(false);
    expect(commentConfigSchema.safeParse({ mentions: [{ keyword: '@pi-bot' }] }).success).toBe(false);
  });

  it('角色按 by 判别：association 要 any_of、members 要 login，各自缺字段即失败', () => {
    const ok = commentConfigSchema.safeParse({
      mentions: [{ keyword: 'pi-bot' }],
      roles: [
        { name: '维护者', by: 'association', any_of: ['OWNER', 'MEMBER'] },
        { name: '值班同学', by: 'members', members: ['alice', 'bob'] },
      ],
    });
    expect(ok.success).toBe(true);

    // association 少 any_of / any_of 为空
    expect(commentConfigSchema.safeParse({ mentions: [{ keyword: 'k' }], roles: [{ name: 'a', by: 'association' }] }).success).toBe(false);
    expect(
      commentConfigSchema.safeParse({ mentions: [{ keyword: 'k' }], roles: [{ name: 'a', by: 'association', any_of: [] }] })
        .success,
    ).toBe(false);
    // members 少 members / 空数组 / 非法 login（只支持个人，不支持 org/team 形式）
    expect(commentConfigSchema.safeParse({ mentions: [{ keyword: 'k' }], roles: [{ name: 'a', by: 'members' }] }).success).toBe(false);
    expect(
      commentConfigSchema.safeParse({ mentions: [{ keyword: 'k' }], roles: [{ name: 'a', by: 'members', members: [] }] })
        .success,
    ).toBe(false);
    expect(
      commentConfigSchema.safeParse({
        mentions: [{ keyword: 'k' }],
        roles: [{ name: 'a', by: 'members', members: ['acme/team'] }],
      }).success,
    ).toBe(false);
    // 未知判别值与未知关联值都拒绝
    expect(commentConfigSchema.safeParse({ mentions: [{ keyword: 'k' }], roles: [{ name: 'a', by: 'org' }] }).success).toBe(false);
    expect(
      commentConfigSchema.safeParse({
        mentions: [{ keyword: 'k' }],
        roles: [{ name: 'a', by: 'association', any_of: ['ADMIN'] }],
      }).success,
    ).toBe(false);
  });

  it('七个作者关联取值都在（§6.6：作者关联补全七个）', () => {
    expect([...ASSOCIATIONS]).toEqual([
      'OWNER',
      'MEMBER',
      'COLLABORATOR',
      'CONTRIBUTOR',
      'FIRST_TIME_CONTRIBUTOR',
      'FIRST_TIMER',
      'NONE',
    ]);
  });
});

describe('跨字段约束：闸门只能引用已定义的角色', () => {
  const withGates = (allowRoles: string[], roles: unknown[]) => ({
    ...LEGACY_OK,
    comment: { mentions: [{ keyword: 'pi-bot' }], roles },
    triggers: {
      events: { 'issue_comment.created': { enabled: 'conditional', gates: { require_role: true, allow_roles: allowRoles } } },
    },
  });

  /**
   * 两个夹具都用**显式类型**（而不是裸字面量）：裸字面量的 `by` 会被推断成 `string`，
   * 传给 `findUnknownAllowRoles()` / `findDuplicateRoleNames()` 时会因为「不是判别联合的字面量」
   * 而类型报错。显式标 `CommentRole`（或 `satisfies`）既保住字面量推断，又不放宽生产 schema。
   */
  const 维护者: CommentRole = { name: '维护者', by: 'association', any_of: ['OWNER'] };
  const 维护者按成员 = { name: '维护者', by: 'members', members: ['alice'] } satisfies CommentRole;

  it('引用已定义角色 → 合法', () => {
    expect(repoSettingsSchema.safeParse(withGates(['维护者'], [维护者])).success).toBe(true);
  });

  it('引用未定义角色 → 解析失败，错误落在 allow_roles 路径上', () => {
    const result = repoSettingsSchema.safeParse(withGates(['运维'], [维护者]));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((item) =>
        item.path.join('.').endsWith('gates.allow_roles'),
      );
      expect(issue?.message).toContain('运维');
    }
  });

  it('findUnknownAllowRoles 返回具体名字（去重、保序）', () => {
    const comment = { roles: [维护者] };
    expect(findUnknownAllowRoles(comment, ['维护者'])).toEqual([]);
    expect(findUnknownAllowRoles(comment, ['运维', '维护者', '运维'])).toEqual(['运维']);
  });

  it('角色重名 / 关键词重复也是硬错误', () => {
    const duplicateRole = repoSettingsSchema.safeParse({
      ...LEGACY_OK,
      comment: { mentions: [{ keyword: 'pi-bot' }], roles: [维护者, 维护者按成员] },
    });
    expect(duplicateRole.success).toBe(false);

    // 关键词按大小写不敏感判重（GitHub login/mention 也是这个口径）
    const duplicateKeyword = repoSettingsSchema.safeParse({
      ...LEGACY_OK,
      comment: { mentions: [{ keyword: 'pi-bot' }, { keyword: 'PI-BOT' }], roles: [] },
    });
    expect(duplicateKeyword.success).toBe(false);

    expect(findDuplicateRoleNames({ roles: [维护者, 维护者按成员] })).toEqual(['维护者']);
  });
});

describe('执行限额（§6.7）', () => {
  it('默认：内置系统提示词、并发 2、日配额 100、单轮 20 分钟、三类动作全关、留 90 天', () => {
    expect(V21_DEFAULT_AGENT_EXECUTION).toEqual({
      system_prompt: '',
      concurrency: 2,
      daily_quota: 100,
      turn_timeout_minutes: 20,
      actions: { create_issue: false, open_pr: false, close_issue: false },
      data_retention_days: 90,
    });
  });

  it('取值范围：并发 1–8、日配额 1–1000、单轮 1–30、保留 1–365（整数）', () => {
    const parse = (patch: Record<string, unknown>) => agentExecutionSchema.safeParse(patch).success;
    expect(parse({ concurrency: 1 })).toBe(true);
    expect(parse({ concurrency: 8 })).toBe(true);
    expect(parse({ concurrency: 0 })).toBe(false);
    expect(parse({ concurrency: 9 })).toBe(false);
    expect(parse({ concurrency: 2.5 })).toBe(false);
    expect(parse({ daily_quota: 1 })).toBe(true);
    expect(parse({ daily_quota: 1000 })).toBe(true);
    expect(parse({ daily_quota: 1001 })).toBe(false);
    expect(parse({ turn_timeout_minutes: 30 })).toBe(true);
    expect(parse({ turn_timeout_minutes: 31 })).toBe(false);
    expect(parse({ data_retention_days: 0 })).toBe(false);
    expect(parse({ data_retention_days: 366 })).toBe(false);
    expect(agentExecutionSchema.safeParse({ system_prompt: 'x'.repeat(SYSTEM_PROMPT_MAX_CHARS + 1) }).success).toBe(false);
  });

  it('后三类动作默认关闭，可单独开', () => {
    const parsed = agentExecutionSchema.parse({ actions: { close_issue: true } });
    expect(parsed.actions).toEqual({ create_issue: false, open_pr: false, close_issue: true });
  });
});

describe('标签目录（FR-5.4 / §6.5）', () => {
  it('managed 默认 true、status 默认 active', () => {
    expect(labelCatalogEntryV21Schema.parse({ name: 'bug', role: 'defect' })).toEqual({
      name: 'bug',
      role: 'defect',
      managed: true,
      status: 'active',
    });
    expect(labelCatalogEntryV21Schema.parse({ name: 'bug', role: 'defect', managed: false, status: 'retired' })).toMatchObject({
      managed: false,
      status: 'retired',
    });
    expect(labelCatalogEntryV21Schema.safeParse({ name: 'bug', role: 'defect', status: 'gone' }).success).toBe(false);
  });

  it('目录角色与 v0.3 的 labelRoleSchema 是同一取值集（防两份枚举漂移）', () => {
    expect(labelCatalogEntryV21Schema.shape.role.options).toEqual(labelRoleSchema.options);
  });

  it('成员 login 正则与 repo-config 的 LOGIN_RE 完全一致（防两份正则漂移）', () => {
    expect(MEMBER_LOGIN_RE.source).toBe(LOGIN_RE.source);
    expect(MEMBER_LOGIN_RE.flags).toBe(LOGIN_RE.flags);
  });
});

describe('向后兼容：v0.3 的老配置照样解析', () => {
  it('老配置没有 triggers.events / comment / agent.limits，解析后拿到 v2.1 默认值', () => {
    const settings = parseRepoSettings(LEGACY_OK);
    expect(settings.triggers.events).toEqual(V21_DEFAULT_EVENT_TRIGGERS);
    expect(settings.comment).toEqual(V21_DEFAULT_COMMENT);
    expect(settings.agent.limits).toEqual(V21_DEFAULT_AGENT_EXECUTION);
    expect(settings.agent.system_prompt).toBe('');
    expect(settings.agent.actions).toEqual({ create_issue: false, open_pr: false, close_issue: false });
    // 旧字段语义不变
    expect(settings.agent.project_prompt).toBe('');
    expect(settings.labels.max_per_issue).toBe(6);
  });

  it('旧词表条目仍然合法，managed/status 保持「没写」而不是被补默认值', () => {
    const settings = parseRepoSettings(LEGACY_OK);
    // 词表条目是「可选」而不是「带默认值」：存量的读写路径（skills/prompt、workflows/normalize）
    // 与测试夹具都按「只有 name/role」构造对象，补默认值会把它们的类型与解析结果一起改掉。
    expect(settings.labels.vocabulary[0]).toEqual({ name: '需求', role: 'requirement' });
    expect(settings.labels.vocabulary[1]).toEqual({ name: '缺陷', role: 'defect' });
    // 但显式写出来也照收（v2.1 面板会写）
    const withFlags = parseRepoSettings({
      ...LEGACY_OK,
      labels: {
        vocabulary: [
          { name: '需求', role: 'requirement', managed: false, status: 'retired' },
          { name: '缺陷', role: 'defect' },
        ],
      },
    });
    expect(withFlags.labels.vocabulary[0]).toMatchObject({ managed: false, status: 'retired' });
  });

  it('形状默认值也带上 v2.1 段（部署默认 / 面板恢复默认走它）', () => {
    const shape = repoSettingsShapeSchema.parse({});
    expect(shape.comment).toEqual(V21_DEFAULT_COMMENT);
    expect(shape.triggers.events['issues.closed'].enabled).toBe('off');
    expect(shape.agent.limits.concurrency).toBe(2);
  });
});

describe('JSON Schema：每个导出的 schema 都能生成（面板/OpenAPI 需要）', () => {
  const schemas = {
    EventTrigger: eventTriggerSchema,
    CommentEventTrigger: commentEventTriggerSchema,
    CommentGates: commentGatesSchema,
    CommentConfig: commentConfigSchema,
    AgentExecution: agentExecutionSchema,
    EventTriggers: eventTriggersSchema,
    LabelCatalogEntryV21: labelCatalogEntryV21Schema,
  } as const;

  it('生成 draft 2020-12 JSON Schema 且带 type/属性（不依赖 transform）', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      const jsonSchema = schema.toJSONSchema({ target: 'draft-2020-12', io: 'output' }) as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      expect(jsonSchema.type, name).toBe('object');
      expect(Object.keys(jsonSchema.properties ?? {}).length, name).toBeGreaterThan(0);
    }
  });
});
