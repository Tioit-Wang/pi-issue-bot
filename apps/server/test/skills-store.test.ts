/**
 * `skills/store.ts` 的**真库**测试（`pi_issue_bot_test`，见 `helpers/queries-db.ts` 的三条约定）。
 *
 * 断言的是「库里几行、盘上几个文件、审计有没有」，不是形状——形状由 zod 契约保证。
 * 磁盘用 `mkdtemp` 的临时目录，跑完删掉；不碰 `PI_BOT_DATA_DIR`。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Pool } from 'pg';
import { upsertRepo } from '../src/config/repo-config.ts';
import type { SqlRunner } from '../src/config/repo-config.ts';
import {
  CONSERVATIVE_OTHER_LAYERS_CHARS,
  PROMPT_BUDGET_CHARS,
  getPrompt,
  listPromptVersions,
  readLastAssembleStats,
  recordAssembleStats,
  rollbackPrompt,
  savePrompt,
} from '../src/prompt/index.ts';
import { SkillStoreError, createSkillStore, treeHashOf } from '../src/skills/store.ts';
import type { SkillStore } from '../src/skills/store.ts';
import type { SkillBundle } from '../src/skills/bundle.ts';
import { FIXED_NOW, openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

/** `pg.Pool` → `SqlRunner`（`values` 的可变/只读数组形状差异，包一层最省事）。 */
const runnerOf = (pool: Pool): SqlRunner => ({
  query: (text, values) => pool.query(text, values as unknown[]),
});

/** P1 测试用的仓库（`prompt_versions` 的 `repo` 是纯文本，不需要 `repos` 外键）。 */
const PROMPT_REPO = 'acme/widgets';
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 直接造一个「技能包」：本测试不经过 zip（zip → bundle 由 `skills-bundle.test.ts` 覆盖）。 */
function bundleOf(input: {
  name: string;
  description?: string;
  body: string;
  extraFiles?: { path: string; text: string }[];
  validation?: SkillBundle['validation'];
}): SkillBundle {
  const files = [
    {
      path: 'SKILL.md',
      text: `---\nname: ${input.name}\ndescription: ${input.description ?? '演示技能'}\n---\n${input.body}\n`,
    },
    ...(input.extraFiles ?? []).map((file) => ({ path: file.path, text: file.text })),
  ].map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.text, 'utf8'), sha256: sha256(file.text), text: file.text }));

  return {
    name: input.name,
    description: input.description ?? '演示技能',
    frontmatter: { name: input.name, description: input.description ?? '演示技能' },
    body: input.body,
    files,
    treeSha256: treeHashOf(files),
    validation: input.validation ?? { ok: true, errors: [], warnings: [] },
    rootDir: '',
  };
}

describe('skills/store（真库 + 临时目录）', () => {
  let db: TestDb;
  let dataDir: string;
  let store: SkillStore;

  beforeAll(async () => {
    db = await openTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // P1（`prompt_versions`）与它的预算输入（`runtime_flags`）、仓库行（`repos`）一起清：
    // 同一个文件里跑两组存储测试，各组的表互不影响。
    await db.sql('truncate table skills, skill_versions, skills_audit, prompt_versions, runtime_flags, repos cascade');
    dataDir = await mkdtemp(join(tmpdir(), 'pi-skills-'));
    store = createSkillStore({ pool: db.pool, dataDir, now: () => FIXED_NOW });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('上传：建 1 行 + 写入磁盘 + 立即可读（get 的正文来自 SKILL.md）', async () => {
    const result = await store.upload({
      bundle: bundleOf({ name: '/demo', body: '第一条指令' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });

    expect(result.created).toBe(true);
    expect(result.version).toBe(1);
    expect(result.skill.name).toBe('/demo');
    expect(result.skill.sizeBytes).toBeGreaterThan(0);

    const detail = await store.get(result.skill.id);
    expect(detail).not.toBeNull();
    expect(detail?.body).toBe('第一条指令');
    expect(detail?.files.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(detail?.validation.ok).toBe(true);

    const onDisk = await readFile(join(dataDir, 'skills', result.skill.id, '1', 'SKILL.md'), 'utf8');
    expect(onDisk).toContain('第一条指令');

    const audit = await db.sql('select action, actor from skills_audit where skill_id = $1', [result.skill.id]);
    expect(audit).toEqual([{ action: 'upload', actor: 'alice' }]);
  });

  it('同名再传 = 新版本（current_version 前进，历史保留）', async () => {
    const first = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'v1' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });
    const second = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'v2' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });

    expect(second.created).toBe(false);
    expect(second.skill.id).toBe(first.skill.id);
    expect(second.version).toBe(2);
    expect((await store.get(first.skill.id))?.body).toBe('v2');

    const versions = await store.versions(first.skill.id);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
  });

  it('开关：enabled=false 后 list(enabled=true) 为空，但记录仍在；再开启回来', async () => {
    const { skill } = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'x' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });

    await store.patch({ id: skill.id, patch: { enabled: false }, actor: 'alice' });
    expect(await store.list({ enabled: true })).toHaveLength(0);
    expect(await store.list({})).toHaveLength(1);
    expect(await store.activeSkillFiles(null)).toHaveLength(0);

    await store.patch({ id: skill.id, patch: { enabled: true }, actor: 'alice' });
    expect(await store.list({ enabled: true })).toHaveLength(1);
    const active = await store.activeSkillFiles(null);
    expect(active).toHaveLength(1);
    expect(active[0]?.text).toContain('name: /demo');

    const actions = await db.sql('select action from skills_audit order by id');
    expect(actions.map((row) => (row as { action: string }).action)).toEqual(['upload', 'disable', 'enable']);
  });

  it('改正文 = 新版本，且保留原 frontmatter 原文；空正文被拒', async () => {
    const { skill } = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'old body' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });

    const detail = await store.patch({ id: skill.id, patch: { body: 'new body' }, actor: 'bob' });
    expect(detail?.body).toBe('new body');
    expect(detail?.currentVersion).toBe(2);

    const onDisk = await readFile(join(dataDir, 'skills', skill.id, '2', 'SKILL.md'), 'utf8');
    expect(onDisk.startsWith('---\nname: /demo')).toBe(true);
    expect(onDisk).toContain('new body');

    await expect(store.patch({ id: skill.id, patch: { body: '   ' }, actor: 'bob' })).rejects.toBeInstanceOf(
      SkillStoreError,
    );
  });

  it('回滚：回到 v1 的内容，但版本号继续往前走', async () => {
    const { skill } = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'v1 body' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });
    await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'v2 body' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });

    const rolled = await store.rollback({ id: skill.id, version: 1, actor: 'alice' });
    expect(rolled?.version).toBe(3);

    const detail = await store.get(skill.id);
    expect(detail?.body).toBe('v1 body');
    expect(detail?.currentVersion).toBe(3);

    const audit = await db.sql("select action, detail from skills_audit where action = 'rollback'");
    expect(audit).toHaveLength(1);
    expect((audit[0] as { detail: { to: number } }).detail.to).toBe(1);
  });

  it('软删：从列表消失、盘上还在；硬删：行与目录都清掉', async () => {
    const { skill } = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'x' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });
    const dir = join(dataDir, 'skills', skill.id);

    expect(await store.remove({ id: skill.id, hard: false, actor: 'alice' })).toBe(true);
    expect(await store.list({})).toHaveLength(0);
    expect(await store.get(skill.id)).toBeNull();
    expect((await stat(join(dir, '1', 'SKILL.md'))).isFile()).toBe(true);

    // 软删后同名可以重新上传（唯一索引只约束 deleted_at is null）
    const again = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'x' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });
    expect(again.created).toBe(true);
    expect(again.skill.id).not.toBe(skill.id);

    expect(await store.remove({ id: again.skill.id, hard: true, actor: 'alice' })).toBe(true);
    const rows = await db.sql('select count(*)::int as n from skills where id = $1', [again.skill.id]);
    expect((rows[0] as { n: number }).n).toBe(0);
    await expect(stat(join(dataDir, 'skills', again.skill.id))).rejects.toThrow();
  });

  it('覆盖关系：同名时仓库作用域的生效，全局那条标 overriddenBy', async () => {
    const global = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'global' }),
      scope: 'global',
      repo: null,
      enabled: true,
      actor: 'alice',
    });
    const repoScoped = await store.upload({
      bundle: bundleOf({ name: '/demo', body: 'repo' }),
      scope: 'repo',
      repo: 'acme/widgets',
      enabled: true,
      actor: 'alice',
    });

    const list = await store.list({});
    const globalRow = list.find((row) => row.id === global.skill.id);
    const repoRow = list.find((row) => row.id === repoScoped.skill.id);
    expect(repoRow?.overriddenBy).toBeNull();
    expect(globalRow?.overriddenBy).toBe(repoScoped.skill.id);

    // 装配期只取一份：仓库作用域那份，且不进全局
    const active = await store.activeSkillFiles('acme/widgets');
    expect(active).toHaveLength(1);
    expect(active[0]?.text).toContain('repo');

    const otherRepo = await store.activeSkillFiles('other/lib');
    expect(otherRepo).toHaveLength(1);
    expect(otherRepo[0]?.text).toContain('global');
  });

  it('校验不通过（ok=false）的上传直接拒绝，库里不留行', async () => {
    await expect(
      store.upload({
        bundle: bundleOf({
          name: '/demo',
          body: 'x',
          validation: { ok: false, errors: ['缺少 SKILL.md'], warnings: [] },
        }),
        scope: 'global',
        repo: null,
        enabled: true,
        actor: 'alice',
      }),
    ).rejects.toBeInstanceOf(SkillStoreError);

    expect(await store.list({})).toHaveLength(0);
  });
});

/**
 * P1「项目人格层」的存储（W3-G）：`prompt_versions` + `repos.settings.prompt`。
 *
 * 断言的是「库里几行、指针指哪儿、历史有没有被改写」——形状由 zod 契约保证。
 * 放在本文件里而不是另建一个：两者都是「PG 存储层」的真库测试，共用一套夹具与 advisory lock。
 */
describe('prompt/store（真库）：保存即新版本、回滚不改历史、超预算拒写', () => {
  let db: TestDb;
  let runner: SqlRunner;

  beforeAll(async () => {
    db = await openTestDb();
    runner = runnerOf(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.sql('truncate table prompt_versions, runtime_flags, repos cascade');
    // 建仓库行：settings 必须**合法**（§4.5 / Q4 之后 `pipeline.managers` 非空 + 词表 `requirement`/`defect`
    // 各 1 条都是硬要求），否则 `readRepoPolicy` 判 `settings-valid=false`，`savePrompt()` 一律返回 settings-invalid。
    // `prompt` 段默认 `current_version: 0`，`pipeline.*_prompt_version` 默认 0。
    const created = await upsertRepo(runner, {
      repo: PROMPT_REPO,
      settings: validRepoSettings(),
    });
    expect(created.ok).toBe(true);
  });

  /** `repos.settings.prompt.current_version` 的当前值（指针只有一处真源）。 */
  const currentVersionInDb = async (): Promise<number> => {
    const rows = await db.sql('select settings from repos where repo_full_name = $1', [PROMPT_REPO]);
    const settings = (rows[0] as { settings: { prompt: { current_version: number } } }).settings;
    return settings.prompt.current_version;
  };

  it('保存即新建版本：v1 → v2，settings.prompt.current_version 跟着走', async () => {
    // 还没有版本时：getPrompt 返回 0 / 空正文，而不是抛错
    expect(await getPrompt(runner, PROMPT_REPO)).toEqual({
      kind: 'project',
      version: 0,
      body: '',
      enabled: true,
      present: false,
    });
    expect(await currentVersionInDb()).toBe(0);

    const first = await savePrompt(runner, PROMPT_REPO, '项目背景 v1', '首版');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.version).toBe(1);
    expect(await currentVersionInDb()).toBe(1);

    const second = await savePrompt(runner, PROMPT_REPO, '项目背景 v2');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.version).toBe(2);

    expect(await getPrompt(runner, PROMPT_REPO)).toEqual({
      kind: 'project',
      version: 2,
      body: '项目背景 v2',
      enabled: true,
      present: true,
    });

    const versions = await listPromptVersions(runner, PROMPT_REPO);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    // 历史行原样保留（正文与备注都不动）
    expect(versions[0]?.body).toBe('项目背景 v2');
    expect(versions[1]?.body).toBe('项目背景 v1');
    expect(versions[1]?.note).toBe('首版');

    const rows = await db.sql('select count(*)::int as n from prompt_versions where repo = $1', [PROMPT_REPO]);
    expect((rows[0] as { n: number }).n).toBe(2);
  });

  it('回滚：新建一版指向旧内容，旧行一个字都不改', async () => {
    await savePrompt(runner, PROMPT_REPO, 'v1 正文', '首版');
    await savePrompt(runner, PROMPT_REPO, 'v2 正文');

    const rolled = await rollbackPrompt(runner, PROMPT_REPO, 1);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.version).toBe(3);

    const state = await getPrompt(runner, PROMPT_REPO);
    expect(state.version).toBe(3);
    expect(state.body).toBe('v1 正文');
    expect(await currentVersionInDb()).toBe(3);

    const versions = await listPromptVersions(runner, PROMPT_REPO);
    expect(versions.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(versions[0]?.body).toBe('v1 正文');
    expect(versions[0]?.note).toBe('回滚到 v1');
    // 历史不变：v2 还是 v2 的正文
    expect(versions[1]?.body).toBe('v2 正文');

    // 不存在的版本 → 不写库
    const missing = await rollbackPrompt(runner, PROMPT_REPO, 99);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('version-not-found');
    expect(await listPromptVersions(runner, PROMPT_REPO)).toHaveLength(3);
  });

  it('超预算保存被拒：返回 {available, requested}，一行都不写', async () => {
    // 没有历史装配统计 → 保守估算 2400（12000 − 9600）
    const tooLong = 'x'.repeat(3_000);
    const rejected = await savePrompt(runner, PROMPT_REPO, tooLong);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.budget?.available).toBe(PROMPT_BUDGET_CHARS - CONSERVATIVE_OTHER_LAYERS_CHARS);
    expect(rejected.budget?.requested).toBeGreaterThan(3_000);

    expect(await listPromptVersions(runner, PROMPT_REPO)).toHaveLength(0);
    expect(await currentVersionInDb()).toBe(0);

    // 预算内的照常成功
    const accepted = await savePrompt(runner, PROMPT_REPO, 'x'.repeat(1_000));
    expect(accepted.ok).toBe(true);
  });

  it('最近一次装配统计会挤掉 P1 的可用额度（实测优先于估算）', async () => {
    // 估算下 2300 能存（≤ 2400）
    expect((await savePrompt(runner, PROMPT_REPO, 'y'.repeat(2_300))).ok).toBe(true);

    // 记一次「很满」的装配：别的层占 10000 → P1 只剩 2000
    await recordAssembleStats(
      runner,
      PROMPT_REPO,
      { baseChars: 6_000, promptChars: 0, agentsChars: 3_000, skillChars: 1_000, totalChars: 10_000, truncated: [] },
      { now: FIXED_NOW },
    );
    const stats = await readLastAssembleStats(runner, PROMPT_REPO);
    expect(stats?.baseChars).toBe(6_000);
    expect(stats?.at).toBe(FIXED_NOW.toISOString());

    const rejected = await savePrompt(runner, PROMPT_REPO, 'y'.repeat(2_000)); // 2000 + 标题 > 2000
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.budget?.available).toBe(2_000);

    // 2000 以内照常
    expect((await savePrompt(runner, PROMPT_REPO, 'y'.repeat(1_900))).ok).toBe(true);
  });

  it('空正文被拒；仓库不存在时明确说「先建行」', async () => {
    const empty = await savePrompt(runner, PROMPT_REPO, '   ');
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.code).toBe('empty-body');

    const unknown = await savePrompt(runner, 'nobody/nothing', '正文');
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe('repo-not-found');
  });
});
