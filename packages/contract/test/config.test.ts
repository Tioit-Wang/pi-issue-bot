import { describe, expect, it } from 'vitest';

import {
  SKILL_ALLOWED_TOOLS,
  SKILL_OUTPUT_INTENTS,
  SKILL_RESERVED_NAMES,
  SKILL_TIMEOUT_MAX_MS,
  effectiveSkillTimeout,
  parseRepoConfig,
  parseSkillTimeoutMs,
  repoConfigSchema,
  skillFrontmatterSchema,
  toSkillEffectiveConfig,
} from '../src/index.ts';

describe('.github/pi-bot.yml', () => {
  it('只写 version 时全部取默认值（含建 issue 日配额 10、默认 dry-run）', () => {
    const config = parseRepoConfig({ version: 1 });
    expect(config.enabled).toBe(true);
    expect(config.dry_run).toBe(true);
    expect(config.create_issue.enabled).toBe(false);
    expect(config.create_issue.daily_quota).toBe(10);
    expect(config.create_issue.scenarios).toEqual(['pr-review']);
    expect(config.commands.allowed).toEqual(['/review-pr', '/issue-triage', '/issue-repro']);
    expect(config.commands.author_associations).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    expect(config.limits.max_task_minutes).toBe(20);
    expect(config.labels.map).toEqual({});
    expect(config.compliance.rules).toEqual([]);
  });

  it('完整配置可以解析（标签映射 / 开关 / 配额 / 命令白名单）', () => {
    const config = parseRepoConfig({
      version: 1,
      enabled: true,
      dry_run: false,
      model: 'anthropic/claude-sonnet-4',
      labels: { map: { bug: 'bug', feature: 'enhancement', needsInfo: 'needs-info' }, allow: ['bug', 'enhancement'] },
      compliance: { enabled: true, rules: [{ id: 'has-repro', description: '复现步骤', required: true }] },
      create_issue: { enabled: true, daily_quota: 3, scenarios: ['pr-review', 'dependency'] },
      commands: { enabled: true, allowed: ['/review-pr'], allow_users: ['alice'], rate_limit_per_hour: 5 },
      skills: { repo_skills: false },
      limits: { max_comments_per_hour: 4, max_actions_per_run: 6, max_task_minutes: 30 },
    });
    expect(config.labels.map['bug']).toBe('bug');
    expect(config.create_issue.daily_quota).toBe(3);
    expect(config.commands.rate_limit_per_hour).toBe(5);
  });

  it('未知键被拒（配置写错不能静默忽略）', () => {
    expect(repoConfigSchema.safeParse({ version: 1, dryrun: true }).success).toBe(false);
    expect(repoConfigSchema.safeParse({ version: 1, limits: { max_comment: 3 } }).success).toBe(false);
  });

  it('版本号只接受 1', () => {
    expect(repoConfigSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(repoConfigSchema.safeParse({}).success).toBe(false);
  });

  it('配额与限额有边界', () => {
    expect(repoConfigSchema.safeParse({ version: 1, create_issue: { daily_quota: 0 } }).success).toBe(false);
    expect(repoConfigSchema.safeParse({ version: 1, create_issue: { daily_quota: 101 } }).success).toBe(false);
    expect(repoConfigSchema.safeParse({ version: 1, limits: { max_actions_per_run: 9 } }).success).toBe(false);
    expect(repoConfigSchema.safeParse({ version: 1, limits: { max_task_minutes: 31 } }).success).toBe(false);
  });

  it('模型名必须是 provider/model', () => {
    expect(repoConfigSchema.safeParse({ version: 1, model: 'claude-sonnet-4' }).success).toBe(false);
    expect(repoConfigSchema.safeParse({ version: 1, model: 'anthropic/claude-sonnet-4' }).success).toBe(true);
  });

  it('合规规则 id 只接受小写短横线，命令白名单必须带 /', () => {
    expect(repoConfigSchema.safeParse({ version: 1, compliance: { rules: [{ id: 'Has Repro' }] } }).success).toBe(false);
    expect(repoConfigSchema.safeParse({ version: 1, commands: { allowed: ['review-pr'] } }).success).toBe(false);
    expect(repoConfigSchema.safeParse({ version: 1, commands: { author_associations: ['NONE'] } }).success).toBe(false);
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
    // 1. description 块标量（多行）
    expect(
      skillFrontmatterSchema.safeParse({ ...minimal, description: '审查这个 PR，跑测试。\n会推 bot 分支。' }).success,
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
    expect(skillFrontmatterSchema.safeParse({ ...minimal, name: 'review-pr' }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, name: '/Review-Pr' }).success).toBe(false);
    for (const reserved of SKILL_RESERVED_NAMES) {
      expect(skillFrontmatterSchema.safeParse({ ...minimal, name: reserved }).success).toBe(false);
    }
    expect(skillFrontmatterSchema.safeParse({ ...minimal, name: '/a' }).success).toBe(false);
  });

  it('description 长度 10–200', () => {
    expect(skillFrontmatterSchema.safeParse({ ...minimal, description: '太短' }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ ...minimal, description: 'a'.repeat(201) }).success).toBe(false);
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
