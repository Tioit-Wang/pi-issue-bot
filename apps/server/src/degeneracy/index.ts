/**
 * `degeneracy/` 的对外出口（plan §9.3 / tech-plan §7.4 的 S2）。
 *
 * worker 只从这里 import：`createDegeneracyMonitor()` 拿监视器，`DegeneracyHit` 描述命中，
 * 三条判据的实现细节（窗口大小、n-gram 阶数、计数表）留在这个目录里。
 *
 * 依赖方向（tech-plan §8.2）：`worker → degeneracy`，本目录**不依赖任何其它模块**
 * （连 `shared` 都不用：判据是纯函数与内存状态机，不需要日志与错误分类）。
 */
export {
  DEGENERACY_CRITERIA,
  type DegeneracyClock,
  type DegeneracyCriterion,
  type DegeneracyDetector,
  type DegeneracyHit,
  type DegeneracyMonitor,
  type DegeneracyStats,
  type TextDegeneracyDetector,
  type ToolCallObservation,
  type ToolLoopDetector,
} from './types.ts';

export { normalizeText, stableStringify, summarize, tokenize } from './text.ts';

export {
  PARAGRAPH_MAX_TRACKED_WINDOWS,
  PARAGRAPH_REPEAT_THRESHOLD,
  PARAGRAPH_WINDOW_CHARS,
  createParagraphRepeatDetector,
  type ParagraphRepeatDetector,
  type ParagraphRepeatOptions,
} from './paragraph-repeat.ts';

export {
  NOVELTY_NGRAM,
  NOVELTY_THRESHOLD,
  NOVELTY_WINDOW_TOKENS,
  createIncrementalNoveltyDetector,
  type IncrementalNoveltyDetector,
  type IncrementalNoveltyOptions,
} from './incremental-novelty.ts';

export {
  TOOL_LOOP_THRESHOLD,
  createToolLoopDetector,
  type ToolLoopOptions,
  type ToolLoopState,
} from './tool-loop.ts';

export {
  TEXT_EVENT_KINDS,
  TOOL_EVENT_KINDS,
  defaultDegeneracyEventAdapter,
  type DegeneracyEventAdapter,
  type DegeneracyEventSource,
} from './events.ts';

export { createDegeneracyMonitor, type DegeneracyMonitorOptions } from './monitor.ts';
