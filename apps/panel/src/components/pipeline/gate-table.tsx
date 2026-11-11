import { Badge } from '../ui/badge.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.tsx';
import { GATE_ROWS } from './pipeline-constants.tsx';

/**
 * 门禁处置表（只读，`docs/plan-fixed-pipeline.md` §8 的七行，一行不多一行不少）。
 *
 * 列：**当前状态 | 收到 @ 的处置 | 为什么**。
 *  - 状态列用徽章 + 圆点（有 tone 的走低饱和底，`closed` / `ready` 走中性描边）；
 *  - 「为什么」用 `text-faint`：它是解释，不该和处置抢同一层视觉重量；
 *  - 表不套卡片、不填表头底色，行高走 `--row-height`（33px）。
 *  - 只读：门禁是代码判定，这里没有任何可编辑控件（也就不需要「保存」）。
 */
export function GateTable() {
  return (
    <Table className="min-w-[36rem] text-sm" data-testid="gate-table">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="w-[13rem]">
            当前状态
          </TableHead>
          <TableHead scope="col">收到 @ 的处置</TableHead>
          <TableHead scope="col" className="w-[16rem]">
            为什么
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {GATE_ROWS.map((row) => (
          <TableRow key={row.key} className="hover:bg-transparent" data-testid={`gate-row-${row.key}`}>
            <TableCell>
              {row.status.tone === undefined ? (
                <Badge variant="outline">{row.status.label}</Badge>
              ) : (
                <Badge tone={row.status.tone} dot>
                  {row.status.label}
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-xs text-foreground">{row.action}</TableCell>
            <TableCell className="text-xs text-faint">{row.reason}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
