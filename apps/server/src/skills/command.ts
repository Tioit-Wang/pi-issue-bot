/**
 * `@bot /命令 参数` 的解析与**解析期**校验（契约 §2.1 / §4.2 第二行）。
 *
 * 语法刻意很窄（契约定的，不是这里偷懒）：`key=value`，值必须是单个 token
 * （不接受空格、引号、空值），最多 8 个；未知 key 或超出技能 `inputs` 声明一律拒绝。
 *
 * 为什么窄是对的：解析失败发生在**入队之前**，代价只是一条回复；
 * 如果放宽到「随便写，跑起来再试」，代价就是一次容器执行 + 一份成本。
 * 所以这里宁可回「用法说明」也不猜。
 *
 * 门禁（谁能用命令）不在这里，在 `workflows/command-gate.ts`：
 * 本文件只回答「这句话是不是一条合法的、已加载的命令」。
 */
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';
import type { SkillRegistry } from './registry.ts';
import type { SkillDefinition } from './types.ts';

/** 评论里默认的机器人提及名。真实 login 由调用方注入（各仓库的机器人名字不同）。 */
export const DEFAULT_COMMAND_MENTION = '@bot';

/** 单个参数值的长度上限（与 `renderSkillPrompt` 的 `PROMPT_LIMITS.inputValue` 同口径）。 */
export const MAX_INPUT_VALUE_LENGTH = 200;

/** 一次命令最多带几个参数（契约 §2.1）。 */
export const MAX_COMMAND_ARGS = 8;

const COMMAND_TOKEN_RE = /^\/[a-z][a-z0-9-]{1,30}$/u;
const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,23}$/u;
const ARG_TOKEN_RE = /^([a-z][a-z0-9_]{0,23})=(\S+)$/u;

/** 解析成功的一条命令。 */
export type ParsedCommand = {
  /** 归一化命令名（小写，带 `/`）。 */
  readonly command: string;
  /** 已校验的参数（原样的值，渲染时再中和）。 */
  readonly args: Readonly<Record<string, string>>;
  /** 命中的提及原文（日志里保留原始大小写，便于排查「@Pi-Bot 没反应」）。 */
  readonly mention: string;
};

/**
 * 拒绝原因。每一个都对应一条**面向人的回复**，不存在「静默忽略」：
 *  - `no-mention`       文本里没有提及机器人
 *  - `no-command`       提及了但没有合法的 `/命令`
 *  - `commands-disabled` 仓库配置 `commands.enabled: false`
 *  - `unknown-command`  注册表里没有这个命令
 *  - `skill-disabled`   注册表里有，但被禁用（原因在 `detail` 里，契约 §3）
 *  - `bad-args`         参数不符合 `inputs` 声明
 */
export type CommandRejectReason =
  | 'no-mention'
  | 'no-command'
  | 'commands-disabled'
  | 'not-allowed'
  | 'unknown-command'
  | 'skill-disabled'
  | 'bad-args';

export type CommandParseResult =
  | {
      readonly ok: true;
      readonly command: ParsedCommand;
      readonly skill: SkillDefinition;
    }
  | {
      readonly ok: false;
      readonly reason: CommandRejectReason;
      readonly message: string;
      /** 解析到一半时已知的命令名（用于回复「/x 配置无效」）；完全没有时为 `null`。 */
      readonly command: string | null;
      readonly detail: string | null;
    };

export type CommandParseOptions = {
  readonly registry: SkillRegistry;
  /** 仓库配置的 `commands` 段（不给则跳过「开关 + 白名单」两项，单测方便）。 */
  readonly commands?: Pick<RepoConfig, 'commands'>['commands'] | null;
  /** 机器人提及名（含 `@`），默认 `@bot`。 */
  readonly mention?: string;
};

/** 把文本按空白切成 token（`\s` 同时管换行，评论里命令另起一行是常态）。 */
function tokenize(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token !== '');
}

/**
 * 只做词法切分：找到提及 + 紧随其后（跳过空 token 后）的 `/命令` 与 `key=value`。
 *
 * 不做任何校验，也不看注册表 —— 这样门禁可以在「命令是否合法」之前先判「这个人能不能用」，
 * 两者互不依赖（`workflows/command-gate.ts` 就是这么用的）。
 */
export function parseCommandMention(
  text: string,
  mention: string = DEFAULT_COMMAND_MENTION,
): { readonly command: string; readonly args: Readonly<Record<string, string>>; readonly mention: string } | null {
  const wanted = mention.toLowerCase();
  const tokens = tokenize(text);
  const index = tokens.findIndex((token) => token.toLowerCase() === wanted);
  if (index < 0) {
    return null;
  }
  const commandToken = tokens[index + 1];
  if (commandToken === undefined) {
    return null;
  }
  const command = commandToken.toLowerCase();
  if (!COMMAND_TOKEN_RE.test(command)) {
    return null;
  }
  const args: Record<string, string> = {};
  for (const token of tokens.slice(index + 2)) {
    const matched = ARG_TOKEN_RE.exec(token);
    if (matched === null) {
      // 值里带空格/引号/空值的写法在这里就断了：把它当「多出来的无用 token」记下，
      // 由 `parseCommand` 统一回一条用法说明（不在词法层决定对错）。
      args['__malformed__'] = token.slice(0, MAX_INPUT_VALUE_LENGTH);
      break;
    }
    const key = matched[1];
    const value = matched[2];
    if (key === undefined || value === undefined) {
      continue;
    }
    args[key] = value.slice(0, MAX_INPUT_VALUE_LENGTH);
  }
  return { command, args, mention: tokens[index] ?? mention };
}

/** 一条面向人的用法说明（「未知命令」与 `bad-args` 都回它）。 */
export function usageMessage(skill: SkillDefinition): string {
  const inputs = skill.effective.inputs;
  if (inputs.length === 0) {
    return `用法：\`${skill.name}\`（不接受参数）。${skill.frontmatter.description}`;
  }
  const parts = inputs.map((input) => {
    const value =
      input.pattern === undefined ? `<${input.name}>` : `<${input.name}:${input.pattern}>`;
    return input.required ? value : `[${input.name}=${value.slice(1, -1)}]`;
  });
  return `用法：\`${skill.name} ${parts.join(' ')}\`。${skill.frontmatter.description}`;
}

/** 把 `pattern` 编译成 RegExp；编译失败返回 `null`（技能里的正则写坏时不能把进程带崩）。 */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

function reject(
  reason: CommandRejectReason,
  message: string,
  command: string | null,
  detail: string | null = null,
): CommandParseResult {
  return { ok: false, reason, message, command, detail };
}

/**
 * 完整解析：词法 → 仓库命令配置（开关 / 白名单）→ 注册表（是否已加载 / 是否被禁用）→ 参数校验。
 *
 * 顺序是刻意的：**先便宜的判定，后贵的**。命令被禁用时不该再去校验参数——
 * 那样会把「配置坏了」包装成「你参数写错了」。
 */
export function parseCommand(text: string, options: CommandParseOptions): CommandParseResult {
  const mention = options.mention ?? DEFAULT_COMMAND_MENTION;
  const lexical = parseCommandMention(text, mention);
  if (lexical === null) {
    const hasMention = tokenize(text).some((token) => token.toLowerCase() === mention.toLowerCase());
    return hasMention
      ? reject('no-command', `请把命令写成 \`${mention} /<命令> k=v\` 的形式。`, null)
      : reject('no-mention', `没有找到 \`${mention}\`。`, null);
  }

  const { command, args } = lexical;
  const malformed = args['__malformed__'];

  const commands = options.commands ?? null;
  if (commands !== null) {
    if (!commands.enabled) {
      return reject('commands-disabled', '本仓库已关闭命令功能（`commands.enabled: false`）。', command);
    }
    const allowed = commands.allowed.map((item) => item.toLowerCase());
    if (!allowed.includes(command)) {
      return reject('not-allowed', `\`${command}\` 不在本仓库的命令白名单里。`, command);
    }
  }

  const entry = options.registry.get(command);
  if (entry === undefined) {
    return reject('unknown-command', `未知命令 \`${command}\`。`, command);
  }
  if (entry.kind === 'disabled') {
    return reject(
      'skill-disabled',
      `\`${command}\` 当前不可用（${entry.reason}）。${entry.detail}`,
      command,
      entry.detail,
    );
  }

  const skill = entry.skill;
  if (malformed !== undefined) {
    return reject('bad-args', `参数必须是 \`key=value\`（值不能带空格或引号）。${usageMessage(skill)}`, command);
  }

  const declared = new Map(skill.effective.inputs.map((input) => [input.name, input]));
  const provided = Object.entries(args);
  if (provided.length > MAX_COMMAND_ARGS) {
    return reject('bad-args', `一次最多 ${MAX_COMMAND_ARGS} 个参数。${usageMessage(skill)}`, command);
  }
  for (const [key] of provided) {
    if (!declared.has(key)) {
      return reject('bad-args', `未知参数 \`${key}\`。${usageMessage(skill)}`, command);
    }
  }
  for (const input of skill.effective.inputs) {
    const value = args[input.name];
    if (value === undefined) {
      if (input.required) {
        return reject('bad-args', `缺少必填参数 \`${input.name}\`。${usageMessage(skill)}`, command);
      }
      continue;
    }
    if (input.pattern === undefined) {
      continue;
    }
    const regex = compilePattern(input.pattern);
    if (regex === null) {
      // 技能自己的正则写坏了：拒绝执行并把原因说清楚（而不是放过任意值）。
      return reject(
        'bad-args',
        `技能 \`${command}\` 的参数校验规则无效（pattern 编译失败），已拒绝执行：${input.pattern}`,
        command,
        input.pattern,
      );
    }
    if (!regex.test(value)) {
      return reject('bad-args', `参数 \`${input.name}\` 的取值不合法。${usageMessage(skill)}`, command);
    }
  }

  const normalizedArgs: Record<string, string> = {};
  for (const [key, value] of provided) {
    // 只保留声明的参数（`__malformed__` 已在上面拦掉），并统一大小写不敏感的名字。
    if (INPUT_NAME_RE.test(key)) {
      normalizedArgs[key] = value;
    }
  }

  return { ok: true, command: { command, args: normalizedArgs, mention: lexical.mention }, skill };
}