/**
 * `skills/zip.ts` —— 零依赖 zip 读取器（`docs/spec/skill-management.md` §8）。
 *
 * 这组测试刻意**不读任何 zip 文件**：zip 由下面的 `makeZip` 现场拼出来。理由是坏样本
 * （CRC 篡改、`../`、重复路径、超条目）用真工具很难稳定产出，而「一个 30 行的写包器」
 * 正好也是「我们到底支持 zip 的哪一小块」的可执行说明。
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { readZipEntries, ZipError, ZIP_LIMITS } from '../src/skills/zip.ts';
import type { ZipErrorCode } from '../src/skills/zip.ts';

const utf8 = new TextEncoder();

/** CRC32（与 zip 的 `crc-32` 字段同款）；测试自己算，不复用实现，免得「实现错了测试也错」。 */
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

type BuildEntry = {
  name: string;
  text?: string;
  bytes?: Uint8Array;
  method?: 'store' | 'deflate';
  /** 故意写坏 CRC 时用。 */
  crc?: number;
  /** 额外置位的通用标志（例如 0x1 = 加密）。 */
  flags?: number;
  /** Unix mode（外部属性高 16 位），例如 0o120777 = symlink。 */
  mode?: number;
};

/** 迷你写包器：本地文件头 + 数据 + 中央目录 + EOCD。够用来造各种合法/畸形样本。 */
function makeZip(entries: readonly BuildEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localSize = 0;

  for (const entry of entries) {
    const name = utf8.encode(entry.name);
    const data = entry.bytes ?? utf8.encode(entry.text ?? '');
    const method = entry.method === 'deflate' ? 8 : 0;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = entry.crc ?? crc32(data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800 | (entry.flags ?? 0), true); // UTF-8 文件名（可附加加密位）
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
    centralView.setUint16(4, 0x0314, true); // made by Unix(3) + 版本 20，便于用外部属性表达 symlink
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800 | (entry.flags ?? 0), true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(38, ((entry.mode ?? 0) << 16) >>> 0, true);
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

  const total = localSize + centralSize + eocd.length;
  const zip = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    zip.set(part, cursor);
    cursor += part.length;
  }
  return zip;
}

function codeOf(fn: () => unknown): ZipErrorCode | 'no-throw' {
  try {
    fn();
  } catch (error) {
    if (error instanceof ZipError) {
      return error.code;
    }
    throw error;
  }
  return 'no-throw';
}

describe('zip 读取器：能读的两种压缩方法', () => {
  it('store（method 0）按原字节返回', () => {
    const zip = makeZip([
      { name: 'SKILL.md', text: 'hello' },
      { name: 'assets/note.txt', text: 'world' },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.path)).toEqual(['SKILL.md', 'assets/note.txt']);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe('hello');
    expect(entries[1]?.uncompressedSize).toBe(5);
  });

  it('deflate（method 8）用 inflateRaw 还原，内容与原文一致', () => {
    const repeated = '重复内容'.repeat(50);
    const zip = makeZip([{ name: 'SKILL.md', text: repeated, method: 'deflate' }]);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe(repeated);
    expect(entries[0]?.uncompressedSize).toBe(utf8.encode(repeated).length);
  });

  it('目录条目（以 / 结尾）被跳过', () => {
    const zip = makeZip([
      { name: 'assets/', text: '' },
      { name: 'assets/a.txt', text: 'a' },
    ]);
    expect(readZipEntries(zip).map((entry) => entry.path)).toEqual(['assets/a.txt']);
  });
});

describe('zip 读取器：路径安全（zip slip）', () => {
  it('`../etc/passwd` → unsafe-path', () => {
    const zip = makeZip([{ name: '../etc/passwd', text: 'root' }]);
    expect(codeOf(() => readZipEntries(zip))).toBe('unsafe-path');
  });

  it('绝对路径 `/etc/passwd` → unsafe-path', () => {
    const zip = makeZip([{ name: '/etc/passwd', text: 'root' }]);
    expect(codeOf(() => readZipEntries(zip))).toBe('unsafe-path');
  });

  it('带盘符 `C:\\\\x` → unsafe-path', () => {
    const zip = makeZip([{ name: 'C:\\x', text: 'x' }]);
    expect(codeOf(() => readZipEntries(zip))).toBe('unsafe-path');
  });

  it('反斜杠路径被规范化为 /', () => {
    const zip = makeZip([{ name: 'assets\\sub\\a.txt', text: 'a' }]);
    expect(readZipEntries(zip).map((entry) => entry.path)).toEqual(['assets/sub/a.txt']);
  });

  it('前导 ./ 被去掉', () => {
    const zip = makeZip([{ name: './SKILL.md', text: 'x' }]);
    expect(readZipEntries(zip).map((entry) => entry.path)).toEqual(['SKILL.md']);
  });
});

describe('zip 读取器：完整性与限额', () => {
  it('CRC 被篡改 → checksum-mismatch', () => {
    const zip = makeZip([{ name: 'SKILL.md', text: 'hello', crc: 0xdeadbeef }]);
    expect(codeOf(() => readZipEntries(zip))).toBe('checksum-mismatch');
  });

  it('条目数超过上限 → too-many-entries', () => {
    const zip = makeZip([
      { name: 'a.txt', text: 'a' },
      { name: 'b.txt', text: 'b' },
      { name: 'c.txt', text: 'c' },
    ]);
    expect(codeOf(() => readZipEntries(zip, { maxEntries: 2 }))).toBe('too-many-entries');
  });

  it('单文件超过上限 → entry-too-large', () => {
    const zip = makeZip([{ name: 'big.txt', text: 'x'.repeat(64) }]);
    expect(codeOf(() => readZipEntries(zip, { maxFileBytes: 32 }))).toBe('entry-too-large');
  });

  it('解压总量超过上限 → total-too-large', () => {
    const zip = makeZip([
      { name: 'a.txt', text: 'x'.repeat(20) },
      { name: 'b.txt', text: 'x'.repeat(20) },
    ]);
    expect(codeOf(() => readZipEntries(zip, { maxTotalBytes: 30 }))).toBe('total-too-large');
  });

  it('压缩比超过上限 → compression-ratio', () => {
    const zip = makeZip([{ name: 'bomb.txt', text: 'a'.repeat(1000), method: 'deflate' }]);
    expect(codeOf(() => readZipEntries(zip, { maxRatio: 2 }))).toBe('compression-ratio');
  });

  it('zip64 哨兵（条目计数 0xFFFF）→ unsupported-zip64，不半读半猜', () => {
    const zip = makeZip([{ name: 'a.txt', text: 'a' }]);
    // EOCD 固定在尾部 22 字节：把「本盘条目数 / 总条目数」写成 zip64 哨兵（字节全是 0xFF，
    // 与端序无关）。
    new DataView(zip.buffer).setUint16(zip.length - 22 + 8, 0xffff, true);
    new DataView(zip.buffer).setUint16(zip.length - 22 + 10, 0xffff, true);
    expect(codeOf(() => readZipEntries(zip))).toBe('unsupported-zip64');
  });

  it('符号链接条目（外部属性 S_IFLNK）→ unsafe-path（§8：拒绝非普通文件）', () => {
    const zip = makeZip([{ name: 'link.txt', text: '/etc/passwd', mode: 0o120777 }]);
    expect(codeOf(() => readZipEntries(zip))).toBe('unsafe-path');
  });

  it('加密条目（flags bit 0）→ unsupported-compression（没有口令来源）', () => {
    const zip = makeZip([{ name: 'SKILL.md', text: 'x', flags: 0x1 }]);
    expect(codeOf(() => readZipEntries(zip))).toBe('unsupported-compression');
  });

  it('不支持的压缩方法（12 = bzip2）→ unsupported-compression', () => {
    const zip = makeZip([{ name: 'a.txt', text: 'a' }]);
    const eocdOffset = zip.length - 22;
    const centralOffset = new DataView(zip.buffer).getUint32(eocdOffset + 16, true);
    new DataView(zip.buffer).setUint16(centralOffset + 10, 12, true);
    expect(codeOf(() => readZipEntries(zip))).toBe('unsupported-compression');
  });
  it('非 zip 字节 → not-zip', () => {
    expect(codeOf(() => readZipEntries(utf8.encode('这不是 zip，只是一段文字'.repeat(10))))).toBe('not-zip');
  });

  it('太短的内容 → not-zip', () => {
    expect(codeOf(() => readZipEntries(new Uint8Array([1, 2, 3])))).toBe('not-zip');
  });

  it('重复路径 → duplicate-entry', () => {
    const zip = makeZip([
      { name: 'dup.txt', text: 'a' },
      { name: 'dup.txt', text: 'b' },
    ]);
    expect(codeOf(() => readZipEntries(zip))).toBe('duplicate-entry');
  });
});

describe('zip 读取器：默认限额与常量', () => {
  it('ZIP_LIMITS 与 spec §8 一致', () => {
    expect(ZIP_LIMITS).toEqual({
      maxEntries: 200,
      maxFileBytes: 512 * 1024,
      maxTotalBytes: 5 * 1024 * 1024,
      maxRatio: 100,
    });
  });
});
