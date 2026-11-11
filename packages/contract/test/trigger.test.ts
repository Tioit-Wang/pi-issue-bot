import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIGGER_ALIASES,
  findAliasHits,
  isTriggerUserAllowed,
  maskCodeRegions,
  normalizeTriggerAlias,
  parseTriggerBody,
  resolveTriggerAliases,
  triggersConfigSchema,
} from '../src/trigger.ts';

const ALIASES = resolveTriggerAliases({ deployment: ['issuebot', 'ibot'] });

describe('normalizeTriggerAlias', () => {
  it('去掉 @、大小写归一', () => {
    expect(normalizeTriggerAlias('@IssueBot')).toBe('issuebot');
    expect(normalizeTriggerAlias('  IBot ')).toBe('ibot');
  });
});

describe('resolveTriggerAliases', () => {
  it('默认就是 issuebot + ibot，最长优先', () => {
    expect(ALIASES).toEqual(['issuebot', 'ibot']);
    expect(DEFAULT_TRIGGER_ALIASES).toEqual(['issuebot', 'ibot']);
  });

  it('仓库别名与部署默认并集（merge_defaults 默认开）', () => {
    const configured = triggersConfigSchema.parse({ aliases: ['TriageBot'] });
    expect(resolveTriggerAliases({ configured, deployment: ['issuebot', 'ibot'] })).toEqual([
      'triagebot',
      'issuebot',
      'ibot',
    ]);
  });

  it('merge_defaults=false 时只用仓库别名', () => {
    const configured = triggersConfigSchema.parse({ aliases: ['triagebot'], merge_defaults: false });
    expect(resolveTriggerAliases({ configured, deployment: ['issuebot', 'ibot'] })).toEqual(['triagebot']);
  });

  it('remove 能把默认别名摘掉（撞真人用户名时用）', () => {
    const configured = triggersConfigSchema.parse({ remove: ['@ibot'] });
    expect(resolveTriggerAliases({ configured, deployment: ['issuebot', 'ibot'] })).toEqual(['issuebot']);
  });

  it('去重 + 丢弃过短别名', () => {
    const configured = triggersConfigSchema.parse({ aliases: ['IssueBot'] });
    expect(resolveTriggerAliases({ configured, deployment: ['issuebot', 'i'] })).toEqual(['issuebot']);
  });
});

describe('maskCodeRegions / findAliasHits', () => {
  it('围栏代码块里的提及不算命中', () => {
    const body = ['看这个：', '```', '@ibot /review-pr', '```'].join('\n');
    expect(parseTriggerBody(body, ALIASES).kind).toBe('none');
  });

  it('行内代码里的提及不算命中', () => {
    expect(parseTriggerBody('用法是 `@ibot /review-pr` 这样', ALIASES).kind).toBe('none');
  });

  it('蒙版保留换行与长度', () => {
    const body = '```\nabc\n```';
    const masked = maskCodeRegions(body);
    expect(masked.length).toBe(body.length);
    expect(masked.split('\n').length).toBe(body.split('\n').length);
  });

  it('foo@ibot / @ibotx 不算命中', () => {
    expect(findAliasHits('foo@ibot', ALIASES)).toHaveLength(0);
    expect(findAliasHits('@ibotx 你好', ALIASES)).toHaveLength(0);
  });

  it('句末句号不影响命中', () => {
    expect(findAliasHits('谢谢 @ibot.', ALIASES)).toHaveLength(1);
  });

  it('中文紧跟别名也能命中（不是 \\w 边界）', () => {
    expect(findAliasHits('@ibot处理一下', ALIASES)).toHaveLength(1);
  });

  it('最长别名优先：@issuebot 不会只匹配成 ibot', () => {
    const hits = findAliasHits('@issuebot /issue-triage', ALIASES);
    expect(hits[0]?.alias).toBe('issuebot');
  });
});

describe('parseTriggerBody', () => {
  it('默认三个别名大小写都能触发（约束 6）', () => {
    for (const handle of ['@issuebot', '@IssueBot', '@IBOT', '@ibot']) {
      expect(parseTriggerBody(`${handle} /issue-triage`, ALIASES).kind).toBe('command');
    }
  });

  it('命令与参数分开（参数不再被丢弃）', () => {
    const parsed = parseTriggerBody('@ibot /review-pr 123 --deep', ALIASES);
    expect(parsed.kind).toBe('command');
    expect(parsed.command).toBe('/review-pr');
    expect(parsed.args).toBe('123 --deep');
  });

  it('别名后跟标点仍能解析出命令', () => {
    expect(parseTriggerBody('@ibot, /issue-triage', ALIASES).command).toBe('/issue-triage');
    expect(parseTriggerBody('@ibot：帮我看看这个报错', ALIASES).kind).toBe('question');
  });

  it('纯 @ 提问取正文', () => {
    const parsed = parseTriggerBody('@issuebot 这条报错怎么排查？', ALIASES);
    expect(parsed.kind).toBe('question');
    expect(parsed.question).toBe('这条报错怎么排查？');
  });

  it('只 @ 了不说话 → none（不该白跑一次 turn）', () => {
    expect(parseTriggerBody('@ibot', ALIASES).kind).toBe('none');
    expect(parseTriggerBody('@ibot   ', ALIASES).kind).toBe('none');
  });

  it('没有命中别名时 command/question 都是 null', () => {
    const parsed = parseTriggerBody('随便说点什么', ALIASES);
    expect(parsed.kind).toBe('none');
    expect(parsed.alias).toBeNull();
    expect(parsed.command).toBeNull();
    expect(parsed.question).toBeNull();
  });

  it('取最前面的命中点（一次评论只产一个任务）', () => {
    const parsed = parseTriggerBody('@ibot /issue-triage 后面又写了 @issuebot /review-pr', ALIASES);
    expect(parsed.command).toBe('/issue-triage');
  });

  it('@ 不在句首也能命中（引用块里提问）', () => {
    const parsed = parseTriggerBody('> 报错如上\n\n@ibot 这是为什么？', ALIASES);
    expect(parsed.kind).toBe('question');
  });

  it('正文过长会被截断到 4000', () => {
    const parsed = parseTriggerBody(`@ibot ${'啊'.repeat(5000)}`, ALIASES);
    expect(parsed.question?.length).toBe(4000);
  });
});

describe('isTriggerUserAllowed', () => {
  it('all 放行任何人', () => {
    expect(isTriggerUserAllowed('all', 'stranger')).toBe(true);
  });

  it('名单精确匹配，大小写不敏感', () => {
    expect(isTriggerUserAllowed(['Alice'], 'alice')).toBe(true);
    expect(isTriggerUserAllowed(['alice'], 'bob')).toBe(false);
  });
});

describe('triggersConfigSchema', () => {
  it('缺省值：总开关、与部署默认并集、触发人 all', () => {
    const parsed = triggersConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.merge_defaults).toBe(true);
    expect(parsed.users).toBe('all');
  });

  it('空触发人名单是配置非法（不是 all）', () => {
    expect(triggersConfigSchema.safeParse({ users: [] }).success).toBe(false);
  });

  it('未知键被拒（strict）', () => {
    expect(triggersConfigSchema.safeParse({ alias: ['x'] }).success).toBe(false);
  });

  it('别名允许写 @ 与大写；归一化发生在 resolve（schema 保持纯校验，才能出 JSON Schema）', () => {
    const parsed = triggersConfigSchema.parse({ aliases: ['@TriageBot'] });
    expect(parsed.aliases).toEqual(['@TriageBot']);
    expect(resolveTriggerAliases({ configured: parsed, deployment: ['issuebot'] })).toEqual([
      'triagebot',
      'issuebot',
    ]);
  });

  it('`faces` 已删除（P7）：写成已知键也不再接受，整份配置拒收', () => {
    expect(triggersConfigSchema.safeParse({ faces: { issue_opened: 'auto' } }).success).toBe(false);
    expect(triggersConfigSchema.safeParse({ faces: {} }).success).toBe(false);
  });
});
