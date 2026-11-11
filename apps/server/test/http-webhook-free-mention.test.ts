/**
 * 自由问答（`@bot 你的问题`，不带 `/命令`）的纯函数与判定：
 *  - `extractFreeQuestion`：只认「@ 到句柄 + 没有 `/命令` + 正文非空」；
 *  - `encodeFreeQuestion` / `decodeFreeQuestion`：问题正文编码进 `tasks.command`；
 *  - `decideWebhookTask(freeMention)`：开启时建 `@answer:` 任务，关闭时忽略。
 */
import { describe, expect, it } from 'vitest';


import {
  FREE_MENTION_PREFIX,
  decodeFreeQuestion,
  decideWebhookTask,
  encodeFreeQuestion,
  extractFreeQuestion,
} from '../src/http/index.ts';

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
  it('v0.3：纯 @ 提问产出一条 mention 消息计划（`@answer` 任务通道已被 agent 取代）', () => {
    const decision = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload(`@${HANDLE} 这条报错怎么排查？`),
      mention: HANDLE,
      freeMention: true,
    });
    expect(decision.action).toBe('task');
    if (decision.action !== 'task') return;
    // 原话进 `agent` 计划；永久幂等改由 `agent_messages` 的 fingerprint 承担（L-01 / L-02）
    expect(decision.plan.source).toBe('agent');
    expect(decision.plan.command).toBe('agent:mention');
    expect(decision.plan.agent).toMatchObject({
      kind: 'mention',
      templateId: null,
      rawText: '这条报错怎么排查？',
    });
    // `@answer` 的编码路径不再是生产路径（函数保留只为兼容历史任务行）
    expect(decodeFreeQuestion(decision.plan.command)).toBeNull();
  });

  it('没有 @ 到别名的评论 → 不建任何消息（不再有「补充评论」隐式通道）', () => {
    const decision = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload('这条报错怎么排查？'),
      mention: HANDLE,
      freeMention: true,
    });
    expect(decision.action).toBe('ignore');
  });
});
