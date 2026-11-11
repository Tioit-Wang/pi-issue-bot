/**
 * 端到端（真 PG）：**幂等重投**（dev-plan §6 的「同一 `X-GitHub-Delivery` POST 20 次」）。
 *
 * 两个幂等点都必须由**数据库唯一索引**兜住，而不是内存去重表：
 *  1. 投递级：`webhook_deliveries.delivery_id`（20 次 → 1 行）；
 *  2. 任务级：`tasks.idempotency_key`（换一个 delivery 再投同一个事件 → 仍然 1 个任务）。
 *
 * 第 2 条是「GitHub 因为超时重发、但 delivery id 变了」的真实场景 —— 只做投递级去重会漏。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import {
  E2E_WEBHOOK_SECRET,
  FakeRacpHost,
  createCountingGithubApi,
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  signBody,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import type { FakeQueue, FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const ATTEMPTS = 20;

function issuesOpenedPayload(): string {
  return JSON.stringify({
    action: 'opened',
    issue: { number: 11, updated_at: '2026-06-01T00:00:00.000Z', author_association: 'OWNER' },
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
  });
}

describe('e2e 幂等：同一投递 20 次 + 换投递同任务', () => {
  let db: TestDb;
  let app: Application;
  let host: FakeHost;
  let queue: FakeQueue;

  beforeAll(async () => {
    db = await openTestDb();
    await db.truncate();
    await db.sql(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
       values ($1, true, true, $2::jsonb, true)`,
      [REPO, validSettingsJson()],
    );

    host = await FakeRacpHost.start();
    queue = createFakeQueue();
    const github = createCountingGithubApi();
    const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });

    app = createApplication(e2eConfig(), {
      pool: poolWithNoopEnd(db.pool),
      queue,
      ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
      metrics: quietMetrics(),
      metricsServer: stubMetricsServer(),
      ack: {
        addEyesReaction: async () => undefined,
      },
    });
    await app.start();
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    await host?.close();
    await db?.close();
  }, 60_000);

  it(`同一 X-GitHub-Delivery 投 ${String(ATTEMPTS)} 次 → deliveries 1 行 · tasks 1 行 · send 1 次`, async () => {
    const body = issuesOpenedPayload();
    const signature = signBody(E2E_WEBHOOK_SECRET, body);
    const deliveryId = 'e2e-idempotent-fixed-delivery';
    const statuses: number[] = [];
    const actions: string[] = [];

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const response = await app.server.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': deliveryId,
          'x-github-event': 'issues',
          'x-hub-signature-256': signature,
        },
        payload: body,
      });
      statuses.push(response.statusCode);
      actions.push(response.json<{ action: string }>().action);
    }

    // GitHub 只看 2xx：重复投递一律 200（不是 409）
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(actions.filter((action) => action === 'enqueued')).toHaveLength(1);
    expect(actions.filter((action) => action === 'duplicate')).toHaveLength(ATTEMPTS - 1);

    const deliveries = await db.sql('select * from webhook_deliveries where delivery_id = $1', [
      deliveryId,
    ]);
    expect(deliveries).toHaveLength(1);

    const tasks = await db.sql('select * from tasks');
    expect(tasks).toHaveLength(1);

    // 入队只发生过一次（其余 19 次在第 4 步就返回了，没走到第 7 步）
    expect(queue.record.sent).toHaveLength(1);

    console.log(
      `[e2e-idempotent] posts=${String(ATTEMPTS)} deliveries=${String(deliveries.length)}` +
        ` tasks=${String(tasks.length)} bossSend=${String(queue.record.sent.length)}` +
        ` actions=${actions.filter((action) => action === 'duplicate').length}duplicate`,
    );
  }, 60_000);

  it('换 delivery 但同一 idempotency_key 再投 → tasks 仍 1 行、不入队', async () => {
    const body = issuesOpenedPayload();
    const response = await app.server.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'e2e-idempotent-other-delivery',
        'x-github-event': 'issues',
        'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const accepted = response.json<{ action: string; duplicate: boolean; taskId: string | null }>();
    expect(accepted.action).toBe('duplicate');
    expect(accepted.duplicate).toBe(true);
    // 幂等命中要能报出已有任务 id（面板与 replay 都靠它定位）
    expect(accepted.taskId).not.toBeNull();

    // 两次投递、一个任务
    expect(await db.sql('select * from webhook_deliveries')).toHaveLength(2);
    const tasks = await db.sql('select * from tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.['id']).toBe(accepted.taskId);
    expect(queue.record.sent).toHaveLength(1);
  }, 30_000);
});
