/**
 * 写执行器的单测（B12 / tech-plan §5.4、§5.6）。
 *
 * 覆盖点与 tech-plan 的表格一一对应：
 *  - 标记生成与去重：正文变 → 新评论；正文不变 → 不重复；**不同 taskId 不影响去重**
 *  - 标签归属：人打过的标签 bot 不得删除
 *  - `create_issue` 三态：create / comment_only / quota_exceeded
 *  - `push_branch` 缺 `paths` → 判不合规
 *  - `close_issue` 只接受外部布尔，不成立时不发任何请求
 * 全部使用假 `GithubWriteApi`，不发真实请求。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_ISSUE_QUOTA,
  buildMarker,
  composeCommentBody,
  decideCloseIssue,
  decideCreateIssue,
  dispatchWriteAction,
  executeAddReaction,
  executeCloseIssue,
  executeComment,
  executeCreateIssue,
  executeLabelPlan,
  executeRemoveOwnReactions,
  findExisting,
  hashCommentBody,
  isOwnReactionLogin,
  normalizeCommentBody,
  parseMarkers,
  pickOwnReactionIds,
  planComment,
  planLabelDelta,
  planPushBranch,
  shouldPost,
  validateOpenPr,
  validatePushBranch,
  withTransientRetry,
} from '../src/github/executor.ts';
import type { BotLabelLedger, CloseIssueInput } from '../src/github/executor.ts';
import type { GithubReactionApi, ReactionEntry } from '../src/github/types.ts';
import { createFakeWriteApi } from './helpers/fake-github.ts';

const REPO = 'acme/widgets';
const TARGET = 42;
const INTENT = 'triage';
const BODY = '缺少复现步骤与版本号，请补充后重新打开。';

const baseInput = { repo: REPO, target: TARGET, intent: INTENT, body: BODY };

describe('comment 隐藏标记与去重（tech-plan §5.4）', () => {
  it('标记格式是 `<!-- pi-bot:<repo>#<target>:<intent>:<sha256前16位> -->`', () => {
    const marker = buildMarker(baseInput);
    expect(marker).toMatch(/^<!-- pi-bot:acme\/widgets#42:triage:[0-9a-f]{16} -->$/);
    expect(marker).toContain(hashCommentBody(BODY));
  });

  it('正文不变（仅换行/行尾空白差异）→ 不重复发', () => {
    const marker = buildMarker(baseInput);
    const comments = [{ id: 7, body: composeCommentBody(BODY, marker) }];
    const sameMeaning = { ...baseInput, body: '缺少复现步骤与版本号，请补充后重新打开。  \r\n' };

    expect(shouldPost(sameMeaning, comments)).toBe(false);
    expect(findExisting(sameMeaning, comments)?.id).toBe(7);
  });

  it('正文变了 → 算新评论（改稿不算重复）', () => {
    const marker = buildMarker(baseInput);
    const comments = [{ id: 7, body: composeCommentBody(BODY, marker) }];
    const edited = { ...baseInput, body: `${BODY}\n另外请附上日志。` };

    expect(buildMarker(edited)).not.toBe(marker);
    expect(shouldPost(edited, comments)).toBe(true);
    expect(planComment(edited, comments).action).toBe('post');
  });

  it('不同 taskId 不影响去重（标记里根本没有 task id，F7）', () => {
    const withTaskId = { ...baseInput, taskId: '0192f0aa-7f1c-7c3a-9d1e-2b4c6d8e0f12', task_id: 1 };
    const marker = buildMarker(withTaskId as typeof baseInput);

    expect(marker).toBe(buildMarker(baseInput));
    expect(marker).not.toContain('0192f0aa');
    // 反证：解析出来的标记也只有 repo/target/intent/bodyHash 四项
    expect(parseMarkers(marker)).toEqual([
      { repo: REPO, target: TARGET, intent: INTENT, bodyHash: hashCommentBody(BODY) },
    ]);
  });

  it('我们发出去的正文再次进来时，归一化结果与原文一致（不会把自己判成新内容）', () => {
    const marker = buildMarker(baseInput);
    const posted = composeCommentBody(BODY, marker);

    expect(normalizeCommentBody(posted)).toBe(normalizeCommentBody(BODY));
    expect(hashCommentBody(posted)).toBe(hashCommentBody(BODY));
  });

  it('只发一次：同一动作重复执行时第二次跳过（人工通道 intent=comment）', async () => {
    const api = createFakeWriteApi();
    // 去重只对**人工通道**生效（W2-D 第 4 条）：intent 是 `comment` / `fallback` 才走标记。
    const humanInput = { ...baseInput, intent: 'comment' };
    const first = await executeComment(api, humanInput);
    const second = await executeComment(api, humanInput);

    expect(first.action).toBe('posted');
    expect(second.action).toBe('skipped');
    expect(second.commentId).toBe(first.commentId);
    expect(api.calls.filter((call) => call.method === 'createIssueComment')).toHaveLength(1);
  });

  it('标记字段不合法时直接报错（不接受空 repo / 非正 target / 带冒号的 intent）', () => {
    expect(() => buildMarker({ ...baseInput, repo: 'widgets' })).toThrow(/owner\/name/);
    expect(() => buildMarker({ ...baseInput, target: 0 })).toThrow(/正整数/);
    expect(() => buildMarker({ ...baseInput, intent: 'a:b' })).toThrow(/intent/);
  });
});

describe('标签归属：只动自己打过的（plan §6.1）', () => {
  it('人先打的 bug 不会被删除，bot 打的 needs-info 会被撤掉', () => {
    const delta = planLabelDelta(['bug', 'needs-info'], ['needs-info'], ['question']);

    expect(delta.add).toEqual(['question']);
    expect(delta.remove).toEqual(['needs-info']);
    expect(delta.retainHumanOwned).toEqual(['bug']);
    expect(delta.remove).not.toContain('bug');
  });

  it('执行时只把我们自己的标签交给 API，人打的一个都不传', async () => {
    const api = createFakeWriteApi();
    const ledgers: string[] = [];
    const ledger: BotLabelLedger = {
      recordApplied: (input) => {
        ledgers.push(`applied:${input.labels.join(',')}`);
      },
      recordRemoved: (input) => {
        ledgers.push(`removed:${input.labels.join(',')}`);
      },
    };

    const outcome = await executeLabelPlan(
      api,
      {
        repo: REPO,
        issueNumber: TARGET,
        current: ['bug', 'needs-info'],
        botLabels: ['needs-info'],
        desired: ['question'],
      },
      ledger,
    );

    expect(outcome.added).toEqual(['question']);
    expect(outcome.removed).toEqual(['needs-info']);

    const removeCalls = api.calls.filter((call) => call.method === 'removeLabel');
    expect(removeCalls.map((call) => call.input['label'])).toEqual(['needs-info']);
    expect(JSON.stringify(api.calls)).not.toContain('"bug"');
    expect(ledgers).toEqual(['applied:question', 'removed:needs-info']);
  });
});

describe('create_issue 三态（plan §6.3）', () => {
  const decisionInput = {
    repo: REPO,
    fingerprint: 'fp-001',
    fingerprintKnown: false,
    createdToday: 3,
  };

  it('三态：create / comment_only / quota_exceeded', () => {
    expect(decideCreateIssue(decisionInput).action).toBe('create');
    expect(decideCreateIssue({ ...decisionInput, fingerprintKnown: true }).action).toBe(
      'comment_only',
    );
    expect(
      decideCreateIssue({
        ...decisionInput,
        createdToday: DEFAULT_DAILY_ISSUE_QUOTA,
      }).action,
    ).toBe('quota_exceeded');
  });

  it('去重优先于配额：命中指纹且今日已超配额时仍是 comment_only', () => {
    const decision = decideCreateIssue({
      ...decisionInput,
      fingerprintKnown: true,
      createdToday: DEFAULT_DAILY_ISSUE_QUOTA + 5,
    });
    expect(decision.action).toBe('comment_only');
  });

  it('超配额时不发任何请求（写入待办队列由调用方负责）', async () => {
    const api = createFakeWriteApi();
    const outcome = await executeCreateIssue(api, {
      ...decisionInput,
      createdToday: DEFAULT_DAILY_ISSUE_QUOTA,
      title: '依赖告警',
      body: '正文',
    });

    expect(outcome.decision.action).toBe('quota_exceeded');
    expect(outcome.issueNumber).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('命中指纹时在既有 issue 上追加评论而不是新开', async () => {
    const api = createFakeWriteApi();
    const outcome = await executeCreateIssue(api, {
      ...decisionInput,
      fingerprintKnown: true,
      existingIssueNumber: 7,
      title: '依赖告警',
      body: '又出现一次',
    });

    expect(outcome.commentedOn).toBe(7);
    expect(outcome.issueNumber).toBeNull();
    expect(api.calls.map((call) => call.method)).toEqual(['createIssueComment']);
  });
});

describe('push_branch / open_pr：本层只校验与分派（tech-plan §5.6）', () => {
  it('缺 paths 判不合规', () => {
    const noPaths = { repo: REPO, branch: 'bot/fix-1' } as unknown as Parameters<
      typeof validatePushBranch
    >[0];
    const compliance = validatePushBranch(noPaths);

    expect(compliance.compliant).toBe(false);
    expect(compliance.reasons.join('|')).toContain('paths');
  });

  it('空 paths、绝对路径、".." 段、非 bot/* 分支都不合规', () => {
    expect(validatePushBranch({ repo: REPO, branch: 'bot/x', paths: [] }).compliant).toBe(false);
    expect(validatePushBranch({ repo: REPO, branch: 'bot/x', paths: ['/etc/passwd'] }).compliant).toBe(
      false,
    );
    expect(validatePushBranch({ repo: REPO, branch: 'bot/x', paths: ['../.env'] }).compliant).toBe(
      false,
    );
    expect(validatePushBranch({ repo: REPO, branch: 'main', paths: ['src/a.ts'] }).compliant).toBe(
      false,
    );
  });

  it('合规的 push_branch 会变成交给 git/ owner 的计划，本层不执行', async () => {
    const api = createFakeWriteApi();
    const plan = planPushBranch({ repo: REPO, branch: 'bot/42-triage', paths: ['src/a.ts'] });

    expect(plan.compliance.compliant).toBe(true);
    expect(plan.owner).toBe('git');
    expect(plan.kind).toBe('push_branch');

    const result = await dispatchWriteAction(
      { kind: 'push_branch', repo: REPO, branch: 'bot/42-triage', paths: ['src/a.ts'] },
      { api },
    );
    expect(result.kind).toBe('delegated');
    expect(api.calls).toEqual([]);
  });

  it('open_pr 的 head 必须是 bot/* 分支', () => {
    expect(
      validateOpenPr({ repo: REPO, head: 'main', base: 'main', title: 'x' }).compliant,
    ).toBe(false);
    expect(
      validateOpenPr({ repo: REPO, head: 'bot/42-triage', base: 'main', title: 'x' }).compliant,
    ).toBe(true);
  });
});

describe('close_issue：只接受外部判定（tech-plan §7.2 的边界）', () => {
  const baseClose: CloseIssueInput = {
    repo: REPO,
    issueNumber: TARGET,
    deterministicConditionSatisfied: false,
  };

  it('条件未满足 → skip，且不发任何请求', async () => {
    const api = createFakeWriteApi();

    expect(decideCloseIssue(baseClose).action).toBe('skip');
    const decision = await executeCloseIssue(api, baseClose);
    expect(decision.action).toBe('skip');
    expect(api.calls).toEqual([]);
  });

  it('条件满足 → 关闭，reason 走 not_planned', async () => {
    const api = createFakeWriteApi();
    const decision = await executeCloseIssue(api, {
      ...baseClose,
      deterministicConditionSatisfied: true,
    });

    expect(decision.action).toBe('close');
    expect(api.calls.map((call) => call.method)).toEqual(['closeIssue']);
    expect(api.calls[0]?.input['reason']).toBe('not_planned');
  });
});

/**
 * 假的 reaction 写面（W2-D）：记录调用，`entries` 是 `listReactions` 的数据源。
 *
 * `failures` 让单测逐次注入失败（429 / 403 / 5xx），从而钉住「重试 1 次」与降级路径。
 */
function createFakeReactionApi(seed: {
  readonly entries?: readonly ReactionEntry[];
  readonly failures?: readonly unknown[];
} = {}): GithubReactionApi & {
  readonly calls: string[];
  readonly addCalls: { issueNumber: number; content: string; commentId?: number | null }[];
  readonly removed: number[];
} {
  const calls: string[] = [];
  const addCalls: { issueNumber: number; content: string; commentId?: number | null }[] = [];
  const removed: number[] = [];
  const entries = [...(seed.entries ?? [])];
  const failures = [...(seed.failures ?? [])];
  let nextId = 9000;

  const takeFailure = (): void => {
    const failure = failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  };

  return {
    calls,
    addCalls,
    removed,
    async addReaction(input) {
      calls.push(`add:${input.content}`);
      takeFailure();
      nextId += 1;
      addCalls.push({
        issueNumber: input.issueNumber,
        content: input.content,
        ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
      });
      return { id: nextId };
    },
    async listReactions(input) {
      calls.push(`list:${input.content}`);
      takeFailure();
      return entries.filter((entry) => entry.content === input.content);
    },
    async removeReaction(input) {
      calls.push(`remove:${String(input.reactionId)}`);
      takeFailure();
      removed.push(input.reactionId);
    },
  };
}

describe('reaction：无感反馈的判定与执行（W2-D）', () => {
  it('归属判定：只看 [bot] 后缀与 App slug，人打的 reaction 不算自己的', () => {
    expect(isOwnReactionLogin('pi-issue-bot[bot]', null)).toBe(true);
    expect(isOwnReactionLogin('pi-issue-bot[bot]', 'pi-issue-bot')).toBe(true);
    expect(isOwnReactionLogin('pi-issue-bot', 'pi-issue-bot')).toBe(true);
    expect(isOwnReactionLogin('alice', 'pi-issue-bot')).toBe(false);
    expect(isOwnReactionLogin(null, 'pi-issue-bot')).toBe(false);

    const entries: ReactionEntry[] = [
      { id: 1, content: 'eyes', userLogin: 'pi-issue-bot[bot]' },
      { id: 2, content: 'eyes', userLogin: 'alice' },
      { id: 3, content: 'eyes', userLogin: null },
    ];
    expect(pickOwnReactionIds(entries, 'pi-issue-bot')).toEqual([1]);
  });

  it('加 reaction 不先查（同 content 重复 POST 幂等）：只发一次 POST', async () => {
    const api = createFakeReactionApi();
    const outcome = await executeAddReaction(api, {
      repo: REPO,
      issueNumber: TARGET,
      content: 'rocket',
    });

    expect(outcome.action).toBe('added');
    expect(outcome.reactionId).toBe(9001);
    expect(api.calls).toEqual(['add:rocket']);
  });

  it('删 reaction：只删自己打的，别人的留着；一条都没有就算 skipped', async () => {
    const api = createFakeReactionApi({
      entries: [
        { id: 11, content: 'eyes', userLogin: 'pi-issue-bot[bot]' },
        { id: 12, content: 'eyes', userLogin: 'alice' },
      ],
    });

    const done = await executeRemoveOwnReactions(api, {
      repo: REPO,
      issueNumber: TARGET,
      content: 'eyes',
    });
    expect(done.action).toBe('removed');
    expect(done.removed).toEqual([11]);
    expect(api.removed).toEqual([11]);

    const empty = createFakeReactionApi({
      entries: [{ id: 13, content: 'eyes', userLogin: 'alice' }],
    });
    const skipped = await executeRemoveOwnReactions(empty, {
      repo: REPO,
      issueNumber: TARGET,
      content: 'eyes',
    });
    expect(skipped.action).toBe('skipped');
    expect(empty.removed).toEqual([]);
  });

  it('429 / 5xx / 网络抖动只重试 1 次；403 与 4xx 不重试', async () => {
    const transient = async (): Promise<string> => {
      throw Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    };
    let attempts = 0;
    await expect(
      withTransientRetry(async () => {
        attempts += 1;
        return transient();
      }),
    ).rejects.toMatchObject({ info: { status: 429 } });
    expect(attempts).toBe(2);

    const forbidden = async (): Promise<string> => {
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    };
    let forbiddenAttempts = 0;
    await expect(
      withTransientRetry(async () => {
        forbiddenAttempts += 1;
        return forbidden();
      }),
    ).rejects.toMatchObject({ info: { class: 'auth', status: 403 } });
    expect(forbiddenAttempts).toBe(1);
  });

  it('分派：reaction.add / reaction.remove 走注入的 reaction 写面；没注入则明确失败', async () => {
    const api = createFakeWriteApi();
    const reactions = createFakeReactionApi();

    const added = await dispatchWriteAction(
      { kind: 'reaction.add', repo: REPO, target: TARGET, content: 'rocket' },
      { api, reactions },
    );
    expect(added.kind).toBe('reaction');
    expect(reactions.addCalls).toEqual([{ issueNumber: TARGET, content: 'rocket' }]);
    // 写面（评论/打标）一次都没被碰
    expect(api.calls).toEqual([]);

    const removed = await dispatchWriteAction(
      { kind: 'reaction.remove', repo: REPO, target: TARGET, content: 'eyes' },
      { api, reactions },
    );
    expect(removed.kind).toBe('reaction');

    await expect(
      dispatchWriteAction(
        { kind: 'reaction.add', repo: REPO, target: TARGET, content: 'eyes' },
        { api },
      ),
    ).rejects.toThrow(/reaction 写面未注入/);
  });
});

describe('动作分派', () => {
  it('comment 动作（人工通道）走注入的写接口，并带上标记', async () => {
    const api = createFakeWriteApi();
    const result = await dispatchWriteAction(
      { kind: 'comment', repo: REPO, target: TARGET, intent: 'comment', body: BODY },
      { api },
    );

    expect(result.kind).toBe('comment');
    const created = api.calls.find((call) => call.method === 'createIssueComment');
    expect(String(created?.input['body'])).toContain(buildMarker({ ...baseInput, intent: 'comment' }));
  });

  it('打标/反馈类评论（intent=triage）不带标记、也不列评论：这类评论已退役（W2-D 第 4 条）', async () => {
    const api = createFakeWriteApi();
    const result = await dispatchWriteAction(
      { kind: 'comment', repo: REPO, target: TARGET, intent: 'triage', body: BODY },
      { api },
    );

    expect(result.kind).toBe('comment');
    if (result.kind !== 'comment') {
      throw new Error('期望 comment 分派结果');
    }
    expect(result.outcome.dedupe).toBe('none');
    expect(result.outcome.marker).toBe('');
    // 一次写都没有「先查」：标记去重只属于人工通道
    expect(api.calls.map((call) => call.method)).toEqual(['createIssueComment']);
    expect(String(api.calls[0]?.input['body'])).toBe(BODY);
  });
});
