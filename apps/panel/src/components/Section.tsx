import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

/**
 * 分区（`Section`）：页面主体的**默认骨架**。
 *
 * 一个分区 = 标题行（标题 + 可选计数 + 可选说明 + 右侧动作）+ 内容，分区之间靠 hairline 分隔，
 * **不套卡片**。为什么：这个控制台日常高频使用，卡片套卡片会让「哪一层是容器」
 * 变得毫无意义，还白吃 16px 边距；连续分区让标题成为扫描锚点。
 *
 * 间距：分区之间 24px、标题与内容 8px、内容内部 16px —— 三级足够，不要自创。
 */
export type SectionProps = {
  title: ReactNode;
  /**
   * 标题右侧的计数：紧贴标题渲染成 `标题 (17)`，**不**跳到右侧动作区。
   * 为什么：计数描述的是标题本身（多少条待办），放到 400px 外就变成另一个控件了。
   */
  count?: number;
  /** 一句话说明：这一区在看什么、口径是什么。 */
  description?: ReactNode;
  /** 标题行右侧：过滤、计数、次要动作。 */
  actions?: ReactNode;
  /** 内容下方的脚注（口径、数据来源）。 */
  footnote?: ReactNode;
  /** 第一个分区不要上边线（否则与页面标题挤在一起）。 */
  first?: boolean;
  className?: string;
  children: ReactNode;
};

export function Section({
  title,
  count,
  description,
  actions,
  footnote,
  first = false,
  className,
  children,
}: SectionProps) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-2 pt-4',
        first ? 'pt-0' : 'border-t border-border',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="flex min-w-0 items-baseline text-base font-semibold tracking-tight text-foreground">
            <span className="min-w-0">{title}</span>
            {count === undefined ? null : (
              <span
                data-testid="section-count"
                className="ml-1 shrink-0 text-sm font-normal tabular text-faint"
              >
                {`(${String(count)})`}
              </span>
            )}
          </h2>
          {description === undefined ? null : (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>

      <div className="min-w-0">{children}</div>

      {footnote === undefined ? null : (
        <p className="text-2xs leading-relaxed text-faint">{footnote}</p>
      )}
    </section>
  );
}
