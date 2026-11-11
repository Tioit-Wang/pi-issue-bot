/**
 * 分类打标（**真库**，plan §6.1 + `docs/impl-multi-repo.md` §4 W2-E）。
 *
 * 这一组用例覆盖 W2-E 的六条交付：
 *  1. 归一化后落标（映射 / 词表 / 互斥组 / 上限 / 人工否决）——
 *     规则本身的单测在 `workflow-normalize.test.ts`，这里测的是「接上了没有」；
 *  2. 落标仍走 `planLabelDelta` + `executeLabelPlan`（人打的 `bug` 不动、
 *     `bot_labels` 里没有它那一行）；
 *  3. `labels.missing` 的 warn / create / ignore；
 *  4. `label_decisions` 每轮一行（含 `blocked_reason` / `reason`），
 *     `bot_labels` 带上 `source_key` / `judgement_hash` / `run_id`；
 *  5. **缺信息只打标 + reaction**：不再有任何评论（旧的 `workflow-compliance.test.ts`
 *     整文件删除，等价语义搬到这里）；
 *  6. 打标失败 `failure.fatal === false`（不翻 run）。
 *
 * worker 用假的 `EnvelopeRunner`：这一层要测的是「拿到 verdict 之后怎么打标」，
 * 而不是容器怎么跑（那是 worker 的测试）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Verdict } from '../../../packages/envelope/src/index.ts';
import { createSkillRegistry } from '../src/skills/registry.ts';
import { createPgLabelDecisionRecorder, listLabelDecisions } from '../src/workflows/label-decisions.ts';
import { toSqlRunner } from '../src/workflows/ports.ts';
import type { EnvelopeRunner, RunSummary, SqlRunner } from '../src/workflows/ports.ts';
import { needsInfoLabelOf, runTriage } from '../src/workflows/triage.ts';
import { createAttributedBotLabelLedger, createPgBotLabelLedger, listBotLabels, loadHumanVetoed } from '../src/workflows/bot-labels.ts';
import { createFakeWriteApi } from './helpers/fake-github.ts';
import type { RecordedWriteCall } from './helpers/fake-github.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { parseValidSettings, vocabularyWithRoles } from './helpers/repo-settings.ts';

/**
 * 这些用例都持有 pi_issue_bot_test 的 advisory lock（openTestDb 的设计）——
 * 全量跑时多个文件排队等锁，默认 10s 的 hook 超时不够用，所以显式放宽。
 */
const HOOK_TIMEOUT_MS = 60_000;

const REPO = 'acme/widgets';
const ISSUE = 7;
const ISSUE_HASH = '0123456789abcdef';

const config = parseValidSettings({
  labels: {
    map: { bug: 'bug', feature: 'enhancement', question: 'question', 'needs-info': 'needs-info' },
    allow: ['bug', 'enhancement', 'question', 'needs-info'],
  },
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

/** 记录 reaction 的假端口（`github/` 的真实实现在 W2-D，这里只断言「打了一个 confused」）。 */
function fakeReaction(): { readonly calls: Array<Record<string, unknown>>; add(input: Record<string, unknown>): Promise<void> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    add: async (input) => {
      calls.push(input);
    },
  };
}

/** 记录建标签的假目录端口。 */
function fakeCatalog(existing: readonly string[]): {
  readonly created: Array<Record<string, unknown>>;
  list(input: { repo: string }): Promise<readonly string[]>;
  create(input: Record<string, unknown>): Promise<void>;
} {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    list: async () => existing,
    create: async (input) => {
      created.push(input);
    },
  };
}

/** 把假执行器记录到的调用镜像成一个「GitHub 现状」标签数组（模拟下一次读出来的值）。 */
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
  // `openTestDb().truncate()` 还没带上 label_decisions（不在本包名下），这里显式清一次，
  // 否则「每轮一行」的计数会跨用例累加。
  await db.sql('delete from label_decisions');
});

afterAll(async () => {
  await db.close();
}, HOOK_TIMEOUT_MS);

describe('runTriage（真库 + 假 worker）', () => {
  it('只打映射到的标签；人打的 bug 仍在，bot_labels 无它那一行', async () => {
    const api = createFakeWriteApi();
    const runner = runnerOf({ kind: 'issue', labels: ['bug', 'feature'], evidence: [] });

    const result = await runTriage(
      { runner, github: api, ledger: createAttributedBotLabelLedger(sql), decisions: createPgLabelDecisionRecorder(sql) },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: '崩溃了',
        body: '1. 打开 2. 点按钮 3. 崩溃',
        currentLabels: ['bug'],
        botLabels: [],
        config,
        skill: triageSkill,
        issueVersionHash: ISSUE_HASH,
      },
    );

    expect(result.outcome).toBe('applied');
    expect(result.desiredLabels).toEqual(['bug', 'enhancement']);
    expect(result.delta?.add).toEqual(['enhancement']);
    expect(result.label?.added).toEqual(['enhancement']);
    // 没有缺项 → 不打 reaction
    expect(result.missingEvidence).toEqual([]);
    expect(result.reaction).toBeNull();

    // prompt 里带上了围栏后的正文、输出契约与项目标签词表
    expect(result.prompt).toContain('<<<PI-BOT:UNTRUSTED:body>>>');
    expect(result.prompt).toContain('acme/widgets');
    expect(result.prompt).toContain('## 项目标签');

    const botLabels = await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE });
    expect(botLabels).toEqual(['enhancement']);
    const bugRows = await db.sql(
      `select 1 from bot_labels where repo = $1 and issue_number = $2 and label = 'bug'`,
      [REPO, ISSUE],
    );
    expect(bugRows).toHaveLength(0);

    // 归因列：source_key / judgement_hash / run_id 都落上了
    const attribution = await db.sql(
      `select source_key, judgement_hash, run_id from bot_labels where repo = $1 and issue_number = $2`,
      [REPO, ISSUE],
    );
    expect(attribution[0]?.['source_key']).toBe('feature');
    expect(attribution[0]?.['judgement_hash']).toBe(ISSUE_HASH);
    expect(String(attribution[0]?.['run_id'] ?? '')).not.toBe('');
  });

  it('每轮写一行 label_decisions（desired / applied / blocked_reason / reason / judgement_hash）', async () => {
    const api = createFakeWriteApi();
    const restricted = parseValidSettings({
      labels: { map: { bug: 'bug' }, max_per_issue: 1 },
    });
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug', 'feature'], evidence: [] }), github: api },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: [],
        botLabels: [],
        config: restricted,
        skill: triageSkill,
        issueVersionHash: ISSUE_HASH,
      },
    );
    expect(result.blockedLabels.map((item) => [item.label, item.reason])).toEqual([['feature', 'unmapped']]);

    // 显式给 decisions 端口，验证落库形状
    const withDecisions = await runTriage(
      {
        runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }),
        github: api,
        decisions: createPgLabelDecisionRecorder(sql),
      },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: [],
        botLabels: [],
        config: restricted,
        skill: triageSkill,
        issueVersionHash: ISSUE_HASH,
      },
    );
    expect(withDecisions.outcome).toBe('applied');

    const rows = await listLabelDecisions(sql, { repo: REPO, targetNumber: ISSUE });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['desired']).toEqual(['bug']);
    expect(rows[0]?.['applied']).toEqual(['bug']);
    expect(rows[0]?.['judgement_hash']).toBe(ISSUE_HASH);
    expect(rows[0]?.['blocked_reason']).toBeNull();
    expect(rows[0]?.['reason']).toBeNull();
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

  it('判定键全都没映射 → 不打标、**不发评论**，blocked 里有 unmapped（等价旧的 comment-only 降级）', async () => {
    const api = createFakeWriteApi();
    const noFeature = parseValidSettings({ labels: { map: { bug: 'bug' } } });
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

    expect(result.outcome).toBe('nothing');
    expect(result.unmappedLabels).toEqual(['feature']);
    expect(result.blockedLabels.map((item) => item.reason)).toEqual(['unmapped']);
    expect(result.warnings.join('\n')).toContain('labels.map');
    // 无感反馈：自动通道零评论
    expect(api.calls.filter((call) => call.method === 'createIssueComment')).toHaveLength(0);
    expect(api.calls.some((call) => call.method === 'addLabels')).toBe(false);
  });

  it('拿不到信封 → 不动标签不发评论，但仍写一行 label_decisions（可追溯为什么没打）', async () => {
    const api = createFakeWriteApi();
    const result = await runTriage(
      { runner: runnerOf(null), github: api, decisions: createPgLabelDecisionRecorder(sql) },
      { repo: REPO, issueNumber: ISSUE, title: 't', body: 'b', currentLabels: ['bug'], botLabels: [], config, skill: triageSkill },
    );

    expect(result.outcome).toBe('no-envelope');
    expect(api.calls).toHaveLength(0);
    const rows = await listLabelDecisions(sql, { repo: REPO, targetNumber: ISSUE });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['reason']).toContain('信封');
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
});

describe('缺必填信息：只打 needs-info + confused reaction（不发评论）', () => {
  /** 缺两项：`repro-steps`（有引用）、`version`（没给引用）。 */
  const incomplete: Verdict = {
    kind: 'issue',
    labels: ['bug'],
    evidence: [
      { rule: 'repro-steps', quote: '', passed: false },
      { rule: 'version', quote: '0.1.0', passed: false },
    ],
  };

  it('缺信息 → needs-info 标签 + confused reaction，零评论，明细进 label_decisions.reason', async () => {
    const api = createFakeWriteApi();
    const reaction = fakeReaction();
    const result = await runTriage(
      {
        runner: runnerOf(incomplete),
        github: api,
        ledger: createAttributedBotLabelLedger(sql),
        reaction,
        decisions: createPgLabelDecisionRecorder(sql),
      },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: '崩溃了',
        body: '描述很短',
        currentLabels: [],
        botLabels: [],
        config,
        skill: triageSkill,
        issueVersionHash: ISSUE_HASH,
      },
    );

    expect(result.outcome).toBe('applied');
    expect(result.desiredLabels).toEqual(['bug', 'needs-info']);
    expect(result.missingEvidence.map((item) => item.rule)).toEqual(['repro-steps', 'version']);
    expect(result.needsInfoLabel).toBe('needs-info');
    expect(result.reaction).toBe('confused');
    expect(reaction.calls).toEqual([
      { repo: REPO, targetKind: 'issue', targetNumber: ISSUE, content: 'confused' },
    ]);

    // 缺信息**不发评论**（§0.4）：整轮只有打标调用
    expect(api.calls.filter((call) => call.method === 'createIssueComment')).toHaveLength(0);
    expect(api.calls.filter((call) => call.method === 'addLabels')).toHaveLength(1);

    // 明细进 label_decisions.reason：缺哪几条 + 引用哪段
    const rows = await listLabelDecisions(sql, { repo: REPO, targetNumber: ISSUE });
    expect(rows).toHaveLength(1);
    const reason = String(rows[0]?.['reason'] ?? '');
    expect(reason).toContain('缺 2 项必填信息');
    expect(reason).toContain('repro-steps');
    expect(reason).toContain('version');
    expect(reason).toContain('0.1.0');
    expect(reason).toContain('已打');

    // needs-info 的 bot_labels 行带 reason（面板解释「为什么打它」）
    const labelRow = await db.sql(
      `select source_key, reason from bot_labels where repo = $1 and issue_number = $2 and label = 'needs-info'`,
      [REPO, ISSUE],
    );
    expect(labelRow).toHaveLength(1);
    expect(labelRow[0]?.['source_key']).toBe('needs-info');
    expect(String(labelRow[0]?.['reason'] ?? '')).toContain('缺 2 项必填信息');
  });

  it('补全信息后重算 → 撤掉自己打的 needs-info，且不再打 reaction', async () => {
    const api = createFakeWriteApi();
    const ledger = createPgBotLabelLedger(sql);
    const reaction = fakeReaction();
    let labels: string[] = ['bug'];

    await runTriage(
      { runner: runnerOf(incomplete), github: api, ledger, reaction },
      { repo: REPO, issueNumber: ISSUE, title: 't', body: '短', currentLabels: labels, botLabels: [], config, skill: triageSkill },
    );
    labels = mirror(labels, api.calls, 0);
    expect(labels).toEqual(['bug', 'needs-info']);

    const cursor = api.calls.length;
    const completed: Verdict = {
      kind: 'issue',
      labels: ['bug'],
      evidence: [
        { rule: 'repro-steps', quote: '1. 打开 2. 点按钮', passed: true },
        { rule: 'version', quote: '0.1.0', passed: true },
      ],
    };
    const second = await runTriage(
      { runner: runnerOf(completed), github: api, ledger, reaction },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: '补齐了',
        currentLabels: labels,
        botLabels: await listBotLabels(sql, { repo: REPO, issueNumber: ISSUE }),
        config,
        skill: triageSkill,
      },
    );

    expect(second.missingEvidence).toEqual([]);
    expect(second.delta?.remove).toEqual(['needs-info']);
    expect(second.reaction).toBeNull();
    labels = mirror(labels, api.calls, cursor);
    expect(labels).toEqual(['bug']);
    expect(reaction.calls).toHaveLength(1); // 只有第一轮打了一次
  });

  it('人把 needs-info 撤下后不再自动加回（human-veto）', async () => {
    const api = createFakeWriteApi();
    // 造历史：我们打过 needs-info，人撤了
    await db.sql(
      `insert into bot_labels (repo, issue_number, label, applied_at, removed_at)
       values ($1, $2, 'needs-info', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')`,
      [REPO, ISSUE],
    );
    const vetoed = await loadHumanVetoed(sql, { repo: REPO, issueNumber: ISSUE });
    expect(vetoed).toEqual(['needs-info']);

    const result = await runTriage(
      { runner: runnerOf(incomplete), github: api, ledger: createPgBotLabelLedger(sql) },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: '短',
        currentLabels: ['bug'],
        botLabels: [],
        humanVetoed: vetoed,
        config,
        skill: triageSkill,
      },
    );

    expect(result.desiredLabels).toEqual(['bug']);
    expect(result.blockedLabels.map((item) => [item.label, item.reason])).toEqual([['needs-info', 'human-veto']]);
    expect(api.calls.some((call) => call.method === 'addLabels')).toBe(false);
  });
});

describe('labels.missing 的三个策略', () => {
  const onlyVocabBug = parseValidSettings({
    labels: {
      // `role` 自 §4.5 / Q4 起必填（`bug` → defect）。
      vocabulary: vocabularyWithRoles([{ name: 'bug', meaning: '崩溃', color: 'FF0000', description: '崩溃/报错' }]),
      map: { bug: 'bug', 'needs-info': 'needs-info' },
      missing: 'warn',
    },
  });

  it('warn（默认）：仓库里没有该标签时只记台账，不动 GitHub', async () => {
    const api = createFakeWriteApi();
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }), github: api, decisions: createPgLabelDecisionRecorder(sql) },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: [],
        botLabels: [],
        repoLabels: [], // 仓库里一个标签都没有
        config: onlyVocabBug,
        skill: triageSkill,
      },
    );

    expect(result.desiredLabels).toEqual([]);
    expect(result.blockedLabels.map((item) => [item.label, item.reason])).toEqual([['bug', 'missing-label']]);
    expect(api.calls.some((call) => call.method === 'addLabels')).toBe(false);
    const rows = await listLabelDecisions(sql, { repo: REPO, targetNumber: ISSUE });
    expect(String(rows[0]?.['blocked_reason'] ?? '')).toContain('missing-label:bug');
  });

  it('create：按词表的 color/description 建标签（只建词表内的）', async () => {
    const api = createFakeWriteApi();
    const catalog = fakeCatalog([]);
    const createConfig = parseValidSettings({
      labels: { ...onlyVocabBug.labels, missing: 'create' },
    });

    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }), github: api, catalog },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: [],
        botLabels: [],
        repoLabels: [],
        config: createConfig,
        skill: triageSkill,
      },
    );

    expect(catalog.created).toEqual([
      { repo: REPO, name: 'bug', color: 'FF0000', description: '崩溃/报错' },
    ]);
    expect(result.desiredLabels).toEqual(['bug']);
    expect(result.outcome).toBe('applied');
  });

  it('create 但标签不在词表 → 不建、记 not-creatable', async () => {
    const api = createFakeWriteApi();
    const catalog = fakeCatalog([]);
    const createConfig = parseValidSettings({
      labels: { map: { bug: 'bug' }, missing: 'create' },
    });

    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }), github: api, catalog },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: [],
        botLabels: [],
        repoLabels: [],
        config: createConfig,
        skill: triageSkill,
      },
    );

    expect(catalog.created).toEqual([]);
    expect(result.blockedLabels.map((item) => [item.label, item.reason])).toEqual([['bug', 'not-creatable']]);
    expect(result.desiredLabels).toEqual([]);
  });

  it('ignore：静默跳过（不记 warn，但仍进 blocked_reason）', async () => {
    const api = createFakeWriteApi();
    const ignoreConfig = parseValidSettings({ labels: { map: { bug: 'bug' }, missing: 'ignore' } });
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }), github: api, decisions: createPgLabelDecisionRecorder(sql) },
      {
        repo: REPO,
        issueNumber: ISSUE,
        title: 't',
        body: 'b',
        currentLabels: [],
        botLabels: [],
        repoLabels: [],
        config: ignoreConfig,
        skill: triageSkill,
      },
    );

    expect(result.desiredLabels).toEqual([]);
    expect(result.blockedLabels.map((item) => item.reason)).toEqual(['missing-label']);
    expect(result.warnings.filter((line) => line.includes('labels.missing'))).toEqual([]);
  });
});

describe('失败不翻 run 与 dry-run', () => {
  it('打标失败 → failure.fatal === false，判定仍然返回', async () => {
    const api = createFakeWriteApi();
    const broken: typeof api = {
      ...api,
      addLabels: async () => {
        throw new Error('502 Bad Gateway');
      },
    };
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: ['bug'], evidence: [] }), github: broken },
      { repo: REPO, issueNumber: ISSUE, title: 't', body: 'b', currentLabels: [], botLabels: [], config, skill: triageSkill },
    );

    expect(result.failure?.fatal).toBe(false);
    expect(result.failure?.message).toContain('502');
    expect(result.verdict?.labels).toEqual(['bug']);
    expect(result.warnings.join('\n')).toContain('打标失败');
  });

  it('dry-run：只算 diff，不写 GitHub / 不打 reaction，但记一行 label_decisions', async () => {
    const api = createFakeWriteApi();
    const reaction = fakeReaction();
    const result = await runTriage(
      { runner: runnerOf({ kind: 'issue', labels: [], evidence: [{ rule: 'repro-steps', quote: '', passed: false }] }), github: api, reaction, decisions: createPgLabelDecisionRecorder(sql) },
      { repo: REPO, issueNumber: ISSUE, title: 't', body: 'b', currentLabels: [], botLabels: [], config, skill: triageSkill, dryRun: true },
    );

    expect(result.outcome).toBe('dry-run');
    expect(result.desiredLabels).toEqual(['needs-info']);
    expect(result.delta?.add).toEqual(['needs-info']);
    expect(api.calls).toHaveLength(0);
    expect(reaction.calls).toEqual([]);

    const rows = await listLabelDecisions(sql, { repo: REPO, targetNumber: ISSUE });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['applied']).toEqual([]);
    expect(String(rows[0]?.['reason'] ?? '')).toContain('dry-run');
  });
});

describe('needsInfoLabelOf', () => {
  it('配了映射就用映射，没配就用字面量 needs-info', () => {
    expect(needsInfoLabelOf(parseValidSettings({ labels: { map: { 'needs-info': '缺少信息' } } }))).toBe('缺少信息');
    expect(needsInfoLabelOf(parseValidSettings({}))).toBe('needs-info');
    expect(needsInfoLabelOf(parseValidSettings({ labels: { map: { 'needs-info': ['缺信息', 'triage'] } } }))).toBe(
      '缺信息',
    );
  });
});
