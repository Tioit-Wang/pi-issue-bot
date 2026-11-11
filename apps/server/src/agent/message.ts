/**
 * 消息模板与组装（`docs/req-issue-agent.md` §1.2 / §1.4 / §1.5，模板文案见 D-3）。
 *
 * 一次组装做三件事，顺序固定：
 *  1. **摘别名**（`@bot 打个标签` → `打个标签`）：别名是句柄不是内容；
 *  2. **扫技能并改写**（`findSkillMentions`）：命中的 `/名字` 从正文里删掉，改成一句
 *     「先加载这些技能」——正文**不**进上下文，只有目录常驻（需求 §2.3 第 1 条）；
 *  3. **算 fingerprint**：人消息按归一化文本（永久幂等），事件消息按
 *     `templateId + issue.updated_at`（豁免永久幂等，L-07）。
 *
 * 事件消息（`opened` / `edited`）的正文里**内联**了 issue 标题、正文、`project_prompt`
 * 与技能目录提示：一个 issue 一个持久会话时，第一轮就得让模型看见「这个 issue 长什么样」，
 * 而 webhook 侧没有别的地方能塞这些内容（`tasks.target_body` 只给流水线用过）。
 */
import { findSkillMentions } from '../../../../packages/contract/src/index.ts';
import {
  AGENT_MAX_BODY_CHARS,
  AGENT_MAX_CATALOG_ENTRIES,
  AGENT_MAX_PROJECT_PROMPT_CHARS,
  AGENT_MAX_TITLE_CHARS,
  type AgentMessageKind,
  type AgentTemplateId,
} from './constants.ts';
import { stripAliases } from './canonical-text.ts';
import { eventFingerprint, mentionFingerprint } from './fingerprint.ts';

/* ── 模板（中文；三条：opened / edited / mention）─────────────────────────── */

/**
 * 三条消息模板。
 *
 * 占位符（`{名字}`）在一整行都只是它且解析为空时**整行消失** —— 于是「没有
 * `project_prompt` 的仓库」不会出现一个空标题，目录为空时也不会留下半截段落（X-03）。
 */
export const AGENT_MESSAGE_TEMPLATES = Object.freeze({
  opened: [
    '新 issue 已创建：先按项目规范检查格式是否合规；不合规就告诉作者要补什么，合规就静默（不要打标签）。',
    '',
    '仓库：{repo}',
    'issue：#{issue}',
    '标题：{title}',
    '',
    '正文：',
    '{body}',
    '',
    '项目规范（由维护者配置）：',
    '{project_prompt}',
    '',
    '{skills}',
    '',
    '{catalog}',
  ].join('\n'),
  edited: [
    'issue 的标题或正文被修改过：请重新看一遍，重点仍然是格式是否合规；不合规就说清缺哪几项。',
    '',
    '仓库：{repo}',
    'issue：#{issue}',
    '标题：{title}',
    '',
    '正文：',
    '{body}',
    '',
    '项目规范（由维护者配置）：',
    '{project_prompt}',
    '',
    '{skills}',
    '',
    '{catalog}',
  ].join('\n'),
  /** 人消息：原话 + 命中的技能指令（`{skills}` 为空时只剩原话，满足 §1.5 的对照）。 */
  mention: '{skills}{text}',
} as const);

/** 命中技能时的前置指令（需求 §1.5：「差别只有一句『先加载谁』」）。 */
export const AGENT_SKILL_DIRECTIVE =
  '先加载技能 {skills}（用 Skill 工具按 id 取正文），按它的要求执行；下面是我的原话。\n\n';

/** 技能目录段（只有目录，正文按需加载）。 */
export const AGENT_SKILL_CATALOG_HEADER =
  '可用技能（这里只有目录，正文不在上下文里；需要时用 Skill 工具按 id 加载）：';

/** 正文为空时的占位（需求 X-10：不抛错，给明确占位）。 */
export const AGENT_EMPTY_BODY = '（正文为空）';

/** 只 @ 了一下、没有正文时的占位（需求 C9：正常回复即可）。 */
export const AGENT_EMPTY_MENTION = '（只 @ 了机器人，没有写正文）';

/** 截断标注（需求 X-11：截断必须显式说明）。 */
export function truncatedMarker(originalChars: number, keptChars: number): string {
  return `…（正文已截断：原文 ${String(originalChars)} 字符，只带前 ${String(keptChars)} 字符）`;
}

/* ── 类型 ────────────────────────────────────────────────────────────────── */

/** 目录条目（S2 的 `skills/catalog.ts` 产出；S1 只用 id，名字与描述可选）。 */
export type AgentSkillCatalogEntry = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
};

/** 这一条消息对应的 issue 快照。 */
export type AgentIssueSnapshot = {
  readonly repo: string;
  readonly number: number;
  readonly title: string | null;
  readonly body: string | null;
  /** `issue.updated_at`（事件消息 fingerprint 的一部分；人消息不用它） */
  readonly updatedAt: string;
};

/** 组装只需要 `settings.agent` 的这几项（避免把整份 `RepoSettings` 拉进纯函数）。 */
export type AgentMessageSettings =
  | {
      /** 管理员名单（权限判定用；`agent/message.ts` 自己不用，但 webhook 只解析一次 settings） */
      readonly managers?: readonly string[] | undefined;
      readonly on_opened?: string | null | undefined;
      readonly on_edited?: string | null | undefined;
      readonly project_prompt?: string | undefined;
    }
  | null
  | undefined;

export type ComposeAgentMessageInput = {
  readonly kind: AgentMessageKind;
  /** `kind='event'` 必填：`opened` / `edited`。 */
  readonly templateId?: AgentTemplateId | undefined;
  /** 人消息是原话（含 `@别名` 与 `/技能名`）；事件消息可给空串。 */
  readonly rawText: string;
  readonly aliases: readonly string[];
  readonly catalog: readonly AgentSkillCatalogEntry[];
  readonly issue: AgentIssueSnapshot;
  readonly settings: AgentMessageSettings;
};

export type ComposedAgentMessage = {
  readonly kind: AgentMessageKind;
  readonly templateId: AgentTemplateId | null;
  /** 进 `agent_messages.comment_body`（也就是 agent 真正看到的那条用户消息） */
  readonly text: string;
  /** 这一条点名了哪些技能（事件消息来自 settings，人消息来自命中） */
  readonly skillIds: readonly string[];
  readonly fingerprint: string;
};

/* ── 组装 ────────────────────────────────────────────────────────────────── */

/** `settings.agent.on_opened` / `on_edited` → 事件消息点名的技能（空/`null` = 不投递）。 */
export function eventSkillsOf(settings: AgentMessageSettings, templateId: AgentTemplateId): readonly string[] {
  const configured = templateId === 'opened' ? settings?.on_opened : settings?.on_edited;
  if (configured === null || configured === undefined) {
    return [];
  }
  const id = configured.trim();
  return id === '' ? [] : [id];
}

/** 事件模板配了哪条技能（`null` = 该事件不投递，需求 §1.4 / CF-02 / CF-03）。 */
export function eventTemplateSkillOf(
  settings: AgentMessageSettings,
  templateId: AgentTemplateId,
): string | null {
  const skills = eventSkillsOf(settings, templateId);
  return skills[0] ?? null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n${truncatedMarker(text.length, max)}`;
}

function renderBody(body: string | null): string {
  const trimmed = (body ?? '').trim();
  return trimmed === '' ? AGENT_EMPTY_BODY : clip(trimmed, AGENT_MAX_BODY_CHARS);
}

function renderTitle(title: string | null): string {
  const trimmed = (title ?? '').trim();
  return trimmed === '' ? '（无标题）' : clip(trimmed, AGENT_MAX_TITLE_CHARS);
}

/** 目录段：`- \`id\` — 名字: 描述`（S-10 的格式）；空目录整段消失。 */
export function renderCatalog(catalog: readonly AgentSkillCatalogEntry[]): string {
  const entries = catalog.slice(0, AGENT_MAX_CATALOG_ENTRIES);
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map((entry) => {
    const name = entry.name === undefined || entry.name.trim() === '' ? '' : ` — ${entry.name.trim()}`;
    const description =
      entry.description === undefined || entry.description.trim() === ''
        ? ''
        : `: ${entry.description.trim().slice(0, 200)}`;
    return `- \`${entry.id}\`${name}${description}`;
  });
  return [AGENT_SKILL_CATALOG_HEADER, ...lines].join('\n');
}

function renderSkillDirective(skillIds: readonly string[]): string {
  if (skillIds.length === 0) {
    return '';
  }
  return AGENT_SKILL_DIRECTIVE.replace('{skills}', skillIds.map((id) => `\`${id}\``).join('、'));
}

/** 整行只有一个占位符：`{skills}` / `{catalog}` / `{project_prompt}` … */
const SINGLE_PLACEHOLDER = /^\{([A-Za-z_]+)\}$/u;

/**
 * 占位符替换：
 *  - 一整行只有一个占位符且解析为空 → **整行消失**；
 *  - 该行是「标签行」（以全角/半角冒号结尾）且**下一行**是空占位符 → 标签行也消失
 *    （否则会留下一个「项目规范（由维护者配置）：」然后什么都没有，X-03）；
 *  - 结尾多余空行收掉、连续 3 个以上换行压成 2 个。
 */
function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  const raw = template.split('\n');
  const lines: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index] ?? '';
    const single = SINGLE_PLACEHOLDER.exec(line.trim());
    if (single !== null) {
      const value = vars[single[1] ?? ''] ?? '';
      if (value === '') {
        continue;
      }
      lines.push(value);
      continue;
    }
    // 标签行 + 下一行是空占位符 → 一起丢
    const nextRaw = raw[index + 1];
    const nextPlaceholder = nextRaw === undefined ? null : SINGLE_PLACEHOLDER.exec(nextRaw.trim());
    if (
      /[：:]$/u.test(line.trim()) &&
      nextPlaceholder !== null &&
      (vars[nextPlaceholder[1] ?? ''] ?? '') === ''
    ) {
      index += 1;
      continue;
    }
    lines.push(line.replace(/\{([A-Za-z_]+)\}/gu, (_match, key: string) => vars[key] ?? ''));
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

/**
 * 组装一条 agent 消息。
 *
 * `kind='mention'` → 原话（摘别名 + 摘技能 token）+ 技能指令；fingerprint 用归一化后的
 * 原话（永久幂等）。
 * `kind='event'` → 模板渲染；fingerprint 含 `templateId` + `issue.updated_at`。
 */
export function composeAgentMessage(input: ComposeAgentMessageInput): ComposedAgentMessage {
  const { issue } = input;
  const catalog = renderCatalog(input.catalog);

  if (input.kind === 'event') {
    const templateId: AgentTemplateId = input.templateId ?? 'opened';
    const skillIds = eventSkillsOf(input.settings, templateId);
    const text = renderTemplate(AGENT_MESSAGE_TEMPLATES[templateId], {
      repo: issue.repo,
      issue: String(issue.number),
      title: renderTitle(issue.title),
      body: renderBody(issue.body),
      project_prompt: clip((input.settings?.project_prompt ?? '').trim(), AGENT_MAX_PROJECT_PROMPT_CHARS),
      skills: renderSkillDirective(skillIds),
      catalog,
    });
    return {
      kind: 'event',
      templateId,
      text,
      skillIds,
      fingerprint: eventFingerprint({
        repo: issue.repo,
        issueNumber: issue.number,
        templateId,
        issueUpdatedAt: issue.updatedAt,
      }),
    };
  }

  const withoutAlias = stripAliases(input.rawText, input.aliases);
  const scan = findSkillMentions(withoutAlias, input.catalog.map((entry) => entry.id));
  const body = scan.text.trim() === '' ? AGENT_EMPTY_MENTION : scan.text.trim();
  const text = renderTemplate(AGENT_MESSAGE_TEMPLATES.mention, {
    skills: renderSkillDirective(scan.skillIds),
    text: body,
  });
  return {
    kind: 'mention',
    templateId: null,
    text,
    skillIds: scan.skillIds,
    fingerprint: mentionFingerprint({
      repo: issue.repo,
      issueNumber: issue.number,
      // 幂等看的是「人说了什么」：别名与技能 token 都算噪声，但行内空白不动（归一化会压）
      text: withoutAlias,
    }),
  };
}
