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

  it('仓库配了 aliases 就只用它（v0.3 只有一个来源）', () => {
    const configured = triggersConfigSchema.parse({ aliases: ['TriageBot'] });
    expect(resolveTriggerAliases({ configured, deployment: ['issuebot', 'ibot'] })).toEqual(['triagebot']);
  });

  it('去重 + 丢弃过短别名', () => {
    const configured = triggersConfigSchema.parse({ aliases: ['IssueBot'] });
    expect(resolveTriggerAliases({ configured, deployment: ['issuebot', 'i'] })).toEqual(['issuebot']);
  });

  it('configured 不给 aliases 时回落到部署默认', () => {
    const configured = triggersConfigSchema.parse({});
    expect(resolveTriggerAliases({ configured, deployment: ['issuebot'] })).toEqual(['issuebot']);
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

describe('parseTriggerBody（v0.3：只判「有没有 @ 我」+ 原文，无命令语义）', () => {
  it('默认三个别名大小写都能触发', () => {
    for (const handle of ['@issuebot', '@IssueBot', '@IBOT', '@ibot']) {
      expect(parseTriggerBody(`${handle} 帮我看看`, ALIASES).kind).toBe('mention');
    }
  });

  it('`/技能名` 原样留在原文里（改写在 skill-mentions，不在触发解析）', () => {
    const parsed = parseTriggerBody('@ibot /review-pr 123 --deep', ALIASES);
    expect(parsed.kind).toBe('mention');
    expect(parsed.text).toBe('/review-pr 123 --deep');
  });

  it('别名后跟标点也能取到正文', () => {
    expect(parseTriggerBody('@ibot, /issue-triage', ALIASES).text).toBe('/issue-triage');
    expect(parseTriggerBody('@ibot：帮我看看这个报错', ALIASES).text).toBe('帮我看看这个报错');
  });

  it('纯 @ 提问取正文', () => {
    const parsed = parseTriggerBody('@issuebot 这条报错怎么排查？', ALIASES);
    expect(parsed.kind).toBe('mention');
    expect(parsed.text).toBe('这条报错怎么排查？');
    expect(parsed.alias).toBe('issuebot');
  });

  it('只 @ 了不说话 → none（不该白跑一次 turn）', () => {
    expect(parseTriggerBody('@ibot', ALIASES).kind).toBe('none');
    expect(parseTriggerBody('@ibot   ', ALIASES).kind).toBe('none');
    expect(parseTriggerBody('@ibot', ALIASES).alias).toBe('ibot');
  });

  it('没有命中别名时 alias / text 都是 null', () => {
    const parsed = parseTriggerBody('随便说点什么', ALIASES);
    expect(parsed.kind).toBe('none');
    expect(parsed.alias).toBeNull();
    expect(parsed.text).toBeNull();
  });

  it('取最前面的命中点（一次评论只产一条消息）', () => {
    const parsed = parseTriggerBody('@ibot /issue-triage 后面又写了 @issuebot /review-pr', ALIASES);
    expect(parsed.text).toBe('/issue-triage 后面又写了 @issuebot /review-pr');
    expect(parsed.alias).toBe('ibot');
  });

  it('@ 不在句首也能命中（引用块里提问）', () => {
    const parsed = parseTriggerBody('> 报错如上\n\n@ibot 这是为什么？', ALIASES);
    expect(parsed.kind).toBe('mention');
  });

  it('正文过长会被截断到 4000', () => {
    const parsed = parseTriggerBody(`@ibot ${'啊'.repeat(5000)}`, ALIASES);
    expect(parsed.text?.length).toBe(4000);
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

describe('triggersConfigSchema（v0.3 只剩 aliases）', () => {
  it('缺省 = 没有 aliases（webhook 用部署默认）', () => {
    const parsed = triggersConfigSchema.parse({});
    expect(parsed.aliases).toBeUndefined();
  });

  it('未知键被拒（strict）：enabled / users / merge_defaults / remove 都已删', () => {
    expect(triggersConfigSchema.safeParse({ alias: ['x'] }).success).toBe(false);
    expect(triggersConfigSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(triggersConfigSchema.safeParse({ users: [] }).success).toBe(false);
    expect(triggersConfigSchema.safeParse({ merge_defaults: false }).success).toBe(false);
    expect(triggersConfigSchema.safeParse({ remove: ['ibot'] }).success).toBe(false);
  });

  it('别名允许写 @ 与大写；归一化发生在 resolve（schema 保持纯校验，才能出 JSON Schema）', () => {
    const parsed = triggersConfigSchema.parse({ aliases: ['@TriageBot'] });
    expect(parsed.aliases).toEqual(['@TriageBot']);
    expect(resolveTriggerAliases({ configured: parsed, deployment: ['issuebot'] })).toEqual(['triagebot']);
  });

  it('`faces` 已删除：写成已知键也不再接受，整份配置拒收', () => {
    expect(triggersConfigSchema.safeParse({ faces: { issue_opened: 'auto' } }).success).toBe(false);
    expect(triggersConfigSchema.safeParse({ faces: {} }).success).toBe(false);
  });
});
