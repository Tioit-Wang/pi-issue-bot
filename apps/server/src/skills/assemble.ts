/**
 * 提示词装配（spec §7「装配顺序」，R8 的统一入口）。
 *
 * ```
 * 1. 系统约束 + 任务上下文（`basePrompt`，上游已拼好）
 * 2. 项目人格层（P1，`prompt_versions` 里的正文 → `## 项目约定`）—— 没有 P1 时这一层不存在
 * 3. AGENTS.md 层：根 → 就近（各段已由 `agents-md.ts` 围栏）
 * 4. 技能层：`## 任务技能 /xxx` + `renderSkillPrompt()` 的产出
 * 5. 输出契约（`basePrompt` 的尾部，必须仍是**最后**一段）
 * ```
 *
 * ## 插入点（为什么不把层追加到末尾）
 *
 * `basePrompt`（`buildTaskPrompt` / `buildAnswerPrompt`）的结构是「身份/命令/约束头部 + 输出契约」，
 * 输出契约在最后一条是**有意的语义**（模型读到的最后一段文字，且不在任何不可信块里）。
 * 若把 AGENTS.md 与技能层追加到末尾，输出契约就不再是最后一段 —— 那是静默改变既有语义。
 * 若在 `basePrompt` 里切出「输出契约段」再插到它前面，就得解析上游的段落边界（脆，且上游是
 * 另一个文件的知识）。所以这里选**第三种**：把层插到 `basePrompt` 的**头部之后**
 * （第一个空行之前都是头部；没有空行就取第一行之后），于是：
 *   - `basePrompt` 自己的字节顺序不变（从未被重排，只是中间插入了若干块）；
 *   - 输出契约仍是**最后**一段；
 *   - 两处 `basePrompt` 片段之间只有「项目约定」「仓库约定」「任务技能」三块，不含任何来自
 *     不可信输入的指令级内容（AGENTS.md 与技能正文都已围栏）。
 *
 * P1 的位置由 `docs/plan-multi-repo.md` §7 钉死：**插在 head 之后、AGENTS.md 之前**
 * （切分逻辑零改动，输出契约保住「最后一段」）。
 *
 * ## 预算与截断
 *
 * 总预算默认 12000 字符（`budgetChars` 可覆盖，统计的是**整条 prompt**）。超预算时**只丢两层**：
 * 先丢 P1（项目约定=上下文），再丢技能正文。
 *
 * **系统提示词（head）与 AGENTS.md 不可被裁**，这是硬约束：
 *  - `head` / `tail` 从来不在丢弃清单里（V18）：系统提示词与输出契约丢了，任务语义就变了；
 *  - AGENTS.md 是**仓库所有者写给人看的约定**（构建方式、禁改路径、提交规范）。丢掉它不会
 *    让任务"变小"，只会让 agent 去违反它 —— 那比上下文不够严重得多。所以预算不够时，
 *    宁可让技能正文与项目提示词先消失，也不动 AGENTS.md。
 * 丢弃的单位是**整段**（围栏块 + 分节标题），绝不切字符 —— 半个 `<<<PI-BOT:UNTRUSTED:…>>>`
 * 或半个 ``` 围栏比没有更危险。每次丢弃都留一条可见标记并记进 `stats.truncated`，
 * 所以「预算不够」永远不会静默。
 *
 * 为什么 P1 在技能之前丢：P1 是项目背景/领域知识/语气，丢了任务仍然正确；
 * 技能正文是命令语义，丢了命令行为就错了。
 *
 * 纯函数：无 I/O、无副作用、不读时钟。
 */
import type { AgentsMdResult, AgentsMdSection } from './agents-md.ts';

/** 总预算（spec §7 没给数字；12000 是「根 4000 + 就近 6000 + 技能 2000」的余量口径）。 */
export const DEFAULT_ASSEMBLE_BUDGET_CHARS = 12_000;

/** 技能层的最小形状：`renderSkillPrompt()` 的 `prompt` 直接传进来即可。 */
export interface AssembleSkillLayer {
  /** 归一化命令名（`/review-pr`）。 */
  readonly name: string;
  /** `renderSkillPrompt()` 的产出（已含围栏与替换后的占位符）。 */
  readonly promptText: string;
}

/**
 * 装配的三个阶段（`docs/plan-fixed-pipeline.md` §16.3 的作用域矩阵）。
 *
 * 名称与 `prompt_versions.kind` 不完全一样（`format_check` → `format`）：
 * kind 是**版本线**的名字，stage 是**装配位置**的名字，两者由 `ASSEMBLE_STAGE_OF_KIND` 映射。
 */
export type AssembleStage = 'format' | 'classify' | 'agent';

export interface AssemblePromptInput {
  /** 上游拼好的提示词（系统约束 + 任务上下文 + 输出契约）。 */
  readonly basePrompt: string;
  /**
   * P1 项目人格层的**正文**（`prompt_versions.body`）。
   *
   * 缺省 / `null` / 全空白 = 没有 P1 层，装配结果与「P1 这个特性不存在时」**逐字节相同**。
   * 传正文而不是渲染后的层：标题由 `ASSEMBLE_HEADINGS.project` 统一给，
   * 面板的保存期预算预演（`prompt/budget.ts`）与运行期必须用同一个渲染函数，否则两边长度对不上。
   */
  readonly projectPrompt?: string | null;
  /** `collectAgentsMd()` 的结果；缺省/null 表示没有 AGENTS.md 层。 */
  readonly agentsMd?: AgentsMdResult | null;
  /** 命中命令的技能；缺省/null 表示没有技能层（`stage='format'|'classify'` 时按矩阵忽略）。 */
  readonly skill?: AssembleSkillLayer | null;
  /** 覆盖总预算（单测用）。 */
  readonly budgetChars?: number;
  /**
   * 阶段维度（`docs/plan-fixed-pipeline.md` §16.3 作用域矩阵）。
   *
   * 缺省 = **现有行为，逐字节一致**（`basePrompt` 走 `splitBasePrompt()`，P1/技能层照常参与）。
   * 给了值就换一套作用域：
   *  - `format` / `classify`：`head` = `stagePrompt`，`tail` = `outputContract ?? basePrompt`（**整段**
   *    都是代码追加的输出契约），层里只有 AGENTS.md —— 没有 P1、没有技能层（Q9 要求 AGENTS.md 全阶段生效）。
   *  - `agent`：`head` = `stagePrompt`（项目版或内置默认）→ P1 → AGENTS.md → 技能层 → 输出契约。
   */
  readonly stage?: AssembleStage | null;
  /**
   * 阶段系统提示词（**已渲染**：项目版本整体覆盖内置默认，见 `skills/stage-prompts.ts` 与 `renderStagePrompt()`）。
   *
   * 只在给了 `stage` 时有效；空串 = 没有这一段（`agent` 阶段退回 `splitBasePrompt()` 的头部）。
   */
  readonly stagePrompt?: string | null;
  /**
   * 输出契约（信封形状 + 字段白名单）。**由代码给出、不可配、永远是最后一段**（§4.4 / V16）。
   *
   * 缺省时：`format`/`classify` 用整个 `basePrompt`，`agent` 用 `basePrompt` 的尾部。
   */
  readonly outputContract?: string | null;
}
/** 层序预览的一层（面板「最终 prompt 预览」与测试断言共用同一份口径）。 */
export interface AssembleStageLayer {
  /** `head` / `project` / `agents:root` / `agents:nearby:<path>` / `skill:<name>` / `tail`。 */
  readonly name: string;
  /** 这一层现在的字符数（已被丢弃时为 0，丢弃标记不算进层字符数）。 */
  readonly chars: number;
  /**
   * 能否因超预算被整段丢弃。`head` / `tail`（系统提示词与输出契约）与 AGENTS.md 层
   * 永远 `false`（§4.4 / V18 + 「AGENTS.md 不可裁」）；只有 P1 与技能正文会是 `true`。
   */
  readonly droppable: boolean;
  /** 这一层是否已被预算整段丢弃。 */
  readonly dropped: boolean;
}

export interface AssemblePromptStats {
  readonly baseChars: number;
  /** P1 层（含分节标题与丢弃标记）的字符数；没有 P1 时为 0。 */
  readonly promptChars: number;
  /** AGENTS.md 层（含分节标题与丢弃标记）的字符数。 */
  readonly agentsChars: number;
  /** 技能层（含分节标题与丢弃标记）的字符数。 */
  readonly skillChars: number;
  readonly totalChars: number;
  /**
   * 因预算被整段丢弃的层名。只剩两种：`project` / `skill:<name>` ——
   * AGENTS.md（`root` / `nearby:<path>`）**永不出现**：它不可裁。
   */
  readonly truncated: readonly string[];
}

export interface AssemblePromptResult {
  readonly prompt: string;
  readonly stats: AssemblePromptStats;
}

/* ── 内部形状 ─────────────────────────────────────────────────────────────── */

type AgentsEntry =
  | { readonly kind: 'root'; readonly section: AgentsMdSection }
  | { readonly kind: 'nearby'; readonly section: AgentsMdSection }
  | { readonly kind: 'dropped'; readonly title: string; readonly chars: number };

type SkillSlot =
  | { readonly kind: 'skill'; readonly layer: AssembleSkillLayer }
  | { readonly kind: 'dropped'; readonly name: string; readonly chars: number }
  | null;

type ProjectSlot =
  | { readonly kind: 'body'; readonly body: string }
  | { readonly kind: 'dropped'; readonly chars: number }
  | null;

/**
 * 分节标题（测试按它断言层序，**改这里的字符串等于改契约**）。
 *
 * 三个理由，改之前先看一眼：
 *  1. `apps/server/test/skills-assemble.test.ts` 直接按这些字符串断言层序与插入点；
 *  2. 面板的「最终 system prompt 预览」把整段文本原样回显给人看，改标题 = 改人看到的东西；
 *  3. `project` 这个标题还进了 P1 的预算口径（`prompt/budget.ts` 用 `renderProjectLayer()` 量长度），
 *     改长改短都会改变「这条 P1 还能占多少字符」。
 */
export const ASSEMBLE_HEADINGS = {
  /** P1 项目人格层（`docs/plan-multi-repo.md` §7 的「项目约定」）。 */
  project: '项目约定',
  agents: '仓库约定（AGENTS.md）',
  agentsRoot: 'AGENTS.md（仓库根）',
  skillPrefix: '任务技能',
} as const;

/**
 * 渲染 P1 层（标题 + 正文）。**装配与保存期预算预演共用它**：两边各写一份渲染，
 * 就会出现「保存时说放得下、运行期却被整段丢掉」这种最难查的偏差。
 *
 * 空正文 → 空串（= 没有这一层，不是渲染出一个空标题）。
 */
export function renderProjectLayer(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') {
    return '';
  }
  return `## ${ASSEMBLE_HEADINGS.project}\n\n${trimmed}`;
}

/** P1 槽位 → 文本（原样正文，或一条同标题的丢弃标记）。 */
function renderProjectSlot(slot: ProjectSlot): string {
  if (slot === null) {
    return '';
  }
  if (slot.kind === 'body') {
    return renderProjectLayer(slot.body);
  }
  return [
    `## ${ASSEMBLE_HEADINGS.project}`,
    '',
    `[已按总预算丢弃：项目提示词未进上下文（原文 ${String(slot.chars)} 字符）]`,
  ].join('\n');
}
function entryTitle(entry: AgentsEntry): string {
  if (entry.kind === 'root') {
    return ASSEMBLE_HEADINGS.agentsRoot;
  }
  if (entry.kind === 'nearby') {
    return `AGENTS.md（就近：${entry.section.path}）`;
  }
  return entry.title;
}

function renderAgents(entries: readonly AgentsEntry[]): string {
  if (entries.length === 0) {
    return '';
  }
  const lines: string[] = [`## ${ASSEMBLE_HEADINGS.agents}`];
  for (const entry of entries) {
    lines.push('', `### ${entryTitle(entry)}`, '');
    if (entry.kind === 'dropped') {
      lines.push(`[已按总预算丢弃：该段未进上下文（原文 ${String(entry.chars)} 字符）]`);
    } else {
      lines.push(entry.section.text);
    }
  }
  return lines.join('\n');
}

function renderSkill(slot: SkillSlot): string {
  if (slot === null) {
    return '';
  }
  if (slot.kind === 'skill') {
    return [`## ${ASSEMBLE_HEADINGS.skillPrefix} ${slot.layer.name}`, '', slot.layer.promptText.trim()].join('\n');
  }
  return [
    `## ${ASSEMBLE_HEADINGS.skillPrefix} ${slot.name}`,
    '',
    `[已按总预算丢弃：技能正文未进上下文（原文 ${String(slot.chars)} 字符）]`,
  ].join('\n');
}

/**
 * 把 `basePrompt` 切成「头部 + 其余」。
 *
 * 头部 = 第一个空行之前的内容（`buildTaskPrompt` / `buildAnswerPrompt` 的头部恰好是
 * 身份 + 命令 + dry-run 三行）；没有空行就取第一行；单行或空串时整段都算头部（层会追加到末尾，
 * 那时它本来就是最后一段）。
 */
export function splitBasePrompt(basePrompt: string): { readonly head: string; readonly tail: string } {
  if (basePrompt === '') {
    return { head: '', tail: '' };
  }
  const blank = basePrompt.indexOf('\n\n');
  if (blank >= 0) {
    return { head: basePrompt.slice(0, blank), tail: basePrompt.slice(blank + 2) };
  }
  const newline = basePrompt.indexOf('\n');
  if (newline >= 0) {
    return { head: basePrompt.slice(0, newline), tail: basePrompt.slice(newline + 1) };
  }
  return { head: basePrompt, tail: '' };
}

/* ── 入口 ─────────────────────────────────────────────────────────────────── */

/** 阶段维度解析出来的「框架」：不可丢的头尾 + 允许哪些可丢层。 */
type AssembleFrame = {
  readonly head: string;
  readonly tail: string;
  readonly allowProject: boolean;
  readonly allowSkill: boolean;
  /** `true` = 缺省行为（调用方没给 `stage`），走 `splitBasePrompt()`。 */
  readonly legacy: boolean;
};

/**
 * `stage` → head/tail + 层作用域（`docs/plan-fixed-pipeline.md` §16.3）。
 *
 * 缺省（没给 `stage`）时的输出与 P1 时代的装配**逐字节一致**：head/tail 仍是
 * `splitBasePrompt()` 的两半，P1 与技能层照常参与。
 */
function resolveFrame(input: AssemblePromptInput): AssembleFrame {
  const stage = input.stage ?? null;
  if (stage === null) {
    const { head, tail } = splitBasePrompt(input.basePrompt);
    return { head, tail, allowProject: true, allowSkill: true, legacy: true };
  }

  const stagePrompt = (input.stagePrompt ?? '').trim();
  if (stage === 'format' || stage === 'classify') {
    // 阶段 0/1：`basePrompt` **整段**都当输出契约（代码追加、永远最后），
    // 阶段系统提示词占据 P0 位置；P1 与技能层不出现，AGENTS.md 照常注入（Q9）。
    return {
      head: stagePrompt,
      tail: input.outputContract ?? input.basePrompt,
      allowProject: false,
      allowSkill: false,
      legacy: false,
    };
  }

  // 阶段 2：`agent` 阶段系统提示词顶掉原来的 head，其余层序不变（P1 → AGENTS.md → 技能 → 契约）。
  const split = splitBasePrompt(input.basePrompt);
  return {
    head: stagePrompt === '' ? split.head : stagePrompt,
    tail: input.outputContract ?? split.tail,
    allowProject: true,
    allowSkill: true,
    legacy: false,
  };
}

type AssembleCore = {
  readonly prompt: string;
  readonly stats: AssemblePromptStats;
  readonly layers: readonly AssembleStageLayer[];
};

/**
 * 装配的唯一实现（`assemblePrompt()` 与 `stageLayers()` 都走它）。
 *
 * 两处「有意的差别」：
 *  1. 阶段模式下 `stats.baseChars` = 阶段系统提示词 + 输出契约，而不是 `basePrompt` 的长度
 *     —— `agent` 提示词写多长就直接扣掉 P1 多少额度（R6 / V18）。
 *  2. 丢层顺序：**P1 → 技能正文**。AGENTS.md 与 `head` / `tail` 永不丢（见文件头的预算段）。
 */
function assembleCore(input: AssemblePromptInput): AssembleCore {
  const base = input.basePrompt;
  const budgetChars = input.budgetChars ?? DEFAULT_ASSEMBLE_BUDGET_CHARS;
  const frame = resolveFrame(input);

  const rootSection = input.agentsMd?.root ?? null;
  const nearbySections = input.agentsMd?.nearby ?? [];
  const skillLayer = frame.allowSkill ? (input.skill ?? null) : null;
  const projectBody = frame.allowProject ? (input.projectPrompt ?? '').trim() : '';

  /** 不可丢的部分（缺省模式下就是整段 `basePrompt`）。 */
  const fixedChars = frame.legacy ? base.length : frame.head.length + frame.tail.length;
  const headLayer: AssembleStageLayer = {
    name: 'head',
    chars: frame.head.length,
    droppable: false,
    dropped: false,
  };
  const tailLayer: AssembleStageLayer = {
    name: 'tail',
    chars: frame.tail.length,
    droppable: false,
    dropped: false,
  };

  if (
    frame.legacy &&
    rootSection === null &&
    nearbySections.length === 0 &&
    skillLayer === null &&
    projectBody === ''
  ) {
    return {
      prompt: base,
      stats: {
        baseChars: base.length,
        promptChars: 0,
        agentsChars: 0,
        skillChars: 0,
        totalChars: base.length,
        truncated: [],
      },
      layers: [headLayer, tailLayer],
    };
  }

  const agentsEntries: AgentsEntry[] = [];
  if (rootSection !== null) {
    agentsEntries.push({ kind: 'root', section: rootSection });
  }
  for (const section of nearbySections) {
    agentsEntries.push({ kind: 'nearby', section });
  }
  // 层名在丢弃**之前**定好：丢弃后槽里只剩标题与字符数，路径就查不回来了。
  const agentsNames = agentsEntries.map((entry) =>
    entry.kind === 'root'
      ? 'agents:root'
      : entry.kind === 'nearby'
        ? `agents:nearby:${entry.section.path}`
        : 'agents',
  );
  let skillSlot: SkillSlot = skillLayer === null ? null : { kind: 'skill', layer: skillLayer };
  let projectSlot: ProjectSlot = projectBody === '' ? null : { kind: 'body', body: projectBody };

  const { head, tail } = frame;

  const compose = (): string => {
    // 中间这几块的顺序就是契约：P1 → AGENTS.md → 技能。
    const layers: string[] = [];
    const project = renderProjectSlot(projectSlot);
    if (project !== '') {
      layers.push(project);
    }
    const agents = renderAgents(agentsEntries);
    if (agents !== '') {
      layers.push(agents);
    }
    const skill = renderSkill(skillSlot);
    if (skill !== '') {
      layers.push(skill);
    }
    const parts: string[] = [];
    if (head !== '') {
      parts.push(head);
    }
    if (layers.length > 0) {
      parts.push(layers.join('\n\n'));
    }
    if (tail !== '') {
      parts.push(tail);
    }
    return parts.join('\n\n');
  };

  const dropSkill = (): string | null => {
    if (skillSlot === null || skillSlot.kind === 'dropped') {
      return null;
    }
    const code = `skill:${skillSlot.layer.name}`;
    skillSlot = { kind: 'dropped', name: skillSlot.layer.name, chars: skillSlot.layer.promptText.length };
    return code;
  };

  const dropProject = (): string | null => {
    if (projectSlot === null || projectSlot.kind === 'dropped') {
      return null;
    }
    const code = 'project';
    projectSlot = { kind: 'dropped', chars: projectSlot.body.length };
    return code;
  };

  // 丢弃顺序：**只丢 P1（上下文）与技能正文**，P1 在技能之前（背景/语气 vs 命令语义）。
  //
  // 三样东西**不在**这个列表里，这是刻意的：
  //  - `head` / `tail`：系统提示词与输出契约。丢了它们任务语义就变了（V18）；
  //  - AGENTS.md（根与就近）：仓库所有者写下的约定（构建方式、禁改路径、提交规范）。
  //    「预算不够」时先砍技能与项目上下文，绝不砍它 —— 让 agent 违反仓库约定比少给一段
  //    背景严重得多（早年的实现把根 AGENTS.md 也放进丢弃清单，等于超预算时先把规矩丢掉）。
  // 于是 `stats.truncated` 里只剩 `project` / `skill:<name>` 两种层名。
  const removals: { readonly run: () => string | null }[] = [];
  if (projectSlot !== null) {
    removals.push({ run: dropProject });
  }
  if (skillSlot !== null) {
    removals.push({ run: dropSkill });
  }

  const truncated: string[] = [];
  let prompt = compose();
  for (const removal of removals) {
    if (prompt.length <= budgetChars) {
      break;
    }
    const code = removal.run();
    if (code === null) {
      continue;
    }
    truncated.push(code);
    prompt = compose();
  }

  const projectText = renderProjectSlot(projectSlot);
  const agentsText = renderAgents(agentsEntries);
  const skillText = renderSkill(skillSlot);

  // 收尾时用「取值函数」而不是直接读 `let` 槽：槽在丢弃回调里被改过，
  // TS 会把它们按初始赋值收窄，于是 `kind === 'dropped'` 那几行会被判成永假。
  const finalProject = (): ProjectSlot => projectSlot;
  const finalSkill = (): SkillSlot => skillSlot;

  const layers: AssembleStageLayer[] = [headLayer];
  if (projectSlot !== null) {
    layers.push({
      name: 'project',
      chars: finalProject()?.kind === 'body' ? projectText.length : 0,
      droppable: true,
      dropped: finalProject()?.kind === 'dropped',
    });
  }
  agentsEntries.forEach((entry, index) => {
    layers.push({
      name: agentsNames[index] ?? 'agents',
      chars: entry.kind === 'dropped' ? 0 : entry.section.text.length,
      // AGENTS.md **永远不可裁**（根与就近都是）：预算不够时先丢 P1 与技能正文。
      // 面板的「最终 prompt 预览」按 `droppable` 给人看哪层可能消失，这里必须说实话。
      droppable: false,
      dropped: entry.kind === 'dropped',
    });
  });
  const skillFinal = finalSkill();
  if (skillFinal !== null) {
    layers.push({
      name: skillFinal.kind === 'skill' ? `skill:${skillFinal.layer.name}` : `skill:${skillFinal.name}`,
      chars: skillFinal.kind === 'skill' ? skillFinal.layer.promptText.length : 0,
      droppable: true,
      dropped: skillFinal.kind === 'dropped',
    });
  }
  layers.push(tailLayer);

  return {
    prompt,
    stats: {
      baseChars: fixedChars,
      promptChars: projectText.length,
      agentsChars: agentsText.length,
      skillChars: skillText.length,
      totalChars: prompt.length,
      truncated,
    },
    layers,
  };
}

/**
 * 装配提示词。
 *
 * `projectPrompt` / `agentsMd` / `skill` / `stage` 都缺省时返回的 `prompt` 与 `basePrompt`
 * **逐字节相同**（硬约束：装配层的存在不能改变任何既有部署的提示词）。
 */
export function assemblePrompt(input: AssemblePromptInput): AssemblePromptResult {
  const { prompt, stats } = assembleCore(input);
  return { prompt, stats };
}

/**
 * 层序预览：各层字符数 + 是否可丢弃 + 是否已被丢（面板的「最终 prompt 预览」与测试共用）。
 *
 * 跑的是**同一个** `assembleCore()`，所以预览里的层序、字符数、丢弃项与最终文本永远一致
 * （各写一份拼接逻辑正是这类偏差的来源）。`head` / `tail` 与 AGENTS.md 层恒为
 * `droppable: false`（V18 + AGENTS.md 不可裁）。
 */
export function stageLayers(input: AssemblePromptInput): readonly AssembleStageLayer[] {
  return assembleCore(input).layers;
}
