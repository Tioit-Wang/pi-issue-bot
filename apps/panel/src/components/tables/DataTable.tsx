import { useTable, type CellData, type ColumnDef, type RowData } from '@tanstack/react-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { cn } from '../../lib/utils.ts';
import { panelTableFeatures } from './features.ts';

/**
 * 列定义驱动的通用表格（TanStack Table v9 + 内置空态/加载态）。
 *
 * 设计要点：
 * - **列定义在页面里**（`createColumnHelper<typeof panelTableFeatures, Row>()`），本组件只管渲染，
 *   这样每页的列可以独立演进，也不会把格式化逻辑塞进表格组件；
 * - 空态与加载态是**内建**的（tech-plan §9.4：不手写第二套），加载时保留表头，避免布局跳动；
 * - `getRowId` 让 React 的 key 稳定（任务列表的 id 是字符串，默认用行号会导致重排时整表重挂）。
 */
export type DataTableColumn<TData extends RowData> = ColumnDef<typeof panelTableFeatures, TData, CellData>;

export type DataTableProps<TData extends RowData> = {
  columns: ReadonlyArray<DataTableColumn<TData>>;
  data: TData[];
  /** 加载中：显示骨架行（默认 5 行）。 */
  loading?: boolean;
  loadingRows?: number;
  /** 空态文案。 */
  emptyText?: string;
  getRowId?: (row: TData, index: number) => string;
  onRowClick?: (row: TData) => void;
  className?: string;
  testId?: string;
};

export function DataTable<TData extends RowData>({
  columns,
  data,
  loading = false,
  loadingRows = 5,
  emptyText = '没有数据',
  getRowId,
  onRowClick,
  className,
  testId,
}: DataTableProps<TData>) {
  const table = useTable({
    features: panelTableFeatures,
    columns: columns as Array<ColumnDef<typeof panelTableFeatures, TData, CellData>>,
    data,
    ...(getRowId === undefined ? {} : { getRowId }),
  });

  const headerGroups = table.getHeaderGroups();
  const rows = table.getRowModel().rows;
  const columnCount = headerGroups[0]?.headers.length ?? columns.length;

  return (
    <div className={cn('rounded-lg border border-border bg-card', className)} data-testid={testId}>
      <Table>
        <TableHeader>
          {headerGroups.map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: loadingRows }, (_, index) => (
                <TableRow key={`skeleton-${String(index)}`}>
                  {Array.from({ length: columnCount }, (__, cellIndex) => (
                    <TableCell key={`skeleton-cell-${String(cellIndex)}`}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={onRowClick === undefined ? undefined : 'cursor-pointer'}
                  onClick={
                    onRowClick === undefined
                      ? undefined
                      : () => {
                          onRowClick(row.original);
                        }
                  }
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
          {!loading && rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="py-10 text-center text-sm text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
