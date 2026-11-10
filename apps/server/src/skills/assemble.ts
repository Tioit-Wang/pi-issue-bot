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
 * 总预算默认 12000 字符（`budgetChars` 可覆盖，统计的是**整条 prompt**）。超预算时**从后往前**丢：
 * 先丢最远的就近 AGENTS.md，再丢 P1（项目约定），再丢技能正文，根 AGENTS.md 最后丢。
 * 丢弃的单位是**整段**（围栏块 + 分节标题），绝不切字符 —— 半个 `<<<PI-BOT:UNTRUSTED:…>>>`
 * 或半个 ``` 围栏比没有更危险。每次丢弃都留一条可见标记并记进 `stats.truncated`，
 * 所以「预算不够」永远不会静默。
 *
 * 为什么 P1 在技能之前丢：P1 是项目背景/领域知识/语气，丢了任务仍然正确；
 * 技能正文是命令语义，丢了命令行为就错了。
 *
 * 保存期还有一道**预演**（`prompt/budget.ts`）：面板保存 P1 时先算「还能占多少」，存不下直接拒绝，
 * 所以运行期这条兜底路径通常只对「别的层后来长大了」生效。
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
  /** 命中命令的技能；缺省/null 表示没有技能层。 */
  readonly skill?: AssembleSkillLayer | null;
  /** 覆盖总预算（单测用）。 */
  readonly budgetChars?: number;
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
  /** 因预算被整段丢弃的东西（`nearby:<path>` / `project` / `skill:<name>` / `root`）。 */
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

/**
 * 装配提示词。
 *
 * `projectPrompt` / `agentsMd` / `skill` 都缺省时返回的 `prompt` 与 `basePrompt` **逐字节相同**
 * （这是硬约束：装配层的存在不能改变任何既有部署的提示词，包括「P1 表刚建好但还没人写」的状态）。
 */
export function assemblePrompt(input: AssemblePromptInput): AssemblePromptResult {
  const base = input.basePrompt;
  const budgetChars = input.budgetChars ?? DEFAULT_ASSEMBLE_BUDGET_CHARS;

  const rootSection = input.agentsMd?.root ?? null;
  const nearbySections = input.agentsMd?.nearby ?? [];
  const skillLayer = input.skill ?? null;
  const projectBody = (input.projectPrompt ?? '').trim();

  if (rootSection === null && nearbySections.length === 0 && skillLayer === null && projectBody === '') {
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
    };
  }

  const agentsEntries: AgentsEntry[] = [];
  if (rootSection !== null) {
    agentsEntries.push({ kind: 'root', section: rootSection });
  }
  for (const section of nearbySections) {
    agentsEntries.push({ kind: 'nearby', section });
  }
  let skillSlot: SkillSlot = skillLayer === null ? null : { kind: 'skill', layer: skillLayer };
  let projectSlot: ProjectSlot = projectBody === '' ? null : { kind: 'body', body: projectBody };

  const { head, tail } = splitBasePrompt(base);

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

  /** 一次「整段丢弃」：把第 `index` 个 AGENTS 段换成同位置的丢弃标记。 */
  const dropAgents = (index: number): string | null => {
    const entry = agentsEntries[index];
    if (entry === undefined || entry.kind === 'dropped') {
      return null;
    }
    const code = entry.kind === 'root' ? 'root' : `nearby:${entry.section.path}`;
    agentsEntries[index] = {
      kind: 'dropped',
      title: entryTitle(entry),
      chars: entry.section.text.length,
    };
    return code;
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

  // 从后往前丢的顺序：最远的就近段 → … → 最近的 → P1 → 技能 → 根。
  // P1 排在技能之前：P1 是背景/语气，技能正文是命令语义（丢了命令就错了）。
  const removals: { readonly run: () => string | null }[] = [];
  for (let index = agentsEntries.length - 1; index >= 0; index -= 1) {
    if (agentsEntries[index]?.kind !== 'nearby') {
      continue;
    }
    const target = index;
    removals.push({ run: () => dropAgents(target) });
  }
  if (projectSlot !== null) {
    removals.push({ run: dropProject });
  }
  if (skillSlot !== null) {
    removals.push({ run: dropSkill });
  }
  for (let index = 0; index < agentsEntries.length; index += 1) {
    if (agentsEntries[index]?.kind !== 'root') {
      continue;
    }
    const target = index;
    removals.push({ run: () => dropAgents(target) });
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

  return {
    prompt,
    stats: {
      baseChars: base.length,
      promptChars: projectText.length,
      agentsChars: agentsText.length,
      skillChars: skillText.length,
      totalChars: prompt.length,
      truncated,
    },
  };
}
