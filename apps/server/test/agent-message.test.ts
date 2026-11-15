/**
 * agent 运行时（S1）的纯函数层：归一化 / fingerprint / 消息组装。
 *
 * 对应 `docs/test-plan-issue-agent.md` 的 L-02（归一化）、L-04 的组装侧、H-01..H-09 的改写侧，
 * 以及 X-10（空正文占位）/ X-11（截断标注）/ X-03（目录为空整段消失）。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_EMPTY_BODY,
  AGENT_EMPTY_MENTION,
  AGENT_MESSAGE_TEMPLATES,
  AGENT_SKILL_CATALOG_HEADER,
  composeAgentMessage,
  eventFingerprint,
  mentionFingerprint,
  normalizeForIdempotency,
  renderCatalog,
  stripAliases,
} from '../src/agent/index.ts';

const ALIASES = ['pi-bot', 'issuebot'];
const CATALOG = [
  { id: 'format-check', name: '格式检查', description: '检查 issue 格式' },
  { id: 'label-triage', name: '打标签' },
];
const ISSUE = {
  repo: 'acme/widgets',
  number: 7,
  title: '登录按钮没反应',
  body: '复现步骤：点一下',
  updatedAt: '2026-06-01T00:00:00Z',
};
const SETTINGS = { on_opened: 'format-check', on_edited: 'format-check', project_prompt: '必须有复现步骤' };

describe('normalizeForIdempotency（L-02）', () => {
  it('只做两件事：去首尾空白 + 合并连续空行', () => {
    expect(normalizeForIdempotency('  打个标签 \n\n')).toBe('打个标签');
    expect(normalizeForIdempotency('第一行\n\n\n\n第二行')).toBe('第一行\n\n第二行');
    expect(normalizeForIdempotency('第一行\n\n第二行')).toBe('第一行\n\n第二行');
    expect(normalizeForIdempotency('')).toBe('');
  });

  it('不压行内空白、不把多行压成一行（需求只合并空行）', () => {
    expect(normalizeForIdempotency('打个  标签')).toBe('打个  标签');
    expect(normalizeForIdempotency('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('不摘 @ 提及、不去标点、不抹代码区（措辞不同就是不同内容）', () => {
    expect(normalizeForIdempotency('@bot 打个标签！')).toBe('@bot 打个标签！');
    expect(normalizeForIdempotency('看这里\n```\nconst a = 1;\n```\n然后再说')).toBe(
      '看这里\n```\nconst a = 1;\n```\n然后再说',
    );
  });

  it('不转小写：大小写不同就是不同消息（OQ-10 未采纳）', () => {
    expect(normalizeForIdempotency('Fix It')).not.toBe(normalizeForIdempotency('fix it'));
  });

  it('只改标点 / 只挪代码块 → 不同内容（否则新问题会被静默吞掉）', () => {
    expect(normalizeForIdempotency('打个标签')).not.toBe(normalizeForIdempotency('打个标签！'));
    expect(normalizeForIdempotency('看这里\n```\nconst a = 1;\n```')).not.toBe(
      normalizeForIdempotency('看这里\n```\nconst a = 2;\n```'),
    );
  });
});

describe('stripAliases', () => {
  it('摘掉 @别名（大小写不敏感），保留其余正文', () => {
    expect(stripAliases('@pi-bot 打个标签', ALIASES)).toBe('打个标签');
    expect(stripAliases('@Pi-Bot 打个标签', ALIASES)).toBe('打个标签');
  });

  it('最长别名优先、`@ibotx` 不误伤', () => {
    expect(stripAliases('@issuebot 看一下', ALIASES)).toBe('看一下');
    expect(stripAliases('@pi-botx 看一下', ALIASES)).toBe('@pi-botx 看一下');
  });

  it('保留换行（多行指令的行结构要保住）', () => {
    expect(stripAliases('@pi-bot 第一行\n第二行', ALIASES)).toBe('第一行\n第二行');
  });
});

describe('fingerprint', () => {
  it('L-02：只差首尾空白 / 空行 → fingerprint 相同', () => {
    const a = mentionFingerprint({ repo: 'r/x', issueNumber: 1, text: '打个标签' });
    const b = mentionFingerprint({ repo: 'r/x', issueNumber: 1, text: '  打个标签\n\n\n' });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('L-02：只改标点 → 不同 fingerprint（不做语义近似判断）', () => {
    const base = mentionFingerprint({ repo: 'r/x', issueNumber: 1, text: '打个标签' });
    expect(mentionFingerprint({ repo: 'r/x', issueNumber: 1, text: '打个标签！' })).not.toBe(base);
  });

  it('不同 issue / 不同 repo / 不同文本 → 不同 fingerprint', () => {
    const base = mentionFingerprint({ repo: 'r/x', issueNumber: 1, text: '打个标签' });
    expect(mentionFingerprint({ repo: 'r/x', issueNumber: 2, text: '打个标签' })).not.toBe(base);
    expect(mentionFingerprint({ repo: 'r/y', issueNumber: 1, text: '打个标签' })).not.toBe(base);
    expect(mentionFingerprint({ repo: 'r/x', issueNumber: 1, text: '打个别的' })).not.toBe(base);
  });

  it('L-07：事件 fingerprint 含 templateId 与 updated_at（同文本两次编辑 ≠ 同一条）', () => {
    const first = eventFingerprint({
      repo: 'r/x',
      issueNumber: 1,
      templateId: 'edited',
      issueUpdatedAt: '2026-06-01T00:00:00Z',
    });
    const second = eventFingerprint({
      repo: 'r/x',
      issueNumber: 1,
      templateId: 'edited',
      issueUpdatedAt: '2026-06-01T10:00:00Z',
    });
    const opened = eventFingerprint({
      repo: 'r/x',
      issueNumber: 1,
      templateId: 'opened',
      issueUpdatedAt: '2026-06-01T00:00:00Z',
    });
    expect(first).not.toBe(second);
    expect(first).not.toBe(opened);
  });
});

describe('composeAgentMessage：人消息（mention）', () => {
  it('摘别名 + 保留原话；没有技能命中时不加指令', () => {
    const composed = composeAgentMessage({
      kind: 'mention',
      rawText: '@pi-bot 给这个 issue 重新打标签',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(composed.text).toBe('给这个 issue 重新打标签');
    expect(composed.skillIds).toEqual([]);
    expect(composed.templateId).toBeNull();
  });

  it('L-04：命中 `/format-check` → token 被删、前面加「按技能执行」指令', () => {
    const composed = composeAgentMessage({
      kind: 'mention',
      rawText: '@pi-bot 看看格式 /format-check',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(composed.skillIds).toEqual(['format-check']);
    expect(composed.text).not.toContain('/format-check');
    expect(composed.text).toContain('按技能');
    expect(composed.text).toContain('看看格式');
  });

  it('未知技能当自然语言：token 保留、不报错（C8 / X-02）', () => {
    const composed = composeAgentMessage({
      kind: 'mention',
      rawText: '@pi-bot /unknown-skill 看一下',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(composed.skillIds).toEqual([]);
    expect(composed.text).toBe('/unknown-skill 看一下');
  });

  it('只 @ 不说话 → 明确占位（C9）', () => {
    const composed = composeAgentMessage({
      kind: 'mention',
      rawText: '@pi-bot',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(composed.text).toBe(AGENT_EMPTY_MENTION);
  });

  it('同一句话（不同别名 / 首尾空白 / 空行差异）→ 同一 fingerprint（永久幂等）', () => {
    const a = composeAgentMessage({
      kind: 'mention',
      rawText: '@pi-bot 打个标签',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    const b = composeAgentMessage({
      kind: 'mention',
      rawText: '@issuebot  打个标签\n\n\n',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('只改标点 → 不同 fingerprint（别名是噪声，措辞不是）', () => {
    const a = composeAgentMessage({
      kind: 'mention',
      rawText: '@pi-bot 打个标签',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    const b = composeAgentMessage({
      kind: 'mention',
      rawText: '@issuebot 打个标签！',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('composeAgentMessage：事件消息（event）', () => {
  it('E-01：opened 模板带 issue 标题、正文、project_prompt 与技能目录（不点名技能）', () => {
    const composed = composeAgentMessage({
      kind: 'event',
      templateId: 'opened',
      rawText: '',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(composed.text).toContain('登录按钮没反应');
    expect(composed.text).toContain('复现步骤：点一下');
    expect(composed.text).toContain('必须有复现步骤');
    expect(composed.text).toContain(AGENT_SKILL_CATALOG_HEADER);
    // 目录里只有 id，正文不进上下文（需求 §2.3 第 1 条）
    expect(composed.text).toContain('- `format-check` — 格式检查: 检查 issue 格式');
    expect(composed.text).not.toContain('检查 issue 格式\n\n格式检查正文');
    /*
      Q-6 / FR-5.1：事件消息**不点名技能**，也不渲染技能指令段。
      `SETTINGS` 里仍带着 `on_opened: 'format-check'`（存量配置的真实形状），
      但平台不读它 —— 读它就等于「平台按事件类型替执行侧挑规则」。
    */
    expect(composed.skillIds).toEqual([]);
    expect(composed.text).not.toContain('按技能');
  });

  it('X-10：正文为空 → 明确占位而不是空段落', () => {
    const composed = composeAgentMessage({
      kind: 'event',
      templateId: 'edited',
      rawText: '',
      aliases: ALIASES,
      catalog: [],
      issue: { ...ISSUE, body: '', title: '' },
      settings: SETTINGS,
    });
    expect(composed.text).toContain(AGENT_EMPTY_BODY);
    expect(composed.text).toContain('（无标题）');
  });

  it('X-11：正文超限 → 截断且显式标注「已截断」', () => {
    const composed = composeAgentMessage({
      kind: 'event',
      templateId: 'opened',
      rawText: '',
      aliases: ALIASES,
      catalog: [],
      issue: { ...ISSUE, body: 'x'.repeat(5_000) },
      settings: SETTINGS,
    });
    expect(composed.text).toContain('已截断');
  });

  it('X-03：目录为空 → 整段目录不出现（不是空标题）', () => {
    const composed = composeAgentMessage({
      kind: 'event',
      templateId: 'opened',
      rawText: '',
      aliases: ALIASES,
      catalog: [],
      issue: ISSUE,
      settings: { ...SETTINGS, project_prompt: '' },
    });
    expect(composed.text).not.toContain(AGENT_SKILL_CATALOG_HEADER);
    expect(composed.text).not.toContain('项目规范（由维护者配置）：');
    expect(composed.text).not.toContain('\n\n\n');
  });

  it('opened 与 edited 用两条不同模板（首句不同）', () => {
    const opened = composeAgentMessage({
      kind: 'event',
      templateId: 'opened',
      rawText: '',
      aliases: ALIASES,
      catalog: [],
      issue: ISSUE,
      settings: SETTINGS,
    });
    const edited = composeAgentMessage({
      kind: 'event',
      templateId: 'edited',
      rawText: '',
      aliases: ALIASES,
      catalog: [],
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(opened.text).not.toBe(edited.text);
    expect(opened.fingerprint).not.toBe(edited.fingerprint);
    expect(Object.keys(AGENT_MESSAGE_TEMPLATES).sort()).toEqual(['edited', 'mention', 'opened']);
  });
});

describe('事件消息不点名技能（Q-6 / FR-5.1：平台不维护事件→技能映射）', () => {
  /*
    曾经这里断言的是 `eventTemplateSkillOf({on_opened:'format-check'})` —— 一张
    「事件 → 技能」的映射表，也正是 Q-6 要拆掉的那层。现在断言反过来：
    **配什么都不影响事件消息的 skillIds**，平台不替执行侧决定加载哪套规则。
  */
  it('事件消息的 skillIds 恒为空，与 settings 里的历史字段无关', () => {
    // `on_opened` / `on_edited` 虽然还在契约里，但组装侧根本不读它们。
    const withLegacyFields = { on_opened: 'format-check', on_edited: 'label-triage', project_prompt: '' };
    for (const templateId of ['opened', 'edited'] as const) {
      const composed = composeAgentMessage({
        kind: 'event',
        templateId,
        rawText: '',
        aliases: ALIASES,
        catalog: CATALOG,
        issue: ISSUE,
        settings: withLegacyFields,
      });
      expect(composed.skillIds, templateId).toEqual([]);
    }
  });

  it('事件消息正文里没有技能指令段（模板不再有 {skills}）', () => {
    const composed = composeAgentMessage({
      kind: 'event',
      templateId: 'opened',
      rawText: '',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(AGENT_MESSAGE_TEMPLATES.opened).not.toContain('{skills}');
    expect(AGENT_MESSAGE_TEMPLATES.edited).not.toContain('{skills}');
    expect(composed.text).not.toContain('按技能');
    // 目录仍然在：那是「本项目有哪些技能」的事实，不是平台预设的选择
    expect(composed.text).toContain(AGENT_SKILL_CATALOG_HEADER);
  });

  it('人消息的技能点名不受影响（那是用户写的，不是平台预设）', () => {
    const composed = composeAgentMessage({
      kind: 'mention',
      rawText: '@bot /label-triage 归类一下',
      aliases: ALIASES,
      catalog: CATALOG,
      issue: ISSUE,
      settings: SETTINGS,
    });
    expect(composed.skillIds).toEqual(['label-triage']);
    expect(composed.text).toContain('按技能');
  });
});

describe('renderCatalog', () => {
  it('格式：`- \\`id\\` — 名字: 描述`；缺名字/描述时省略对应片段', () => {
    expect(renderCatalog([{ id: 'a' }, { id: 'b', name: 'B' }])).toBe(
      [AGENT_SKILL_CATALOG_HEADER, '- `a`', '- `b` — B'].join('\n'),
    );
  });

  it('空目录 → 空串', () => {
    expect(renderCatalog([])).toBe('');
  });
});
