/**
 * 判据 3：**工具循环**（plan §9.3 第 3 条）。
 *
 * 判据原文：「同一工具、同一参数连续调用 3 次，且没有产生新的文件或测试结果变化」。
 *
 * 三个词各自有实现含义，缺一条就会误报或漏报：
 *   - **同一工具、同一参数**：工具名 + `stableStringify(params)` 组成签名（键顺序无关）；
 *   - **连续**：签名一变就重置计数（中间插了一次别的工具，就不算「在原地打转」）；
 *   - **没有状态变化**：每次调用带一个 `stateDigest`（文件集 / 测试结果的摘要）。
 *     连续调用签名相同**且**状态指纹也没变，才累计；状态一变立刻归零。
 *     没传 `stateDigest` 按「没有观测到变化」处理——真正的死循环必然伴随状态不变。
 *
 * 为什么不看输出文本：工具循环的文本往往还在「解释为什么这次又失败」，
 * 内容看着有信息量（所以低增量判据抓不到），但世界没变。
 */
import { stableStringify, summarize } from './text.ts';
import type { DegeneracyClock, DegeneracyHit, ToolCallObservation, ToolLoopDetector } from './types.ts';

/** 连续相同调用的命中阈值（plan §9.3：连续 3 次）。 */
export const TOOL_LOOP_THRESHOLD = 3;

export interface ToolLoopOptions {
  readonly threshold?: number;
  readonly clock?: DegeneracyClock;
}

export interface ToolLoopState extends ToolLoopDetector {
  /** 当前连续相同调用的次数（诊断用：能断言「差一次就命中」）。 */
  readonly streak: number;
  /** 当前连续段的签名（未开始时为空串）。 */
  readonly lastSignature: string;
}

export function createToolLoopDetector(options: ToolLoopOptions = {}): ToolLoopState {
  const threshold = Math.max(2, options.threshold ?? TOOL_LOOP_THRESHOLD);
  const clock = options.clock ?? ((): number => Date.now());

  let calls = 0;
  let signature = '';
  let stateDigest: string | undefined;
  let streak = 0;
  let sticky: DegeneracyHit | null = null;

  const reset = (): void => {
    calls = 0;
    signature = '';
    stateDigest = undefined;
    streak = 0;
    sticky = null;
  };

  return {
    get consumed(): number {
      return calls;
    },
    get streak(): number {
      return streak;
    },
    get lastSignature(): string {
      return signature;
    },
    reset,
    push(call: ToolCallObservation): DegeneracyHit | null {
      if (sticky !== null) {
        return sticky;
      }
      if (typeof call?.tool !== 'string' || call.tool.length === 0) {
        return null;
      }
      calls += 1;
      const nextSignature = `${call.tool}\u0000${stableStringify(call.params)}`;
      const sameCall = nextSignature === signature;
      const sameState = call.stateDigest === stateDigest;

      if (sameCall && sameState) {
        streak += 1;
      } else if (sameCall) {
        // 参数没变但世界变了：这不是空转，重新计数。
        stateDigest = call.stateDigest;
        streak = 1;
      } else {
        signature = nextSignature;
        stateDigest = call.stateDigest;
        streak = 1;
      }

      if (streak < threshold) {
        return null;
      }
      const hit: DegeneracyHit = {
        criterion: 'tool-loop',
        detail: {
          tool: call.tool,
          consecutiveCalls: streak,
          threshold,
          paramsPreview: summarize(call.params, 200),
          stateDigest: call.stateDigest ?? null,
          totalCalls: calls,
        },
        at: clock(),
      };
      sticky = hit;
      return hit;
    },
  };
}
