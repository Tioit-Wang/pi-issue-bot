import { http, HttpResponse, type HttpHandler } from 'msw';
import type { TaskListItem, TasksResponse } from '../../lib/contract.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 任务列表（S2）的拦截器 —— W3-K 只改这一个文件。
 *
 * 契约：`GET /api/tasks`（`TasksResponse`，docs/spec/contract-api.md §2）。
 *
 * 三条口径（与契约逐字对齐，别在页面里补）：
 *  1. **游标分页**：`limit` 默认 50、上限 200；`cursor` 对客户端不透明，这里用 `o:<偏移>` 编码，
 *     只回传不解释。末页 `nextCursor: null` + `hasMore: false`。
 *  2. **筛选**：`repo` / `status` / `failureClass` / `command` / `from` / `to` 全部由服务端做（页面只传参），
 *     所以「切筛选 = 换一次请求」这件事可以被测试直接观测到。
 *  3. **数据集锚在「请求时刻」**：`tasksFixture`（fixtures.ts）用的是固定的 `MOCK_NOW`，
 *     时间范围筛选在真实时钟下会永远筛出空结果，演示不了「最近 24 小时」。
 *     这里按请求时刻往前铺 130 条（每 20 分钟一条 ≈ 43 小时），`?from/&to` 才有意义。
 *
 * 非法参数按契约返回 400 `bad-request` / 422 `unprocessable`，不静默兜底：
 * mock 也要让页面的错误分支有路可走。
 */
const MINUTE_MS = 60_000;

/** 契约 §0：`limit` 默认 50、上限 200。 */
export const TASKS_DEFAULT_LIMIT = 50;
const TASKS_MAX_LIMIT = 200;

/** 游标前缀（与偏移编码一起构成「不透明」字符串）。 */
const CURSOR_PREFIX = 'o:';

/** 数据集规模：130 条 × 50/页 → 三页，足够覆盖「加载更多」与末页两种分支。 */
const DATASET_SIZE = 130;
const STEP_MS = 20 * MINUTE_MS;

type Template = {
  command: string;
  source: TaskListItem['source'];
  targetKind: TaskListItem['targetKind'];
};

/** 契约 §2 的三个命令取值（`/review-pr`、`auto:triage`、`auto:compliance`）。 */
const TEMPLATES: readonly Template[] = [
  { command: '/review-pr', source: 'command', targetKind: 'pr' },
  { command: 'auto:triage', source: 'webhook', targetKind: 'issue' },
  { command: 'auto:compliance', source: 'cron', targetKind: 'issue' },
];

const REPOS = ['acme/widgets', 'other/lib'] as const;
const ACTORS = ['alice', 'bob', 'carol', 'dana'] as const;

/** 失败分类取值 = 契约 §1 `failureTop` 的枚举（十个）。 */
export const FAILURE_CLASSES = [
  'timeout',
  'interrupt',
  'degenerate-output',
  'sandbox-oom',
  'sandbox-crash',
  'auth',
  'rate-limit',
  'model',
  'parse',
  'github-api',
] as const;

/**
 * 请求参数不合法（mock 侧替服务端说话）。
 *
 * 用异常而不是返回 `null`：调用点在 `buildTasksResponse` 内部有多处校验，
 * 异常能让「哪里不合法」只写一次，handler 里统一翻译成契约错误体。
 */
export class MockRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MockRequestError';
    this.status = status;
    this.code = code;
  }
}

/** 取模取值：`noUncheckedIndexedAccess` 下索引访问是 `T | undefined`，这里收敛成 `T`。 */
function pick<T>(list: readonly T[], index: number): T {
  const value = list[index % list.length];
  if (value === undefined) throw new Error('mock 列表不应为空');
  return value;
}

/** 确定性伪 sha（同一 index 永远同值，测试可断言）。 */
function pseudoSha(index: number): string {
  const head = (index * 2_654_435_761).toString(16).padStart(8, '0');
  const tail = (index * 40_503).toString(16).padStart(4, '0');
  return `${head}${tail}`.slice(0, 12);
}

function statusFor(index: number): TaskListItem['status'] {
  if (index % 17 === 16) return 'cancelled';
  if (index % 11 === 10) return 'running';
  if (index % 13 === 12) return 'queued';
  if (index % 7 === 6) return 'failed';
  return 'succeeded';
}

function buildTask(index: number, now: number): TaskListItem {
  const template = pick(TEMPLATES, index);
  const status = statusFor(index);
  const queuedAt = now - index * STEP_MS;
  const startedAt = status === 'queued' ? null : queuedAt + 4_000;
  // 只有跑完的才有耗时/成本（契约：未结束为 null，0 才是「免费」）
  const durationMs = status === 'succeeded' || status === 'failed' ? (3 + (index % 9)) * MINUTE_MS : null;
  const endedAt = startedAt === null || durationMs === null ? null : startedAt + durationMs;
  const failureClass = status === 'failed' ? pick(FAILURE_CLASSES, index) : null;
  const outcome =
    status === 'succeeded'
      ? 'success'
      : status === 'failed'
        ? index % 3 === 0
          ? 'timed-out'
          : 'failed'
        : status === 'cancelled'
          ? 'interrupted'
          : null;
  const costUsd = endedAt === null ? null : Number(((index % 23) * 0.0037).toFixed(4));

  return {
    id: `t-mock-${String(index + 1)}`,
    repo: pick(REPOS, index),
    source: template.source,
    command: template.command,
    targetKind: template.targetKind,
    targetNumber: 10 + index,
    headSha: template.targetKind === 'pr' ? pseudoSha(index) : null,
    status,
    failureClass,
    outcome,
    actorLogin: template.source === 'cron' ? null : pick(ACTORS, index),
    queuedAt: new Date(queuedAt).toISOString(),
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
    durationMs,
    costUsd,
    dryRun: index % 5 === 4,
  };
}

/** 完整数据集（按时间倒序）。导出给测试复用，页面不要 import 它。 */
export function buildTaskDataset(now: number = Date.now()): TaskListItem[] {
  return Array.from({ length: DATASET_SIZE }, (_, index) => buildTask(index, now));
}

function readLimit(raw: string | null): number {
  if (raw === null || raw === '') return TASKS_DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > TASKS_MAX_LIMIT) {
    throw new MockRequestError(400, 'bad-request', `limit 必须是 1–${String(TASKS_MAX_LIMIT)} 的整数`);
  }
  return value;
}

/** 游标解码：`o:<偏移>`；空 → 第一页；其它形态一律 400（契约：cursor 不透明，客户端不得自造）。 */
function readCursor(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  if (!raw.startsWith(CURSOR_PREFIX)) {
    throw new MockRequestError(400, 'bad-request', 'cursor 不合法');
  }
  const offset = Number(raw.slice(CURSOR_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MockRequestError(400, 'bad-request', 'cursor 不合法');
  }
  return offset;
}

/** `from` / `to`：必须能被 `Date.parse` 读懂；`from > to` 按契约是 422 而不是 400。 */
function readTimeRange(params: URLSearchParams): { from: number | null; to: number | null } {
  const parse = (key: 'from' | 'to'): number | null => {
    const raw = params.get(key);
    if (raw === null || raw === '') return null;
    const value = Date.parse(raw);
    if (Number.isNaN(value)) throw new MockRequestError(400, 'bad-request', `${key} 不是合法时间`);
    return value;
  };
  const from = parse('from');
  const to = parse('to');
  if (from !== null && to !== null && from > to) {
    throw new MockRequestError(422, 'unprocessable', 'from 不能晚于 to');
  }
  return { from, to };
}

function filterTasks(items: readonly TaskListItem[], params: URLSearchParams): TaskListItem[] {
  const repo = params.get('repo');
  const status = params.get('status');
  const failureClass = params.get('failureClass');
  const command = params.get('command');
  const { from, to } = readTimeRange(params);

  return items.filter((item) => {
    if (repo !== null && repo !== '' && item.repo !== repo) return false;
    if (status !== null && status !== '' && item.status !== status) return false;
    if (failureClass !== null && failureClass !== '' && item.failureClass !== failureClass) return false;
    if (command !== null && command !== '' && item.command !== command) return false;
    const queuedAt = Date.parse(item.queuedAt);
    if (from !== null && queuedAt < from) return false;
    if (to !== null && queuedAt > to) return false;
    return true;
  });
}

/** 纯函数：查询串 → `TasksResponse`（handler 与测试共用同一份实现）。 */
export function buildTasksResponse(search: string, now: number = Date.now()): TasksResponse {
  const params = new URLSearchParams(search);
  const filtered = filterTasks(buildTaskDataset(now), params);
  const offset = readCursor(params.get('cursor'));
  const limit = readLimit(params.get('limit'));
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < filtered.length;

  return {
    items: page,
    nextCursor: hasMore ? `${CURSOR_PREFIX}${String(nextOffset)}` : null,
    hasMore,
    totalEstimate: filtered.length,
  };
}

/** `?mock=empty` 用的空响应（不是「筛不出结果」，是「库里有 0 条」）。 */
export function buildEmptyTasksResponse(): TasksResponse {
  return { items: [], nextCursor: null, hasMore: false, totalEstimate: 0 };
}

export const tasksHandlers: HttpHandler[] = [
  http.get('/api/tasks', ({ request }) => {
    const search = new URL(request.url).search;
    let data: TasksResponse;
    try {
      data = buildTasksResponse(search);
    } catch (error) {
      if (error instanceof MockRequestError) {
        return HttpResponse.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      }
      throw error;
    }
    return scenarioResponse({ data, empty: buildEmptyTasksResponse() });
  }),
];
