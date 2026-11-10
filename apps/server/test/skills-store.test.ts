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

import { SkillStoreError, createSkillStore, treeHashOf } from '../src/skills/store.ts';
import type { SkillStore } from '../src/skills/store.ts';
import type { SkillBundle } from '../src/skills/bundle.ts';
import { FIXED_NOW, openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

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
    await db.sql('truncate table skills, skill_versions, skills_audit cascade');
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
