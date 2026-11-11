import { http, HttpResponse, type HttpHandler } from 'msw';
import type {
  IssueKind,
  IssueListItem,
  IssueSessionResponse,
  IssueTurn,
  IssuesResponse,
} from '../../lib/contract.ts';
import { scenarioResponse } from './shared.ts';

/**
 * issue 会话视图（R3）的两条拦截器：`GET /api/issues` 与 `GET /api/issues/:owner/:name/:kind/:number`。
 *
 * 契约：`docs/spec/ux-issue-sessions.md` §3（**本文件的字段名照抄，不自行改名**）。
 *
 * 三条口径：
 *  1. **数据集锚在「请求时刻」**（同 `tasks.ts`）：每次请求按 `now` 往前铺时间，
 *     否则「最后活跃 3 小时前」这类相对时间在真实时钟下永远是「几个月前」。
 *  2. **有一个「有故事」的 issue**（`acme/widgets#17`）：3 轮人类 + 3 轮机器人，
 *     机器人轮里有工具调用、有标签、**最后一轮是失败轮**（`failed` + `failureClass=timeout`）——
 *     这正好覆盖详情页要表达的每一件事（气泡、折叠、侧栏三段）。
 *  3. **游标分页**：`cursor` 对客户端不透明，这里用 `i:<偏移>` 编码，只回传不解释；
 *     数据集 12 条 × 每页 10 条 → 两页，`/issues` 的「加载更多」有第二页可拿。
 *
 * 详情 404 按契约返回 `not-found`（`(repo,kind,number)` 没有任何 `tasks` 行）；
 * 页面据此显示「找不到这个会话」的空态，而不是错误态或白屏。
 */

const MINUTE_MS = 60_000;

/** 契约 §3.1：`limit` 默认 30、1..100。页面显式传 10，让分页在 mock 里也可观测。 */
export const ISSUES_DEFAULT_LIMIT = 30;
const ISSUES_MAX_LIMIT = 100;

/** 游标前缀（与偏移编码一起构成「不透明」字符串）。 */
const CURSOR_PREFIX = 'i:';

const BOT_LOGIN = 'pi-issue-bot[bot]';
const REPO_MAIN = 'acme/widgets';
const REPO_OTHER = 'other/lib';

/**
 * mock 侧「种子」类型：契约里的新字段（`stateStale`/`autoTurns`/`commentId`/`attempts`/`truncated`）
 * 在样本里能省就省，由 `finalizeList` / `finalizeTurn` 统一补默认值——否则每加一个契约字段
 * 都要改十几处字面量，而漂移正是在这种地方长出来的。
 */
type ListSeed = Omit<
  IssueListItem,
  | 'stateStale'
  | 'autoTurns'
  | 'lastReplyAt'
  | 'lastActorLogin'
  | 'lastActorKind'
  | 'awaitingReply'
  | 'reactionState'
  | 'labelDecisions'
  | 'feedback'
  // 固定流水线状态：样本默认「没有状态行」（`null`），单测要覆盖时显式给
  | 'pipeline'
> &
  Partial<
    Pick<
      IssueListItem,
      | 'stateStale'
      | 'autoTurns'
      | 'lastReplyAt'
      | 'lastActorLogin'
      | 'lastActorKind'
      | 'awaitingReply'
      | 'reactionState'
      | 'labelDecisions'
      | 'feedback'
      | 'pipeline'
    >
  >;
type TurnSeed = Omit<IssueTurn, 'commentId' | 'attempts' | 'truncated'> &
  Partial<Pick<IssueTurn, 'commentId' | 'attempts' | 'truncated'>>;

/** 反馈时间线里的「最新终态」（`received` 只是「我收到了」，不算终态）。 */
function reactionStateOf(
  feedback: readonly IssueListItem['feedback'][number][],
): IssueListItem['reactionState'] {
  for (let index = feedback.length - 1; index >= 0; index -= 1) {
    const event = feedback[index];
    if (event !== undefined && event.stage !== 'received') return event;
  }
  return null;
}

/** 补齐列表行的契约字段（样本里的默认：状态可信、无自动轮、没回复过、不欠回答、无反馈）。 */
function finalizeList(seed: ListSeed): IssueListItem {
  const feedback = seed.feedback ?? [];
  return {
    ...seed,
    stateStale: seed.stateStale ?? false,
    autoTurns: seed.autoTurns ?? 0,
    lastReplyAt: seed.lastReplyAt ?? null,
    lastActorLogin: seed.lastActorLogin ?? null,
    lastActorKind: seed.lastActorKind ?? null,
    awaitingReply: seed.awaitingReply ?? false,
    feedback,
    // `reactionState` 默认从时间线推（显式给了就用显式的，方便测试单独改一处）
    reactionState: seed.reactionState ?? reactionStateOf(feedback),
    labelDecisions: seed.labelDecisions ?? null,
    pipeline: seed.pipeline ?? null,
  };
}

type IssueRecord = {
  list: ListSeed;
  participants: string[];
  turns: TurnSeed[];
};

/** 补齐轮次的契约字段（`commentId`/`attempts`/`truncated`）。 */
function finalizeTurn(seed: TurnSeed): IssueTurn {
  return {
    ...seed,
    commentId: seed.commentId ?? null,
    attempts: seed.attempts ?? 1,
    truncated: seed.truncated ?? false,
  };
}

/** 预告文本按契约截前 120 字（这是列表行的「最后一条预览」）。 */
function previewOf(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 120)}…`;
}

/** `acme/widgets#17`：多轮问答 + 工具调用 + 标签 + 失败轮（详情页的全部形态都在这条里）。 */
function storyEacces(now: number): IssueRecord {
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * MINUTE_MS).toISOString();
  const questionOne = '这个 EACCES 报错一般是什么原因？我们的部署脚本昨天开始一直失败。';
  const answerOne =
    'EACCES 是「有权限做这个操作，但目标不允许」：最常见的是写到了只有 root 能写的路径（/var/run、/usr/local 之类），' +
    '或者文件属主跟运行用户不一致。你们的脚本在 /var/run/app.sock 上 mkdir，这个目录在 systemd 单元里应该用 RuntimeDirectory 交给 systemd 建。';
  const questionTwo = '那我把监听端口改成 8080、socket 放到 /tmp 下，还会复现吗？';
  const answerTwo =
    '不会。A 轮结论：/tmp 是可写的，但两个副作用要注意——重启后 socket 文件不会自动清理，多实例会抢同一个文件；' +
    'systemd 的 PrivateTmp=yes 会把 /tmp 变成沙箱，容器里看到的未必是宿主的 /tmp。建议还是 RuntimeDirectory。';
  const questionThree = '顺便看下 CI 里那个 flaky 的 panel 测试，今天挂了三次。';
  const toolAt = (minutesAgo: number): string => at(minutesAgo);

  const turns: TurnSeed[] = [
    {
      id: 'task:8f3c1a',
      role: 'human',
      login: 'Tioit-Wang',
      at: at(180),
      channel: 'mention',
      text: questionOne,
      commentUrl: `${issueUrl(REPO_MAIN, 17)}#issuecomment-410001`,
      labels: [],
      status: 'succeeded',
      failureClass: null,
      taskId: 't-17-1',
      toolCalls: [],
    },
    {
      id: 'run:9a1b01',
      role: 'bot',
      login: BOT_LOGIN,
      at: at(176),
      channel: null,
      text: answerOne,
      commentUrl: `${issueUrl(REPO_MAIN, 17)}#issuecomment-410002`,
      labels: [],
      status: 'succeeded',
      failureClass: null,
      taskId: 't-17-1',
      toolCalls: [
        {
          name: 'read/fetch-spans',
          summary: '读 deploy/systemd/pi-issue-bot.service（第 1–60 行）',
          at: toolAt(178),
          ok: true,
        },
        {
          name: 'grep/search',
          summary: '在 apps/server 里搜 RuntimeDirectory / /var/run 的用法',
          at: toolAt(177),
          ok: true,
        },
      ],
    },
    {
      id: 'task:8f3c2b',
      role: 'human',
      login: 'Tioit-Wang',
      at: at(120),
      channel: 'command',
      text: questionTwo,
      commentUrl: `${issueUrl(REPO_MAIN, 17)}#issuecomment-410011`,
      labels: [],
      status: 'succeeded',
      failureClass: null,
      taskId: 't-17-2',
      toolCalls: [],
    },
    {
      id: 'run:9a1b02',
      role: 'bot',
      login: BOT_LOGIN,
      at: at(116),
      channel: null,
      text: answerTwo,
      commentUrl: `${issueUrl(REPO_MAIN, 17)}#issuecomment-410012`,
      labels: ['bug'],
      status: 'succeeded',
      failureClass: null,
      taskId: 't-17-2',
      toolCalls: [
        {
          name: 'read/fetch-spans',
          summary: '读 README 的「部署」一节，确认 PrivateTmp 的既有说明',
          at: toolAt(118),
          ok: true,
        },
      ],
    },
    {
      id: 'task:8f3c3c',
      role: 'human',
      login: 'alice',
      at: at(40),
      channel: 'mention',
      text: questionThree,
      commentUrl: `${issueUrl(REPO_MAIN, 17)}#issuecomment-410021`,
      labels: [],
      status: 'failed',
      failureClass: 'timeout',
      taskId: 't-17-3',
      toolCalls: [],
    },
    {
      // 失败轮：没有正文（envelopes.actions 里没有 comment），只有一条失败的工具调用
      id: 'run:9a1b03',
      role: 'bot',
      login: BOT_LOGIN,
      at: at(34),
      channel: null,
      text: null,
      commentUrl: null,
      labels: [],
      status: 'failed',
      failureClass: 'timeout',
      taskId: 't-17-3',
      toolCalls: [
        {
          name: 'bash/exec',
          summary: 'pnpm --filter @pi-issue-bot/panel test（30 分钟预算用尽，被时间闸掐断）',
          at: toolAt(36),
          ok: false,
        },
      ],
    },
  ];

  return {
    list: {
      repo: REPO_MAIN,
      kind: 'issue',
      number: 17,
      title: "EACCES: permission denied, open '/var/run/app.sock'",
      url: issueUrl(REPO_MAIN, 17),
      state: 'open',
      lastActivityAt: at(34),
      humanTurns: 3,
      botTurns: 3,
      labels: ['bug', 'needs-info'],
      outcomes: { succeeded: 2, failed: 1 },
      lastPreview: previewOf(answerTwo),
      // 服务端口径：最后说话的是人、且之后没有回复（不是「botTurns===0」那种代理）
      awaitingReply: true,
      lastActorKind: 'human',
      lastActorLogin: 'alice',
      /*
       * 无感反馈时间线（契约 `IssueListItem.feedback`）：入队 eyes → 成功 rocket → 再入队 eyes → 失败 confused。
       * `reactionState` 由 `finalizeList()` 从这条时间线推出「最新终态」= failed / confused。
       */
      feedback: [
        { stage: 'received', content: 'eyes', appliedAt: at(178), at: at(178), commentId: '410000' },
        { stage: 'succeeded', content: 'rocket', appliedAt: at(174), at: at(174), commentId: '410000' },
        { stage: 'received', content: 'eyes', appliedAt: at(38), at: at(38), commentId: '410020' },
        { stage: 'failed', content: 'confused', appliedAt: at(32), at: at(32), commentId: '410020' },
      ],
      // 打标判定摘要：想要的比打上的多一个（`flaky-test` 不在词表）
      labelDecisions: {
        lastAt: at(34),
        desired: ['bug', 'flaky-test', 'needs-info'],
        applied: ['bug', 'needs-info'],
        reason: 'flaky-test 不在词表，按 warn 策略跳过（不发评论催人）',
        blocked: [
          { reason: 'not-in-vocabulary', count: 2 },
          { reason: 'max_per_issue', count: 1 },
        ],
      },
      /*
       * 固定流水线：三段都走完，等 `@`（`agent/ready`）。
       * 有 `sessionId` 与 `sessionTurns`（阶段 2 复用会话），并且 `staleAt` 非空
       * （ready 之后正文被编辑过一次：只记录，不重跑）。
       */
      pipeline: {
        stage: 'agent',
        state: 'ready',
        category: 'defect',
        formatFailCount: 1,
        infoRequestedAt: null,
        blockedReason: null,
        readyAt: at(150),
        staleAt: at(120),
        sessionId: 'sess-17-agent',
        sessionTurns: 3,
      },
    },
    participants: ['Tioit-Wang', 'alice', BOT_LOGIN],
    turns,
  };
}

/** `acme/widgets#42`：一轮问答（单轮会话），已关闭。 */
function storyClosedOne(now: number): IssueRecord {
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * MINUTE_MS).toISOString();
  const question = 'CI 在 Node 22 上偶发超时，是不是 runtime 的超时预算太紧？';
  const answer =
    '看了三段日志：超时都发生在 sandbox 启动之后第 28 分钟，预算 30 分钟——不是预算紧，是 turn 内层没有心跳。' +
    '把 turn 预算改成 20 分钟、外层保留 30 分钟就能把这类失败提前暴露成 timed-out 而不是 sandbox-crash。';

  return {
    list: {
      repo: REPO_MAIN,
      kind: 'issue',
      number: 42,
      title: 'CI 在 Node 22 上偶发超时',
      url: issueUrl(REPO_MAIN, 42),
      state: 'closed',
      lastActivityAt: at(90),
      humanTurns: 1,
      botTurns: 1,
      labels: ['needs-info'],
      outcomes: { succeeded: 1 },
      lastPreview: previewOf(answer),
      // 一轮正常闭环：入队 eyes → 成功 rocket（`reactionState` 由时间线推出 = succeeded / rocket）
      feedback: [
        { stage: 'received', content: 'eyes', appliedAt: at(94), at: at(94), commentId: '420000' },
        { stage: 'succeeded', content: 'rocket', appliedAt: at(89), at: at(89), commentId: '420000' },
      ],
      // 已经结束（人工关闭）：`closed/closed`，类别是 other（只打过标签，没发评论）
      pipeline: {
        stage: 'closed',
        state: 'closed',
        category: 'other',
        formatFailCount: 0,
        infoRequestedAt: null,
        blockedReason: null,
        readyAt: at(200),
        staleAt: null,
        sessionId: 'sess-42-agent',
        sessionTurns: 1,
      },
    },
    participants: ['bob', BOT_LOGIN],
    turns: [
      {
        id: 'task:77aa01',
        role: 'human',
        login: 'bob',
        at: at(96),
        channel: 'auto',
        text: question,
        commentUrl: `${issueUrl(REPO_MAIN, 42)}#issuecomment-420001`,
        labels: [],
        status: 'succeeded',
        failureClass: null,
        taskId: 't-42-1',
        toolCalls: [],
      },
      {
        id: 'run:77aa02',
        role: 'bot',
        login: BOT_LOGIN,
        at: at(90),
        channel: null,
        text: answer,
        commentUrl: `${issueUrl(REPO_MAIN, 42)}#issuecomment-420002`,
        labels: ['needs-info'],
        status: 'succeeded',
        failureClass: null,
        taskId: 't-42-1',
        toolCalls: [
          {
            name: 'bash/exec',
            summary: 'pnpm -r test（在 sandbox 里跑，取到了第 28 分钟的失败点）',
            at: at(94),
            ok: true,
          },
        ],
      },
    ],
  };
}

/** `other/lib#7`：只有人类提问、机器人还没回（详情页「一轮」的边界形态）。 */
function storyWaiting(now: number): IssueRecord {
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * MINUTE_MS).toISOString();
  const question = 'build 脚本能不能强制 --frozen-lockfile？我们上周被锁文件漂移坑过一次。';

  return {
    list: {
      repo: REPO_OTHER,
      kind: 'issue',
      number: 7,
      title: 'build 脚本能否强制 --frozen-lockfile',
      url: issueUrl(REPO_OTHER, 7),
      state: 'unknown',
      lastActivityAt: at(6),
      humanTurns: 1,
      botTurns: 0,
      labels: [],
      outcomes: { queued: 1 },
      lastPreview: previewOf(question),
      /*
       * 还没跑完：只有入队那条 `eyes`，而且 `appliedAt` 还是 null（dry-run / 排队中）——
       * 详情页的 `pendingFeedback` 就是靠它展示「计划了但没落地」。
       * `reactionState` 因此是 null（`received` 不算终态）。
       */
      feedback: [{ stage: 'received', content: 'eyes', appliedAt: null, at: at(6), commentId: '70000' }],
      // 阶段 0 不通过、等作者补充（`infoRequestedAt` 非空 ⇒ 进 48h 自动关闭扫描）
      pipeline: {
        stage: 'format',
        state: 'awaiting_info',
        category: null,
        formatFailCount: 2,
        infoRequestedAt: at(30 * 60),
        blockedReason: null,
        readyAt: null,
        staleAt: null,
        sessionId: null,
        sessionTurns: 0,
      },
    },
    participants: ['carol'],
    turns: [
      {
        id: 'task:55cc01',
        role: 'human',
        login: 'carol',
        at: at(6),
        channel: 'mention',
        text: question,
        commentUrl: `${issueUrl(REPO_OTHER, 7)}#issuecomment-70001`,
        labels: [],
        status: 'queued',
        failureClass: null,
        taskId: 't-7-1',
        toolCalls: [],
      },
    ],
  };
}

/**
 * `acme/widgets#88`：**分类结论 + 证据**的样本（详情页的证据两栏与「等管理员」）。
 *
 * - `classify/awaiting_info`：not-found 停在等管理员（`infoRequestedAt` 为空，**不进** 48h 自动关闭）；
 * - 最后一轮是分类任务（`taskId = t-classify-88`）：`GET /api/tasks/t-classify-88` 的信封里带
 *   `verdict.evidence`（`rule=code:*` 与 `rule=checked:*`），详情页据此渲染两栏；
 * - 类别 `not-found`：不打缺陷标签，`@managers` 等回复。
 */
function storyLostEvidence(now: number): IssueRecord {
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * MINUTE_MS).toISOString();
  const question = '搜索排名疑似被人工降权：同样的关键词上周还能搜到，现在掉到第 4 页。请确认是不是代码里加了权重惩罚。';
  const classifyComment =
    '无法分类：在 apps/server 与 apps/panel 里都没找到「权重惩罚 / 降权」相关代码，也没有排序权重的可调参数。' +
    '已查范围：apps/server/src/search/**、apps/panel/src/**；需要维护者补充：具体查询词、复现时间、是否改过索引配置。';

  return {
    list: {
      repo: REPO_MAIN,
      kind: 'issue',
      number: 88,
      title: '搜索排名疑似被人工降权（查不到证据）',
      url: issueUrl(REPO_MAIN, 88),
      state: 'open',
      lastActivityAt: at(15 * 60),
      humanTurns: 1,
      botTurns: 1,
      labels: [],
      outcomes: { succeeded: 1 },
      lastPreview: previewOf(classifyComment),
      lastActorKind: 'bot',
      lastActorLogin: BOT_LOGIN,
      pipeline: {
        stage: 'classify',
        state: 'awaiting_info',
        category: 'not-found',
        formatFailCount: 0,
        // 等管理员（不是等作者）：`info_requested_at = NULL`，不进 48h 关闭扫描
        infoRequestedAt: null,
        blockedReason: null,
        readyAt: null,
        staleAt: null,
        sessionId: null,
        sessionTurns: 0,
      },
    },
    participants: ['erin', BOT_LOGIN],
    turns: [
      {
        id: 'task:88aa01',
        role: 'human',
        login: 'erin',
        at: at(16 * 60),
        channel: 'auto',
        text: question,
        commentUrl: `${issueUrl(REPO_MAIN, 88)}#issuecomment-880001`,
        labels: [],
        status: 'succeeded',
        failureClass: null,
        taskId: 't-88-format',
        toolCalls: [],
      },
      {
        id: 'run:88aa02',
        role: 'bot',
        login: BOT_LOGIN,
        at: at(15 * 60),
        channel: null,
        text: classifyComment,
        commentUrl: `${issueUrl(REPO_MAIN, 88)}#issuecomment-880002`,
        labels: [],
        status: 'succeeded',
        failureClass: null,
        // 分类任务：任务详情里带 verdict.evidence（面板的两栏证据就来自这里）
        taskId: 't-classify-88',
        toolCalls: [],
      },
    ],
  };
}

/** 填充条目：让列表有两页可翻（超出 4 条「有故事」的）。 */
function filler(index: number, now: number): IssueRecord {
  const minutesAgo = 300 + index * 45;
  const at = new Date(now - minutesAgo * MINUTE_MS).toISOString();
  const repo = index % 2 === 0 ? REPO_MAIN : REPO_OTHER;
  const number = 100 + index;
  const question = `第 ${String(index + 1)} 条演示 issue：这个告警需要我处理吗？`;
  const answer = `第 ${String(index + 1)} 条演示回答：查了下 run_events，这一轮是正常结束的，不需要处理。`;

  return {
    list: {
      repo,
      kind: 'issue',
      number,
      title: `演示 issue ${String(number)}：告警是否需要处理`,
      url: issueUrl(repo, number),
      state: index % 3 === 2 ? 'closed' : 'open',
      lastActivityAt: at,
      humanTurns: 1,
      botTurns: 1,
      labels: index % 4 === 1 ? ['question'] : [],
      outcomes: { succeeded: 1 },
      lastPreview: previewOf(answer),
      /*
       * 三类填充行覆盖看板的三种形态：
       *  - `index % 3 === 0`：阶段 0 排队（`format/pending`），没有时间锚点 → 停留列走最后活动兜底；
       *  - `index % 3 === 1`：`agent/blocked`（信封连续 2 次不合法），带 `blockedReason`；
       *  - 其余：**没有流水线行**（`null`）→ 看板的「未入流水线」与列表的「未入流水线」徽章。
       */
      pipeline:
        index % 3 === 0
          ? {
              stage: 'format',
              state: 'pending',
              category: null,
              formatFailCount: 0,
              infoRequestedAt: null,
              blockedReason: null,
              readyAt: null,
              staleAt: null,
              sessionId: null,
              sessionTurns: 0,
            }
          : index % 3 === 1
            ? {
                stage: 'agent',
                state: 'blocked',
                category: 'requirement',
                formatFailCount: 3,
                infoRequestedAt: null,
                blockedReason: '信封连续 2 次不合法（fail_streak=2）',
                readyAt: at,
                staleAt: null,
                sessionId: `sess-demo-${String(number)}`,
                sessionTurns: 26,
              }
            : null,
    },
    participants: ['dana', BOT_LOGIN],
    turns: [
      {
        id: `task:demo-${String(number)}`,
        role: 'human',
        login: 'dana',
        at,
        channel: 'mention',
        text: question,
        commentUrl: `${issueUrl(repo, number)}#issuecomment-${String(number)}001`,
        labels: [],
        status: 'succeeded',
        failureClass: null,
        taskId: `t-demo-${String(number)}`,
        toolCalls: [],
      },
      {
        id: `run:demo-${String(number)}`,
        role: 'bot',
        login: BOT_LOGIN,
        at: new Date(Date.parse(at) + 2 * MINUTE_MS).toISOString(),
        channel: null,
        text: answer,
        commentUrl: `${issueUrl(repo, number)}#issuecomment-${String(number)}002`,
        labels: [],
        status: 'succeeded',
        failureClass: null,
        taskId: `t-demo-${String(number)}`,
        toolCalls: [],
      },
    ],
  };
}

/** 数据集：3 条有故事的 + 9 条填充 = 12 条（每页 10 条 → 两页）。 */
function buildIssueRecords(now: number = Date.now()): IssueRecord[] {
  return [
    storyEacces(now),
    storyClosedOne(now),
    storyWaiting(now),
    storyLostEvidence(now),
    ...Array.from({ length: 9 }, (_, index) => filler(index, now)),
  ].sort((left, right) => Date.parse(right.list.lastActivityAt) - Date.parse(left.list.lastActivityAt));
}

function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${String(number)}`;
}

/** 请求参数不合法 → 400 / 422（mock 也替服务端说话，页面的错误分支才有路可走）。 */
class MockIssueRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MockIssueRequestError';
    this.status = status;
    this.code = code;
  }
}

function readLimit(raw: string | null): number {
  if (raw === null || raw === '') return ISSUES_DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > ISSUES_MAX_LIMIT) {
    throw new MockIssueRequestError(
      400,
      'bad-request',
      `limit 必须是 1–${String(ISSUES_MAX_LIMIT)} 的整数`,
    );
  }
  return value;
}

function readKind(raw: string | null): IssueKind {
  if (raw === null || raw === '') return 'issue';
  if (raw === 'issue' || raw === 'pr') return raw;
  throw new MockIssueRequestError(400, 'bad-request', 'kind 只能是 issue 或 pr');
}

/** 游标解码：`i:<偏移>`；空 → 第一页；其它形态一律 400（契约：cursor 不透明，客户端不得自造）。 */
function readCursor(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  if (!raw.startsWith(CURSOR_PREFIX)) {
    throw new MockIssueRequestError(400, 'bad-request', 'cursor 不合法');
  }
  const offset = Number(raw.slice(CURSOR_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MockIssueRequestError(400, 'bad-request', 'cursor 不合法');
  }
  return offset;
}

/** 纯函数：查询串 → `IssuesResponse`（handler 与测试共用同一份实现）。 */
export function buildIssuesResponse(search: string, now: number = Date.now()): IssuesResponse {
  const params = new URLSearchParams(search);
  const repo = params.get('repo');
  const kind = readKind(params.get('kind'));
  const q = params.get('q');
  const limit = readLimit(params.get('limit'));
  const offset = readCursor(params.get('cursor'));

  const filtered = buildIssueRecords(now).filter((record) => {
    const item = record.list;
    if (item.kind !== kind) return false;
    if (repo !== null && repo !== '' && item.repo !== repo) return false;
    if (q !== null && q !== '') {
      const needle = q.toLowerCase();
      const haystack = `${item.title ?? ''} #${String(item.number)}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < filtered.length;

  return {
    generatedAt: new Date(now).toISOString(),
    issues: page.map((record) => finalizeList(record.list)),
    hasMore,
    nextCursor: hasMore ? `${CURSOR_PREFIX}${String(nextOffset)}` : null,
  };
}

/** `?mock=empty` 用的空响应（不是「筛不出结果」，是「库里有 0 条」）。 */
export function buildEmptyIssuesResponse(now: number = Date.now()): IssuesResponse {
  return { generatedAt: new Date(now).toISOString(), issues: [], hasMore: false, nextCursor: null };
}

/**
 * 一个 issue = 一个 session 的完整样本；`null` 表示没有任何人类触发（契约 §3.2 的 404）。
 */
export function buildIssueSessionResponse(
  owner: string,
  name: string,
  kind: string,
  number: string,
  now: number = Date.now(),
): IssueSessionResponse | null {
  const repo = `${owner}/${name}`;
  const parsed = Number(number);
  if (!Number.isInteger(parsed)) return null;

  const record = buildIssueRecords(now).find(
    (candidate) =>
      candidate.list.repo === repo &&
      candidate.list.kind === kind &&
      candidate.list.number === parsed,
  );
  if (record === undefined) return null;

  const item = finalizeList(record.list);
  return {
    generatedAt: new Date(now).toISOString(),
    issue: {
      repo: item.repo,
      kind: item.kind,
      number: item.number,
      title: item.title,
      url: item.url,
      state: item.state,
      stateStale: item.stateStale,
      labels: item.labels,
      participants: record.participants,
      reactionState: item.reactionState,
      // 记了台账但还没落地的那几条（dry-run 计划 / 排队中）
      pendingFeedback: item.feedback.filter((event) => event.appliedAt === null),
      pipeline: item.pipeline,
    },
    turns: record.turns.map(finalizeTurn),
  };
}

function errorResponse(error: MockIssueRequestError): Response {
  return HttpResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

/** 详情：`/api/issues/:owner/:name/:kind/:number`（`repo` 含 `/`，所以拆四段）。 */
export const issueSessionHandlers: HttpHandler[] = [
  http.get('/api/issues/:owner/:name/:kind/:number', ({ params }) => {
    const owner = String(params['owner']);
    const name = String(params['name']);
    const kind = String(params['kind']);
    const number = String(params['number']);

    if (kind !== 'issue' && kind !== 'pr') {
      return HttpResponse.json(
        { error: { code: 'bad-request', message: 'kind 只能是 issue 或 pr' } },
        { status: 400 },
      );
    }

    const data = buildIssueSessionResponse(owner, name, kind, number);
    if (data === null) {
      // 契约 §3.2：没有任何 `tasks` 行 → 404 `not-found`
      return HttpResponse.json(
        { error: { code: 'not-found', message: '这个 issue 没有会话记录' } },
        { status: 404 },
      );
    }

    return scenarioResponse({
      data,
      empty: { ...data, turns: [] },
      slowMs: 600,
    });
  }),
];

/** 列表：`/api/issues`。 */
export const issuesHandlers: HttpHandler[] = [
  http.get('/api/issues', ({ request }) => {
    const search = new URL(request.url).search;
    let data: IssuesResponse;
    try {
      data = buildIssuesResponse(search);
    } catch (error) {
      if (error instanceof MockIssueRequestError) return errorResponse(error);
      throw error;
    }
    return scenarioResponse({ data, empty: buildEmptyIssuesResponse() });
  }),
];
