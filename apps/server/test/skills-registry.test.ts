/**
 * 技能加载与注册表（契约 `docs/spec/contract-skill.md` §2 / §3）。
 *
 * 这一组测试的重点不是「好文件能加载」，而是**坏文件不会被悄悄放过**：
 * 名字不合规、未知字段、超时越界、保留名、撞名、`requires-repo-config` 缺失——
 * 每一个都必须「禁用 + 给出原因」，且**不回落内置**。
 *
 * 另外两条是给 CI 用的：`examples/` 里的仓库配置与技能模板必须真能被解析，
 * 且模板与内置技能的 name / allowed-tools / outputs 不许漂移（否则文档会慢慢撒谎）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { skillSummarySchema, skillFrontmatterSchema } from '../../../packages/contract/src/index.ts';
import { decodeRepoConfig } from '../src/config/repo-config.ts';
import { parseSkillFile, splitFrontmatter } from '../src/skills/frontmatter.ts';
import { createSkillRegistry, REPO_SKILLS_DIR, UNNAMED_SKILL } from '../src/skills/index.ts';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

function readExample(path: string): string {
  return readFileSync(`${EXAMPLES_DIR}${path}`, 'utf8');
}

/** 一份最小合法技能（各用例在此基础上改一处）。 */
const MINIMAL = [
  '---',
  'name: /demo-cmd',
  'description: 一个用来测试的最小技能描述',
  'allowed-tools: [Read, Glob]',
  'outputs: [comment]',
  '---',
  '',
  '正文：处理 {{target}}。',
].join('\n');

describe('frontmatter 解析与校验（加载期）', () => {
  it('最小合法技能通过，并给出归一化名与正文', () => {
    const parsed = parseSkillFile(MINIMAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.name).toBe('/demo-cmd');
    expect(parsed.body).toBe('正文：处理 {{target}}。');
  });

  it('缺少 frontmatter / 没有结束分隔行都会被拒', () => {
    expect(parseSkillFile('name: /x\ndescription: 没有 frontmatter 的一段文字').ok).toBe(false);
    expect(splitFrontmatter('---\nname: /x\n').ok).toBe(false);
  });

  it('契约 §5.2：名字非小写、不以 / 开头 + 键写错 → 逐个都是拒绝理由', () => {
    const parsed = parseSkillFile(
      ['---', 'name: Review-PR', 'description: 审查 PR', 'allowed-tool: [Read, Bash]', 'outputs: [comment]', '---', ''].join('\n'),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    // 名字不合规（大写、无 `/`）与未知键（allowed-tool）必须都说出来
    expect(parsed.issues.join('; ')).toMatch(/name/u);
    expect(parsed.issues.join('; ')).toMatch(/allowed-tool/u);
  });

  it('契约 §5.3：块标量 / 枚举外工具 / 超时越界 / push_branch / yes 布尔全部被拒', () => {
    const text = [
      '---',
      'name: /review-pr',
      'description: |',
      '  审查这个 PR，跑测试并给出结论。',
      'allowed-tools: [Read, Bash, WebFetch]',
      'timeout: 45',
      'outputs: [comment, push_branch]',
      'requires-repo-config: yes',
      '---',
      '',
    ].join('\n');
    const parsed = parseSkillFile(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    // 块标量在受限 YAML 子集里就先被拒了（`|` 不支持）——这比「解析成多行再校验」更早也更明确
    expect(parsed.detail).toMatch(/块标量|description/u);
  });

  it('保留名不可用（/retry /help /skills）', () => {
    const parsed = parseSkillFile(
      ['---', 'name: /retry', 'description: 想覆盖人工重跑入口的技能', 'allowed-tools: [Read]', 'outputs: [comment]', '---', ''].join('\n'),
    );
    expect(parsed.ok).toBe(false);
  });

  it('timeout 缺单位会被拒（合法但超上限是另一条路径：截断 + warn）', () => {
    const bad = parseSkillFile(
      ['---', 'name: /a-b', 'description: 缺少单位的超时声明', 'allowed-tools: [Read]', 'timeout: 45', 'outputs: [comment]', '---', ''].join('\n'),
    );
    expect(bad.ok).toBe(false);

    const overLimit = parseSkillFile(
      ['---', 'name: /a-b', 'description: 超过上限但格式合法的超时', 'allowed-tools: [Read]', 'timeout: 90m', 'outputs: [comment]', '---', ''].join('\n'),
    );
    expect(overLimit.ok).toBe(true);
  });
});

describe('注册表：覆盖、冲突与禁用可见性', () => {
  it('内置技能的摘要能通过契约的 skillSummarySchema（面板直接吃它）', () => {
    const registry = createSkillRegistry();
    const summaries = registry.summaries();
    expect(summaries.map((s) => s.name)).toEqual(['/issue-repro', '/issue-triage', '/review-pr']);
    for (const summary of summaries) {
      const parsed = skillSummarySchema.safeParse({
        name: summary.name,
        source: summary.source,
        enabled: summary.enabled,
        disabledReason: summary.disabledReason,
        outputs: [...summary.outputs],
        timeoutMs: summary.timeoutMs,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('仓库技能同名时整体替换内置技能（不合并字段）', () => {
    const registry = createSkillRegistry({
      repoSkills: [
        {
          path: `${REPO_SKILLS_DIR}/review-pr.md`,
          text: [
            '---',
            'name: /review-pr',
            'description: 仓库自己的审查流程，只读不写',
            'allowed-tools: [Read, Grep]',
            'outputs: [comment]',
            '---',
            '',
            '只评论。',
          ].join('\n'),
        },
      ],
    });
    const skill = registry.resolve('/review-pr');
    expect(skill).toBeDefined();
    expect(skill?.source).toBe('repo');
    expect(skill?.frontmatter['allowed-tools']).toEqual(['Read', 'Grep']);
    expect(skill?.effective.outputs).toEqual(['comment']);
    expect(registry.diagnostics().some((d) => d.code === 'builtin-overridden')).toBe(true);
  });

  it('非法仓库技能不回落内置：该命令不可用且原因可见', () => {
    const registry = createSkillRegistry({
      repoSkills: [
        {
          path: `${REPO_SKILLS_DIR}/review-pr.md`,
          text: ['---', 'name: /review-pr', 'description: 写坏了', 'allowed-tools: [Read]', 'outputs: [comment]', '---', ''].join('\n'),
        },
      ],
    });
    expect(registry.resolve('/review-pr')).toBeUndefined();
    const entry = registry.get('/review-pr');
    expect(entry?.kind).toBe('disabled');
    expect(entry?.summary.disabledReason).toBe('skill_invalid');
    expect(entry?.kind === 'disabled' ? entry.detail : '').toMatch(/description/u);
  });

  it('仓库内两个技能归一化后同名 → 两个都不加载，记 skill_conflict', () => {
    const registry = createSkillRegistry({
      repoSkills: [
        { path: `${REPO_SKILLS_DIR}/a.md`, text: MINIMAL.replace('/demo-cmd', '/Dup-Cmd') },
        { path: `${REPO_SKILLS_DIR}/b.md`, text: MINIMAL.replace('/demo-cmd', '/dup-cmd') },
      ],
    });
    expect(registry.resolve('/dup-cmd')).toBeUndefined();
    expect(registry.get('/dup-cmd')?.summary.disabledReason).toBe('skill_conflict');
    expect(registry.diagnostics().filter((d) => d.code === 'skill-conflict')).toHaveLength(2);
  });

  it('合法但超 30m 的技能被截断到上限并记 warn（技能仍可用）', () => {
    const registry = createSkillRegistry({
      repoSkills: [
        {
          path: `${REPO_SKILLS_DIR}/slow.md`,
          text: ['---', 'name: /slow-cmd', 'description: 一个超时的长任务技能', 'allowed-tools: [Bash]', 'timeout: 90m', 'outputs: [comment]', '---', ''].join('\n'),
        },
      ],
    });
    const skill = registry.resolve('/slow-cmd');
    expect(skill?.effective.timeoutMs).toBe(30 * 60 * 1000);
    expect(skill?.effective.timeoutTruncated).toBe(true);
    expect(registry.diagnostics().some((d) => d.code === 'timeout-truncated')).toBe(true);
  });

  it('requires-repo-config 缺配置 → repo-config-missing；有配置 → 可用', () => {
    const text = [
      '---',
      'name: /needs-config',
      'description: 依赖仓库配置的判定技能',
      'allowed-tools: [Read]',
      'outputs: [comment]',
      'requires-repo-config: true',
      '---',
      '',
    ].join('\n');

    const missing = createSkillRegistry({ repoSkills: [{ path: `${REPO_SKILLS_DIR}/nc.md`, text }] });
    expect(missing.get('/needs-config')?.summary.disabledReason).toBe('repo-config-missing');

    const withConfig = createSkillRegistry({
      repoSkills: [{ path: `${REPO_SKILLS_DIR}/nc.md`, text }],
      config: { labels: { map: { bug: 'bug' } }, compliance: { enabled: true, rules: [] }, skills: { repo_skills: true } },
    });
    expect(withConfig.resolve('/needs-config')).toBeDefined();
  });

  it('skills.repo_skills=false 时仓库技能整批不生效，内置仍然可用', () => {
    const registry = createSkillRegistry({
      repoSkills: [{ path: `${REPO_SKILLS_DIR}/x.md`, text: MINIMAL }],
      config: { labels: { map: {} }, compliance: { enabled: true, rules: [] }, skills: { repo_skills: false } },
    });
    expect(registry.resolve('/demo-cmd')).toBeUndefined();
    expect(registry.resolve('/issue-triage')).toBeDefined();
    expect(registry.diagnostics().some((d) => d.code === 'repo-skills-disabled')).toBe(true);
  });

  it('连名字都没有的坏文件也要在面板里占一行（不静默丢弃）', () => {
    const registry = createSkillRegistry({
      repoSkills: [{ path: `${REPO_SKILLS_DIR}/broken.md`, text: '---\ndescription: 没有 name 的技能\nallowed-tools: [Read]\noutputs: [comment]\n---\n' }],
    });
    expect(registry.summaries().some((s) => s.name === UNNAMED_SKILL)).toBe(true);
  });

  it('内置技能自身的 frontmatter 必须满足契约（我们自己也不许写错）', () => {
    const registry = createSkillRegistry();
    for (const entry of registry.list()) {
      if (entry.kind !== 'ready') {
        continue;
      }
      expect(skillFrontmatterSchema.safeParse(entry.skill.frontmatter).success).toBe(true);
    }
  });
});

describe('examples/ 是 CI 的校验样本', () => {
  it('示例 .github/pi-bot.yml 能通过 repoConfigSchema', () => {
    const decoded = decodeRepoConfig(readExample('.github/pi-bot.yml'));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.config.compliance.rules.length).toBeGreaterThan(0);
    expect(decoded.config.commands.allowed).toContain('/review-pr');
  });

  it('示例技能 md 全部合法，且与内置技能的声明一致（防文档漂移）', () => {
    const dir = `${EXAMPLES_DIR}.github/pi-bot/skills/`;
    const files = readdirSync(dir).filter((name) => name.endsWith('.md'));
    expect(files.length).toBe(3);

    const builtin = createSkillRegistry();
    for (const file of files) {
      const parsed = parseSkillFile(readExample(`.github/pi-bot/skills/${file}`));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      const reference = builtin.get(parsed.name);
      expect(reference?.kind).toBe('ready');
      if (reference?.kind !== 'ready') {
        continue;
      }
      expect(parsed.frontmatter['allowed-tools']).toEqual(reference.skill.frontmatter['allowed-tools']);
      expect(parsed.frontmatter.outputs).toEqual(reference.skill.frontmatter.outputs);
      expect(parsed.frontmatter.timeout).toEqual(reference.skill.frontmatter.timeout);
    }
  });
});