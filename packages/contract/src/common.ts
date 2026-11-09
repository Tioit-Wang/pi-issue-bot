/**
 * 全局标量约定（B3 契约冻结）。
 *
 * 这些约定是**语义**约定，不只是类型：
 * - 时间：ISO8601 UTC，字符串结尾必须是 `Z`（面板只追加相对时间，不做时区换算）
 * - 金额：USD，保留 4 位小数（`0.0412`）
 * - token / 耗时 / 计数：整数，不带单位后缀
 * - 耗时：毫秒（字段名带 `Ms` 后缀）
 * - 比例：0–1 的浮点数（字段名带 `Rate` 后缀），**不乘 100**
 * - `null` 与 `0` 必须可区分：`null` = 「没有这个值」（例如队列里没有任务时的 p95），
 *   `0` = 「值是 0」（例如跑了但没花钱的成本）。因此所有可缺字段用 `.nullable()`，不用可选字段
 * - 分页：游标式，响应必给 `nextCursor`（末页为 `null`）+ `hasMore`
 */
import { z } from 'zod';

/** ISO8601 UTC 时间。注意 zod 会把「带日期校验的正则」一并生成进 JSON Schema，这是有意的。 */
export const isoDateTimeSchema = z.iso.datetime();

/** ISO 日期（`YYYY-MM-DD`），用于按天聚合的键。 */
export const isoDateSchema = z.iso.date();

/** USD 金额，保留 4 位小数。不用 `multipleOf` 卡精度：`0.1 + 0.2` 这类浮点会让合法值被拒。 */
export const usdAmountSchema = z.number().min(0);

/** 比例 0–1。分母为 0 时用 `null`，不用 `0`。 */
export const ratioSchema = z.number().min(0).max(1);

/** 整数计数（token 数、任务数、事件数）。 */
export const countSchema = z.number().int().min(0);

/** 耗时毫秒（整数）。 */
export const durationMsSchema = z.number().int().min(0);

/** 提交 sha：允许短 sha（≥7）与完整 40 位。 */
export const gitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/);

/** `owner/name` */
export const repoFullNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

/** 短 id（任务 / run / 动作行）。`cuid2` 长度不超过 32，这里取宽松上限。 */
export const shortIdSchema = z.string().min(1).max(64);

/** GitHub 标签名：1–50 字符，禁止控制字符（`\p{Cc}`，允许中文与空格；R4 说沿用仓库现有标签）。 */
export const labelNameSchema = z.string().min(1).max(50).regex(/^[^\p{Cc}]+$/u);

/** GitHub 登录名。 */
export const loginSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);

/** run_events.cursor：单调递增整数（游标重放的基准）。 */
export const eventCursorSchema = z.number().int().min(0);

/** 面板 API 错误体。所有 4xx/5xx 都返回这个形状，没有第二种。 */
export const errorBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          'bad-request',
          'unauthorized',
          'forbidden',
          'not-found',
          'conflict',
          'payload-too-large',
          'unprocessable',
          'internal',
          'unavailable',
        ]),
        /** 面向人的一句话，可含中文；不得包含密钥（日志脱敏同样适用）。 */
        message: z.string().min(1).max(500),
        /** 结构化补充（例如 zod 的字段错误列表）。键名稳定，面板可展示。 */
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict()
  .meta({ id: 'ErrorBody' });
export type ErrorBody = z.infer<typeof errorBodySchema>;

/**
 * 游标分页的公共响应字段。
 * 游标是不透明字符串（服务端编码「排序键 + id」），客户端只许回传，不许解析。
 */
export const pageInfoShape = {
  /** 下一页游标；`null` = 没有下一页。 */
  nextCursor: z.string().max(512).nullable(),
  /** 是否还有下一页（与 `nextCursor !== null` 等价，冗余是为了让面板少写一次判断）。 */
  hasMore: z.boolean(),
} as const;

/** 每页条数：默认 50，上限 200（面板一次最多 200 行）。 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** 查询参数里的 `limit`（HTTP 里是字符串，故用 coerce）。 */
export const pageLimitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT);

/** 查询参数里的 `cursor`（不透明字符串）。空串由服务端当作缺省处理，故此处只限长度。 */
export const pageCursorSchema = z.string().max(512).optional();

/** 所有只读接口的公共时间范围参数。`from`/`to` 缺省由服务端补默认窗口（最近 24h）。 */
export const timeRangeShape = {
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
} as const;

/** 时间戳包装（响应体里的 `generatedAt`）。 */
export function timestamped<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({
      generatedAt: isoDateTimeSchema,
      ...shape,
    })
    .strict();
}
