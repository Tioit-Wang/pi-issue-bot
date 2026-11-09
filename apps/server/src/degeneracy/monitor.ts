/**
 * 三条判据的合并监视器：**worker 只需要 `observe(event)` 一个入口**。
 *
 * 命中语义（plan §9.3 的处置）：命中即粘住——`hit` 非空之后所有 `push*` 都返回同一个 hit，
 * worker 据此只 `turn/interrupt` 一次、只写一条 `degeneracy_hits`。
 *
 * 为什么是「先命中者胜」而不是「三条都算完取最严重」：
 * 三条判据的处置完全一样（中断本轮 + 判 `degenerate-output` + 不重试），
 * 而再多跑一轮就可能多烧几万 token。所以第一个命中就是答案。
 */
import { defaultDegeneracyEventAdapter } from './events.ts';
import type { DegeneracyEventAdapter, DegeneracyEventSource } from './events.ts';
import { createIncrementalNoveltyDetector } from './incremental-novelty.ts';
import type { IncrementalNoveltyOptions } from './incremental-novelty.ts';
import { createParagraphRepeatDetector } from './paragraph-repeat.ts';
import type { ParagraphRepeatOptions } from './paragraph-repeat.ts';
import { createToolLoopDetector } from './tool-loop.ts';
import type { ToolLoopOptions } from './tool-loop.ts';
import type { DegeneracyHit, DegeneracyMonitor, DegeneracyStats, ToolCallObservation } from './types.ts';

export interface DegeneracyMonitorOptions {
  readonly paragraphRepeat?: ParagraphRepeatOptions;
  readonly novelty?: IncrementalNoveltyOptions;
  readonly toolLoop?: ToolLoopOptions;
  readonly events?: DegeneracyEventAdapter;
}

export function createDegeneracyMonitor(options: DegeneracyMonitorOptions = {}): DegeneracyMonitor {
  const paragraph = createParagraphRepeatDetector(options.paragraphRepeat ?? {});
  const novelty = createIncrementalNoveltyDetector(options.novelty ?? {});
  const toolLoop = createToolLoopDetector(options.toolLoop ?? {});
  const adapter = options.events ?? defaultDegeneracyEventAdapter;

  let hit: DegeneracyHit | null = null;
  const hits: DegeneracyHit[] = [];

  const accept = (candidate: DegeneracyHit | null): DegeneracyHit | null => {
    if (candidate === null) {
      return hit;
    }
    if (hit === null) {
      hit = candidate;
      hits.push(candidate);
    }
    return hit;
  };

  return {
    get hit(): DegeneracyHit | null {
      return hit;
    },
    get hits(): readonly DegeneracyHit[] {
      return hits;
    },
    get stats(): DegeneracyStats {
      return {
        textChars: paragraph.consumed,
        tokens: novelty.consumed,
        toolCalls: toolLoop.consumed,
        paragraphMaxCount: paragraph.maxCount,
        noveltyRatio: novelty.lastNoveltyRatio,
        toolLoopStreak: toolLoop.streak,
      };
    },
    reset(): void {
      paragraph.reset();
      novelty.reset();
      toolLoop.reset();
      hit = null;
      hits.length = 0;
    },
    pushText(chunk: string): DegeneracyHit | null {
      if (hit !== null) {
        return hit;
      }
      // 两条文本判据都要喂：段落重复看字符窗口，低增量看 token n-gram。
      return accept(paragraph.push(chunk) ?? novelty.push(chunk));
    },
    pushToolCall(call: ToolCallObservation): DegeneracyHit | null {
      if (hit !== null) {
        return hit;
      }
      return accept(toolLoop.push(call));
    },
    observe(event: DegeneracyEventSource): DegeneracyHit | null {
      if (hit !== null) {
        return hit;
      }
      const tool = adapter.toolCallOf(event);
      if (tool !== undefined) {
        const toolHit = toolLoop.push(tool);
        if (toolHit !== null) {
          return accept(toolHit);
        }
      }
      const text = adapter.textOf(event);
      if (text !== undefined) {
        return accept(paragraph.push(text) ?? novelty.push(text));
      }
      return hit;
    },
  };
}
