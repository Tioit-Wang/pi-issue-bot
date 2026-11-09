/**
 * 分类打标（**真库**，plan §6.1 + tech-plan R4）。
 *
 * 三条验收：
 *  1. 人先打的 `bug` 在重算后仍在，且 `bot_labels` 里**没有** `bug` 那一行——
 *     「只动自己打过的」不是靠比较标签名，而是靠这张记账表。
 *  2. 判定键经 `labels.map` 换成仓库实际标签；映射缺失 → 只评论不打标 + warn（不发明标签）。
 *  3. 拿不到信封 → 一律不动标签（不猜默认标签）。
 *
 * worker 用假的 `EnvelopeRunner`：这一层要测的是「拿到 verdict 之后怎么打标」，
 * 而不是容器怎么跑（那是 W3 的 worker 测试）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseRepoConfig } from '../../../packages/contract/src/index.ts';
import type { Verdict } from '../../../packages/envelope/src/index.ts';
import { createSkillRegistry } from '../src/skills/registry.ts';
import { listBotLabels, createPgBotLabelLedger } from '../src/workflows/bot-labels.ts';
import { toSqlRunner } from '../src/workflows/ports.ts';
import type { EnvelopeRunner, RunSummary, SqlRunner } from '../src/workflows/ports.ts';
import { mapVerdictLabels, runTriage } from '../src/workflows/triage.ts';
import { createFakeWriteApi } from './helpers/fake-github.ts';
import type { RecordedWriteCall } from './helpers/fake-github.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/**
 * 这些用例都持有 pi_issue_bot_test 的 advisory lock（openTestDb 的设计）——
 * 全量跑时多个文件排队等锁，默认 10s 的 hook 超时不够用，所以显式放宽。
 */
const HOOK_TIMEOUT_MS = 60_000;

const REPO = 'acme/widgets';
const ISSUE = 7;

const config = parseRepoConfig({
  version: 1,
  labels: { map: { bug: 'bug', feature: 'enhancement', question: 'question' }, allow: ['bug', 'enhancement', 'question'] },
});

const registry = createSkillRegistry();
const triageSkill = (() => {
  const skill = registry.resolve('/issue-triage');
  if (skill === undefined) {
    throw new Error('内置 /issue-triage 没加载出来');
  }
  return skill;
})();

/** 一个只回固定信封的 worker 替身。 */
function runnerOf(verdict: Verdict | null): EnvelopeRunner & { readonly inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    runTask: async (input): Promise<RunSummary> => {
      inputs.push(input);
      if (verdict === null) {
        return { outcome: 'failed', failureClass: 'parse', actions: [], envelope: null };
      }
      return {
        outcome: 'succeeded',
        failureClass: null,
        actions: [],
        envelope: {
          text: '{}',
          valid: true,
          errors: [],
          accepted: [],
          dropped: [],
          envelope: {
            verdict,
            actions: [],
            usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
          },
        },
      };
    },
  };
}

function mirror(labels: readonly string[], calls: readonly RecordedWriteCall[], from: number): string[] {
  let next = [...labels];
  for (const call of calls.slice(from)) {
    if (call.method === 'addLabels') {
      for (const label of call.input['labels'] as readonly string[]) {
        if (!next.includes(label)) {
          next.push(label);
        }
      }
    }
    if (call.method === 'removeLabel') {
      const label = call.input['label'] as string;
      next = next.filter((item) => item !== label);
    }
  }
  return next;
}

let db: TestDb;
let sql: SqlRunner;

beforeAll(async () => {
  db = await openTestDb();
  sql = toSqlRunner(db.pool);
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.truncate();
});

afterAll(async () => {
  await db.close();
}, HOOK_TIMEOUT_MS);

describe('runTriage（真库 + 假 worker）', () => {
  it('只打映射到的标签；人打的 bug 仍在且 bot_labels 无它那一行', async () => {
    const api = createFakeWriteApi();
    const ledger = createPgBotLabelLedger(sql);
    const runner = runnerOf({ kind: 'issue', labels: ['bug', 'feature'], evidence: [] });

    const result = await runTriage(
      { runner, github: api, ledger },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: '崩溃了',
        body: '1. 打开 2. 点按钮 3. 崩溃',
        currentLabels: ['bug'],
        botLabels: [],
        config,
        skill: triageSkill,
      },
    );

    expect(result.outcome).toBe('applied');
    expect(result.desiredLabels).toEqual(['bug', 'enhancement']);
    expect(result.delta?.add).toEqual(['enhancement']);
    expect(result.label?.added).toEqual(['enhancement']);

    // prompt 里带上了围栏后的正文与输出契约（顺手验证渲染接上了）
    expect(result.prompt).toContain('<<<PI-BOT:UNTRUSTED:body>>>');
    expect(result.prompt).toContain('acme/widgets');

    const botLabels = await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE });
    expect(botLabels).toEqual(['enhancement']);
    const bugRows = await db.sql(
      `select 1 from bot_labels where repo = $1 and issue_number = $2 and label = 'bug'`,
      [REPO, ISSUE],
    );
    expect(bugRows).toHaveLength(0);
  });

  it('编辑后重算：只撤自己打过的，人打的标签不动', async () => {
    const api = createFakeWriteApi();
    const ledger = createPgBotLabelLedger(sql);
    let labels: string[] = ['bug'];

    await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug', 'feature'], evidence: [] }), github: api, ledger },
      { repo: REPO, issueNumber: ISSUE, title: 't', body: 'b', currentLabels: labels, botLabels: [], config, skill: triageSkill },
    );
    labels = mirror(labels, api.calls, 0);
    expect(labels).toEqual(['bug', 'enhancement']);

    // 人的 bug + 我们打的 enhancement；重算后 verdict 只剩下 bug
    const cursor = api.calls.length;
    const second = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }), github: api, ledger },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b（已补充复现步骤）',
        currentLabels: labels,
        botLabels: await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE }),
        config,
        skill: triageSkill,
      },
    );

    expect(second.delta?.remove).toEqual(['enhancement']);
    expect(second.delta?.retainHumanOwned).toEqual([]);
    labels = mirror(labels, api.calls, cursor);
    expect(labels).toEqual(['bug']);
    expect(await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE })).toEqual([]);
  });

  it('人的标签不在 desired 里时必须被保留（retainHumanOwned 记下来）', async () => {
    const api = createFakeWriteApi();
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['feature'], evidence: [] }), github: api },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: ['bug', 'wontfix'],
        botLabels: [],
        config,
        skill: triageSkill,
      },
    );
    expect(result.delta?.retainHumanOwned).toEqual(['bug', 'wontfix']);
    expect(result.delta?.remove).toEqual([]);
    expect(api.calls.some((call) => call.method === 'removeLabel')).toBe(false);
  });

  it('映射全缺失 → 只评论不打标，并说明去改 labels.map', async () => {
    const api = createFakeWriteApi();
    const noFeature = parseRepoConfig({ version: 1, labels: { map: { bug: 'bug' } } });
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['feature'], evidence: [] }), github: api },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: [],
        botLabels: [],
        config: noFeature,
        skill: triageSkill,
      },
    );

    expect(result.outcome).toBe('comment-only');
    expect(result.unmappedLabels).toEqual(['feature']);
    expect(result.warnings.join('\n')).toContain('labels.map');
    const comments = api.calls.filter((call) => call.method === 'createIssueComment');
    expect(comments).toHaveLength(1);
    expect(String(comments[0]?.input['body'])).toContain('labels.map');
    expect(api.calls.some((call) => call.method === 'addLabels')).toBe(false);
  });

  it('拿不到信封 → 不动标签、不发评论', async () => {
    const api = createFakeWriteApi();
    const result = await runTriage(
      { runner: runnerOf(null), github: api },
      { repo: REPO, issueNumber: ISSUE, title: 't', body: 'b', currentLabels: ['bug'], botLabels: [], config, skill: triageSkill },
    );
    expect(result.outcome).toBe('no-envelope');
    expect(api.calls).toHaveLength(0);
  });

  it('技能 outputs 不含 labels 时什么都不打（技能说了不算的事不做）', async () => {
    const repro = registry.resolve('/issue-repro');
    expect(repro).toBeDefined();
    if (repro === undefined) {
      return;
    }
    const api = createFakeWriteApi();
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }), github: api },
      { repo: REPO, issueNumber: ISSUE, title: 't', body: 'b', currentLabels: [], botLabels: [], config, skill: repro },
    );
    expect(result.warnings.join('\n')).toContain('outputs');
    expect(api.calls.some((call) => call.method === 'addLabels')).toBe(false);
  });

  it('mapVerdictLabels 把白名单外的映射也拦下（防手滑写错标签名）', () => {
    const restricted = parseRepoConfig({
      version: 1,
      labels: { map: { bug: 'bug', feature: 'not-allowed-label' }, allow: ['bug'] },
    });
    const mapping = mapVerdictLabels(restricted, ['bug', 'feature', 'question']);
    expect(mapping.mapped).toEqual(['bug']);
    expect(mapping.rejected).toEqual(['feature']);
    expect(mapping.unmapped).toEqual(['question']);
  });
});