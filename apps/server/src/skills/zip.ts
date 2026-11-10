/**
 * 最小 zip 读取器 —— **结构层**，不含任何技能语义（技能语义在 `bundle.ts`）。
 *
 * 为什么手写而不是引包：`docs/spec/skill-management.md` §6 与决策 D5 钉死了「上传用原始
 * `application/zip` body、零新依赖」，本 session 也不许改 lockfile。上传上限 5 MB，
 * 所以全部同步实现、不流式——省掉一个手写的状态机，也省掉流式解包的背压坑。
 *
 * 只做 zip 规范里够用的那一小块（§8 的安全模型）：
 *  - 定位 **EOCD**（扫描尾部 64 KiB + 22 字节，容忍尾部填充），读中央目录；
 *  - 逐条读**中央目录**，再用**本地文件头**算出数据起点（两处 name/extra 长度可以不同，这是
 *    「用本地头 offset + 本地头的长度字段」而不用中央目录长度字段的原因）；
 *  - method 0（store）与 8（deflate，`zlib.inflateRawSync`）；其它方法一律明确报
 *    `unsupported-compression`，**不猜**；
 *  - 自己算 CRC32 并与中央目录声明值比对（`checksum-mismatch`）；
 *  - 路径规范化 + zip slip / zip 炸弹限额（`ZIP_LIMITS`，调用方可覆盖）。
 *
 * 刻意不做（各自的理由都是「做了也没有可信的用法」）：
 *  - **zip64**：上限 5 MB 用不上 4 GB 偏移；遇到就报 `unsupported-zip64`，而不是半读半猜；
 *  - **加密条目**：没有密码来源（面板上传不收集口令），按「读不出来」报 `unsupported-compression`；
 *  - **分卷 / 多盘**：上传的是一个完整 body，分卷只可能是畸形输入，报 `not-zip`；
 *  - **符号链接**：§8 要求拒绝非普通文件条目，外部属性里 `S_IFLNK` 一律 `unsafe-path`。
 */
import { inflateRawSync } from 'node:zlib';

/** 失败原因码。调用方（HTTP 层）负责映射到 `docs/spec/skill-management.md` §9 的错误码。 */
export type ZipErrorCode =
  | 'not-zip'
  | 'unsupported-zip64'
  | 'unsupported-compression'
  | 'checksum-mismatch'
  | 'unsafe-path'
  | 'duplicate-entry'
  | 'too-many-entries'
  | 'entry-too-large'
  | 'total-too-large'
  | 'compression-ratio';

/** 结构层失败。`code` 是稳定的机器可读原因，`message` 直接进日志与面板的错误详情。 */
export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

/**
 * 默认限额（`docs/spec/skill-management.md` §8）：
 * 总解压 ≤5 MB、条目 ≤200、单文件 ≤512 KB、压缩比 ≤100:1。
 *
 * 类型上刻意用 `number` 而不是字面量类型——调用方（例如测试或更严格的仓库策略）
 * 需要能把它们调小：`readZipEntries(buf, { maxEntries: 2 })`。
 */
export const ZIP_LIMITS: {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
} = {
  maxEntries: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxRatio: 100,
};

/** 一个已校验的普通文件条目。`path` 已规范化（`/` 分隔、无 `..`、无前导 `./`）。 */
export type ZipEntry = {
  path: string;
  bytes: Uint8Array;
  uncompressedSize: number;
};

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** EOCD 固定 22 字节 + 注释（≤65535）。 */
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 外部属性高 16 位是 Unix mode；`S_IFLNK`。 */
const S_IFLNK = 0xa000;

const utf8Lenient = new TextDecoder('utf-8');

/**
 * CRC32（IEEE 802.3，与 zip 的 `crc-32` 字段同款）。
 *
 * 30 行的代价换来「数据被篡改 / 传坏了一定能被发现」——这是 §8 里唯一能对**内容**做出
 * 完整性保证的检查，比体积限额更贴近「供应链」那条风险。
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    crc = ((CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 规范化条目路径，顺带挡掉 zip slip（§8 第一行）。
 *
 * 宽容的三处（不影响安全，只影响「写得难看」）：
 *  - 反斜杠视为分隔符（Windows 打的包会把 `a\b` 写进 zip）；
 *  - 前导 `./` 段直接丢掉；
 *  - 末尾 `/` 丢掉（目录条目的标记：`directory` 字段在 `readCentralEntry` 里从原始名判定）。
 *
 * 严格的两处：
 *  - 任何 `..` 段 → `unsafe-path`（**不能**「用栈吃掉」上一个段：`a/../../x` 归一成
 *    `../x` 之类的算法只要有一处偏差就是 zip slip，直接拒绝没有第二次机会的语义）；
 *  - 中间空段（`a//b`）、绝对路径、盘符、NUL 与控制字符 → `unsafe-path`。
 */
export function normalizeEntryPath(raw: string): string {
  // 控制字符检查用码点循环而不是正则：`/[\\u0000-\\u001f]/` 会触发 `no-control-regex`，
  // 而这条检查是安全断言，不该靠 eslint-disable 换安静。
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      throw new ZipError('unsafe-path', `路径含控制字符：${quote(raw)}`);
    }
  }
  const slashed = raw.replace(/\\/gu, '/');
  if (slashed.startsWith('/')) {
    throw new ZipError('unsafe-path', `拒绝绝对路径：${quote(raw)}`);
  }
  if (/^[A-Za-z]:/u.test(slashed)) {
    throw new ZipError('unsafe-path', `拒绝带盘符的路径：${quote(raw)}`);
  }
  const segments = slashed.split('/');
  const kept: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    const isLast = index === segments.length - 1;
    if (segment === '') {
      // 末尾的空段是目录条目的 `/`（也可能是多打的一个 `/`），中间的空段是畸形路径。
      if (isLast) {
        continue;
      }
      throw new ZipError('unsafe-path', `路径含空段：${quote(raw)}`);
    }
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new ZipError('unsafe-path', `路径含 \`..\` 段（zip slip）：${quote(raw)}`);
    }
    kept.push(segment);
  }
  if (kept.length === 0) {
    throw new ZipError('unsafe-path', `路径为空：${quote(raw)}`);
  }
  return kept.join('/');
}

function quote(raw: string): string {
  return JSON.stringify(raw.slice(0, 200));
}

function ensureRange(total: number, end: number, what: string): void {
  if (end > total) {
    throw new ZipError('not-zip', `zip 结构不完整：${what} 越界`);
  }
}

/**
 * 从尾部向前找 EOCD。从 `总长-22` 开始递减而不是只信任最后 22 字节：
 * 有些写包器会在 EOCD 之后留填充，只按「最后 22 字节」判定会把合法 zip 误判成 `not-zip`。
 */
function findEocd(view: DataView, total: number): number {
  if (total < EOCD_MIN_BYTES) {
    throw new ZipError('not-zip', '不是 zip：内容短于 EOCD（22 字节）');
  }
  const lowest = Math.max(0, total - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let offset = total - EOCD_MIN_BYTES; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) !== SIG_EOCD) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_MIN_BYTES + commentLength <= total) {
      return offset;
    }
  }
  throw new ZipError('not-zip', '不是 zip：找不到中央目录结尾记录（EOCD）');
}

type CentralDirectory = {
  entryCount: number;
  cdOffset: number;
  cdSize: number;
};

function readEocd(view: DataView, total: number, eocdOffset: number): CentralDirectory {
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const cdStartDisk = view.getUint16(eocdOffset + 6, true);
  const entriesThisDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // zip64：EOCD 之前 20 字节是 zip64 EOCD locator，或 32 位字段被写成 0xFFFFFFFF（计数是 0xFFFF）。
  // 不完整支持就不假装支持——半读的 zip64 会把「大文件」静默截断成「小文件」。
  if (eocdOffset >= 20 && view.getUint32(eocdOffset - 20, true) === SIG_ZIP64_EOCD_LOCATOR) {
    throw new ZipError('unsupported-zip64', '不支持 zip64（EOCD 前有 zip64 locator）');
  }
  if (
    entryCount === 0xffff ||
    entriesThisDisk === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new ZipError('unsupported-zip64', '不支持 zip64（32 位字段溢出为哨兵值）');
  }

  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesThisDisk !== entryCount) {
    throw new ZipError('not-zip', `不支持分卷 zip（disk=${diskNumber}, cdDisk=${cdStartDisk}）`);
  }
  ensureRange(total, cdOffset + cdSize, '中央目录');
  return { entryCount, cdOffset, cdSize };
}

type ResolvedLimits = typeof ZIP_LIMITS;

type EntryDeclaration = {
  path: string;
  crc: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  /** 条目名以 `/` 结尾（目录条目）：调用方跳过，但仍要先过一遍路径安全检查。 */
  directory: boolean;
  /** 下一项中央目录记录的起点（name + extra + comment 之后）。 */
  nextCursor: number;
};

function readCentralEntry(
  view: DataView,
  buffer: Uint8Array,
  total: number,
  cursor: number,
  index: number,
): EntryDeclaration {
  ensureRange(total, cursor + CENTRAL_HEADER_BYTES, `中央目录第 ${index + 1} 项`);
  if (view.getUint32(cursor, true) !== SIG_CENTRAL) {
    throw new ZipError('not-zip', `中央目录第 ${index + 1} 项签名不正确`);
  }
  const flags = view.getUint16(cursor + 8, true);
  const method = view.getUint16(cursor + 10, true);
  const crc = view.getUint32(cursor + 16, true);
  const compressedSize = view.getUint32(cursor + 20, true);
  const uncompressedSize = view.getUint32(cursor + 24, true);
  const nameLength = view.getUint16(cursor + 28, true);
  const extraLength = view.getUint16(cursor + 30, true);
  const commentLength = view.getUint16(cursor + 32, true);
  const externalAttributes = view.getUint32(cursor + 38, true);
  const localOffset = view.getUint32(cursor + 42, true);

  const nameStart = cursor + CENTRAL_HEADER_BYTES;
  ensureRange(total, nameStart + nameLength, `中央目录第 ${index + 1} 项的文件名`);
  const rawName = utf8Lenient.decode(buffer.subarray(nameStart, nameStart + nameLength));

  // 路径安全检查放在最前面：畸形路径是最需要「指名道姓」报出来的那类坏输入。
  const path = normalizeEntryPath(rawName);

  if (((externalAttributes >>> 16) & 0xf000) === S_IFLNK) {
    throw new ZipError('unsafe-path', `拒绝符号链接条目（非普通文件）：${path}`);
  }
  if ((flags & 0x1) === 0x1) {
    throw new ZipError('unsupported-compression', `不支持加密条目：${path}`);
  }
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
    throw new ZipError('unsupported-zip64', `不支持 zip64 条目：${path}`);
  }

  // 名字之后是 extra + comment，循环游标要整段跳过（extra 里可能有 zip64 或时间戳扩展）。
  return {
    path,
    crc,
    method,
    compressedSize,
    uncompressedSize,
    localOffset,
    directory: rawName.replace(/\\/gu, '/').endsWith('/'),
    nextCursor: nameStart + nameLength + extraLength + commentLength,
  };
}

/**
 * 解包一个 zip。返回的条目顺序 = 中央目录顺序；目录条目被跳过（目录信息没有用处：
 * 空目录不可能是技能的一部分，落盘时按文件路径建目录即可）。
 *
 * @throws ZipError 结构性失败（不是 zip / 路径不安全 / 超限 / 校验和不符 / 不支持的压缩方法）。
 */
export function readZipEntries(buffer: Uint8Array, limits: Partial<ResolvedLimits> = {}): ZipEntry[] {
  const limit: ResolvedLimits = { ...ZIP_LIMITS, ...limits };
  const total = buffer.byteLength;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const eocdOffset = findEocd(view, total);
  const directory = readEocd(view, total, eocdOffset);

  if (directory.entryCount > limit.maxEntries) {
    throw new ZipError(
      'too-many-entries',
      `条目数超过上限：${directory.entryCount} > ${limit.maxEntries}`,
    );
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let cursor = directory.cdOffset;

  for (let index = 0; index < directory.entryCount; index += 1) {
    const declaration = readCentralEntry(view, buffer, total, cursor, index);
    cursor = declaration.nextCursor;

    if (declaration.directory) {
      continue;
    }
    if (seen.has(declaration.path)) {
      throw new ZipError('duplicate-entry', `zip 内有重复路径：${declaration.path}`);
    }
    seen.add(declaration.path);

    if (declaration.method !== METHOD_STORE && declaration.method !== METHOD_DEFLATE) {
      throw new ZipError(
        'unsupported-compression',
        `不支持的压缩方法 ${declaration.method}：${declaration.path}`,
      );
    }
    if (declaration.uncompressedSize > limit.maxFileBytes) {
      throw new ZipError(
        'entry-too-large',
        `单文件超过上限：${declaration.path}（${declaration.uncompressedSize} > ${limit.maxFileBytes}）`,
      );
    }
    // 压缩比用**声明值**判定：这是防 zip 炸弹的那一步，必须在真正解压之前拒绝。
    if (declaration.compressedSize > 0 && declaration.uncompressedSize / declaration.compressedSize > limit.maxRatio) {
      throw new ZipError(
        'compression-ratio',
        `压缩比超过上限（疑似 zip 炸弹）：${declaration.path}`,
      );
    }
    if (totalBytes + declaration.uncompressedSize > limit.maxTotalBytes) {
      throw new ZipError(
        'total-too-large',
        `解压后总量超过上限：> ${limit.maxTotalBytes}`,
      );
    }

    const bytes = readEntryData(view, buffer, total, declaration, limit);
    totalBytes += bytes.byteLength;
    entries.push({ path: declaration.path, bytes, uncompressedSize: bytes.byteLength });
  }

  return entries;
}

function readEntryData(
  view: DataView,
  buffer: Uint8Array,
  total: number,
  declaration: EntryDeclaration,
  limit: ResolvedLimits,
): Uint8Array {
  const localOffset = declaration.localOffset;
  ensureRange(total, localOffset + LOCAL_HEADER_BYTES, `本地文件头（${declaration.path}）`);
  if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
    throw new ZipError('not-zip', `本地文件头签名不正确：${declaration.path}`);
  }
  // 本地头的 name/extra 长度可以与中央目录不同（中央目录的 extra 常被裁掉），
  // 所以数据起点只能用**本地头**的长度字段算。
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + LOCAL_HEADER_BYTES + nameLength + extraLength;
  ensureRange(total, dataStart + declaration.compressedSize, `条目数据（${declaration.path}）`);
  const raw = buffer.subarray(dataStart, dataStart + declaration.compressedSize);

  let bytes: Uint8Array;
  if (declaration.method === METHOD_STORE) {
    bytes = raw;
  } else {
    try {
      // `maxOutputLength` 是第二道闸：中央目录声明的 uncompressedSize 可以撒谎，
      // 真解压时用它把内存上限也钉住（超出时 zlib 抛 RangeError）。
      bytes = new Uint8Array(
        inflateRawSync(raw, { maxOutputLength: limit.maxFileBytes + 1 }),
      );
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ZipError(
          'entry-too-large',
          `解压后超过单文件上限：${declaration.path}（> ${limit.maxFileBytes}）`,
        );
      }
      throw new ZipError(
        'not-zip',
        `deflate 数据损坏（${declaration.path}）：${describeError(error)}`,
      );
    }
  }

  if (bytes.byteLength > limit.maxFileBytes) {
    throw new ZipError(
      'entry-too-large',
      `解压后超过单文件上限：${declaration.path}（${bytes.byteLength} > ${limit.maxFileBytes}）`,
    );
  }
  if (bytes.byteLength !== declaration.uncompressedSize) {
    throw new ZipError(
      'checksum-mismatch',
      `解压长度与声明不符：${declaration.path}（${bytes.byteLength} ≠ ${declaration.uncompressedSize}）`,
    );
  }
  const actual = crc32(bytes);
  if (actual !== declaration.crc) {
    throw new ZipError(
      'checksum-mismatch',
      `CRC32 不符：${declaration.path}（实际 ${hex32(actual)} ≠ 声明 ${hex32(declaration.crc)}）`,
    );
  }
  return bytes;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
