/**
 * 从 RACP 事件里抽「文本增量」与「工具调用」（熔断监视器的输入面）。
 *
 * **为什么要抽而不是约定**：`racp.schema.json` 还没 vendored（tech-plan §2.2），
 * 事件 payload 的确切形状无法钉死。所以这里用「多形状容忍 + 可覆盖」两件套：
 *   - 默认实现对几种常见嵌套都试一遍（`payload.text` / `payload.delta` / `payload.item.text`…），
 *     对不上就返回 undefined（**不猜、不静默当成整段文本**）；
 *   - `DegeneracyEventAdapter` 允许上层整体替换抽取逻辑，等 vendor 了真实 schema 再改一处即可。
 *
 * 一个刻意的边界：`turn.activity` / `item.delta` 这类 **ephemeral** 事件才是文本流的主体，
 * 但熔断判据不能只看流式增量（增量可能被合并、被重放）。所以两层都在：
 * `item.delta` 给高频增量，`item.completed` / `turn.completed` 给「整条内容」兜底。
 * 同一条内容被数两次不会造成误报（重复文本本来就是判据要找的东西），
 * 但会提前触发——这是有意偏向保守（宁可早熔断，也别把 token 烧完）。
 */

/** 事件里可以承载「模型输出文本增量」的键路径（按顺序尝试）。 */
const TEXT_PATHS: readonly (readonly string[])[] = [
  ['text'],
  ['delta', 'text'],
  ['delta'],
  ['chunk'],
  ['content', 'text'],
  ['item', 'text'],
  ['item', 'content'],
  ['message', 'text'],
  ['output', 'text'],
];

/** 事件里可以承载「工具名」的键路径。 */
const TOOL_NAME_PATHS: readonly (readonly string[])[] = [
  ['tool', 'name'],
  ['tool'],
  ['toolName'],
  ['name'],
  ['call', 'name'],
  ['item', 'tool'],
];

/** 事件里可以承载「工具参数」的键路径。 */
const TOOL_INPUT_PATHS: readonly (readonly string[])[] = [
  ['tool', 'input'],
  ['input'],
  ['args'],
  ['arguments'],
  ['params'],
  ['call', 'input'],
  ['item', 'input'],
];

/** 事件里可以承载「调用后状态指纹」的键路径（文件集 / 测试结果摘要）。 */
const STATE_PATHS: readonly (readonly string[])[] = [
  ['stateDigest'],
  ['state'],
  ['workspace', 'digest'],
  ['workspaceDigest'],
  ['files', 'digest'],
  ['test', 'digest'],
];

/** 文本类事件的 kind（增量 + 终态兜底）。 */
export const TEXT_EVENT_KINDS: readonly string[] = [
  'item.delta',
  'item.completed',
  'turn.activity',
  'turn.completed',
  'turn.failed',
];

/** 工具类事件的 kind。 */
export const TOOL_EVENT_KINDS: readonly string[] = ['tool.progress', 'item.started', 'item.completed'];

function pick(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function pickString(value: unknown, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const found = pick(value, path);
    if (typeof found === 'string' && found.length > 0) {
      return found;
    }
  }
  return undefined;
}

export interface DegeneracyEventSource {
  readonly kind: string;
  readonly payload: unknown;
}

/** 抽取可覆盖点（等真实 schema vendored 后只需替换它）。 */
export interface DegeneracyEventAdapter {
  textOf(event: DegeneracyEventSource): string | undefined;
  toolCallOf(
    event: DegeneracyEventSource,
  ): { readonly tool: string; readonly params: unknown; readonly stateDigest?: string } | undefined;
}

/** 默认抽取器：多形状容忍，对不上返回 undefined。 */
export const defaultDegeneracyEventAdapter: DegeneracyEventAdapter = {
  textOf(event) {
    if (!TEXT_EVENT_KINDS.includes(event.kind)) {
      return undefined;
    }
    return pickString(event.payload, TEXT_PATHS);
  },
  toolCallOf(event) {
    if (!TOOL_EVENT_KINDS.includes(event.kind)) {
      return undefined;
    }
    const tool = pickString(event.payload, TOOL_NAME_PATHS);
    if (tool === undefined) {
      return undefined;
    }
    const params = ((): unknown => {
      for (const path of TOOL_INPUT_PATHS) {
        const found = pick(event.payload, path);
        if (found !== undefined) {
          return found;
        }
      }
      return null;
    })();
    const stateDigest = pickString(event.payload, STATE_PATHS);
    return { tool, params, ...(stateDigest === undefined ? {} : { stateDigest }) };
  },
};
