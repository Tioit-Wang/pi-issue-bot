/**
 * 技能「按文件」读写 + 多技能 zip 导入（`skills/files.ts` 与 `/api/skills/:id/files`、`/api/skills/import`）。
 *
 * 两块各自盯一类失效：
 *  1. **纯函数**（`normalizeSkillFilePath` / `bundleFromFiles` / `splitZipBundles`）盯「手输路径与
 *     重建包」的边界：`..`、绝对路径、非法段、缺 `SKILL.md`、frontmatter 非法，全都要变成
 *     `validation.errors` / `errors` 而不是异常或静默放行。
 *  2. **HTTP** 盯「编辑器保存一个文件后，其余文件是否原样保留、是否真生成新版本」，
 *     以及导入接口「部分成功仍 200 + errors」的语义。
 *
 * zip 一律现场拼（`makeZip`，与 `skills-zip.test.ts` 同款思路）：不新增依赖，且坏样本可造。
 */
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpError, buildServer, createAllowAllAuth, createOctokitVerifier } from '../src/http/index.ts';
import type { ZodFastify } from '../src/http/index.ts';
import { createSkillStore } from '../src/skills/store.ts';
import {
  bundleFromFiles,
  isEditableSkillPath,
  normalizeSkillFilePath,
  replaceFileIn,
  splitZipBundles,
} from '../src/skills/files.ts';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { FIXED_NOW, openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/* ── 迷你 zip 写包器（本地 deflate + 中央目录 + EOCD，CRC32 自算）──────────────── */

const utf8 = new TextEncoder();

/** CRC32（zip 的 `crc-32` 字段）；测试自己算，不复用 `zip.ts` 的实现，免得实现错了测试也错。 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type BuildEntry = { name: string; text: string; method?: 'store' | 'deflate' };

function makeZip(entries: readonly BuildEntry[]): Buffer {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localSize = 0;

  for (const entry of entries) {
    const name = utf8.encode(entry.name);
    const data = utf8.encode(entry.text);
    const method = entry.method === 'deflate' ? 8 : 0;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 文件名
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, payload);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x0314, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localSize, true);
    central.set(name, 46);
    centralParts.push(central);

    localSize += local.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localSize, true);

  return Buffer.from(
    Buffer.concat([...localParts, ...centralParts, eocd].map((part) => Buffer.from(part))),
  );
}

/* ── 技能文本样本 ──────────────────────────────────────────────────────────── */

/** 一份最小合法 SKILL.md（`description` ≥10 字符、正文非空，两个都是 bundle 层额外的校验）。 */
const skillMd = (name: string, description = '用来测试按文件编辑的技能描述'): string =>
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

const API_MD_V1 = '# API 参考\n\n第一版内容。\n';
const API_MD_V2 = '# API 参考\n\n第二版内容（编辑器保存）。\n';

/* ── 纯函数 ────────────────────────────────────────────────────────────────── */

describe('normalizeSkillFilePath', () => {
  it('合法路径：去空白、反斜杠转 `/`、保留大小写与层级', () => {
    expect(normalizeSkillFilePath('SKILL.md')).toBe('SKILL.md');
    expect(normalizeSkillFilePath('  references/api.md  ')).toBe('references/api.md');
    expect(normalizeSkillFilePath('references\\api.md')).toBe('references/api.md');
    expect(normalizeSkillFilePath('a\\b\\c-d_1.txt')).toBe('a/b/c-d_1.txt');
    // 300 字符上限之内（3 段 × 80 + 2 个分隔符 = 242）
    const long = [80, 80, 80].map((n) => 'a'.repeat(n)).join('/');
    expect(normalizeSkillFilePath(long)).toBe(long);
  });

  it('非法路径一律 null：空串 / 绝对路径 / `..` / 空段 / 超长', () => {
    expect(normalizeSkillFilePath('')).toBeNull();
    expect(normalizeSkillFilePath('   ')).toBeNull();
    expect(normalizeSkillFilePath('/etc/passwd')).toBeNull();
    expect(normalizeSkillFilePath('C:/windows/x.md')).toBeNull();
    expect(normalizeSkillFilePath('../etc/passwd')).toBeNull();
    expect(normalizeSkillFilePath('a/../b.md')).toBeNull();
    expect(normalizeSkillFilePath('a//b.md')).toBeNull();
    // 总长 > 300（4 × 80 + 3 = 323）
    expect(normalizeSkillFilePath([80, 80, 80, 80].map((n) => 'a'.repeat(n)).join('/'))).toBeNull();
    // 单段 > 120
    expect(normalizeSkillFilePath('a'.repeat(121))).toBeNull();
  });

  it('中文 / 空格是正常文件名（与 zip 侧同一口径）', () => {
    // 旧实现在这里返回 null：`[A-Za-z0-9._-]` 段正则把中文与空格判非法，
    // 于是「zip 能上传、面板改一个字就 400」，而报错点名的是他没动过的附件。
    expect(normalizeSkillFilePath('参考 文档.md')).toBe('参考 文档.md');
    expect(normalizeSkillFilePath('references/设计 说明.md')).toBe('references/设计 说明.md');
    expect(normalizeSkillFilePath('a/./b.md')).toBe('a/b.md');
  });
});

describe('isEditableSkillPath', () => {
  it('只认 md / markdown / txt / json / yaml / yml / toml（大小写不敏感）', () => {
    for (const path of [
      'SKILL.md',
      'references/api.markdown',
      'notes.txt',
      'config.json',
      'config.yaml',
      'config.yml',
      'config.toml',
      'references/API.MD',
    ]) {
      expect(isEditableSkillPath(path)).toBe(true);
    }
  });

  it('二进制与脚本不算可编辑', () => {
    for (const path of ['assets/logo.png', 'run.sh', 'a.exe', 'b.zip', 'c.md.bak', 'dmarkdown']) {
      expect(isEditableSkillPath(path)).toBe(false);
    }
  });
});

describe('bundleFromFiles', () => {
  it('缺 SKILL.md → validation.ok=false 且不抛异常', () => {
    const bundle = bundleFromFiles([{ path: 'references/api.md', text: '# 只有附件\n' }]);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors.join('；')).toContain('缺少入口文件 SKILL.md');
    expect(bundle.name).toBe('/invalid-skill');
  });

  it('frontmatter 非法 → validation.ok=false，错误里点名 SKILL.md', () => {
    const noFence = bundleFromFiles([{ path: 'SKILL.md', text: 'name: /demo\ndescription: 没有 frontmatter' }]);
    expect(noFence.validation.ok).toBe(false);
    expect(noFence.validation.errors.join('；')).toContain('SKILL.md frontmatter 非法');

    const badName = bundleFromFiles([
      { path: 'SKILL.md', text: skillMd('/Bad Name') },
    ]);
    expect(badName.validation.ok).toBe(false);
    expect(badName.validation.errors.join('；')).toContain('SKILL.md frontmatter 非法');
  });

  it('正常含附件 → files 按 path 排序、bytes/sha256 与内容一致、name 归一成 `/xxx`', () => {
    const bundle = bundleFromFiles([
      { path: 'references/api.md', text: API_MD_V1 },
      { path: 'SKILL.md', text: skillMd('/demo-skill') },
      { path: 'assets\\b.json', text: '{}\n' },
    ]);
    expect(bundle.validation.ok).toBe(true);
    expect(bundle.validation.errors).toEqual([]);
    // `SKILL.md` 有效 → 名字取 frontmatter（仅小写归一，大小写非法时 schema 会拒，这里用合法名）
    expect(bundle.name).toBe('/demo-skill');
    expect(bundle.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'assets/b.json',
      'references/api.md',
    ]);
    expect(bundle.files.find((file) => file.path === 'references/api.md')?.bytes).toBe(
      Buffer.byteLength(API_MD_V1, 'utf8'),
    );
    expect(bundle.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true);
    expect(bundle.treeSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('treeSha256 稳定：入参顺序不影响结果，内容变了才变', () => {
    const files = [
      { path: 'SKILL.md', text: skillMd('/demo-skill') },
      { path: 'references/api.md', text: API_MD_V1 },
    ];
    const forward = bundleFromFiles(files).treeSha256;
    const reverse = bundleFromFiles([...files].reverse()).treeSha256;
    expect(reverse).toBe(forward);

    const changed = bundleFromFiles([
      files[0] as { path: string; text: string },
      { path: 'references/api.md', text: API_MD_V2 },
    ]).treeSha256;
    expect(changed).not.toBe(forward);
  });

  it('重复路径与非法路径都进 errors（不抛、不静默丢弃）', () => {
    const bundle = bundleFromFiles([
      { path: 'SKILL.md', text: skillMd('/demo-skill') },
      { path: 'references/api.md', text: API_MD_V1 },
      { path: 'references/api.md', text: API_MD_V2 },
      { path: '../escape.md', text: 'x' },
    ]);
    expect(bundle.validation.ok).toBe(false);
    const errors = bundle.validation.errors.join('；');
    expect(errors).toContain('文件路径重复：references/api.md');
    expect(errors).toContain('非法文件路径');
    // 第一份保留，重复的那份被跳过
    expect(bundle.files.find((file) => file.path === 'references/api.md')?.text).toBe(API_MD_V1);
  });
});

describe('replaceFileIn', () => {
  it('替换已有文件 / 追加新文件，且不改入参', () => {
    const original = [
      { path: 'SKILL.md', text: skillMd('/demo-skill') },
      { path: 'references/api.md', text: API_MD_V1 },
    ];
    const replaced = replaceFileIn(original, 'references/api.md', API_MD_V2);
    expect(replaced).toHaveLength(2);
    expect(replaced.find((file) => file.path === 'references/api.md')?.text).toBe(API_MD_V2);
    expect(original.find((file) => file.path === 'references/api.md')?.text).toBe(API_MD_V1);

    const added = replaceFileIn(original, 'notes/todo.txt', 'todo\n');
    expect(added.map((file) => file.path).sort()).toEqual([
      'SKILL.md',
      'notes/todo.txt',
      'references/api.md',
    ]);
    expect(original).toHaveLength(2);
  });
});

describe('splitZipBundles', () => {
  it('两个技能目录 → 2 个包，附件路径去掉目录前缀', () => {
    const zip = makeZip([
      { name: 'alpha/SKILL.md', text: skillMd('/alpha-skill') },
      { name: 'alpha/references/api.md', text: API_MD_V1, method: 'deflate' },
      { name: 'beta/SKILL.md', text: skillMd('/beta-skill') },
    ]);
    const split = splitZipBundles(zip);
    expect(split.errors).toEqual([]);
    expect(split.bundles.map((bundle) => bundle.name)).toEqual(['/alpha-skill', '/beta-skill']);
    expect(split.bundles[0]?.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/api.md',
    ]);
    expect(split.bundles[0]?.validation.ok).toBe(true);
    expect(split.bundles[1]?.validation.ok).toBe(true);
  });

  it('扁平 SKILL.md（zip 根）→ 1 个包，根下附件归给这个包', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillMd('/flat-skill') },
      { name: 'references/api.md', text: API_MD_V1 },
      { name: 'README.md', text: '包说明\n' },
    ]);
    const split = splitZipBundles(zip);
    expect(split.errors).toEqual([]);
    expect(split.bundles).toHaveLength(1);
    expect(split.bundles[0]?.name).toBe('/flat-skill');
    expect(split.bundles[0]?.files.map((file) => file.path)).toEqual([
      'README.md',
      'SKILL.md',
      'references/api.md',
    ]);
  });

  it('没有 SKILL.md → bundles 为空 + errors 非空', () => {
    const zip = makeZip([
      { name: 'README.md', text: '这不是技能\n' },
      { name: 'assets/a.txt', text: 'a\n' },
    ]);
    const split = splitZipBundles(zip);
    expect(split.bundles).toEqual([]);
    expect(split.errors.length).toBeGreaterThan(0);
    expect(split.errors.join('；')).toContain('SKILL.md');
  });

  it('技能目录之外的散文件 → 记 warning 而不是错误', () => {
    const zip = makeZip([
      { name: 'alpha/SKILL.md', text: skillMd('/alpha-skill') },
      { name: 'loose-notes.md', text: '根目录的散文件\n' },
    ]);
    const split = splitZipBundles(zip);
    expect(split.errors).toEqual([]);
    expect(split.bundles).toHaveLength(1);
    expect(split.bundles[0]?.validation.warnings.join('；')).toContain(
      '忽略技能目录之外的文件',
    );
  });
});

/* ── HTTP 层 ───────────────────────────────────────────────────────────────── */

const SECRET = 'test-secret';
const WRITE_HEADERS = {
  'x-pi-bot-csrf': '1',
  'content-type': 'application/json',
} as const;

describe('技能按文件读写与批量导入（HTTP 层）', () => {
  let db: TestDb;
  let dataDir: string;
  let app: ZodFastify;

  /** 上传一份 zip 并返回技能 id（走既有 POST /api/skills，不另造写库路径）。 */
  async function uploadSkill(zip: Buffer): Promise<{ id: string; name: string; version: number }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills?repo=o%2Fn',
      headers: { 'content-type': 'application/zip', 'x-pi-bot-csrf': '1' },
      payload: zip,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      skill: { id: string; name: string };
      version: number;
      validation: { ok: boolean };
    };
    expect(body.validation.ok).toBe(true);
    return { id: body.skill.id, name: body.skill.name, version: body.version };
  }

  beforeAll(async () => {
    db = await openTestDb(FIXED_NOW);
    dataDir = await mkdtemp(join(tmpdir(), 'pi-skills-files-'));
    app = buildServer({
      logger: createNullLogger(),
      pool: db.pool,
      queries: db.queries,
      requireAuth: createAllowAllAuth('tester'),
      skills: { store: createSkillStore({ pool: db.pool, dataDir, now: () => FIXED_NOW }), writeMode: 'loopback' },
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
    // 收尾：技能表不在 `db.truncate()` 的清单里（那是共享库的「业务表」集合），
    // 本文件上传的技能行必须自己清掉，否则后续文件会看到多出来的技能。
    await db.sql('truncate table skills, skill_versions, skills_audit cascade');
    await db.close();
  });

  it('GET /api/skills/:id/files → 200 + 两个文件（按 path 排序、文本原样）', async () => {
    const skill = await uploadSkill(
      makeZip([
        { name: 'SKILL.md', text: skillMd('/skill-with-refs') },
        { name: 'references/api.md', text: API_MD_V1, method: 'deflate' },
      ]),
    );

    const response = await app.inject({ method: 'GET', url: `/api/skills/${skill.id}/files` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      generatedAt: string;
      skillId: string;
      files: { path: string; text: string }[];
    };
    expect(body.skillId).toBe(skill.id);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/api.md']);
    expect(body.files[1]?.text).toBe(API_MD_V1);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/skills/:id/files 不存在的技能 → 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/skills/does-not-exist/files' });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('not-found');
  });

  it('PUT /api/skills/:id/files 改 references/api.md → 200 新版本，SKILL.md 原样保留', async () => {
    const skill = await uploadSkill(
      makeZip([
        { name: 'SKILL.md', text: skillMd('/editable-skill') },
        { name: 'references/api.md', text: API_MD_V1 },
      ]),
    );

    const before = await app.inject({ method: 'GET', url: `/api/skills/${skill.id}/files` });
    const beforeFiles = (before.json() as { files: { path: string; text: string }[] }).files;
    const beforeSkillMd = beforeFiles.find((file) => file.path === 'SKILL.md')?.text;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/skills/${skill.id}/files`,
      headers: WRITE_HEADERS,
      payload: { path: 'references/api.md', text: API_MD_V2 },
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json() as {
      id: string;
      currentVersion: number;
      files: { path: string; sha256: string }[];
      treeSha256: string;
    };
    expect(detail.id).toBe(skill.id);
    expect(detail.currentVersion).toBe(2);
    expect(detail.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/api.md']);

    const after = await app.inject({ method: 'GET', url: `/api/skills/${skill.id}/files` });
    const afterFiles = (after.json() as { files: { path: string; text: string }[] }).files;
    expect(afterFiles.find((file) => file.path === 'references/api.md')?.text).toBe(API_MD_V2);
    // 关键断言：只改了一个文件，入口文件必须逐字节不变
    expect(afterFiles.find((file) => file.path === 'SKILL.md')?.text).toBe(beforeSkillMd);
  });

  it('PUT .../files 非法路径（`../`）→ 400 bad-request', async () => {
    const skill = await uploadSkill(makeZip([{ name: 'SKILL.md', text: skillMd('/bad-path-skill') }]));
    const response = await app.inject({
      method: 'PUT',
      url: `/api/skills/${skill.id}/files`,
      headers: WRITE_HEADERS,
      payload: { path: '../etc/passwd', text: 'x' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toContain('非法的文件路径');
  });

  it('PUT .../files 非文本扩展名 → 400（只支持 md/txt/json/yaml/toml）', async () => {
    const skill = await uploadSkill(makeZip([{ name: 'SKILL.md', text: skillMd('/binary-skill') }]));
    const response = await app.inject({
      method: 'PUT',
      url: `/api/skills/${skill.id}/files`,
      headers: WRITE_HEADERS,
      payload: { path: 'assets/logo.png', text: 'not really a png' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain(
      '只支持编辑文本文件',
    );
  });

  it('PUT .../files 把 SKILL.md 改成非法 frontmatter → 400「技能校验不通过」', async () => {
    const skill = await uploadSkill(makeZip([{ name: 'SKILL.md', text: skillMd('/broken-fm-skill') }]));
    const response = await app.inject({
      method: 'PUT',
      url: `/api/skills/${skill.id}/files`,
      headers: WRITE_HEADERS,
      payload: { path: 'SKILL.md', text: '这段文字没有 frontmatter，也没有结束分隔行。' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toContain('技能校验不通过');
  });

  it('PUT .../files 改技能名 → 400「不允许在编辑器里改技能名」', async () => {
    const skill = await uploadSkill(makeZip([{ name: 'SKILL.md', text: skillMd('/rename-me') }]));
    const response = await app.inject({
      method: 'PUT',
      url: `/api/skills/${skill.id}/files`,
      headers: WRITE_HEADERS,
      payload: { path: 'SKILL.md', text: skillMd('/another-name') },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toContain('不允许在编辑器里改技能名');
  });

  it('POST /api/skills/import 含两个技能目录的 zip → imported 长度 2', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import?repo=o%2Fn',
      headers: { 'content-type': 'application/zip', 'x-pi-bot-csrf': '1' },
      payload: makeZip([
        { name: 'alpha/SKILL.md', text: skillMd('/import-alpha') },
        { name: 'alpha/references/api.md', text: API_MD_V1, method: 'deflate' },
        { name: 'beta/SKILL.md', text: skillMd('/import-beta') },
      ]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      imported: { id: string; name: string; version: number; created: boolean }[];
      errors: string[];
      warnings: string[];
    };
    expect(body.errors).toEqual([]);
    expect(body.imported).toHaveLength(2);
    expect(body.imported.map((item) => item.name)).toEqual(['/import-alpha', '/import-beta']);
    expect(body.imported.every((item) => item.version === 1 && item.created)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);

    // 导入的技能确实带上了附件（不是只落了 SKILL.md）
    const files = await app.inject({
      method: 'GET',
      url: `/api/skills/${body.imported[0]?.id ?? 'x'}/files`,
    });
    expect(files.statusCode).toBe(200);
    expect((files.json() as { files: { path: string }[] }).files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/api.md',
    ]);
  });

  it('POST /api/skills/import 的 zip 里没有 SKILL.md → 200 且 errors 非空', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import?repo=o%2Fn',
      headers: { 'content-type': 'application/zip', 'x-pi-bot-csrf': '1' },
      payload: makeZip([{ name: 'README.md', text: '这不是技能，只是一份说明。\n' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { imported: unknown[]; errors: string[] };
    expect(body.imported).toEqual([]);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.join('；')).toContain('SKILL.md');
  });

  it('POST /api/skills/import 缺 X-Pi-Bot-CSRF → 403（写面第一道门）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills/import?repo=o%2Fn',
      headers: { 'content-type': 'application/zip' },
      payload: makeZip([{ name: 'SKILL.md', text: skillMd('/csrf-skill') }]),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('PUT .../files 不存在的技能 → 404（先校验路径，再查技能）', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/skills/does-not-exist/files',
      headers: WRITE_HEADERS,
      payload: { path: 'SKILL.md', text: skillMd('/whatever') },
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /api/skills/:id/files 未登录 → 401（沿用既有 requireAuth）', async () => {
    const deniedApp = buildServer({
      logger: createNullLogger(),
      pool: db.pool,
      queries: db.queries,
      requireAuth: async () => {
        throw new HttpError('unauthorized', '未登录');
      },
      skills: {
        store: createSkillStore({ pool: db.pool, dataDir, now: () => FIXED_NOW }),
        writeMode: 'loopback',
      },
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
    try {
      const response = await deniedApp.inject({ method: 'GET', url: '/api/skills/x/files' });
      expect(response.statusCode).toBe(401);
    } finally {
      await deniedApp.close();
    }
  });
});
