/**
 * 自由问答（`@bot 你的问题`，不带 `/命令`）的纯函数与判定：
 *  - `extractFreeQuestion`：只认「@ 到句柄 + 没有 `/命令` + 正文非空」；
 *  - `encodeFreeQuestion` / `decodeFreeQuestion`：问题正文编码进 `tasks.command`；
 *  - `decideWebhookTask(freeMention)`：开启时建 `@answer:` 任务，关闭时忽略；
 *  - `checkCommandGate`：`@answer:` 不受 `commands.allowed` 白名单限制，但仍受 association 约束。
 */
import { describe, expect, it } from 'vitest';

import { parseRepoConfig } from '../../../packages/contract/src/index.ts';
import {
  FREE_MENTION_PREFIX,
  checkCommandGate,
  decodeFreeQuestion,
  decideWebhookTask,
  encodeFreeQuestion,
  extractFreeQuestion,
} from '../src/http/index.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

const HANDLE = 'pi-issue-bot-tioit';

const commentPayload = (body: string, association = 'OWNER') => ({
  action: 'created',
  issue: { number: 42, author_association: association },
  comment: { body, user: { login: 'tioit-wang', type: 'User' }, author_association: association },
  sender: { login: 'tioit-wang', type: 'User' },
  repository: { full_name: 'Tioit-Wang/pi-issue-bot-test' },
});

describe('extractFreeQuestion', () => {
  it('@ 到句柄且没有命令 → 返回问题正文（去掉 @ 与首尾空白）', () => {
    expect(extractFreeQuestion(`@${HANDLE} 这个报错是怎么回事？`, HANDLE)).toBe('这个报错是怎么回事？');
  });

  it('带 `/命令` 的不算自由提问（交给命令通道）', () => {
    expect(extractFreeQuestion(`@${HANDLE} /issue-triage`, HANDLE)).toBeNull();
  });

  it('只有 @ 没有正文 → null', () => {
    expect(extractFreeQuestion(`@${HANDLE}`, HANDLE)).toBeNull();
    expect(extractFreeQuestion(`@${HANDLE}   `, HANDLE)).toBeNull();
  });

  it('@ 的是别人 → null（不把别人的提及当成问 bot）', () => {
    expect(extractFreeQuestion('@Tioit-Wang 你好', HANDLE)).toBeNull();
  });
});

describe('encodeFreeQuestion / decodeFreeQuestion', () => {
  it('中文与换行都能原样往返', () => {
    const question = '第一行\n第二行：为什么 `pnpm -r test` 挂住不动？';
    const command = `${FREE_MENTION_PREFIX}${encodeFreeQuestion(question)}`;
    expect(decodeFreeQuestion(command)).toBe(question);
  });

  it('不是自由问答的 command → null；空正文 → null', () => {
    expect(decodeFreeQuestion('/issue-triage')).toBeNull();
    expect(decodeFreeQuestion(FREE_MENTION_PREFIX)).toBeNull();
  });
});

describe('decideWebhookTask：纯 @ 提问', () => {
  it('freeMention 打开 → 建 `@answer:` 任务，且幂等 kind 按问题正文区分', () => {
    const decision = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload(`@${HANDLE} 这条报错怎么排查？`),
      mention: HANDLE,
      freeMention: true,
    });
    expect(decision.action).toBe('task');
    if (decision.action !== 'task') return;
    // 契约里 command ≤64 字符，所以问题正文走 `promptText`（落 prompt_text 列）
    expect(decision.plan.command).toBe('@answer');
    expect(decision.plan.promptText).toBe('这条报错怎么排查？');
    expect(decodeFreeQuestion(decision.plan.command)).toBeNull();
    expect(decision.plan.kind.startsWith('answer:')).toBe(true);

    const again = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload(`@${HANDLE} 这条报错怎么排查？`),
      mention: HANDLE,
      freeMention: true,
    });
    const other = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload(`@${HANDLE} 换一个问题`),
      mention: HANDLE,
      freeMention: true,
    });
    expect(again.action === 'task' && again.plan.kind).toBe(decision.plan.kind);
    expect(other.action === 'task' && other.plan.kind).not.toBe(decision.plan.kind);
  });

  it('freeMention 关闭 → 不建 `@answer` 任务，交回 `pipeline-supplement` 候选（由 handleWebhook 查状态行决定）', () => {
    const decision = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload(`@${HANDLE} 这条报错怎么排查？`),
      mention: HANDLE,
    });
    // E4（§16.2 第 1 条）：普通 issue 评论不再一律 ignored —— 纯函数这里只能给出
    // 「补充信息候选」，真正要不要用由 `handleWebhook` 按 `issue_pipeline.stage/state` 决定。
    expect(decision.action).toBe('pipeline-supplement');
    expect(decision.action).not.toBe('task');
    if (decision.action !== 'pipeline-supplement') return;
    // `body` 是评论原文（截断 / 去 @ 留给拼 `target_supplement` 时做）
    expect(decision.body).toBe(`@${HANDLE} 这条报错怎么排查？`);
  });
});

describe('checkCommandGate：自由问答只受 association 约束', () => {
  // `pipeline.managers` 非空是解析前提（§4.5 / Q4），其余沿用契约默认值
  const config = parseRepoConfig(
    validRepoSettings({
      version: 1,
      commands: { allowed: ['/issue-triage'], author_associations: ['OWNER'] },
    }),
  );

  it('`@answer:` 不在白名单也放行（OWNER）', () => {
    const decision = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload(`@${HANDLE} 为什么？`),
      mention: HANDLE,
      freeMention: true,
    });
    expect(decision.action).toBe('task');
    if (decision.action !== 'task') return;
    expect(checkCommandGate(decision.plan, config)).toEqual({ allowed: true });
  });

  it('非授权作者仍然被挡', () => {
    const decision = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload(`@${HANDLE} 为什么？`, 'NONE'),
      mention: HANDLE,
      freeMention: true,
    });
    expect(decision.action).toBe('task');
    if (decision.action !== 'task') return;
    const gate = checkCommandGate(decision.plan, config);
    expect(gate.allowed).toBe(false);
  });
});
