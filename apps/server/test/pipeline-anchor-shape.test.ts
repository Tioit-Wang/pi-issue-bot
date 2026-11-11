/**
 * 幂等锚的**字符串形状**（`docs/test-plan-fixed-pipeline.md` §6.2 P2-5 / §4 B4）。
 *
 * 锚（`tasks.idempotency_key` 的原料，`queue/idempotency.ts` 对它做 sha256）有两段约定：
 *  - 前缀只在**入队处拼一次**：`pipelineAnchor(stage, issueVersion)` → `pipeline:<stage>:<version>`；
 *  - 评论补充再追加一段：`pipeline:format:<version>:<commentId>`，原料由
 *    `supplementPlanFor()` 给出（`${issueVersion}:${commentId}`），列里只存裸版本（`bareIssueVersion()`）。
 *
 * 为什么值得单测：锚拼错**不报错**，只会让唯一索引静默失效——症状是「同一版内容被跑两遍」
 * 或「换一条评论补同样内容被吞掉」，而且从失败日志里看不出来。行为层的 `S1-55` / `S2-20`
 * 只能证明「当前这条路径恰好正确」，钉不住形状本身。
 */
import { describe, expect, it } from 'vitest';

import { idempotencyParts } from '../src/queue/idempotency.ts';
import { bareIssueVersion, pipelineAnchor } from '../src/workflows/pipeline.ts';
import { supplementPlanFor } from '../src/http/webhook.ts';
import type { PipelineSupplementDecision } from '../src/http/webhook.ts';

const REPO = 'acme/widgets';

/** 一条「评论补充」决策：锚的原料是 `issueVersion` + `commentId`。 */
function supplementDecision(over: Partial<PipelineSupplementDecision> = {}): PipelineSupplementDecision {
  return {
    action: 'pipeline-supplement',
    targetNumber: 7,
    isPullRequest: false,
    actorLogin: 'author',
    association: 'OWNER',
    commentId: 777,
    body: '补上复现步骤',
    issueVersion: 'v1',
    title: '登录时报 500',
    issueBody: '复现步骤：……',
    issueAuthor: 'author',
    ...over,
  };
}

describe('P2-5：阶段锚的形状（pipelineAnchor）', () => {
  it('pipelineAnchor(\'format\', \'v1\') === \'pipeline:format:v1\'（版本缺省给 none）', () => {
    expect(pipelineAnchor('format', 'v1')).toBe('pipeline:format:v1');
    expect(pipelineAnchor('classify', 'v1')).toBe('pipeline:classify:v1');
    // 没有版本时不给空串（`pipeline:format:` 会被当成「和谁都不同」的键）
    expect(pipelineAnchor('format', null)).toBe('pipeline:format:none');
  });
});

describe('P2-5：补充锚的形状（pipeline:format:<version>:<commentId>）', () => {
  it('supplementPlanFor 给的是原料 \'v1:777\'，入队处拼成 \'pipeline:format:v1:777\'', () => {
    const plan = supplementPlanFor(supplementDecision(), 'format');
    expect(plan.command).toBe('pipeline:format');
    expect(plan.issueVersionHash).toBe('v1:777');
    // 入队处（`compose.ts::enqueueStageTask()`）只做这一次拼接
    expect(pipelineAnchor('format', plan.issueVersionHash)).toBe('pipeline:format:v1:777');
    // 幂等五项里就是这整串（哈希前的原料），换 commentId 才换键
    expect(idempotencyParts({
      kind: plan.kind,
      repo: REPO,
      target: `${plan.targetKind}#${String(plan.targetNumber)}`,
      headSha: plan.headSha,
      missingSetHash: plan.issueVersionHash,
      triggerActor: plan.idempotencyActor ?? plan.actorLogin,
    })).toEqual(['pipeline', REPO, 'issue#7', 'v1:777', 'pipeline']);
  });

  it('classify 通道同理；同一条评论的两次投递给出同一个锚，换一条评论就换锚', () => {
    const classify = supplementPlanFor(supplementDecision({ commentId: 778 }), 'classify');
    expect(pipelineAnchor('classify', classify.issueVersionHash)).toBe('pipeline:classify:v1:778');

    const first = supplementPlanFor(supplementDecision(), 'format');
    const again = supplementPlanFor(supplementDecision(), 'format');
    expect(again.issueVersionHash).toBe(first.issueVersionHash);
    expect(supplementPlanFor(supplementDecision({ commentId: 779 }), 'format').issueVersionHash).not.toBe(
      first.issueVersionHash,
    );
    // commentId 缺失时与会话里其它占位一致，用 none（不是空串）
    expect(supplementPlanFor(supplementDecision({ commentId: null }), 'format').issueVersionHash).toBe('v1:none');
  });
});

describe('P2-5：bareIssueVersion 只剥前缀，不碰后缀', () => {
  it('单前缀 / 双重前缀都剥成裸值；裸值原样返回（可重复调用）', () => {
    expect(bareIssueVersion('v1')).toBe('v1');
    expect(bareIssueVersion('pipeline:format:v1')).toBe('v1');
    expect(bareIssueVersion('pipeline:classify:v1')).toBe('v1');
    // 老数据里那种「双重前缀」要一路剥到裸值
    expect(bareIssueVersion('pipeline:classify:pipeline:format:v1')).toBe('v1');
    expect(bareIssueVersion(bareIssueVersion('pipeline:format:v1'))).toBe('v1');
    expect(bareIssueVersion(null)).toBeNull();
  });

  it('补充锚的 commentId 段不受影响；剥完再拼一次不会出现三重前缀', () => {
    // `v1:777` 不是前缀，原样保留（这一列在「补充锚」那条路径上不会被剥）
    expect(bareIssueVersion('v1:777')).toBe('v1:777');
    expect(pipelineAnchor('format', bareIssueVersion('pipeline:classify:pipeline:format:v1'))).toBe(
      'pipeline:format:v1',
    );
  });
});
