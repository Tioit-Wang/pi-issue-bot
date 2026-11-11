/**
 * 层序预览：把 `layers` / `budget` / `preview.stats` 三个来源摊成一张「谁进了上下文」的表。
 *
 * 三条口径（`docs/plan-fixed-pipeline.md` §4.4 / §16.3.1 / V18）：
 *  1. **`head` / `tail` 永不丢弃**：运行期超预算也保留，所以视觉上钉住（实心左条 +「不可丢」微标），
 *     不做成「和别的一样的一行」；
 *  2. **超预算时被牺牲的只有 P1 / 近端 AGENTS / 技能**，顺序固定：就近 AGENTS → P1 → 技能 → 根 AGENTS；
 *  3. **`agent` 计入 `baseChars`**：它写多长就直接扣掉 P1 多少额度（V18），这条在 agent 单独说明。
 *
 * 数据来源优先级：`layers`（服务端逐层实测）→ 缺失时用 `preview.stats` 聚合兜底。
 * 兜底不是猜：`stats` 本来就是装配函数的产物，只是粒度粗（没有逐条 AGENTS / 技能的名字）。
 */
import type { PromptKind } from '../../../../../packages/contract/src/index.ts';
import type { PromptAssemblyStats, PromptBudget } from '../../lib/contract.ts';
import { formatCount } from '../../lib/format.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import type { PromptLayerView } from './use-prompt.ts';

/** 运行期整段丢弃的固定顺序（`assemble.ts` 的丢弃顺序；`head` / `tail` 不在其中）。 */
const DROP_ORDER = ['近端 AGENTS', 'P1 项目约定', '技能'] as const;

/** 层名 → 人话。路径留在等宽里（`agents:nearby:src/foo/AGENTS.md` 的路径要能认出来）。 */
function layerLabel(name: string, stage: boolean): { text: string; path: string | null } {
  if (name === 'head') return { text: stage ? '阶段系统提示词' : '底座（head）', path: null };
  if (name === 'tail') return { text: '输出契约（tail）', path: null };
  if (name === 'project') return { text: '项目约定（P1）', path: null };
  if (name === 'agents:root') return { text: 'AGENTS.md（仓库根）', path: null };
  if (name === 'agents') return { text: 'AGENTS.md', path: null };
  if (name.startsWith('agents:nearby:')) {
    return { text: '近端 AGENTS', path: name.slice('agents:nearby:'.length) };
  }
  if (name.startsWith('skill:')) return { text: '技能', path: name.slice('skill:'.length) };
  return { text: name, path: null };
}

export type PromptLayersPreviewProps = {
  kind: PromptKind;
  stage: boolean;
  /** 服务端逐层实测；`null` = 这个服务端/mock 还没给（退回 `stats` 聚合）。 */
  layers: readonly PromptLayerView[] | null;
  stats: PromptAssemblyStats;
  budget: PromptBudget;
  /** 还能存多少字符（阶段 kind = `limit − 当前`，project = 预算可用额度）。 */
  availableChars: number;
  limit: number;
  /** 当前**草稿**已超限（保存会被拒）：这时按运行期丢弃顺序给预测。 */
  overLimit: boolean;
  testId?: string;
};

export function PromptLayersPreview({
  kind,
  stage,
  layers,
  stats,
  budget,
  availableChars,
  limit,
  overLimit,
  testId = 'prompt-layers',
}: PromptLayersPreviewProps) {
  const fallback = layers === null || layers.length === 0;
  const rows: readonly RowSource[] = fallback
    ? [
        { name: 'head', chars: stats.baseChars, droppable: false, dropped: false },
        { name: 'project', chars: stats.promptChars, droppable: true, dropped: stats.truncated.includes('project') },
        {
          name: 'agents:root',
          chars: stats.agentsChars,
          droppable: true,
          dropped: stats.truncated.some((name) => name === 'root' || name.startsWith('nearby:')),
        },
        {
          name: 'skill:*',
          chars: stats.skillChars,
          droppable: true,
          dropped: stats.truncated.some((name) => name.startsWith('skill:')),
        },
      ]
    : layers;

  const dropped = rows.filter((row) => row.dropped);
  // 草稿超限但服务端还没丢过东西：按固定顺序给预测（不假装已经丢了）
  const prediction = overLimit && dropped.length === 0 ? DROP_ORDER : [];

  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col gap-1 rounded-md border px-2.5 py-2',
        overLimit || dropped.length > 0 ? 'border-warn/40 bg-warn-bg' : 'border-border bg-muted/40',
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <span className="text-2xs text-faint">层序（装配顺序，自上而下）</span>
        <span className="tabular text-xs text-foreground" data-testid={`${testId}-available`}>
          可用 {formatCount(Math.max(0, availableChars))} 字符
        </span>
      </div>

      <ul className="flex flex-col">
        {rows.map((row) => {
          const label = layerLabel(row.name, stage);
          return (
            <li
              key={row.name}
              data-testid={`${testId}-layer-${row.name}`}
              data-droppable={row.droppable ? 'true' : 'false'}
              data-dropped={row.dropped ? 'true' : 'false'}
              className={cn(
                'flex min-w-0 items-baseline gap-2 border-l-2 py-0.5 pl-1.5',
                // 不可丢（head / tail）：实心左条 = 视觉上钉住
                row.droppable ? 'border-l-border' : 'border-l-foreground/45',
                row.dropped && 'opacity-70',
              )}
            >
              <span className={cn('shrink-0 text-xs', row.dropped ? 'text-danger-fg line-through' : 'text-foreground')}>
                {label.text}
              </span>
              {label.path === null ? null : (
                <span className="min-w-0 truncate font-mono text-2xs text-faint" title={label.path}>
                  {label.path}
                </span>
              )}
              <span className="ml-auto shrink-0 tabular text-2xs text-muted-foreground">{formatCount(row.chars)}</span>
              <span className="w-10 shrink-0 text-right text-2xs text-faint">{row.droppable ? '可丢' : '不可丢'}</span>
              {row.dropped ? (
                <Badge tone="danger" className="shrink-0">
                  已丢弃
                </Badge>
              ) : null}
            </li>
          );
        })}
      </ul>

      {fallback ? (
        <p
          className="text-2xs text-faint"
          title="服务端没给逐层明细（layers）：这里按装配统计汇总，逐条 AGENTS 与技能看不到名字"
        >
          按装配统计汇总（无逐层明细）
        </p>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-0.5">
        {dropped.length > 0 ? (
          <p className="text-2xs text-danger-fg" data-testid={`${testId}-discarded`}>
            已丢弃：{dropped.map((row) => layerLabel(row.name, stage).text).join(' / ')}（预算{' '}
            {formatCount(budget.budgetChars)} 字符）
          </p>
        ) : null}
        {prediction.length > 0 ? (
          <p
            className="text-2xs text-warn-fg"
            data-testid={`${testId}-discarded`}
            title="运行期按「就近 AGENTS → P1 → 技能 → 根 AGENTS」整段丢弃；head 与输出契约永不丢"
          >
            超出可用额度，运行期将丢弃：{prediction.join(' / ')}（可用 {formatCount(Math.max(0, availableChars))}{' '}
            字符）
          </p>
        ) : null}
      </div>

      <p className="text-2xs leading-relaxed text-muted-foreground">
        总预算 {formatCount(budget.budgetChars)} · 其它层 {formatCount(budget.otherLayersChars)} · 口径{' '}
        {budget.source === 'last-assembly' ? '上一次真实装配' : '保守估算'} · 本层上限 {formatCount(limit)}
      </p>

      {kind === 'agent' ? (
        <p className="text-2xs text-info-fg" data-testid={`${testId}-agent-budget`}>
          计入 baseChars：{formatCount(stats.baseChars)} 字符 → P1 可存 {formatCount(Math.max(0, budget.available))}{' '}
          字符
        </p>
      ) : null}
    </div>
  );
}

/** `layers` 与兜底聚合的共同形状（兜底那几条是构造出来的，字段与 `AssembleStageLayer` 对齐）。 */
type RowSource = {
  name: string;
  chars: number;
  dropped: boolean;
  droppable: boolean;
};
