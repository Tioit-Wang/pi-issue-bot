/**
 * 两条规划条目的回归：§4.1 P3（阶段任务的信封只开 `comment`）与 §12 V10（全量切换、不可绕过）。
 *
 * 为什么单独钉这两条：
 *  - §4.1 说阶段任务要用 `prepareEnvelope({ allowedIntents: ['comment'] })` 收窄能力。写回闸门里那道
 *    「pipeline 只允许 comment」是**第二道**保险；只留一道时，模型声明 `label` 会先去 `bot_labels`
 *    记账再被丢弃，`actions` 表里留下一行没人解释的 rejected —— 能力边界应该是「进不来」，不是「进来了被扔」。
 *  - §12 V10 要求把 `triggers.enabled=false`、`commands.enabled=false`、`repos.enabled=true` **组合**
 *    投递，三段流程照常跑。分开测过（各一条）不等于组合过：两个开关的判定在不同的分支上，
 *    任意一处在「先判 A 再 return」的位置写错，单独测都是绿的。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
import type { FakePortsRecord } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const ISSUE = 41;

/**
 * 阶段 0 通过，但**信封里多声明了一个 `label` 动作**。
 *
 * 阶段任务的能力边界不允许它落地：`allowedIntents` 只有 `comment`，所以这条 label 连动作列表都进不去。
 * 用「pass」而不是「fail」是为了避开控制面自己那个 `needs-info` 标签，避免把两件事混在一起断言。
 */
const FORMAT_PASS_WITH_LABEL_ACTION = [
  '格式没问题。',
  '```json',
  JSON.stringify({
    stage: { name: 'format', result: 'pass' },
    verdict: { kind: 'issue', labels: [], evidence: [{ rule: 'format', quote: '齐了', passed: true }] },
    actions: [{ intent: 'label', add: ['bug'] }],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
  }),
  '```',
].join('\n');

describe('§4.1 阶段任务的信封只开 comment；§12 V10 组合开关不可绕过', () => {
  let db: TestDb;
  let app: Application;
  let host: FakeRacpHost;
  let record: FakePortsRecord;
  let github: ReturnType<typeof createCountingGithubApi>;

  beforeAll(async () => {
    db = await openTestDb(NOW);
    await db.truncate();
    await db.sql(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
       values ($1, true, false, $2::jsonb, true)`,
      [REPO, validSettingsJson()],
    );
    host = await FakeRacpHost.start({ script: { text: FORMAT_PASS_WITH_LABEL_ACTION } });
    github = createCountingGithubApi();
    const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
    record = fakePorts.record;
    app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false' }), {
      pool: poolWithNoopEnd(db.pool),
      queue: createFakeQueue(),
      ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
      metrics: quietMetrics(),
      metricsServer: stubMetricsServer(),
      ack: { addEyesReaction: async () => undefined },
    });
    await app.start();
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    await host?.close();
    await db?.close();
  }, 60_000);

  beforeEach(async () => {
    await db.sql(
      'truncate table tasks, runs, run_events, envelopes, actions, webhook_deliveries, issue_pipeline cascade',
    );
    // 每个用例都从「合法配置」起步，避免上一个用例改过的开关泄漏到下一个
    await db.sql('update repos set settings = $1::jsonb where repo_full_name = $2', [validSettingsJson(), REPO]);
    host.setScript({ text: FORMAT_PASS_WITH_LABEL_ACTION });
  });

  async function send(event: string, deliveryId: string, payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    const response = await app.server.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': deliveryId,
        'x-github-event': event,
        'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
  }

  function issueOpened(): Promise<void> {
    return send('issues', 'd-v10-open', {
      action: 'opened',
      repository: { full_name: REPO },
      sender: { login: 'alice', type: 'User' },
      issue: {
        number: ISSUE,
        title: '登录时报 500',
        body: '复现步骤：……',
        user: { login: 'author' },
        author_association: 'OWNER',
        updated_at: '2026-05-31T00:00:00Z',
      },
    });
  }

  function commentMentioningCommand(): Promise<void> {
    return send('issue_comment', 'd-v10-comment', {
      action: 'created',
      repository: { full_name: REPO },
      sender: { login: 'alice', type: 'User' },
      comment: {
        id: 777,
        body: '@pi-bot /review-pr',
        user: { login: 'alice' },
        author_association: 'OWNER',
      },
      issue: {
        number: ISSUE,
        title: '登录时报 500',
        body: '复现步骤：……',
        user: { login: 'author' },
        author_association: 'OWNER',
        updated_at: '2026-05-31T00:00:00Z',
      },
    });
  }

  async function onlyTaskId(command: string): Promise<string> {
    const rows = await db.sql(
      `select id from tasks where command = $1 and target_number = $2
       order by queued_at desc, id desc limit 1`,
      [command, ISSUE],
    );
    expect(rows).toHaveLength(1);
    return String(rows[0]?.['id']);
  }

  it('阶段 0 的信封里声明的 label 动作进不来：GitHub 零 addLabels、actions 零 label 行', async () => {
    await issueOpened();
    const report = await app.executeTask({ taskId: await onlyTaskId('pipeline:format') });
    expect(report.outcome).toBe('succeeded');

    // ① 模型声明了 `label`，但 `allowedIntents=['comment']` 在 `prepareEnvelope()` 就把它挡掉
    expect(github.calls.filter((call) => call.method.startsWith('addLabels'))).toHaveLength(0);
    // ② `actions` 表里也不该出现「进来了又被拒」的 label 行（能力边界应是「进不来」）
    const labelActions = await db.sql(`select intent from actions where intent = 'label'`);
    expect(labelActions).toHaveLength(0);
    // ③ 这一轮确实跑完了阶段 0（否则上面两条「零」是空转出来的）
    const enqueued = await db.sql(
      `select command from tasks where target_number = $1 and command = 'pipeline:classify'`,
      [ISSUE],
    );
    expect(enqueued).toHaveLength(1);
    // 阶段 0 是 light：一次容器都不该起
    expect(record.createdContainers).toHaveLength(0);
  }, 120_000);

  it('V10 组合投递：triggers.enabled=false + commands.enabled=false + repos.enabled=true，issue 仍进三段', async () => {
    const settings = JSON.parse(validSettingsJson()) as Record<string, unknown>;
    settings['triggers'] = { ...(settings['triggers'] as Record<string, unknown>), enabled: false };
    settings['commands'] = { ...(settings['commands'] as Record<string, unknown>), enabled: false };
    await db.sql('update repos set settings = $1::jsonb where repo_full_name = $2', [
      JSON.stringify(settings),
      REPO,
    ]);
    // 前置事实：仓库本身是接入状态（`repos.enabled=false` 才是「未接入」，那是部署准入，不在本条判据内）
    await db.sql('update repos set enabled = true where repo_full_name = $1', [REPO]);

    // ① issue 事件不受两个开关影响
    await issueOpened();
    const afterOpen = await db.sql('select command, source from tasks order by queued_at, id');
    expect(afterOpen).toHaveLength(1);
    expect(afterOpen[0]).toMatchObject({ command: 'pipeline:format', source: 'pipeline' });

    // ② 同一仓库下的 `@bot /review-pr` 被两个开关一起挡掉（0 新任务），但投递照常落审计
    await commentMentioningCommand();
    const afterComment = await db.sql('select command from tasks order by queued_at, id');
    expect(afterComment).toHaveLength(1);
    const deliveries = await db.sql('select delivery_id from webhook_deliveries order by delivery_id');
    expect(deliveries).toHaveLength(2);
  }, 60_000);
});
