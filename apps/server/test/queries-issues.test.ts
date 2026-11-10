/**
 * `/api/issues` 与 `/api/issues/:owner/:name/:kind/:number` 的真库断言（PM 评审后的口径）。
 *
 * 覆盖 spec §3 的验收 + 评审提出的 11 条修正里可由数据验证的部分：
 *  1. 机器人轮以 `runs` 为骨架（dry-run 无 `actions` 行也照样有气泡）；
 *  2. 兜底回复 `intent='fallback'` 的 `external_ref`（comment id）不能丢；
 *  3. `commentId` + 服务端拼的 `commentUrl`；`external_ref` 不假设是 URL；
 *  4. `humanTurns` 只数 `tasks.source='command'`，`auto:triage` 进 `autoTurns`；
 *  5. `lastActivityAt` 取四源 max（本例靠 `runs.ended_at` 与 `bot_labels.applied_at` 决定先后）；
 *  6. 游标元组含 `kind`（直接解码游标断言）；
 *  7. `state` 取该 issue 最新投递（`issues.closed` 不建任务也能看到 closed），取不到用 `issue_states` 推断并置 `stateStale`；
 *  8. 没有 `q` 参数（标题只在 jsonb 里，不做深挖）；
 *  9. 工具名抽取顺序 `tool.name` → `tool`(字符串) → `name` → `unknown`，`ok` 只有显式 false 才算失败；
 * 10. 机器人 login 从 `repos.config.bot.login` 取（取不到为 null，不硬编码）；
 * 11. 同一 task 的多次 attempt 合并成一转（`attempts` 作脚注）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  issuesListResponseSchema,
  issuesQuerySchema,
  issueSessionResponseSchema,
} from '../../../packages/contract/src/index.ts';
import { openTestDb, type TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const BOT_LOGIN = 'pi-issue-bot-acme[bot]';

describe('queries/issues（真库）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await openTestDb();
  });

  afterAll(async () => {
    await db.truncate();
    await db.close();
  });

  beforeEach(async () => {
    await db.truncate();
    await seedIssues(db);
  });

  it('列表：四源 lastActivityAt 倒序，字段映射成契约取值', async () => {
    const response = await db.queries.issues({ kind: 'issue', limit: 30 });
    expect(() => issuesListResponseSchema.parse(response)).not.toThrow();
    expect(response.generatedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeNull();

    // other/lib#3 的最后活跃来自 bot_labels（07:00）；acme#7 来自 runs.ended_at（04:35）；
    // acme#9 来自 runs.ended_at（03:05，晚于它的 action 03:00:30）；
    expect(response.issues.map((item) => `${item.repo}#${item.number}`)).toEqual([
      'other/lib#3',
      'acme/widgets#7',
      'acme/widgets#9',
    ]);

    const byKey = new Map(response.issues.map((item) => [`${item.repo}#${item.number}`, item]));

    expect(byKey.get('acme/widgets#7')).toMatchObject({
      kind: 'issue',
      // 标题/状态取**该 issue 最新一条投递**（d-closed），不是「最新 task 的投递」
      title: 'EACCES on publish',
      url: 'https://github.com/acme/widgets/issues/7',
      state: 'closed',
      stateStale: false,
      lastActivityAt: '2026-06-01T04:35:00.000Z',
      // 两次人类触发（t-a1、t-a3 都是 source='command'），auto:triage 不算人
      humanTurns: 2,
      autoTurns: 1,
      // 动作数：r-a1 的 fallback + r-a1b 的 comment 与 label（dry-run 的 r-a3 没有 actions 行）
      botTurns: 3,
      labels: ['bug', 'needs-info'],
      outcomes: { succeeded: 1, running: 1, failed: 1 },
      // 机器人正文取最后一条（r-a3 的 dry-run 回复）
      lastPreview: 'dry-run：这是我会发的回复。',
    });

    // 该 issue 没有任何能定位到它的投递 → state 只能从 issue_states.closed_at 推断（stale=true）
    expect(byKey.get('acme/widgets#9')).toMatchObject({
      title: null,
      url: null,
      state: 'closed',
      stateStale: true,
      lastActivityAt: '2026-06-01T03:05:00.000Z',
      humanTurns: 0,
      autoTurns: 1,
      botTurns: 1,
      labels: [],
      outcomes: { succeeded: 1 },
      lastPreview: null,
    });

    // 只有评论投递（没有 issue/repository 键）→ 标题取不到，预览退回人类提问
    expect(byKey.get('other/lib#3')).toMatchObject({
      title: null,
      url: null,
      state: 'unknown',
      stateStale: true,
      humanTurns: 0,
      autoTurns: 1,
      botTurns: 0,
      labels: ['triage'],
      outcomes: { queued: 1 },
      lastPreview: '@acme-bot 这条没有 issue 键',
    });
  });

  it('游标：分页不重不漏，元组里带 kind，非法游标抛 bad-request', async () => {
    const first = await db.queries.issues({ kind: 'issue', limit: 1 });
    expect(first.issues.map((item) => item.number)).toEqual([3]);
    expect(first.hasMore).toBe(true);

    // 直接解码游标：`<lastActivityAt>|<repo>#<kind><number>` —— kind 在元组里（issue#5 与 pr#5 不会互撞）
    const decoded = Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8');
    expect(decoded).toBe('2026-06-01T07:00:00.000Z|other/lib#issue3');

    const second = await db.queries.issues({ kind: 'issue', limit: 1, cursor: first.nextCursor ?? '' });
    expect(second.issues.map((item) => item.number)).toEqual([7]);
    const third = await db.queries.issues({ kind: 'issue', limit: 1, cursor: second.nextCursor ?? '' });
    expect(third.issues.map((item) => item.number)).toEqual([9]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    const all = await db.queries.issues({ kind: 'issue', limit: 30 });
    expect([...first.issues, ...second.issues, ...third.issues].map((item) => item.number)).toEqual(
      all.issues.map((item) => item.number),
    );

    await expect(db.queries.issues({ kind: 'issue', limit: 1, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('筛选：repo / kind（PR 用 pull_request 键，state 走 issue_states 兜底）', async () => {
    const byRepo = await db.queries.issues({ kind: 'issue', repo: REPO, limit: 30 });
    expect(byRepo.issues.map((item) => item.number)).toEqual([7, 9]);

    const prs = await db.queries.issues({ kind: 'pr', limit: 30 });
    expect(() => issuesListResponseSchema.parse(prs)).not.toThrow();
    expect(prs.issues.map((item) => `${item.repo}#${item.number}`)).toEqual(['acme/widgets#12']);
    expect(prs.issues[0]).toMatchObject({
      kind: 'pr',
      title: 'Add retry to upload',
      url: 'https://github.com/acme/widgets/pull/12',
      // 该 PR 的最新投递（d-pr-12）自己带 state → 不算 stale
      state: 'open',
      stateStale: false,
      humanTurns: 1,
      autoTurns: 0,
      botTurns: 0,
      outcomes: { succeeded: 1 },
    });

    // q 已从契约里删掉：未知查询参数会被 strict() 拒绝
    expect(issuesQuerySchema.safeParse({ q: 'eacces' }).success).toBe(false);
  });

  it('列表聚合数字与手写 SQL 一致', async () => {
    const list = await db.queries.issues({ kind: 'issue', repo: REPO, limit: 30 });
    const row = list.issues.find((item) => item.number === 7);
    expect(row).toBeDefined();

    const [counts] = await db.sql(
      `select
         (select count(*)::int from tasks t
            where t.repo = $1 and t.target_kind = 'issue' and t.target_number = 7
              and t.source = 'command') as human_turns,
         (select count(*)::int from tasks t
            where t.repo = $1 and t.target_kind = 'issue' and t.target_number = 7
              and t.source <> 'command') as auto_turns,
         (select count(*)::int from actions a
            join runs r on r.id = a.run_id
            join tasks t on t.id = r.task_id
           where t.repo = $1 and t.target_kind = 'issue' and t.target_number = 7) as bot_turns,
         (select count(*)::int from bot_labels l
           where l.repo = $1 and l.issue_number = 7 and l.removed_at is null) as labels`,
      [REPO],
    );
    expect(row?.humanTurns).toBe(counts?.['human_turns']);
    expect(row?.autoTurns).toBe(counts?.['auto_turns']);
    expect(row?.botTurns).toBe(counts?.['bot_turns']);
    expect(row?.labels).toHaveLength(Number(counts?.['labels']));
    // 同时把手算值钉死，避免「查出来再跟自己比」
    expect(row).toMatchObject({ humanTurns: 2, autoTurns: 1, botTurns: 3, labels: ['bug', 'needs-info'] });
  });

  it('会话：人类正文来自投递 payload，机器人正文来自 envelopes.actions，attempt 合并为一转', async () => {
    const session = await db.queries.issueSession({ owner: 'acme', name: 'widgets', kind: 'issue', number: 7 });
    expect(session).not.toBeNull();
    if (session === null) return;
    expect(() => issueSessionResponseSchema.parse(session)).not.toThrow();

    expect(session.issue).toMatchObject({
      repo: REPO,
      kind: 'issue',
      number: 7,
      title: 'EACCES on publish',
      state: 'closed',
      stateStale: false,
      labels: ['bug', 'needs-info'],
      // 人类触发者 + 从 repos.config.bot.login 解析到的机器人自己
      participants: ['alice', 'bob', BOT_LOGIN],
    });

    // 5 轮：t-a1 的两条 run 合并成 1 轮机器人（attempts=2），dry-run 的 t-a3 也要有气泡
    expect(session.turns.map((turn) => turn.id)).toEqual([
      'task:t-a1',
      'run:r-a1b',
      'task:t-a2',
      'task:t-a3',
      'run:r-a3',
    ]);

    expect(session.turns[0]).toMatchObject({
      role: 'human',
      login: 'alice',
      at: '2026-06-01T01:00:30.000Z',
      channel: 'mention',
      text: '@acme-bot 这个 EACCES 一般是什么原因？',
      commentId: null,
      commentUrl: 'https://github.com/acme/widgets/issues/7#issuecomment-1001',
      status: 'failed',
      failureClass: 'parse',
      taskId: null,
      attempts: 1,
      labels: [],
      toolCalls: [],
      truncated: false,
    });

    // 合并后的机器人轮：at 取最后一次 attempt 的 ended_at，attempts=2，正文/评论 id 取自该 attempt
    expect(session.turns[1]).toMatchObject({
      role: 'bot',
      login: BOT_LOGIN,
      at: '2026-06-01T01:07:00.000Z',
      channel: null,
      text: '结果：这是容器只读挂载导致的。',
      commentId: '3002',
      commentUrl: 'https://github.com/acme/widgets/issues/7#issuecomment-3002',
      // 本轮「打过」的标：wontfix 在这一轮打上、后来被撤掉，所以仍留在该轮（issue 头的 labels 不含它）
      labels: ['bug', 'wontfix'],
      status: 'failed',
      failureClass: 'parse',
      taskId: 't-a1',
      attempts: 2,
      truncated: true,
    });

    // 自动触发的一轮：channel=auto、没有 run 就没有机器人气泡
    expect(session.turns[2]).toMatchObject({ id: 'task:t-a2', login: 'bob', channel: 'auto', status: 'running', text: null });

    // dry-run：没有任何 actions 行，但 runs + envelopes 在 → 仍有一轮机器人回复（commentId 为 null）
    expect(session.turns[4]).toMatchObject({
      id: 'run:r-a3',
      role: 'bot',
      at: '2026-06-01T04:35:00.000Z',
      text: 'dry-run：这是我会发的回复。',
      commentId: null,
      commentUrl: null,
      status: 'succeeded',
      attempts: 1,
      truncated: false,
    });
  });

  it('兜底回复：intent=fallback 的 external_ref 就是 commentId', async () => {
    const session = await db.queries.issueSession({ owner: 'acme', name: 'widgets', kind: 'issue', number: 9 });
    expect(session).not.toBeNull();
    if (session === null) return;
    const bot = session.turns.find((turn) => turn.role === 'bot');
    expect(bot).toMatchObject({
      // 该 run 只有一条 intent='fallback' 的动作（契约 5 个 intent 之外，但正文/链接必须保留）
      commentId: '3003',
      commentUrl: 'https://github.com/acme/widgets/issues/9#issuecomment-3003',
      // 信封里没有 comment body（信封不合法）→ 正文为 null，不是空串
      text: null,
      failureClass: 'parse',
    });
    // 没有 repos.config.bot.login 的仓库 → login 为 null（不硬编码 App slug）
    expect(bot?.login).toBe(BOT_LOGIN);
    expect(session.issue.participants).toEqual(['carol', BOT_LOGIN]);
  });

  it('工具调用：按 toolCallId 合并三类事件、只留一行摘要、50 条截断', async () => {
    const session = await db.queries.issueSession({ owner: 'acme', name: 'widgets', kind: 'issue', number: 7 });
    const bot = session?.turns.find((turn) => turn.id === 'run:r-a1b');
    expect(bot).toBeDefined();
    if (bot === undefined) return;

    expect(bot.toolCalls).toHaveLength(50);
    expect(bot.truncated).toBe(true);
    // call_1：名字来自 item.started.event.toolName，摘要来自 args.path，时间取该 toolCallId 最早一条事件
    expect(bot.toolCalls[0]).toEqual({
      name: 'read/fetch-spans',
      summary: 'src/a.ts',
      at: '2026-06-01T01:01:01.000Z',
      ok: true,
    });
    // call_2：Bash 的 command 是多行脚本 → 摘要只留第一行；item.completed 的 isError=true → ok:false
    expect(bot.toolCalls[1]).toEqual({
      name: 'Bash',
      summary: 'npm test',
      at: '2026-06-01T01:01:02.000Z',
      ok: false,
    });
    // call_3 有三条事件（1 条 started + 2 条 progress）→ 仍然只有一条工具调用
    expect(bot.toolCalls[2]).toMatchObject({ name: 'Bash', summary: 'run 3', ok: true });
    // 55 个 toolCallId 截到 50 条；60 条 item.delta 与那条 tool-call 都不占额度
    expect(bot.toolCalls[49]?.summary).toBe('run 50');
    expect(bot.toolCalls.some((call) => call.summary === '正文流 1')).toBe(false);
    expect(bot.toolCalls.some((call) => call.name === 'should-not-appear')).toBe(false);

    // dry-run 那一轮：2 个 toolCallId → 2 条，摘要来自参数（不是输出）
    const dry = session?.turns.find((turn) => turn.id === 'run:r-a3');
    expect(dry?.toolCalls.map((call) => `${call.name}:${call.summary}`)).toEqual([
      'read/fetch-spans:README.md',
      'Bash:ls -la',
    ]);
    expect(dry?.truncated).toBe(false);
  });

  it('会话：PR 用 payload.pull_request 取标题，机器人 login 取不到时为 null', async () => {
    const session = await db.queries.issueSession({ owner: 'acme', name: 'widgets', kind: 'pr', number: 12 });
    expect(session).not.toBeNull();
    if (session === null) return;
    expect(() => issueSessionResponseSchema.parse(session)).not.toThrow();
    expect(session.issue).toMatchObject({
      kind: 'pr',
      title: 'Add retry to upload',
      url: 'https://github.com/acme/widgets/pull/12',
      state: 'open',
      stateStale: false,
      participants: ['dave', BOT_LOGIN],
    });
    expect(session.turns.map((turn) => `${turn.role}:${turn.channel ?? '-'}`)).toEqual(['human:command']);

    // other/lib 的 repos.config 里没有 bot.login → bot 轮 login 与 participants 都不含机器人
    const other = await db.queries.issueSession({ owner: 'other', name: 'lib', kind: 'issue', number: 3 });
    expect(other?.issue.participants).toEqual(['erin']);
  });

  it('会话：没有 tasks 行返回 null（http 层映射 404）', async () => {
    expect(await db.queries.issueSession({ owner: 'acme', name: 'widgets', kind: 'issue', number: 404 })).toBeNull();
    expect(await db.queries.issueSession({ owner: 'acme', name: 'widgets', kind: 'pr', number: 7 })).toBeNull();
  });

  it('列表：空库返回空数组 + hasMore=false', async () => {
    await db.truncate();
    const response = await db.queries.issues({ kind: 'issue', limit: 30 });
    expect(response.issues).toEqual([]);
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeNull();
  });

  it('列表/会话的新字段：reactionState 取最新终态、labelDecisions 按 blocked_reason 聚合', async () => {
    // `issue_feedback`：入队 eyes → 成功 rocket（旧）→ 失败 confused（最新）；再补一条没落地的
    await db.sql(
      `insert into issue_feedback (repo, target_kind, target_number, stage, content, anchor, applied_at, created_at)
       values
         ('acme/widgets', 'issue', 7, 'received',  'eyes',     'k1', '2026-06-01T03:00:00Z', '2026-06-01T03:00:00Z'),
         ('acme/widgets', 'issue', 7, 'succeeded', 'rocket',   'k1', '2026-06-01T03:05:00Z', '2026-06-01T03:05:00Z'),
         ('acme/widgets', 'issue', 7, 'failed',    'confused', 'k2', '2026-06-01T04:35:00Z', '2026-06-01T04:35:00Z'),
         ('acme/widgets', 'issue', 7, 'received',  'eyes',     'k3', null,                   '2026-06-01T04:36:00Z')`,
    );
    await db.sql(
      `insert into label_decisions (repo, target_number, judgement_hash, desired, applied, blocked_reason, reason, created_at)
       values
         ('acme/widgets', 7, 'h1', '["bug","needs-info"]'::jsonb, '["bug"]'::jsonb,
          'not-in-vocabulary', 'needs-info 不在词表', '2026-06-01T03:10:00Z'),
         ('acme/widgets', 7, 'h2', '["bug"]'::jsonb, '["bug"]'::jsonb,
          null, '本轮到齐', '2026-06-01T04:00:00Z')`,
    );

    const list = await db.queries.issues({ kind: 'issue', limit: 30 });
    expect(() => issuesListResponseSchema.parse(list)).not.toThrow();
    const item = list.issues.find((issue) => issue.repo === 'acme/widgets' && issue.number === 7);
    expect(item).toBeDefined();
    // 最新终态（`received` 不算终态）：failed / confused
    expect(item?.reactionState).toEqual({
      stage: 'failed',
      content: 'confused',
      appliedAt: '2026-06-01T04:35:00.000Z',
      at: '2026-06-01T04:35:00.000Z',
      commentId: null,
    });
    // 时间线升序、4 条
    expect(item?.feedback.map((event) => event.stage)).toEqual([
      'received',
      'succeeded',
      'failed',
      'received',
    ]);
    // 最近一轮判定 + 被拦原因计数
    expect(item?.labelDecisions).toMatchObject({
      lastAt: '2026-06-01T04:00:00.000Z',
      desired: ['bug'],
      applied: ['bug'],
      reason: '本轮到齐',
      blocked: [{ reason: 'not-in-vocabulary', count: 1 }],
    });

    // 没有反馈/判定数据的 issue：两个字段都是 null / 空数组（不是缺字段）
    const other = list.issues.find((issue) => issue.repo === 'acme/widgets' && issue.number === 9);
    expect(other?.reactionState).toBeNull();
    expect(other?.labelDecisions).toBeNull();
    expect(other?.feedback).toEqual([]);

    // 详情：reactionState 同源；pendingFeedback 只含 `applied_at is null` 的那条
    const session = await db.queries.issueSession({ owner: 'acme', name: 'widgets', kind: 'issue', number: 7 });
    expect(session).not.toBeNull();
    expect(session?.issue.reactionState?.stage).toBe('failed');
    expect(session?.issue.pendingFeedback).toHaveLength(1);
    expect(session?.issue.pendingFeedback[0]).toMatchObject({ stage: 'received', appliedAt: null });
  });
});

/* ── 种子数据 ─────────────────────────────────────────────────────────────── */

/**
 * 4 条 issue/PR（数字都是手算的，改这里必须同时改断言）：
 *
 * - `acme/widgets#7`：3 次任务（2 次人手 + 1 次 auto:triage）。`t-a1` 有 2 次 attempt（parse 失败 → 成功），
 *   第一次留下 `intent='fallback'` 的动作、第二次留下 comment 正文；`t-a3` 是 **dry-run**（没有 actions 行，
 *   只有 runs+envelopes）。`d-closed` 是该 issue 最新一条投递（`issues.closed`，不建任务）→ state=closed。
 * - `acme/widgets#9`：1 次 auto 任务 + 1 条**只有** fallback 动作的 run（comment id 3003）。
 *   没有任何能定位到该 issue 的投递 → state 从 `issue_states.closed_at` 推断、stateStale=true。
 * - `acme/widgets#12`：PR，1 次命令任务、没有 run；最新投递（d-pr-12）自带 state=open → 不算 stale。
 * - `other/lib#3`：1 次任务（source=webhook，算 auto），只有一条评论投递（没有 issue 键），
 *   活跃时间由 `bot_labels.applied_at`（07:00）决定。
 */
async function seedIssues(db: TestDb): Promise<void> {
  const { pool } = db;

  await pool.query(`
    insert into repos (repo_full_name, enabled, dry_run, config, config_valid, config_error)
    values
      ('acme/widgets', true, false, '{"version":1,"bot":{"login":"${BOT_LOGIN}"}}'::jsonb, true, null),
      ('other/lib', true, true, '{}'::jsonb, true, null)
  `);

  await pool.query(`
    insert into webhook_deliveries (delivery_id, event, action, payload, signature_valid, received_at)
    values
      ('d-ic-1', 'issue_comment', 'created',
       '{"action":"created","repository":{"full_name":"acme/widgets"},"issue":{"number":7,"title":"EACCES on publish","html_url":"https://github.com/acme/widgets/issues/7","state":"open"},"comment":{"id":1001,"body":"@acme-bot 这个 EACCES 一般是什么原因？","html_url":"https://github.com/acme/widgets/issues/7#issuecomment-1001","user":{"login":"alice"}}}'::jsonb,
       true, '2026-06-01T01:00:20Z'),
      ('d-iss-7', 'issues', 'opened',
       '{"action":"opened","repository":{"full_name":"acme/widgets"},"issue":{"number":7,"title":"EACCES on publish","html_url":"https://github.com/acme/widgets/issues/7","state":"open"}}'::jsonb,
       true, '2026-06-01T02:00:00Z'),
      ('d-ic-3', 'issue_comment', 'created',
       '{"action":"created","repository":{"full_name":"acme/widgets"},"issue":{"number":7,"title":"EACCES on publish","html_url":"https://github.com/acme/widgets/issues/7","state":"open"},"comment":{"id":1002,"body":"试一下 dry-run 仓库","html_url":"https://github.com/acme/widgets/issues/7#issuecomment-1002","user":{"login":"alice"}}}'::jsonb,
       true, '2026-06-01T04:30:00Z'),
      ('d-closed', 'issues', 'closed',
       '{"action":"closed","repository":{"full_name":"acme/widgets"},"issue":{"number":7,"title":"EACCES on publish","html_url":"https://github.com/acme/widgets/issues/7","state":"closed"}}'::jsonb,
       true, '2026-06-01T06:00:00Z'),
      ('d-pr-12', 'pull_request', 'opened',
       '{"action":"opened","repository":{"full_name":"acme/widgets"},"pull_request":{"number":12,"title":"Add retry to upload","html_url":"https://github.com/acme/widgets/pull/12","state":"open"}}'::jsonb,
       true, '2026-06-01T03:59:00Z'),
      ('d-ic-3-other', 'issue_comment', 'created',
       '{"action":"created","comment":{"id":3001,"body":"@acme-bot 这条没有 issue 键","html_url":"https://github.com/other/lib/issues/3#issuecomment-3001","user":{"login":"erin"}}}'::jsonb,
       true, '2026-06-01T05:00:10Z')
  `);

  await pool.query(`
    insert into tasks
      (id, source, repo, target_kind, target_number, head_sha, command, actor_login, queued_at,
       idempotency_key, status, container_name, attempt, delivery_id, created_at, updated_at, ended_at, prompt_text)
    values
      ('t-a1', 'command', 'acme/widgets', 'issue', 7,  null,            '@answer',    'alice', '2026-06-01T01:00:30Z', 'k-a1', 'failed',    null, 1, 'd-ic-1',
       '2026-06-01T01:00:30Z', '2026-06-01T01:07:00Z', '2026-06-01T01:07:00Z', '@acme-bot 这个 EACCES 一般是什么原因？'),
      ('t-a2', 'webhook', 'acme/widgets', 'issue', 7,  null,            'auto:triage', 'bob',   '2026-06-01T02:00:00Z', 'k-a2', 'running',   null, 1, 'd-iss-7',
       '2026-06-01T02:00:00Z', '2026-06-01T02:00:00Z', null, null),
      ('t-a3', 'command', 'acme/widgets', 'issue', 7,  null,            '@answer',    'alice', '2026-06-01T04:30:00Z', 'k-a3', 'succeeded', null, 1, 'd-ic-3',
       '2026-06-01T04:30:00Z', '2026-06-01T04:35:00Z', '2026-06-01T04:35:00Z', '试一下 dry-run 仓库'),
      ('t-b1', 'webhook', 'acme/widgets', 'issue', 9,  null,            'auto:triage', 'carol', '2026-06-01T03:00:00Z', 'k-b1', 'succeeded', null, 1, null,
       '2026-06-01T03:00:00Z', '2026-06-01T03:05:00Z', '2026-06-01T03:05:00Z', null),
      ('t-p1', 'command', 'acme/widgets', 'pr',    12, 'abcdef1234567', '/review-pr',  'dave',  '2026-06-01T04:00:00Z', 'k-p1', 'succeeded', null, 1, 'd-pr-12',
       '2026-06-01T04:00:00Z', '2026-06-01T04:10:00Z', '2026-06-01T04:10:00Z', null),
      ('t-o1', 'webhook', 'other/lib',    'issue', 3,  null,            '@answer',    'erin',  '2026-06-01T05:00:00Z', 'k-o1', 'queued',    null, 0, 'd-ic-3-other',
       '2026-06-01T05:00:00Z', '2026-06-01T05:00:00Z', null, null)
  `);

  await pool.query(`
    insert into runs (id, task_id, attempt, session_id, turn_id, started_at, ended_at, outcome, failure_class, failure_detail, created_at)
    values
      ('r-a1',  't-a1', 1, 's-a1',  'u-a1',  '2026-06-01T01:00:40Z', '2026-06-01T01:04:00Z', 'parse-failed', 'parse', null, '2026-06-01T01:00:40Z'),
      ('r-a1b', 't-a1', 2, 's-a1b', 'u-a1b', '2026-06-01T01:04:30Z', '2026-06-01T01:07:00Z', 'failed',       'parse', null, '2026-06-01T01:04:30Z'),
      ('r-a3',  't-a3', 1, 's-a3',  'u-a3',  '2026-06-01T04:30:10Z', '2026-06-01T04:35:00Z', 'success',      null,    null, '2026-06-01T04:30:10Z'),
      ('r-b1',  't-b1', 1, 's-b1',  'u-b1',  '2026-06-01T03:00:10Z', '2026-06-01T03:05:00Z', 'parse-failed', 'parse', null, '2026-06-01T03:00:10Z')
  `);

  await pool.query(`
    insert into envelopes (run_id, verdict, actions, usage, valid, errors, created_at)
    values
      ('r-a1',  null, null, null, false, '[{"path":"actions"}]'::jsonb, '2026-06-01T01:03:50Z'),
      ('r-a1b', '{"kind":"issue","labels":["bug"],"evidence":[]}'::jsonb,
       '[{"intent":"comment","body":"结果：这是容器只读挂载导致的。"},{"intent":"label","labels":["bug"]}]'::jsonb,
       '{"inputTokens":10,"outputTokens":5,"costUsd":0.001}'::jsonb, true, null, '2026-06-01T01:05:50Z'),
      ('r-a3',  '{"kind":"issue","labels":[],"evidence":[]}'::jsonb,
       '[{"intent":"comment","body":"dry-run：这是我会发的回复。"}]'::jsonb, null, true, null, '2026-06-01T04:34:50Z'),
      ('r-b1',  null, null, null, false, '[{"path":"kind"}]'::jsonb, '2026-06-01T03:04:50Z')
  `);

  await pool.query(`
    insert into actions (id, run_id, intent, target, external_ref, applied_at, reverted_at, revert_kind, audit, created_at)
    values
      (101, 'r-a1',  'fallback', 'acme/widgets#7', '3001', '2026-06-01T01:04:00Z', null, null, '{"status":"posted","reason":"envelope-invalid"}'::jsonb, '2026-06-01T01:04:00Z'),
      (102, 'r-a1b', 'comment',  'acme/widgets#7', '3002', '2026-06-01T01:06:00Z', null, null, '{"status":"applied"}'::jsonb, '2026-06-01T01:06:00Z'),
      (103, 'r-a1b', 'label',    'acme/widgets#7', null,   '2026-06-01T01:06:10Z', null, null, '{"status":"applied"}'::jsonb, '2026-06-01T01:06:10Z'),
      (104, 'r-b1',  'fallback', 'acme/widgets#9', '3003', '2026-06-01T03:00:30Z', null, null, '{"status":"posted","reason":"envelope-invalid"}'::jsonb, '2026-06-01T03:00:30Z')
  `);

  await pool.query(`
    insert into bot_labels (repo, issue_number, label, applied_at, removed_at)
    values
      ('acme/widgets', 7, 'bug',        '2026-06-01T01:06:10Z', null),
      ('acme/widgets', 7, 'needs-info', '2026-06-01T04:34:00Z', null),
      ('acme/widgets', 7, 'wontfix',    '2026-06-01T01:06:20Z', '2026-06-01T02:00:00Z'),
      ('other/lib',    3, 'triage',     '2026-06-01T07:00:00Z', null)
  `);

  // #9 没有任何能定位到它的投递 → state 只能从 issue_states 推断（stale）
  await pool.query(`
    insert into issue_states (repo, issue_number, closed_at)
    values ('acme/widgets', 9, '2026-05-31T00:00:00Z')
  `);

  // r-a1b：55 个 toolCallId（每个 = 1 条 item.started + 1 条 tool.progress），call_3 再多 2 条 progress
  // （验证「一个 toolCallId = 一条工具调用」），call_2 的 item.completed 带 isError=true（→ ok:false）；
  // 另外插 60 条 item.delta（都带 itemId，若被误收会把 50 条上限吃光）与 1 条不在白名单的 tool-call。
  await pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    select
      'r-a1b',
      g,
      'item.started',
      jsonb_build_object(
        'event', jsonb_build_object(
          'type', 'tool_start',
          'toolName', case when g = 1 then 'read/fetch-spans' else 'Bash' end,
          'toolCallId', 'call_' || g,
          'args', case
            when g = 1 then '{"path":"src/a.ts"}'::jsonb
            when g = 2 then '{"command":"npm test\\n第二行应该被丢掉\\n第三行"}'::jsonb
            else jsonb_build_object('command', format('run %s', g))
          end
        ),
        'itemId', 'call_' || g,
        'itemType', 'tool'
      ),
      ('2026-06-01T01:01:00Z'::timestamptz + (g * interval '1 second'))
    from generate_series(1, 55) as g
  `);
  await pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    select
      'r-a1b',
      100 + g,
      'tool.progress',
      jsonb_build_object(
        'event', jsonb_build_object(
          'type', 'tool_update',
          'toolCallId', 'call_' || g,
          'partialResult', jsonb_build_object(
            'content', jsonb_build_array(
              jsonb_build_object('type', 'text', 'text', format('第 %s 个工具的输出', g))
            )
          )
        ),
        'itemId', 'call_' || g,
        'itemType', 'tool'
      ),
      ('2026-06-01T01:01:00Z'::timestamptz + (g * interval '1 second') + interval '500 milliseconds')
    from generate_series(1, 55) as g
  `);
  await pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    select
      'r-a1b',
      1000 + g,
      'item.delta',
      jsonb_build_object(
        'event', jsonb_build_object('type', 'text_delta', 'text', format('正文流 %s', g)),
        'itemId', 'text_' || g,
        'itemType', 'text'
      ),
      ('2026-06-01T01:01:00Z'::timestamptz + (g * interval '1 second') + interval '700 milliseconds')
    from generate_series(1, 60) as g
  `);
  await pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    values
      ('r-a1b', 400, 'tool.progress',
       '{"event":{"type":"tool_update","toolCallId":"call_3","partialResult":{"content":[{"type":"text","text":"call_3 的第二条进度"}]}},"itemId":"call_3","itemType":"tool"}'::jsonb,
       '2026-06-01T01:01:04Z'),
      ('r-a1b', 401, 'item.completed',
       '{"event":{"type":"tool_end","toolCallId":"call_2","isError":true},"itemId":"call_2","itemType":"tool"}'::jsonb, '2026-06-01T01:01:05Z'),
      ('r-a1b', 402, 'tool-call', '{"name":"should-not-appear"}'::jsonb, '2026-06-01T01:01:06Z'),
      ('r-a3', 1, 'item.started',
       '{"event":{"type":"tool_start","toolName":"read/fetch-spans","toolCallId":"call_a","args":{"path":"README.md"}},"itemId":"call_a","itemType":"tool"}'::jsonb,
       '2026-06-01T04:30:20Z'),
      ('r-a3', 2, 'tool.progress',
       '{"event":{"type":"tool_update","toolCallId":"call_a","partialResult":{"content":[{"type":"text","text":"# pi-issue-bot-test"}]}},"itemId":"call_a","itemType":"tool"}'::jsonb,
       '2026-06-01T04:30:21Z'),
      ('r-a3', 3, 'item.started',
       '{"event":{"type":"tool_start","toolName":"Bash","toolCallId":"call_b","args":{"command":"ls -la\\n第二行忽略"}},"itemId":"call_b","itemType":"tool"}'::jsonb,
       '2026-06-01T04:30:30Z'),
      ('r-a3', 4, 'item.completed',
       '{"event":{"type":"tool_end","toolCallId":"call_a"},"itemId":"call_a","itemType":"tool"}'::jsonb, '2026-06-01T04:30:40Z'),
      ('r-b1', 1, 'item.delta',
       '{"event":{"type":"text_delta","text":"流式增量，不是工具调用"},"itemId":"text_1","itemType":"text"}'::jsonb,
       '2026-06-01T03:00:11Z'),
      -- 消息条目也走 item.started/item.completed（itemType='message'，itemId 是消息 uuid）：
      -- 它们没有 toolCallId，绝不能被算成工具调用。
      ('r-a1b', 500, 'item.started',
       '{"event":{"type":"message_start","message":{"id":"msg_1","role":"user","content":"你是 pi-bot…"}},"itemId":"msg_1","itemType":"message"}'::jsonb,
       '2026-06-01T01:00:30Z'),
      ('r-a1b', 501, 'item.completed',
       '{"event":{"type":"message_end","message":{"id":"msg_2","role":"assistant","content":"我先读取…"}},"itemId":"msg_2","itemType":"message"}'::jsonb,
       '2026-06-01T01:00:40Z')
  `);
}
