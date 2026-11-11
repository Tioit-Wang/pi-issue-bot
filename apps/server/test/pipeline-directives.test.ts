/**
 * 管理员指令（`workflows/pipeline-directives.ts` + `http/webhook.ts::runDirective`）
 * —— `docs/plan-fixed-pipeline.md` §1.7 Q7 / §8 / §12 V20。
 *
 * 覆盖：四种指令的解析、非 managers 被拒（只打 eyes、不执行、不回复）、
 * 以及「指令不进命令门禁」（`commands.enabled=false` 也照跑）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { parseRepoSettings } from '../../../packages/contract/src/index.ts';
import {
  appendMentions,
  describeDirective,
  isPipelineManager,
  managerMentions,
  parsePipelineDirective,
} from '../src/workflows/pipeline-directives.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import { runDirective } from '../src/http/webhook.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const AT = new Date('2026-06-01T12:00:00.000Z');
const ALIASES = ['pi-bot'];

const SETTINGS = parseRepoSettings({
  pipeline: { managers: ['Alice'] },
  // §4.5：`requirement` / `defect` 两类各至少 1 条，缺一类整份配置解析失败（本文件只关心指令，用最小合法词表）。
  labels: {
    vocabulary: [
      { name: '需求', role: 'requirement' },
      { name: '缺陷', role: 'defect' },
    ],
  },
  commands: { enabled: false },
});

describe('parsePipelineDirective', () => {
  it('/recheck 与 /recheck --force', () => {
    expect(parsePipelineDirective('@pi-bot /recheck', ALIASES)).toEqual({ kind: 'recheck', force: false });
    expect(parsePipelineDirective('麻烦看下\n@pi-bot /recheck --force', ALIASES)).toEqual({
      kind: 'recheck',
      force: true,
    });
  });

  it('/pipeline next 与 /pipeline prev（后面跟别的词也是合法指令）', () => {
    expect(parsePipelineDirective('@pi-bot /pipeline next', ALIASES)).toEqual({ kind: 'next' });
    expect(parsePipelineDirective('@pi-bot /pipeline prev 退回重分类', ALIASES)).toEqual({ kind: 'prev' });
  });

  it('大小写不敏感（GitHub 的句柄本来就不分大小写）', () => {
    expect(parsePipelineDirective('@PI-BOT /RECHECK', ALIASES)).toEqual({ kind: 'recheck', force: false });
  });

  it('不是指令：普通命令 / 裸指令 / 别的别名 / 未知子命令', () => {
    expect(parsePipelineDirective('@pi-bot /review-pr', ALIASES)).toBeNull();
    expect(parsePipelineDirective('/recheck', ALIASES)).toBeNull();
    expect(parsePipelineDirective('@other /recheck', ALIASES)).toBeNull();
    expect(parsePipelineDirective('@pi-bot /pipeline restart', ALIASES)).toBeNull();
    expect(parsePipelineDirective('随便一句话', ALIASES)).toBeNull();
    expect(parsePipelineDirective(undefined, ALIASES)).toBeNull();
  });

  it('describeDirective 还原成人读的原文（审计日志用）', () => {
    expect(describeDirective({ kind: 'recheck', force: true })).toBe('/recheck --force');
    expect(describeDirective({ kind: 'next' })).toBe('/pipeline next');
  });
});

describe('isPipelineManager / managerMentions', () => {
  it('managers 里的 login 大小写不敏感；OWNER 也算管理员', () => {
    expect(isPipelineManager(SETTINGS, { login: 'alice', association: 'CONTRIBUTOR' })).toBe(true);
    expect(isPipelineManager(SETTINGS, { login: 'ALICE', association: null })).toBe(true);
    expect(isPipelineManager(SETTINGS, { login: 'bob', association: 'OWNER' })).toBe(true);
    expect(isPipelineManager(SETTINGS, { login: 'bob', association: 'MEMBER' })).toBe(false);
    expect(isPipelineManager(null, { login: 'alice', association: null })).toBe(false);
  });

  it('`@` 名单只取 managers；appendMentions 不重复追加 /cc', () => {
    expect(managerMentions(SETTINGS)).toEqual(['Alice']);
    expect(appendMentions('结论如下', ['Alice'])).toBe('结论如下\n\n/cc @Alice');
    expect(appendMentions('结论如下\n\n/cc @Alice', ['Alice'])).toBe('结论如下\n\n/cc @Alice');
    expect(appendMentions('结论如下', [])).toBe('结论如下');
  });
});

/* ── runDirective：真库（状态机 + 任务行） ─────────────────────────────────── */

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(AT);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table tasks, webhook_deliveries, issue_pipeline');
});

function commentPayload(input: {
  readonly login: string;
  readonly association: string | null;
  readonly body: string;
  readonly number?: number;
}): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: input.login, type: 'User' },
    issue: { number: input.number ?? 7, title: '标题', body: '正文', user: { login: 'author' } },
    comment: {
      id: 900,
      body: input.body,
      author_association: input.association,
      user: { login: input.login, type: 'User' },
    },
  };
}

async function directive(payload: Record<string, unknown>) {
  return runDirective({
    db: db.pool,
    repo: REPO,
    event: 'issue_comment',
    action: 'created',
    payload,
    aliases: ALIASES,
    settings: SETTINGS,
    at: AT,
    dryRun: false,
    log: createNullLogger(),
  });
}

describe('runDirective（真库）', () => {
  it('非 managers 的 /recheck → ignored（不执行、不建任务）', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 });
    const result = await directive(
      commentPayload({ login: 'bob', association: 'MEMBER', body: '@pi-bot /recheck' }),
    );
    expect(result?.kind).toBe('ignored');
    if (result?.kind === 'ignored') expect(result.reason).toBe('not-manager');
    const rows = await db.sql('select count(*)::int as n from tasks');
    expect(rows[0]?.['n']).toBe(0);
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row?.state).toBe('pending');
  });

  it('managers 的 /pipeline next（format → classify）→ 状态推进 + 建分类任务', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 });
    const result = await directive(
      commentPayload({ login: 'alice', association: 'MEMBER', body: '@pi-bot /pipeline next' }),
    );
    expect(result?.kind).toBe('enqueued');
    if (result?.kind === 'enqueued') expect(result.plan.command).toBe('pipeline:classify');
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'classify', state: 'pending' });
    const tasks = await db.sql('select command, source from tasks');
    expect(tasks).toEqual([{ command: 'pipeline:classify', source: 'pipeline' }]);
  });

  it('`commands.enabled=false` 也不影响指令（§16.1 第 3 条）', async () => {
    // SETTINGS 里 commands.enabled 就是 false
    expect(SETTINGS.commands.enabled).toBe(false);
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'classify' });
    const result = await directive(
      commentPayload({ login: 'alice', association: 'MEMBER', body: '@pi-bot /pipeline prev' }),
    );
    expect(result?.kind).toBe('enqueued');
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'format', state: 'pending' });
  });

  it('没有状态行时指令不执行（§1.3 的放行只针对 @）', async () => {
    const result = await directive(
      commentPayload({ login: 'alice', association: 'MEMBER', body: '@pi-bot /pipeline next' }),
    );
    expect(result?.kind).toBe('ignored');
    if (result?.kind === 'ignored') expect(result.reason).toBe('no-row');
  });

  it('`/pipeline next` 进到 agent/ready 时没有阶段任务（no-stage-task）', async () => {
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'classify' });
    const result = await directive(
      commentPayload({ login: 'alice', association: 'MEMBER', body: '@pi-bot /pipeline next' }),
    );
    expect(result?.kind).toBe('ignored');
    if (result?.kind === 'ignored') expect(result.reason).toBe('no-stage-task');
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'agent', state: 'ready' });
  });

  it('普通评论不是指令（返回 null，交回原通道）', async () => {
    const result = await directive(commentPayload({ login: 'alice', association: 'MEMBER', body: '看下这个' }));
    expect(result).toBeNull();
  });
});
