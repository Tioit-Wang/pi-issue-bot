/**
 * V20 的**审计口径**（`docs/test-plan-fixed-pipeline.md` §6.2 P2-4 / `docs/plan-fixed-pipeline.md`
 * §1.7 Q7 / §12 V20）。
 *
 * 管理员指令是唯一能手动改流水线状态的入口，所以「谁在什么时候推了哪一步」必须留痕。
 * 实现选了不新建审计表（`http/webhook.ts::runDirective`）：三条既有通道各留一份 ——
 *
 * ```
 * webhook_deliveries  1 行（这条评论的投递，按 deliveryId 可回放）
 * tasks               1 行（指令触发的阶段任务）
 * 日志                1 条带 directive=<指令原文> 的记录
 * ```
 *
 * 现有用例只断言了 `tasks` 一行，另外两条没测；这里把三条一起钉住，
 * 并补一条**反面**：非 managers 调用 → 0 任务、0 状态变化、1 行投递、0 条 `directive=` 日志
 * （被拒的指令只打 eyes，不执行也不回复）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Logger, LogBindings, LogMethod } from '../../../packages/shared/src/index.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import { handleWebhook } from '../src/http/index.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson, vocabularyWithRoles } from './helpers/repo-settings.ts';

const REPO = 'acme/audit';
const ISSUE = 77;
const AT = new Date('2026-06-01T12:00:00.000Z');
const MANAGER = 'alice';
const OUTSIDER = 'bob';

/** 合法配置：`managers` 里只有 `alice`，词表按 role 各一条（`repoSettingsSchema` 的两条硬约束）。 */
const SETTINGS = {
  pipeline: { managers: [MANAGER] },
  labels: { vocabulary: vocabularyWithRoles([{ name: '需求' }, { name: '缺陷' }]) },
  // 指令**不进命令门禁**（§16.1 第 3 条）：关掉命令也不影响这条用例
  commands: { enabled: false },
};

/* ── 可注入的假 logger（收集「带 directive= 的记录」）──────────────────────── */

interface LogRecord {
  readonly level: string;
  readonly fields: LogBindings;
  readonly message: string | undefined;
}

function createCollectingLogger(records: LogRecord[]): Logger {
  const method =
    (level: string): LogMethod =>
    (fields, message) => {
      records.push({
        level,
        fields: typeof fields === 'string' ? { msg: fields } : fields,
        message,
      });
    };
  const logger: Logger = {
    level: 'debug',
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    child: () => logger,
  };
  return logger;
}

/** 带 `directive=` 字段的日志（= 指令执行留下的审计记录）。 */
const auditRecords = (records: readonly LogRecord[]): LogRecord[] =>
  records.filter((record) => record.fields['directive'] !== undefined);

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(AT);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table tasks, webhook_deliveries, repos, issue_pipeline cascade');
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, validSettingsJson(SETTINGS)],
  );
});

type Harness = {
  readonly deps: WebhookDeps;
  readonly logs: LogRecord[];
  readonly sends: Array<Record<string, unknown>>;
  readonly eyes: Array<Record<string, unknown>>;
};

function harness(): Harness {
  const logs: LogRecord[] = [];
  const sends: Array<Record<string, unknown>> = [];
  const eyes: Array<Record<string, unknown>> = [];
  const ack: WebhookAck = {
    addEyesReaction: async (input) => {
      eyes.push({ ...input });
    },
  };
  return {
    logs,
    sends,
    eyes,
    deps: {
      verify: async (input) => input.signature === 'good-signature',
      db: db.pool,
      enqueue: async (data) => {
        sends.push({ ...data });
        return 'job-1';
      },
      ack,
      logger: createCollectingLogger(logs),
      now: () => AT,
    },
  };
}

function directivePayload(input: {
  readonly login: string;
  readonly association: string;
  readonly body: string;
  readonly commentId: number;
}): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: input.login, type: 'User' },
    issue: {
      number: ISSUE,
      title: '登录时报 500',
      body: '复现步骤：……',
      user: { login: 'author' },
      author_association: 'OWNER',
      updated_at: '2026-05-31T00:00:00Z',
    },
    comment: {
      id: input.commentId,
      body: input.body,
      author_association: input.association,
      user: { login: input.login, type: 'User' },
    },
  };
}

async function deliver(h: Harness, input: {
  readonly deliveryId: string;
  readonly payload: Record<string, unknown>;
}) {
  return handleWebhook(h.deps, {
    deliveryId: input.deliveryId,
    event: 'issue_comment',
    rawBody: JSON.stringify(input.payload),
    signature: 'good-signature',
    source: 'live',
  });
}

/** `format/awaiting_info`：等作者补信息的行（V20 的第一行判据就在这里起步）。 */
async function seedAwaitingInfo(): Promise<void> {
  await ensurePipeline(
    db.pool,
    { repo: REPO, issueNumber: ISSUE },
    { stage: 'format', state: 'awaiting_info', issueVersion: 'v1', infoRequestedAt: AT },
  );
}

async function taskRows(): Promise<Array<Record<string, unknown>>> {
  return db.sql(`select command, source, actor_login from tasks order by queued_at, command`);
}

async function deliveryRows(): Promise<Array<Record<string, unknown>>> {
  return db.sql('select delivery_id, event, action from webhook_deliveries order by received_at');
}

describe('V20：管理员指令的审计（投递行 + 任务行 + directive= 日志）', () => {
  it('format/awaiting_info + managers 的 /pipeline next → classify/pending、1 行分类任务、1 行投递、1 条 directive= 日志', async () => {
    await seedAwaitingInfo();
    const h = harness();

    const result = await deliver(h, {
      deliveryId: 'd-v20-next',
      payload: directivePayload({
        login: MANAGER,
        association: 'MEMBER',
        body: '@pi-bot /pipeline next',
        commentId: 5_001,
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'enqueued' });

    // ① 状态推进：format → classify，仍是 pending（等分类任务跑）
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
    expect(row).toMatchObject({ stage: 'classify', state: 'pending' });
    // 指令路径不动 `info_requested_at` 之外的东西：这里确认它没被顺手写成 now（等的是分类，不是作者）
    expect(row?.infoRequestedAt).toBeNull();

    // ② 任务行：恰好 1 行 pipeline:classify，且真的入了队
    const tasks = await taskRows();
    expect(tasks).toEqual([{ command: 'pipeline:classify', source: 'pipeline', actor_login: MANAGER }]);
    expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:classify']);

    // ③ 投递行：恰好 1 行，且就是这个 deliveryId（回放/对账都靠它）
    const deliveries = await deliveryRows();
    expect(deliveries).toEqual([
      { delivery_id: 'd-v20-next', event: 'issue_comment', action: 'created' },
    ]);

    // ④ ★ 审计日志：恰好 1 条带 directive= 的记录，字段齐全
    const audits = auditRecords(h.logs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      level: 'info',
      fields: {
        repo: REPO,
        issue: ISSUE,
        directive: '/pipeline next',
        stage: 'classify',
        state: 'pending',
      },
    });
    expect(audits[0]?.message).toContain('管理员指令已执行');

    // 执行成功也打一次 eyes（这条评论被处理了；回执形式只有 reaction，见 §0.4）
    expect(h.eyes).toHaveLength(1);
    expect(h.eyes[0]).toMatchObject({ repo: REPO, issueNumber: ISSUE, commentId: 5_001 });
  }, 60_000);

  it('非 managers 的 /pipeline next → 0 任务、0 状态变化、1 行投递、0 条 directive= 日志', async () => {
    await seedAwaitingInfo();
    const h = harness();

    const result = await deliver(h, {
      deliveryId: 'd-v20-outsider',
      payload: directivePayload({
        login: OUTSIDER,
        association: 'MEMBER',
        body: '@pi-bot /pipeline next',
        commentId: 5_002,
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'ignored' });

    // 状态一点不动（被拒的指令不许有任何副作用）
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });
    expect(row).toMatchObject({ stage: 'format', state: 'awaiting_info' });
    expect(await taskRows()).toEqual([]);
    expect(h.sends).toEqual([]);

    // 投递行照记（审计的下限：这条评论确实来过）
    const deliveries = await deliveryRows();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.['delivery_id']).toBe('d-v20-outsider');

    // 没有「已执行」的审计记录，只有一条带原因的 info
    expect(auditRecords(h.logs)).toEqual([]);
    const rejected = h.logs.filter((record) => record.fields['reason'] === 'not-manager');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.message).toContain('管理员指令未执行');
    // 被拒也只打 eyes，不回复（§1.7 Q7）
    expect(h.eyes).toHaveLength(1);
    expect(h.eyes[0]).toMatchObject({ repo: REPO, issueNumber: ISSUE, commentId: 5_002 });
  }, 60_000);
});
