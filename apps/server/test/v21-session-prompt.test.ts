/**
 * 系统提示词的**留痕**（需求 §6.7 SL-1）。
 *
 * 需求原文是「常驻、每次调用都带、项目级可配（未配置用内置默认）」。RACP 协议只有
 * `session/create` 带 `systemPrompt`（`turn/start` 的载荷是 `input.{messageId,text}`、
 * `session/attach` 只吃 `sessionId`），所以「每次调用」在复用轮次里没有下发点 ——
 * 本包能保证的两件事：
 *  1. 会话创建那一刻带的**一定是**项目配置值或内置默认（`resolveAgentExecution()` 一处裁决）；
 *  2. 带的是哪一份**可查**：落 `agent_sessions.system_prompt`，且只在会话尚未建立时写
 *     （会话建好之后身份就冻结了，再写只会得到一份与宿主不一致的记录）。
 */
import { describe, expect, it } from 'vitest';
import { V21_SESSION_PROMPT_SQL, recordSessionSystemPrompt } from '../src/http/webhook-v21.ts';
import { AGENT_IDENTITY_PROMPT } from '../src/skills/prompt.ts';

type QueryCall = { readonly text: string; readonly values: readonly unknown[] | undefined };

function createFakeDb(): { db: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    db: {
      query: async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
    },
  };
}

describe('recordSessionSystemPrompt', () => {
  it('项目没配 → 落内置默认身份说明（不是空串）', async () => {
    const fake = createFakeDb();
    const recorded = await recordSessionSystemPrompt(fake.db, {
      repo: 'acme/widget',
      domain: 'issue',
      issueNumber: 42,
      settings: {},
    });

    expect(recorded).toBe(AGENT_IDENTITY_PROMPT);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.text).toBe(V21_SESSION_PROMPT_SQL.record);
    // 参数顺序必须与 SQL 的占位符对齐：repo、domain、issue、提示词
    expect(fake.calls[0]?.values).toEqual(['acme/widget', 'issue', 42, AGENT_IDENTITY_PROMPT]);
  });

  it('项目配了 → 落项目那一份（不掺默认文案）', async () => {
    const fake = createFakeDb();
    const recorded = await recordSessionSystemPrompt(fake.db, {
      repo: 'acme/widget',
      domain: 'issue',
      issueNumber: 7,
      settings: { agent: { managers: ['alice'], limits: { system_prompt: '你是本仓库的评审助手。' } } },
    });

    expect(recorded).toBe('你是本仓库的评审助手。');
    expect(fake.calls[0]?.values?.[3]).toBe('你是本仓库的评审助手。');
  });

  it('只在会话尚未建立时写：已经是同一份身份时不覆盖', () => {
    expect(V21_SESSION_PROMPT_SQL.record).toContain('"system_prompt" = $4');
    expect(V21_SESSION_PROMPT_SQL.record).toContain('"session_id" IS NULL');
    expect(V21_SESSION_PROMPT_SQL.record).toContain('"system_prompt" IS NULL');
  });
});
