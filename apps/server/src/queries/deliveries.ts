/**
 * `GET /api/repos/{owner}/{name}/deliveries` —— 一次投递的**判定留痕**（BR-6 / FR-6.4③）。
 *
 * 需求原话（`docs/requirements.html:1791` BR-6）：「不触发也留痕：未通过开关或闸门的事件，必须
 * 记录判定结果与原因，**可在后台查询**」；`:1216` FR-6.4③ 的事件时间线要求「被忽略的事件也能
 * 看到原因」。写入侧早已完整（`http/webhook-v21.ts::writeV21Decision` 对触发与未触发都写
 * `decision` / `decision_reason`），缺的正是这一侧的**读**：没有它，「留痕」只是存储，不构成
 * 「可查询」。
 *
 * 三条实现口径：
 *  1. **只读**：本文件只有 `select`（`queries/` 的硬约束）。
 *  2. **`decision` 只映射契约取值**：库里理论上只会有 `triggered` / `ignored`，但契约外的字符串
 *     会整页 `parse()` 失败，所以用 `case` 收敛——契约外一律当 `null`（= 还没判定），
 *     宁可显示「未判定」，也不让留痕接口自己打不开。
 *  3. **`decisionReason` 原样返回**（不在这里做白名单）：它是排查的**现场**，映射不到就说明有新原因，
 *     正是要看的东西；契约侧也刻意用字符串接收（见 `packages/contract/src/api.ts` 的说明）。
 *
 * 分页：`received_at` 倒序 + `delivery_id` 倒序的 keyset（`sql.ts` 的游标语义，不用 offset：
 * 投递是实时写入的，offset 会漏行/重行）。
 */
import {
  Params,
  decodeCursor,
  encodeCursor,
  isoOf,
  stringOrNull,
  type SqlRunner,
} from './sql.ts';
import type { DeliveriesQuery, DeliveriesResponse, DeliveryRow } from './types.ts';

/** 路径里的仓库（`owner/name` 两段拼好；路由侧已按 `repoParamsSchema` 校验过格式）。 */
export type DeliveriesParams = {
  readonly repo: string;
};

/** 契约字段的长度上限（与 `deliveryRowSchema` 的 `max` 对齐，超出截断而不是整页 500）。 */
const DELIVERY_ID_CHARS = 128;
const EVENT_CHARS = 64;
const ACTION_CHARS = 64;
const REASON_CHARS = 64;
const REPO_CHARS = 200;

type DeliveryRowRaw = {
  delivery_id: string;
  event: string;
  action: string | null;
  repo: string | null;
  received_at: Date;
  decision: 'triggered' | 'ignored' | null;
  decision_reason: string | null;
  signature_valid: boolean | null;
};

/**
 * 判定结论：契约外取值收敛成 `NULL`。
 * 为什么要 `case` 而不是直接取列：`decision` 是 `text`（`db/schema.ts:112`），没有 CHECK 约束，
 * 一次手工修库或未来的新取值就会让 `DeliveriesResponse.parse()` 整页失败。
 */
const DECISION_SQL = `case when w.decision in ('triggered', 'ignored') then w.decision end`;

function toDeliveryRow(raw: DeliveryRowRaw): DeliveryRow {
  const reason = stringOrNull(raw.decision_reason, REASON_CHARS);
  return {
    deliveryId: raw.delivery_id.slice(0, DELIVERY_ID_CHARS),
    event: raw.event.slice(0, EVENT_CHARS),
    action: stringOrNull(raw.action, ACTION_CHARS),
    repo: stringOrNull(raw.repo, REPO_CHARS),
    receivedAt: isoOf(raw.received_at, new Date(0).toISOString()),
    decision: raw.decision,
    decisionReason: reason,
    // `signature_valid` 有 `not null default true`，理论上不会是 null；兜底成 true 是保守选择：
    // 显示「验签通过」比让一行历史数据把整个列表打成 500 划算。
    signatureValid: raw.signature_valid ?? true,
  };
}

/**
 * 按仓库 + 时间窗分页查投递及其判定结果。
 *
 * 时间窗语义与其它只读接口一致（`resolveWindow`：默认最近 24h，`from > to` 抛 422）；
 * `decision=pending` 表示「还没判定」（`decision is null`），与 `ignored` 严格区分。
 */
export async function queryDeliveries(
  runner: SqlRunner,
  params: DeliveriesParams,
  query: DeliveriesQuery,
  window: { from: string; to: string },
): Promise<DeliveriesResponse> {
  const limit = Math.min(query.limit ?? 50, 200);
  const values = new Params();
  const where = [
    `w.repo = ${values.add(params.repo)}`,
    `w.received_at >= ${values.add(window.from, 'timestamptz')}`,
    `w.received_at < ${values.add(window.to, 'timestamptz')}`,
  ];
  if (query.event !== undefined) {
    where.push(`w.event = ${values.add(query.event)}`);
  }
  // 必须复用同一个 `case`，不能写裸列 `w.decision is null`：否则契约外取值（手工修库写进来的
  // `error` 之类）在响应里显示成「未判定」，却在 pending / triggered / ignored 三种筛选下一个都
  // 查不到 —— 屏幕上有一行、任何条件都定位不到它。判定口径只能有一处，否则早晚分叉。
  if (query.decision === 'pending') {
    where.push(`${DECISION_SQL} is null`);
  } else if (query.decision !== undefined) {
    where.push(`${DECISION_SQL} = ${values.add(query.decision)}`);
  }

  const cursor = decodeCursor(query.cursor);
  if (cursor !== null) {
    where.push(
      `(w.received_at < ${values.add(cursor.at, 'timestamptz')}` +
        ` or (w.received_at = ${values.add(cursor.at, 'timestamptz')}` +
        ` and w.delivery_id < ${values.add(cursor.id)}))`,
    );
  }

  // 多取一条用于判断 hasMore（比 count(*) 便宜，也不会与实时写入的行数统计打架）
  const rows = (
    await runner.query(
      `select
  w.delivery_id,
  w.event,
  w.action,
  w.repo,
  w.received_at,
  ${DECISION_SQL} as decision,
  w.decision_reason,
  w.signature_valid
from webhook_deliveries w
where ${where.join('\n  and ')}
order by w.received_at desc, w.delivery_id desc
limit ${values.add(limit + 1, 'int')}`,
      values.list(),
    )
  ).rows as DeliveryRowRaw[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toDeliveryRow),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor(isoOf(last.received_at, ''), last.delivery_id)
        : null,
    hasMore,
  };
}
