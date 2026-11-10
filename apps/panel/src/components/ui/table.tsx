import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 表格骨架（`DataTable` 与页面直接使用时都走这里）。
 *
 * 密度：表头/单元格高度锁 32px（`h-8`），单元格左右内边距 8px —— 一屏能看到更多行，
 * 行高不随内容跳动（`align-middle` + `whitespace-nowrap` 只在必要列上加）。
 *
 * 窄屏：外层永久 `overflow-x-auto`；需要「首列吸顶」时给 `Table` 传 `stickyFirst`
 * （首列 `position: sticky` + 与面同色底，横向滚动时行标识不会跑掉）。
 */
export type TableProps = HTMLAttributes<HTMLTableElement> & {
  /** 横向滚动时固定第一列（列表页在 <1024px 宽度下建议开启）。 */
  stickyFirst?: boolean;
};

export function Table({ className, stickyFirst = false, ...props }: TableProps) {
  return (
    <div className="w-full min-w-0 overflow-x-auto" data-sticky-first={stickyFirst ? '' : undefined}>
      <table
        className={cn(
          'w-full min-w-full caption-bottom border-collapse text-sm tabular',
          stickyFirst &&
            '[&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-10 [&_th:first-child]:bg-card [&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:bg-card',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('border-b border-border [&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors duration-[120ms] hover:bg-muted/60',
        'data-[state=selected]:bg-brand-soft',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-8 px-2 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-8 px-2 align-middle', className)} {...props} />;
}

export function TableCaption({ className, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn('mt-1.5 text-xs text-muted-foreground', className)} {...props} />;
}