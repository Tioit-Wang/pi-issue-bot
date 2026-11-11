/**
 * `skills/bundle.ts` —— 技能包（zip 里的 `SKILL.md` 目录）的定根、frontmatter 校验与清单。
 *
 * 这组测试的判据是 `docs/spec/skill-management.md` §9 的两条分界：
 *  - **结构性**坏输入（`../`、非 zip、超限额）必须抛 `ZipError`；
 *  - **技能内容**问题（缺/多 `SKILL.md`、frontmatter 不合规）必须进 `validation.errors` 且 `ok=false`，
 *    **不抛**——否则上传者一次只能知道一个原因。
 *
 * zip 同样现场拼（`makeZip`），不依赖任何真 zip 文件与网络。
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { extractSkillBundle } from '../src/skills/bundle.ts';
import { ZipError } from '../src/skills/zip.ts';

const utf8 = new TextEncoder();

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

type BuildEntry = { name: string; text?: string; bytes?: Uint8Array; method?: 'store' | 'deflate' };

/** 迷你写包器（与 `skills-zip.test.ts` 同款）：本地文件头 + 数据 + 中央目录 + EOCD。 */
function makeZip(entries: readonly BuildEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localSize = 0;

  for (const entry of entries) {
    const name = utf8.encode(entry.name);
    const data = entry.bytes ?? utf8.encode(entry.text ?? '');
    const method = entry.method === 'deflate' ? 8 : 0;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
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
    centralView.setUint16(4, 20, true);
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

  const zip = new Uint8Array(localSize + centralSize + eocd.length);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    zip.set(part, cursor);
    cursor += part.length;
  }
  return zip;
}

/** 一份最小合法 SKILL.md（各用例在此基础上改一行）。 */
function skillText(overrides: { name?: string; extraFrontmatter?: string; body?: string } = {}): string {
  return [
    '---',
    `name: ${overrides.name ?? '/demo-cmd'}`,
    'description: 一个用来测试的最小技能描述',
    'allowed-tools: [Read, Glob]',
    'outputs: [comment]',
    ...(overrides.extraFrontmatter === undefined ? [] : [overrides.extraFrontmatter]),
    '---',
    '',
    overrides.body ?? '正文：处理 {{target}}。',
  ].join('\n');
}

describe('定根：zip 根布局与单顶层目录布局', () => {
  it('SKILL.md 在 zip 根 → rootDir 为 空串，附件路径原样', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText() },
      { name: 'assets/note.txt', text: 'note' },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.rootDir).toBe('');
    expect(bundle.validation).toEqual({ ok: true, errors: [], warnings: [] });
    expect(bundle.name).toBe('/demo-cmd');
    expect(bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/note.txt']);
  });

  it('单顶层目录布局 → rootDir 是该目录，文件路径相对技能根', () => {
    const zip = makeZip([
      { name: 'demo/SKILL.md', text: skillText() },
      { name: 'demo/assets/note.txt', text: 'note' },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.rootDir).toBe('demo');
    expect(bundle.validation.ok).toBe(true);
    expect(bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/note.txt']);
  });

  it('zip 根 + 两个顶层技能目录 → error「一个 zip 只能含一个技能」', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText() },
      { name: 'a/SKILL.md', text: skillText({ name: '/skill-a' }) },
      { name: 'b/SKILL.md', text: skillText({ name: '/skill-b' }) },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors).toContain('一个 zip 只能含一个技能');
  });

  it('两个顶层技能目录（无 zip 根 SKILL.md）→ 同样是一个技能的约束', () => {
    const zip = makeZip([
      { name: 'a/SKILL.md', text: skillText({ name: '/skill-a' }) },
      { name: 'b/SKILL.md', text: skillText({ name: '/skill-b' }) },
    ]);
    expect(extractSkillBundle(zip).validation.errors).toContain('一个 zip 只能含一个技能');
  });

  it('没有 SKILL.md → error「缺少 SKILL.md」', () => {
    const zip = makeZip([
      { name: 'demo/README.md', text: '# 只有说明，没有 SKILL.md' },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors).toContain('缺少 SKILL.md');
  });

  it('__MACOSX 与 .DS_Store 被忽略，不参与定根与清单', () => {
    const zip = makeZip([
      { name: 'demo/SKILL.md', text: skillText() },
      { name: '__MACOSX/._SKILL.md', text: 'junk' },
      { name: 'demo/.DS_Store', text: 'junk' },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.rootDir).toBe('demo');
    expect(bundle.files.map((file) => file.path)).toEqual(['SKILL.md']);
  });
});

describe('name 归一化（决策 D2：宽松入、规范存）', () => {
  it('`name: review-pr` 归一成 `/review-pr` 且校验通过', () => {
    const bundle = extractSkillBundle(makeZip([{ name: 'SKILL.md', text: skillText({ name: 'review-pr' }) }]));
    expect(bundle.name).toBe('/review-pr');
    expect(bundle.validation.ok).toBe(true);
  });

  it('`/review-pr` 原样保留', () => {
    const bundle = extractSkillBundle(makeZip([{ name: 'SKILL.md', text: skillText({ name: '/review-pr' }) }]));
    expect(bundle.name).toBe('/review-pr');
  });

  it('非法名（大写+下划线）→ errors 里有 name 的原因，name 退回 bestEffortName', () => {
    const zip = makeZip([{ name: 'SKILL.md', text: skillText({ name: 'Review_PR' }) }]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors.join(' ')).toContain('name 不合规');
    // 宽松归一后仍是 `/review_pr`（进 errors 的原因来自下划线，而不是大小写）。
    expect(bundle.name).toBe('/review_pr');
  });

  it('落盘的 SKILL.md 正文也必须是规范名（装配期会重新解析磁盘文本）', () => {
    const bundle = extractSkillBundle(makeZip([{ name: 'SKILL.md', text: skillText({ name: 'review-pr' }) }]));
    const skillMd = bundle.files.find((file) => file.path === 'SKILL.md');
    expect(skillMd?.text).toContain('name: /review-pr');
    expect(skillMd?.text.startsWith('---\nname: /review-pr')).toBe(true);
  });
});

describe('frontmatter 校验失败进 errors（不抛）', () => {
  it('未知键 → errors 指出键名', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText({ extraFrontmatter: 'allowed-tool: [Read, Bash]' }) },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors.join(' ')).toContain('未知键');
    expect(bundle.validation.errors.join(' ')).toContain('allowed-tool');
  });

  it('allowed-tools 用了枚举外的工具 → errors 非空', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText().replace('allowed-tools: [Read, Glob]', 'allowed-tools: [Read, WebFetch]') },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors.join(' ')).toContain('allowed-tools 不合规');
  });

  it('省略 outputs（Agent Skills 标准里可选）→ 仍然合法', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText().replace('outputs: [comment]\n', '') },
    ]);
    const bundle = extractSkillBundle(zip);
    // 本仓曾把 `outputs` 当必填；对齐 agentskills.io 后它是可选项，
    // 生效值由 `toSkillEffectiveConfig` 补 `DEFAULT_SKILL_OUTPUTS`（`['comment']`）。
    expect(bundle.validation.ok).toBe(true);
  });

  it('正文为空 → error', () => {
    const zip = makeZip([{ name: 'SKILL.md', text: skillText({ body: '' }) }]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors.join(' ')).toContain('正文为空');
  });

  it('SKILL.md 是二进制 → error，不是 warning', () => {
    const zip = makeZip([{ name: 'SKILL.md', bytes: new Uint8Array([0, 1, 2, 3]) }]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(false);
    expect(bundle.validation.errors.join(' ')).toContain('不是 UTF-8 文本');
  });
});

describe('附件：二进制跳过、脚本只 warn', () => {
  it('二进制附件被排除出 files 并给 warning（技能仍 ok）', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText() },
      { name: 'assets/logo.bin', bytes: new Uint8Array([0x00, 0x01, 0x02]) },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(true);
    expect(bundle.files.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(bundle.validation.warnings.join(' ')).toContain('跳过二进制文件：assets/logo.bin');
  });

  it('带 .sh 附件给 warning 但仍 ok（§8：能带，但不会自动执行）', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText() },
      { name: 'scripts/helper.sh', text: '#!/bin/sh\necho hi\n' },
    ]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(true);
    expect(bundle.validation.warnings.join(' ')).toContain('可执行脚本');
    expect(bundle.validation.warnings.join(' ')).toContain('scripts/helper.sh');
  });

  it('附件超过 50 个 → warning', () => {
    const attachments: BuildEntry[] = Array.from({ length: 51 }, (_unused, index) => ({
      name: `assets/f${index}.txt`,
      text: `n${index}`,
    }));
    const zip = makeZip([{ name: 'SKILL.md', text: skillText() }, ...attachments]);
    const bundle = extractSkillBundle(zip);
    expect(bundle.validation.ok).toBe(true);
    expect(bundle.validation.warnings.join(' ')).toContain('附件数量超过上限');
  });
});

describe('treeSha256', () => {
  it('同样内容的两个 zip → 同一个 treeSha256（64 位小写 hex）', () => {
    const entries: BuildEntry[] = [
      { name: 'SKILL.md', text: skillText() },
      { name: 'assets/note.txt', text: 'note' },
    ];
    const first = extractSkillBundle(makeZip(entries));
    const second = extractSkillBundle(makeZip(entries));
    expect(first.treeSha256).toBe(second.treeSha256);
    expect(first.treeSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('改一个字节 → treeSha256 变化（且仅附件变化时也变）', () => {
    const base = extractSkillBundle(
      makeZip([
        { name: 'SKILL.md', text: skillText() },
        { name: 'assets/note.txt', text: 'note' },
      ]),
    );
    const changed = extractSkillBundle(
      makeZip([
        { name: 'SKILL.md', text: skillText() },
        { name: 'assets/note.txt', text: 'notf' },
      ]),
    );
    expect(changed.treeSha256).not.toBe(base.treeSha256);
    // 单文件 sha256 也变了，但 SKILL.md 没变。
    expect(changed.files.find((file) => file.path === 'SKILL.md')?.sha256).toBe(
      base.files.find((file) => file.path === 'SKILL.md')?.sha256,
    );
  });
});

describe('结构性坏输入抛 ZipError（不是 validation.errors）', () => {
  it('zip slip → unsafe-path', () => {
    const zip = makeZip([{ name: '../SKILL.md', text: skillText() }]);
    expect(() => extractSkillBundle(zip)).toThrow(ZipError);
    try {
      extractSkillBundle(zip);
    } catch (error) {
      expect((error as ZipError).code).toBe('unsafe-path');
    }
  });

  it('非 zip 字节 → not-zip', () => {
    try {
      extractSkillBundle(utf8.encode('这不是 zip'));
      expect.unreachable('应当抛 ZipError');
    } catch (error) {
      expect(error).toBeInstanceOf(ZipError);
      expect((error as ZipError).code).toBe('not-zip');
    }
  });

  it('限额可由调用方覆盖（maxEntries）', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: skillText() },
      { name: 'assets/a.txt', text: 'a' },
      { name: 'assets/b.txt', text: 'b' },
    ]);
    try {
      extractSkillBundle(zip, { limits: { maxEntries: 2 } });
      expect.unreachable('应当抛 ZipError');
    } catch (error) {
      expect((error as ZipError).code).toBe('too-many-entries');
    }
  });
});
