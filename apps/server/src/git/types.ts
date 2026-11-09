/**
 * `git/` 内部共用的形状。
 *
 * 放在单独文件里是为了避免 `writeback-gate ↔ commit-tree` 互相 import：
 * 审计摘要（`PathSetSummary`/`WritebackAudit`）是**跨模块契约**，索引快照是
 * 「worktree 的真索引没被动过」这条不变式的载体，两者都被多个文件用到。
 */

/**
 * 一棵工作树的真索引快照。
 *
 * `tree` 是**语义**判据（真索引写出的树），`sha256` 是索引文件字节的摘要。
 * 为什么两者都要：`git status` 会刷新索引里缓存的 stat 信息并**重写索引文件**，
 * 于是字节会变、树不会变。闸门的不变式是「条目（哪些路径、哪些 blob）不变」，
 * 所以比较以 `tree` 为准，`sha256` 只在树拿不到（索引有冲突/损坏）时兜底。
 */
export interface IndexSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string | null;
  /** 真索引写出的树（拿不到时为 null）。 */
  readonly tree: string | null;
}

/**
 * 一个路径集合的摘要（tech-plan §5.6 第 4 条）。
 *
 * `sha256` 的算法：路径排序后以 `\n` 连接再取 sha256。排序是必须的——
 * `git status` 的输出顺序会受文件系统影响，不排序的话同一次变更会有两个摘要。
 */
export interface PathSetSummary {
  /** 集合大小（不受 `paths` 截断影响）。 */
  readonly count: number;
  readonly sha256: string;
  /** 排序后的路径列表，最多 `MAX_AUDIT_PATHS` 条。 */
  readonly paths: readonly string[];
  /** 是否因为超限而截断（面板要显示「还有 N 条」）。 */
  readonly truncated: boolean;
}

/** 写回闸门的四集合摘要（进 `actions.audit` 与 `run_events`，面板详情页可查）。 */
export interface WritebackAudit {
  readonly declared: PathSetSummary;
  readonly actual: PathSetSummary;
  readonly intersect: PathSetSummary;
  readonly dropped: PathSetSummary;
}
