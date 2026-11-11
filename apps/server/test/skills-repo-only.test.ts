/**
 * 「全局技能已移除」的守卫测试 —— 技能只能是项目（`owner/name`）级。
 *
 * 三件必须钉死的事（任何一件回退都是概念回流）：
 *  1. 列表接口**不给 `repo` 就是 400**，且错误消息明确说「全局技能已移除」；
 *  2. 上传接口**不再接受 `scope`**：`scope=global` 被 `.strict()` 拒成 400（不是被静默忽略）；
 *  3. 隔离性：同仓库多个技能互不干扰、同仓库同名 = 新版本、**不同仓库同名各自独立**，
 *     装配期（`activeSkillFiles`）也只看得到本仓库的那一份。
 *
 * 走真库（`openTestDb`，与其它 `queries-*` 测试共用 `pi_issue_bot_test` + advisory lock），
 * 上传绕过 zip 直接调 `store.upload`：本文件盯的是作用域语义，zip 解包由
 * `skills-bundle.test.ts` / `skills-files-import.test.ts` 覆盖。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, createAllowAllAuth, createOctokitVerifier } from '../src/http/index.ts';
import type { ZodFastify } from '../src/http/index.ts';
import { createSkillStore } from '../src/skills/store.ts';
import type { SkillStore } from '../src/skills/store.ts';
import { bundleFromFiles } from '../src/skills/files.ts';
import type { SkillBundle } from '../src/skills/bundle.ts';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { FIXED_NOW, openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const SECRET = 'test-secret';

/** 一份最小合法 SKILL.md（`description` ≥10 字符是 bundle 层的额外校验）。 */
const skillMd = (name: string, description: string): string =>
  [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'allowed-tools: [Read, Glob]',
    'outputs: [comment]',
    '---',
    '',
    '正文：处理 {{target}}。',
  ].join('\n');

const bundleOf = (name: string, description: string): SkillBundle =>
  bundleFromFiles([{ path: 'SKILL.md', text: skillMd(name, description) }]);

describe('技能只能是项目级（repo-only）', () => {
  let db: TestDb;
  let dataDir: string;
  let app: ZodFastify;
  let store: SkillStore;

  beforeAll(async () => {
    db = await openTestDb(FIXED_NOW);
    dataDir = await mkdtemp(join(tmpdir(), 'pi-skills-repo-only-'));
    store = createSkillStore({ pool: db.pool, dataDir, now: () => FIXED_NOW });
    app = buildServer({
      logger: createNullLogger(),
      pool: db.pool,
      queries: db.queries,
      requireAuth: createAllowAllAuth('tester'),
      skills: { store, writeMode: 'loopback' },
      webhook: {
        verify: createOctokitVerifier(SECRET),
        db: db.pool,
        enqueue: async () => 'job-1',
        ack: { addEyesReaction: async () => undefined },
        logger: createNullLogger(),
        now: () => FIXED_NOW,
      },
      appVersion: 'test',
      now: () => FIXED_NOW,
    });
    await db.sql('truncate table skills, skill_versions, skills_audit cascade');
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await db.sql('truncate table skills, skill_versions, skills_audit cascade');
    await db.close();
  });

  it('GET /api/skills 不带 repo → 400，消息说明全局技能已移除', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/skills' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toContain('repo=owner/name');
    expect(body.error.message).toContain('全局技能已移除');
  });

  it('GET /api/skills 带 scope → 400（查询串 strict 拒绝）', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/skills?repo=o%2Fn&scope=global' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('bad-request');
    expect(JSON.stringify(body.error.details)).toContain('scope');
  });

  it('POST /api/skills 传 scope=global → 400（strict 拒绝，不入库）', async () => {
    await db.sql('truncate table skills, skill_versions, skills_audit cascade');
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills?repo=o%2Fn&scope=global',
      headers: { 'content-type': 'application/zip', 'x-pi-bot-csrf': '1' },
      payload: Buffer.from('not a zip'),
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('bad-request');
    expect(JSON.stringify(body.error.details)).toContain('scope');

    const rows = await db.sql('select count(*)::int as n from skills');
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('同仓库两个技能互不干扰；同仓库同名 = 新版本（不新建行）', async () => {
    const repo = 'acme/skills';
    const alpha1 = await store.upload({
      bundle: bundleOf('/alpha', '第一个技能：用来验证同仓库隔离'),
      repo,
      enabled: true,
      actor: null,
    });
    const beta1 = await store.upload({
      bundle: bundleOf('/beta', '第二个技能：与第一个互不干扰'),
      repo,
      enabled: true,
      actor: null,
    });
    expect(alpha1.created).toBe(true);
    expect(beta1.created).toBe(true);
    expect(alpha1.skill.id).not.toBe(beta1.skill.id);
    expect(alpha1.skill.repo).toBe(repo);
    expect(alpha1.skill.scope).toBe('repo');
    expect(alpha1.skill.overriddenBy).toBeNull();

    // 同名再传 = 新版本（同一行、version+1），不是第二个技能
    const alpha2 = await store.upload({
      bundle: bundleOf('/alpha', '第一个技能：第二版内容更长了'),
      repo,
      enabled: true,
      actor: null,
    });
    expect(alpha2.created).toBe(false);
    expect(alpha2.skill.id).toBe(alpha1.skill.id);
    expect(alpha2.version).toBe(2);

    // beta 完全没被动过
    const betaAgain = await store.get(beta1.skill.id);
    expect(betaAgain?.currentVersion).toBe(1);

    const listed = await store.list({ repo });
    expect(listed.map((item) => item.name).sort()).toEqual(['/alpha', '/beta']);
    expect(listed.every((item) => item.repo === repo && item.scope === 'repo')).toBe(true);
    expect(listed.every((item) => item.overriddenBy === null)).toBe(true);
  });

  it('不同仓库同名各自独立（不同 id、各自 version=1、列表各看各的）', async () => {
    const left = await store.upload({
      bundle: bundleOf('/shared-name', '同名技能：左边仓库的那一份'),
      repo: 'left/one',
      enabled: true,
      actor: null,
    });
    const right = await store.upload({
      bundle: bundleOf('/shared-name', '同名技能：右边仓库的那一份'),
      repo: 'right/two',
      enabled: true,
      actor: null,
    });

    expect(left.created).toBe(true);
    expect(right.created).toBe(true);
    expect(left.skill.id).not.toBe(right.skill.id);
    expect(left.version).toBe(1);
    expect(right.version).toBe(1);

    const leftDetail = await store.get(left.skill.id);
    const rightDetail = await store.get(right.skill.id);
    expect(leftDetail?.repo).toBe('left/one');
    expect(rightDetail?.repo).toBe('right/two');
    expect(leftDetail?.scope).toBe('repo');

    expect((await store.list({ repo: 'left/one' })).map((item) => item.repo)).toEqual(['left/one']);
    expect((await store.list({ repo: 'right/two' })).map((item) => item.repo)).toEqual(['right/two']);
  });

  it('store.upload({repo}) 写入后，activeSkillFiles / activeSkillNames 只看本仓库', async () => {
    const name = '/probe-skill';
    await store.upload({
      bundle: bundleOf(name, '装配期隔离：只属于 probe/one 的技能'),
      repo: 'probe/one',
      enabled: true,
      actor: null,
    });

    const filesHere = await store.activeSkillFiles('probe/one');
    expect(filesHere.map((file) => file.path)).toContain(`upload:${name}`);
    expect(await store.activeSkillNames('probe/one')).toContain(name);

    const filesElsewhere = await store.activeSkillFiles('probe/two');
    expect(filesElsewhere.map((file) => file.path)).not.toContain(`upload:${name}`);
    expect(await store.activeSkillNames('probe/two')).not.toContain(name);
  });
});
