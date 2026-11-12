import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPO_SETTINGS,
  SKILL_ALLOWED_TOOLS,
  SKILL_OUTPUT_INTENTS,
  SKILL_RESERVED_NAMES,
  SKILL_TIMEOUT_MAX_MS,
  effectiveSkillTimeout,
  parseRepoConfig,
  parseRepoSettings,
  parseSkillTimeoutMs,
  pipelineLabelCoverage,
  repoConfigSchema,
  repoSettingsSchema,
  repoSettingsShapeSchema,
  skillFrontmatterSchema,
  toSkillEffectiveConfig,
} from '../src/index.ts';

/** 打标两类硬角色：`requirement` 与 `defect` 各至少 1 个（`other` 可缺省）。 */
const REQUIRED_ROLES = [
  { name: '需求', role: 'requirement' },
  { name: '缺陷', role: 'defect' },
] as const;

/**
 * Q4 之后 `{}` **不再是**合法配置（`agent.managers` 必须非空、词表必须含两类角色）：
 * 正例一律带上这一份。负例直接喂原 schema，断言的是「这一项本身不合法」而不是「因为缺 managers / 缺角色而失败」。
 */
const OK = { agent: { managers: ['alice'] }, labels: { vocabulary: REQUIRED_ROLES } } as const;

function parses(patch: Record<string, unknown>): boolean {
  return repoSettingsSchema.safeParse({ ...OK, ...patch }).success;
}

describe('repoSettingsSchema（repos.settings 的 jsonb 形状）', () => {
  it('合法配置的缺省值（含 version、dry-run、并发、队列等待、agent 段）', () => {
    const settings = parseRepoSettings(OK);
    expect(settings.version).toBe(1);
    expect(settings.enabled).toBe(true);
    expect(settings.dry_run).toBe(true);
    expect(settings.limits.max_task_minutes).toBe(20);
    expect(settings.limits.concurrency_per_repo).toBe(2);
    expect(settings.limits.queue_wait_minutes).toBe(10);
    expect(settings.labels.map).toEqual({});
    // 词表本身没有默认值（形状默认空）；「两类角色各至少 1 个」由严格 schema 校验（见下面几条）
    expect(repoSettingsShapeSchema.parse({}).labels.vocabulary).toEqual([]);
    expect(settings.labels.missing).toBe('warn');
    expect(settings.labels.max_per_issue).toBe(6);
    // 触发体系只剩别名：不配就是 undefined（webhook 用部署默认）
    expect(settings.triggers.aliases).toBeUndefined();
    expect(settings.skills.project_skills).toBe(true);
    // agent 段：没有 enabled、没有任何阈值；两个事件默认加载 issue-format（真实存在的技能）
    expect(settings.agent).toEqual({
      managers: ['alice'],
      on_opened: 'issue-format',
      on_edited: 'issue-format',
      auto_label_after_format_pass: false,
      project_prompt: '',
      // v2.1 新增：系统提示词（空串 = 用内置）、执行限额、后三类动作开关（默认全关）
      system_prompt: '',
      limits: {
        system_prompt: '',
        concurrency: 2,
        daily_quota: 100,
        turn_timeout_minutes: 20,
        actions: { create_issue: false, open_pr: false, close_issue: false },
        data_retention_days: 90,
      },
      actions: { create_issue: false, open_pr: false, close_issue: false },
    });
  });

  it('空对象不再合法：`agent.managers` 非空是运行前提（Q4，不做兼容）', () => {
    const result = repoSettingsSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'agent.managers')).toBe(true);
    }
    expect(repoSettingsSchema.safeParse({ agent: { managers: [] } }).success).toBe(false);
    expect(repoSettingsSchema.safeParse({ agent: {} }).success).toBe(false);
  });

  it('DEFAULT_REPO_SETTINGS = 形状默认值（managers 为空）：不是合法运行配置', () => {
    expect(DEFAULT_REPO_SETTINGS.agent.managers).toEqual([]);
    expect(repoSettingsShapeSchema.parse({})).toEqual(DEFAULT_REPO_SETTINGS);
    // 形状默认值喂给严格 schema 直接被拒（settings_valid=false 属预期）
    expect(repoSettingsSchema.safeParse(DEFAULT_REPO_SETTINGS).success).toBe(false);
    // 只补 managers 仍不合法：词表还缺 requirement / defect
    expect(
      repoSettingsSchema.safeParse({
        ...DEFAULT_REPO_SETTINGS,
        agent: { ...DEFAULT_REPO_SETTINGS.agent, managers: ['alice'] },
      }).success,
    ).toBe(false);
    expect(
      repoSettingsSchema.safeParse({
        ...DEFAULT_REPO_SETTINGS,
        agent: { managers: ['alice'] },
        labels: { vocabulary: REQUIRED_ROLES },
      }).success,
    ).toBe(true);
  });

  it('agent.managers：login 形状、上限 20、大小写不敏感去重', () => {
    expect(parses({ agent: { managers: ['alice', 'bob-2'] } })).toBe(true);
    expect(parses({ agent: { managers: ['@alice'] } })).toBe(false);
    expect(parses({ agent: { managers: [''] } })).toBe(false);
    expect(parses({ agent: { managers: ['alice', 'Alice'] } })).toBe(false);
    expect(parses({ agent: { managers: Array.from({ length: 21 }, (_unused, index) => `u${String(index)}`) } })).toBe(
      false,
    );
  });

  it('agent 段没有 enabled、没有任何流程阈值（收为系统常量）', () => {
    expect(parses({ agent: { managers: ['alice'], enabled: true } })).toBe(false);
    expect(parses({ agent: { managers: ['alice'], close_after_hours: 48 } })).toBe(false);
    expect(parses({ agent: { managers: ['alice'], format_prompt_version: 1 } })).toBe(false);
    expect(parses({ agent: { managers: ['alice'], agent_prompt_version: 7 } })).toBe(false);
  });

  it('agent.on_opened / on_edited 可为 null（= 不投递），project_prompt ≤ 4000', () => {
    const settings = parseRepoSettings({ ...OK, agent: { managers: ['alice'], on_opened: null, on_edited: null } });
    expect(settings.agent.on_opened).toBeNull();
    expect(settings.agent.on_edited).toBeNull();
    expect(parses({ agent: { managers: ['alice'], on_opened: '' } })).toBe(false);
    expect(parses({ agent: { managers: ['alice'], project_prompt: 'a'.repeat(4000) } })).toBe(true);
    expect(parses({ agent: { managers: ['alice'], project_prompt: 'a'.repeat(4001) } })).toBe(false);
    expect(parses({ agent: { managers: ['alice'], auto_label_after_format_pass: 'yes' } })).toBe(false);
  });

  it('标签 role 必填，且只接受 requirement / defect / other（Q4 不做回填）', () => {
    expect(parses({ labels: { vocabulary: [...REQUIRED_ROLES, { name: '咨询', role: 'other' }] } })).toBe(true);
    const missingRole = repoSettingsSchema.safeParse({ ...OK, labels: { vocabulary: [{ name: 'bug' }] } });
    expect(missingRole.success).toBe(false);
    if (!missingRole.success) {
      expect(missingRole.error.issues.some((issue) => issue.path.join('.') === 'labels.vocabulary.0.role')).toBe(true);
    }
    expect(parses({ labels: { vocabulary: [{ name: 'bug', role: 'not-found' }] } })).toBe(false);
    expect(parses({ labels: { vocabulary: [{ name: 'bug', role: 'other', bogus: 1 }] } })).toBe(false);
  });

  it('缺 requirement 角色 → 失败（superRefine 无条件生效）', () => {
    const result = repoSettingsSchema.safeParse({
      agent: { managers: ['alice'] },
      labels: { vocabulary: [{ name: '缺陷', role: 'defect' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((entry) => entry.path.join('.') === 'labels.vocabulary');
      expect(issue?.message).toContain('打标需要至少一个需求标签与一个缺陷标签');
      expect(issue?.message).toContain('requirement');
      expect(issue?.message).not.toContain('defect');
    }
  });

  it('缺 defect 角色 → 失败', () => {
    const result = repoSettingsSchema.safeParse({
      agent: { managers: ['alice'] },
      labels: { vocabulary: [{ name: '需求', role: 'requirement' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((entry) => entry.path.join('.') === 'labels.vocabulary');
      expect(issue?.message).toContain('打标需要至少一个需求标签与一个缺陷标签');
      expect(issue?.message).toContain('defect');
    }
  });

  it('只有 other 两条 → 失败（`other` 可缺省，但不能顶替 requirement / defect）', () => {
    const result = repoSettingsSchema.safeParse({
      agent: { managers: ['alice'] },
      labels: {
        vocabulary: [
          { name: '咨询', role: 'other' },
          { name: '讨论', role: 'other' },
        ],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((entry) => entry.path.join('.') === 'labels.vocabulary')).toBe(true);
    }
  });

  it('requirement + defect 各一、没有 other → 通过（other 可缺省 = 其他类型不打标）', () => {
    const settings = parseRepoSettings({ agent: { managers: ['alice'] }, labels: { vocabulary: REQUIRED_ROLES } });
    expect(settings.labels.vocabulary.map((entry) => entry.role)).toEqual(['requirement', 'defect']);
    expect(pipelineLabelCoverage(settings)).toEqual({ missingRoles: [] });
  });

  it('词表内重复 name 被拒（大小写不敏感：同 role 打哪个标签不能变成不确定）', () => {
    expect(
      parses({
        labels: {
          vocabulary: [
            { name: 'bug', role: 'defect' },
            { name: 'bug', role: 'other' },
          ],
        },
      }),
    ).toBe(false);
    expect(
      parses({
        labels: {
          vocabulary: [
            { name: 'bug', role: 'defect' },
            { name: 'Bug', role: 'other' },
          ],
        },
      }),
    ).toBe(false);
    expect(
      parses({
        labels: {
          vocabulary: [
            { name: 'bug', role: 'defect' },
            { name: '需求', role: 'requirement' },
          ],
        },
      }),
    ).toBe(true);
  });

  it('pipelineLabelCoverage：schema 已强制覆盖，本函数只做面板的防御性展示', () => {
    // 存量 / 迁移后未配置的仓库：形状默认值是空词表（严格 schema 拒收，`settings_valid=false` 属预期）
    expect(pipelineLabelCoverage(DEFAULT_REPO_SETTINGS)).toEqual({ missingRoles: ['requirement', 'defect'] });
    // 存量数据里「只有一类角色」的旧词表（严格 schema 下不合法）也能被它说清缺什么
    const shapeOnlyRequirement = repoSettingsShapeSchema.parse({
      labels: { vocabulary: [{ name: '需求', role: 'requirement' }] },
    });
    expect(pipelineLabelCoverage(shapeOnlyRequirement)).toEqual({ missingRoles: ['defect'] });
    const full = parseRepoSettings({ agent: { managers: ['alice'] }, labels: { vocabulary: REQUIRED_ROLES } });
    expect(pipelineLabelCoverage(full)).toEqual({ missingRoles: [] });
  });

  it('完整配置可以解析（标签词表 / 1:N 映射 / agent / 并发）', () => {
    const settings = parseRepoSettings({
      version: 1,
      enabled: true,
      dry_run: false,
      model: 'anthropic/claude-sonnet-4',
      triggers: { aliases: ['TriageBot'] },
      agent: {
        managers: ['alice', 'bob'],
        on_opened: 'format-check',
        on_edited: null,
        auto_label_after_format_pass: true,
        project_prompt: '本仓库用 pnpm。',
      },
      labels: {
        vocabulary: [
          { name: 'enhancement', role: 'requirement', meaning: '新功能需求', color: 'a2eeef' },
          { name: 'bug', role: 'defect', meaning: '确认的缺陷', color: 'd73a4a', group: 'type' },
          { name: 'needs-info', role: 'other', meaning: '缺复现步骤', color: '0e8a16' },
        ],
        map: { bug: 'bug', needsInfo: ['needs-info', 'question'] },
        allow: ['bug', 'needs-info', 'question'],
        missing: 'create',
        max_per_issue: 3,
      },
      skills: { project_skills: false },
      limits: {
        max_comments_per_hour: 4,
        max_actions_per_run: 6,
        max_task_minutes: 30,
        concurrency_per_repo: 3,
        queue_wait_minutes: 5,
      },
    });
    // 1:1 与 1:N 两种写法都能解析（1:N 的展开在应用层）
    expect(settings.labels.map['bug']).toBe('bug');
    expect(settings.labels.map['needsInfo']).toEqual(['needs-info', 'question']);
    expect(settings.labels.vocabulary.find((entry) => entry.name === 'bug')?.role).toBe('defect');
    expect(settings.labels.missing).toBe('create');
    expect(settings.labels.max_per_issue).toBe(3);
    expect(settings.agent.on_edited).toBeNull();
    expect(settings.agent.auto_label_after_format_pass).toBe(true);
    expect(settings.agent.project_prompt).toBe('本仓库用 pnpm。');
    expect(settings.limits.concurrency_per_repo).toBe(3);
    expect(settings.skills.project_skills).toBe(false);
    expect(settings.triggers.aliases).toEqual(['TriageBot']);
  });

  it('未知键被拒（配置写错不能静默忽略）：compliance / triggers.enabled / agent.enabled / 已删段', () => {
    expect(repoSettingsSchema.safeParse({ dryrun: true }).success).toBe(false);
    expect(repoSettingsSchema.safeParse({ limits: { max_comment: 3 } }).success).toBe(false);
    // `compliance` 不再是合法段（规则改由提示词/技能承载）
    expect(repoSettingsSchema.safeParse({ compliance: { enabled: false } }).success).toBe(false);
    // `triggers.faces` / `triggers.enabled` / `triggers.users` 已删：老配置整份被拒，不静默吞掉
    expect(parses({ triggers: { faces: { issue_comment: 'mention' } } })).toBe(false);
    expect(parses({ triggers: { enabled: false } })).toBe(false);
    expect(parses({ triggers: { users: 'all' } })).toBe(false);
    expect(parses({ triggers: { merge_defaults: false } })).toBe(false);
    expect(parses({ triggers: { remove: ['ibot'] } })).toBe(false);
    // v1.5 的四段整体退役
    expect(parses({ pipeline: { managers: ['alice'] } })).toBe(false);
    expect(parses({ prompt: { enabled: true } })).toBe(false);
    expect(parses({ commands: { enabled: true } })).toBe(false);
    expect(parses({ create_issue: { enabled: true } })).toBe(false);
    expect(parses({ skills: { repo_skills: false } })).toBe(false);
  });

  it('版本号只接受 1（缺省按 1）', () => {
    expect(parses({ version: 2 })).toBe(false);
    expect(parses({ version: 1 })).toBe(true);
    expect(parseRepoSettings(OK).version).toBe(1);
  });

  it('限额有边界', () => {
    expect(parses({ limits: { max_actions_per_run: 9 } })).toBe(false);
    expect(parses({ limits: { max_task_minutes: 31 } })).toBe(false);
    expect(parses({ limits: { concurrency_per_repo: 0 } })).toBe(false);
    expect(parses({ limits: { queue_wait_minutes: 0 } })).toBe(false);
    expect(parses({ labels: { max_per_issue: 0 } })).toBe(false);
  });

  it('模型名必须是 provider/model', () => {
    expect(parses({ model: 'claude-sonnet-4' })).toBe(false);
    expect(parses({ model: 'anthropic/claude-sonnet-4' })).toBe(true);
  });

  it('标签：missing 只接受三态、颜色是 6 位十六进制', () => {
    expect(parses({ labels: { missing: 'boom' } })).toBe(false);
    expect(parses({ labels: { vocabulary: [{ name: 'bug', role: 'other', color: '#d73a4a' }] } })).toBe(false);
    expect(parses({ labels: { vocabulary: [{ name: 'bug', role: 'other', color: 'd73a4a' }, ...REQUIRED_ROLES] } })).toBe(
      true,
    );
  });

  it('旧名是同一个 schema 的 deprecated alias（不复制第二份默认值）', () => {
    expect(repoConfigSchema).toBe(repoSettingsSchema);
    expect(parseRepoConfig).toBe(parseRepoSettings);
    expect(DEFAULT_REPO_SETTINGS).toEqual(repoSettingsShapeSchema.parse({}));
  });
});

describe('技能 frontmatter（contract-skill.md 逐字段）', () => {
  const minimal = {
    name: '/issue-triage',
    description: '判断 issue 是否符合仓库报告标准，缺失项收成一条评论',
    'allowed-tools': ['Read', 'Glob', 'Grep'],
    outputs: ['comment', 'labels'],
  };

  it('契约 §5.1 的最小合法技能通过，并得到默认值', () => {
    const frontmatter = skillFrontmatterSchema.parse(minimal);
    const effective = toSkillEffectiveConfig(frontmatter);
    expect(effective.timeoutMs).toBe(20 * 60_000);
    expect(effective.timeoutTruncated).toBe(false);
    expect(effective.model).toBeNull();
    expect(effective.inputs).toEqual([]);
    expect(effective.requiresRepoConfig).toBe(false);
  });

  it('契约 §5.3 的五处越界逐条被拒', () => {
    // 1. 未知顶层键（description 的多行写法在 Agent Skills 标准里允许，见下方正向用例）
    expect(
      skillFrontmatterSchema.safeParse({ ...minimal, description: '审查这个 PR，跑测试。', unknownKey: 'x' }).success,
    ).toBe(false);
    // 2. allowed-tools 含枚举外工具：整份非法，不截断
    expect(skillFrontmatterSchema.safeParse({ ...minimal, 'allowed-tools': ['Read', 'WebFetch'] }).success).toBe(false);
    // 3. timeout 缺单位 / 超上限（格式非法，没有可截断的值）
    expect(skillFrontmatterSchema.safeParse({ ...minimal, timeout: '45' }).success).toBe(false);
    // 4. outputs 含 push_branch（枚举只有 comment/labels/issue/pr）
    expect(skillFrontmatterSchema.safeParse({ ...minimal, outputs: ['comment', 'push_branch'] }).success).toBe(false);
    // 5. requires-repo-config 只接受字面量布尔（YAML 1.2 下 `yes` 是字符串）
    expect(skillFrontmatterSchema.safeParse({ ...minimal, 'requires-repo-config': 'yes' }).success).toBe(false);
  });

  it('键拼错被拒（allowed-tool 少了 s）', () => {
    const typo = { name: '/review-pr', description: '审查拉取请求并给出结论', 'allowed-tool': ['Read'], outputs: ['comment'] };
    expect(skillFrontmatterSchema.safeParse(typo).success).toBe(false);
  });

  it('名字规则：必须 / 开头、小写、非保留名', () => {
    // 标准允许省略前导 /（解析期归一成 /review-pr），见 contract-skill.md D2
    expect(skillFrontmatterSchema.safeParse({ ...minimal, name: 'review-pr' }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, name: '/Review-Pr' }).success).toBe(false);
    for (const reserved of SKILL_RESERVED_NAMES) {
      expect(skillFrontmatterSchema.safeParse({ ...minimal, name: reserved }).success).toBe(false);
    }
    expect(skillFrontmatterSchema.safeParse({ ...minimal, name: '/a-' }).success).toBe(false); /* 单字符名在标准里合法，这里改用「尾随连字符」*/
  });

  it('description 长度 10–200', () => {
    expect(skillFrontmatterSchema.safeParse({ ...minimal, description: '太短' }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, description: 'a'.repeat(201) }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, description: 'a'.repeat(1025) }).success).toBe(false);
  });

  it('allowed-tools / outputs 都是非空枚举，且工具枚举与审批矩阵同源', () => {
    expect(SKILL_ALLOWED_TOOLS).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, 'allowed-tools': [] }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, outputs: [] }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, 'allowed-tools': ['read'] }).success).toBe(false);
    // pr 隐含 push_branch；outputs 里永远不写 open_pr
    expect(SKILL_OUTPUT_INTENTS.pr).toEqual(['push_branch']);
    expect(SKILL_OUTPUT_INTENTS.comment).toEqual(['comment']);
  });

  it('inputs：≤8 项、name 规则、pattern/description 长度', () => {
    const input = { name: 'focus', required: false, pattern: '^(repro|depth)$', description: '关注点' };
    expect(skillFrontmatterSchema.safeParse({ ...minimal, inputs: [input] }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, inputs: Array.from({ length: 9 }, () => input) }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, inputs: [{ ...input, name: 'Focus' }] }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, inputs: [{ ...input, description: 'a\nb' }] }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, inputs: [{ ...input, pattern: 'a'.repeat(129) }] }).success).toBe(false);
  });
});

describe('技能超时：上限 30m，超出截断 + warn', () => {
  it('解析 s 与 m 后缀', () => {
    expect(parseSkillTimeoutMs('90s')).toBe(90_000);
    expect(parseSkillTimeoutMs('20m')).toBe(1_200_000);
    expect(parseSkillTimeoutMs('0s')).toBe(0);
    expect(() => parseSkillTimeoutMs('45')).toThrow();
  });

  it('缺省 20m；超过上限截断到 30m 并标记 truncated', () => {
    expect(effectiveSkillTimeout(undefined)).toEqual({ ms: 20 * 60_000, truncated: false });
    expect(effectiveSkillTimeout('30m')).toEqual({ ms: SKILL_TIMEOUT_MAX_MS, truncated: false });
    expect(effectiveSkillTimeout('31m')).toEqual({ ms: SKILL_TIMEOUT_MAX_MS, truncated: true });
  });

  it('技能合法但超时也在 schema 层通过（截断发生在展开阶段）', () => {
    const frontmatter = skillFrontmatterSchema.parse({
      name: '/review-pr',
      description: '审查拉取请求，跑测试并给出结论',
      'allowed-tools': ['Read', 'Bash'],
      timeout: '45m',
      outputs: ['comment', 'pr'],
      'requires-repo-config': true,
    });
    const effective = toSkillEffectiveConfig(frontmatter);
    expect(effective.timeoutMs).toBe(SKILL_TIMEOUT_MAX_MS);
    expect(effective.timeoutTruncated).toBe(true);
    expect(effective.outputs).toEqual(['comment', 'pr']);
    expect(effective.requiresRepoConfig).toBe(true);
  });
});
