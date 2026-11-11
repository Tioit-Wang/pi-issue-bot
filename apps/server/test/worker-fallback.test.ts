/**
 * 兜底回复的纯逻辑（`worker/fallback.ts`）。
 *
 * 这里只测**纯函数**与一次写回：跑整条链路的用例在 `worker-run-task.test.ts`
 * （那里已经有一套假端口），本文件负责把「从事件流里取哪一段文本」这件事钉死，
 * 因为它最容易悄悄跑偏（真 pi-host 的形状与假 host 的形状不同，见下）。
 */
import { describe, expect, it } from 'vitest';

import type { GithubWriteApi, IssueComment } from '../src/github/index.ts';
import { FREE_ANSWER_COMMAND as WEBHOOK_FREE_ANSWER_COMMAND } from '../src/http/webhook.ts';
import {
  FALLBACK_COMMENT_MARKER,
  FALLBACK_INTENT,
  FREE_ANSWER_COMMAND,
  MAX_FALLBACK_BODY_CHARS,
  buildFallbackCommentBody,
  findLastAgentText,
  postFallbackComment,
  stripEnvelopeBlocks,
  supportsCommentFallback,
} from '../src/worker/index.ts';
import type { ActionRecord, CapturedEvent, RunStore } from '../src/worker/index.ts';

/** 一段「人话 + 不合规信封」的正文（与真实故障里模型交的东西同形）。 */
const HUMAN_TEXT = '结论：EACCES 不是只读挂载造成的，只读挂载返回 EROFS。';
const ENVELOPE_BLOCK = ['```json', '{"verdict":{"kind":"issue","labels":[],"evidence":[]}', '  "actions":[{"intent":"comment","body":"…"}],', '  "usage":{}}', '```'].join(
  '\n',
);

/** 真 pi-host v0.22.0 的 `item.completed` 载荷形状（对着 `run_events` 里的真实事件核过）。 */
function realHostEvent(content: unknown, role = 'assistant'): CapturedEvent {
  return {
    eventId: 'evt-1',
    kind: 'item.completed',
    payload: {
      event: { type: 'message_end', message: { id: 'msg-1', role, content, status: 'complete' } },
      itemId: 'msg-1',
      itemType: 'message',
    },
  };
}

/** 假 host（`test/helpers` 的脚本）用的简化形状。 */
function flatEvent(text: string): CapturedEvent {
  return { eventId: 'evt-flat', kind: 'item.completed', payload: { text } };
}

function createStore(): RunStore & { readonly actions: ActionRecord[] } {
  const actions: ActionRecord[] = [];
  const noop = async (): Promise<void> => undefined;
  return {
    actions,
    beginRun: noop,
    appendEvent: noop,
    recordEnvelope: noop,
    recordAction: async (record) => {
      actions.push(record);
    },
    recordUsage: noop,
    recordDegeneracyHit: noop,
    finishRun: noop,
    markTask: noop,
  };
}

/** 假写面：`listIssueComments` 返回已有评论，`createIssueComment` 记账。 */
function createApi(
  seed: readonly string[] = [],
  options: { readonly failCreate?: boolean } = {},
): { api: GithubWriteApi; posted: string[] } {
  const posted: string[] = [];
  const comments: IssueComment[] = seed.map((body, index) => ({ id: index + 1, body }));
  const api: GithubWriteApi = {
    listIssueComments: async () => comments,
    createIssueComment: async (input) => {
      if (options.failCreate === true) {
        throw new Error('createIssueComment 失败（模拟）');
      }
      posted.push(input.body);
      const id = comments.length + 1;
      comments.push({ id, body: input.body });
      return { id, htmlUrl: null };
    },
    addLabels: async () => undefined,
    removeLabel: async () => undefined,
    createIssue: async () => ({ number: 1 }),
    closeIssue: async () => undefined,
  };
  return { api, posted };
}

describe('supportsCommentFallback：只有评论类命令才兜底', () => {
  it('`/issue-triage`、`/issue-repro`、`@answer` 允许（含带参数与兼容期编码）', () => {
    expect(supportsCommentFallback('/issue-triage')).toBe(true);
    expect(supportsCommentFallback(' /issue-triage ')).toBe(true);
    expect(supportsCommentFallback('/issue-triage focus')).toBe(true);
    expect(supportsCommentFallback('/issue-repro')).toBe(true);
    expect(supportsCommentFallback('@answer')).toBe(true);
    expect(supportsCommentFallback('@answer:5L2g5aW9')).toBe(true);
    // v0.3 issue agent 的两个入口（产出默认就是一条评论）
    expect(supportsCommentFallback('agent:mention')).toBe(true);
    expect(supportsCommentFallback('agent:event')).toBe(true);
  });

  it('`/review-pr`、push 类与自动分诊不兜底（结论不可信时不该发布）', () => {
    expect(supportsCommentFallback('/review-pr')).toBe(false);
    expect(supportsCommentFallback('/review-pr focus')).toBe(false);
    expect(supportsCommentFallback('auto:triage')).toBe(false);
    expect(supportsCommentFallback('push')).toBe(false);
    expect(supportsCommentFallback('')).toBe(false);
  });

  it('自由问答的命令字面量与 http 层一致（worker 不 import http，只靠这条测试防漂移）', () => {
    expect(FREE_ANSWER_COMMAND).toBe(WEBHOOK_FREE_ANSWER_COMMAND);
  });
});

describe('stripEnvelopeBlocks：只留人话', () => {
  it('摘掉 ```json 信封块，保留人话', () => {
    expect(stripEnvelopeBlocks(`${HUMAN_TEXT}\n\n${ENVELOPE_BLOCK}`)).toBe(HUMAN_TEXT);
  });
  it('开头抄来的「【第一段】」标签被摘掉（正文里的同名字样不动）', () => {
    expect(stripEnvelopeBlocks(`【第一段】\n结论：缺版本号。\n${ENVELOPE_BLOCK}`)).toBe('结论：缺版本号。');
    expect(stripEnvelopeBlocks('**第一段**结论：缺版本号。')).toBe('结论：缺版本号。');
    expect(stripEnvelopeBlocks('第一段：结论：缺版本号。')).toBe('结论：缺版本号。');
    // 出现在正文中间（不是开头）就不动
    expect(stripEnvelopeBlocks('结论：缺版本号。\n【第一段】以上。')).toBe('结论：缺版本号。\n【第一段】以上。');
  });
  it('与信封无关的代码块要保留（它是回答的一部分）', () => {
    const text = ['看这段代码：', '```ts', 'const a = 1;', '```', '', ENVELOPE_BLOCK].join('\n');
    const stripped = stripEnvelopeBlocks(text);
    expect(stripped).toContain('const a = 1;');
    expect(stripped).not.toContain('"verdict"');
  });

  it('无围栏的裸信封（模型忘了写 ```）也能摘掉', () => {
    const bare = ['结论：缺复现步骤。', '{"verdict":{"kind":"issue","labels":[],"evidence":[]},"actions":[],"usage":{}}'].join('\n');
    expect(stripEnvelopeBlocks(bare)).toBe('结论：缺复现步骤。');
  });

  it('CRLF 与多余空行都被归一；只有信封时返回空串', () => {
    expect(stripEnvelopeBlocks(`第一行\r\n\r\n\r\n${ENVELOPE_BLOCK}\r\n`)).toBe('第一行');
    expect(stripEnvelopeBlocks(ENVELOPE_BLOCK)).toBe('');
  });
});

describe('findLastAgentText：取最后一条有文本的 assistant 消息', () => {
  it('真 pi-host 形状（`event.message.content`）', () => {
    const events = [realHostEvent(`${HUMAN_TEXT}\n\n${ENVELOPE_BLOCK}`), realHostEvent('', 'assistant')];
    expect(findLastAgentText(events)).toBe(HUMAN_TEXT);
  });

  it('假 host 的 `{ text }` 形状', () => {
    expect(findLastAgentText([flatEvent(`${HUMAN_TEXT}\n${ENVELOPE_BLOCK}`)])).toBe(HUMAN_TEXT);
  });

  it('跳过 tool / user 消息（它们不是「agent 说的话」）', () => {
    const events = [
      realHostEvent(`${HUMAN_TEXT}\n\n${ENVELOPE_BLOCK}`),
      realHostEvent('{"content":[],"isError":false}', 'tool'),
      realHostEvent('用户的问题原文', 'user'),
    ];
    expect(findLastAgentText(events)).toBe(HUMAN_TEXT);
  });

  it('内容块数组（`[{ type: "text", text }]`）也能取出文本', () => {
    const events = [realHostEvent([{ type: 'thinking', text: '不该出现' }, { type: 'text', text: HUMAN_TEXT }])];
    expect(findLastAgentText(events)).toBe(HUMAN_TEXT);
  });

  it('没有 assistant 文本 / 只有信封 / 没有事件 → null（不猜、不拼）', () => {
    expect(findLastAgentText([])).toBeNull();
    expect(findLastAgentText([realHostEvent(ENVELOPE_BLOCK)])).toBeNull();
    expect(findLastAgentText([{ eventId: 'e', kind: 'turn.completed', payload: { status: 'completed' } }])).toBeNull();
    expect(findLastAgentText([realHostEvent('', 'assistant')])).toBeNull();
  });
});

describe('buildFallbackCommentBody：正文 + 隐藏标记', () => {
  it('人话 + `<!-- pi-issue-bot:fallback -->`，且不含信封', () => {
    const body = buildFallbackCommentBody(`${HUMAN_TEXT}\n${ENVELOPE_BLOCK}`);
    expect(body).toBe(`${HUMAN_TEXT}\n\n${FALLBACK_COMMENT_MARKER}`);
    expect(body).not.toContain('verdict');
  });

  it('只有信封 → null（没有可兜底的内容）', () => {
    expect(buildFallbackCommentBody(ENVELOPE_BLOCK)).toBeNull();
  });

  it('超长正文被截断（GitHub 评论有长度上限）', () => {
    const body = buildFallbackCommentBody('啊'.repeat(MAX_FALLBACK_BODY_CHARS + 10));
    expect(body).not.toBeNull();
    expect(body?.length).toBeLessThan(MAX_FALLBACK_BODY_CHARS + 200);
    expect(body).toContain('已截断');
  });
});

describe('postFallbackComment：幂等与失败留痕', () => {
  it('第一次发；同一段正文第二次命中去重标记 → 跳过', async () => {
    const store = createStore();
    const { api, posted } = createApi();
    const body = buildFallbackCommentBody(HUMAN_TEXT) ?? '';
    const input = {
      runId: 'run-1',
      repo: 'octo/demo',
      targetNumber: 7,
      command: '@answer',
      body,
      api,
      store,
      clock: () => 1_700_000_000_000,
    };

    const first = await postFallbackComment(input);
    const second = await postFallbackComment(input);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('skipped');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(FALLBACK_COMMENT_MARKER);
    // 两次都留痕：一次 applied、一次 skipped
    expect(store.actions).toHaveLength(2);
    expect(store.actions.map((item) => item.intent)).toEqual([FALLBACK_INTENT, FALLBACK_INTENT]);
    expect(store.actions[0]?.audit['command']).toBe('@answer');
    expect(store.actions[0]?.audit['reason']).toBe('envelope-invalid');
  });

  it('发送失败不抛：`applied_at = null` 一行留痕，状态 failed', async () => {
    const store = createStore();
    const { api } = createApi([], { failCreate: true });

    const outcome = await postFallbackComment({
      runId: 'run-2',
      repo: 'octo/demo',
      targetNumber: 7,
      command: '/issue-repro',
      body: buildFallbackCommentBody(HUMAN_TEXT) ?? '',
      api,
      store,
      clock: () => 1_700_000_000_000,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.externalRef).toBeNull();
    expect(store.actions).toHaveLength(1);
    expect(store.actions[0]?.appliedAt).toBeNull();
    expect(store.actions[0]?.audit['status']).toBe('failed');
  });
});
