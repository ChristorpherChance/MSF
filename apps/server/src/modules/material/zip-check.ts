import { crc32, inflateRawSync } from 'node:zlib';

/**
 * ZIP 安全校验链（LLD-2 DSG-F09-1，承接 REQ-103；原型 MaterialZip.read/path 全文逆向）。
 * 纯函数：输入整包字节，输出校验结论；任一拒绝条件命中即整包拒绝，全部通过才允许一次提交。
 * 违规子码闭集（LLD-3 §15(j)）：ZIP_ENCRYPTED/ZIP_ZIP64/ZIP_MULTI_VOLUME/ZIP_PATH_TRAVERSAL/
 * ZIP_ENTRY_OVERLAP/ZIP_CRC_MISMATCH/ZIP_LIMIT_EXCEEDED/ZIP_FORMAT_INVALID。
 */

export type ZipViolationCode =
  | 'ZIP_ENCRYPTED'
  | 'ZIP_ZIP64'
  | 'ZIP_MULTI_VOLUME'
  | 'ZIP_PATH_TRAVERSAL'
  | 'ZIP_ENTRY_OVERLAP'
  | 'ZIP_CRC_MISMATCH'
  | 'ZIP_LIMIT_EXCEEDED'
  | 'ZIP_FORMAT_INVALID';

export interface ZipViolation {
  code: ZipViolationCode;
  message: string;
  target?: string;
}

export interface ZipEntryInfo {
  path: string; // NFC 规范化后的 UTF-8 路径
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  method: 0 | 8;
  dataOffset: number; // 压缩数据区起点（本地头之后）
}

export type ZipCheckResult =
  | { ok: true; entries: ZipEntryInfo[]; totalUncompressed: number }
  | { ok: false; violations: ZipViolation[] };

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const DD_SIG = 0x08074b50;

const MAX_PACKAGE = 30 * 1024 * 1024; // 30MB（步 1）
const MAX_ENTRIES = 100; // 步 3
const MAX_SINGLE = 10 * 1024 * 1024; // 单文件展开 10MB（步 9）
const MAX_TOTAL = 25 * 1024 * 1024; // 总展开 25MB（步 9）
const MAX_DEPTH = 24; // 步 7
const ALLOWED_FLAGS = 0x0808; // bit3 数据描述符 + bit11 UTF-8，其余一律未知标志位（步 5）

const fail = (code: ZipViolationCode, message: string, target?: string): ZipCheckResult => ({
  ok: false,
  violations: [{ code, message, ...(target !== undefined ? { target } : {}) }],
});

/** 路径合法性（步 7/8/15 共用）：NFC 后逐段检查，返回规范化路径或 null */
export function normalizeZipPath(raw: string): string | null {
  const p = raw.normalize('NFC');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null; // 绝对路径
  if (/[\\:]/.test(p)) return null; // 反斜杠/冒号
  if (/[\u0000-\u001f\u007f]/.test(p)) return null; // 控制字符
  const segs = p.split('/');
  if (segs.length > MAX_DEPTH) return null; // 深度 >24
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return null; // 空段/. /..
    if (/[. ]$/.test(seg)) return null; // 段尾点或空格
  }
  return p;
}

export function validateZipPackage(buf: Buffer): ZipCheckResult {
  // 步 1：包级尺寸
  if (buf.length > MAX_PACKAGE) return fail('ZIP_LIMIT_EXCEEDED', 'ZIP 大小不支持（>30MB）');
  if (buf.length < 22) return fail('ZIP_FORMAT_INVALID', 'ZIP 大小不支持（<22 字节）');

  // 步 2：EOCD 定位（尾部 65557 字节内，注释长度自洽）
  const windowStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= windowStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      if (i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) return fail('ZIP_FORMAT_INVALID', 'ZIP 目录损坏');

  // 步 3：卷与格式
  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesDisk = buf.readUInt16LE(eocd + 8);
  const entriesTotal = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0 || entriesDisk !== entriesTotal) {
    return fail('ZIP_MULTI_VOLUME', 'ZIP 多卷、ZIP64、条目超限或目录异常（多卷）');
  }
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return fail('ZIP_ZIP64', 'ZIP 多卷、ZIP64、条目超限或目录异常（ZIP64）');
  }
  if (entriesTotal > MAX_ENTRIES) {
    return fail('ZIP_LIMIT_EXCEEDED', 'ZIP 多卷、ZIP64、条目超限或目录异常（条目 >100）');
  }
  if (cdOffset + cdSize > eocd) {
    return fail('ZIP_FORMAT_INVALID', 'ZIP 多卷、ZIP64、条目超限或目录异常（目录区间不闭合）');
  }

  // 步 4~9：中央目录逐条
  interface RawEntry extends ZipEntryInfo {
    flags: number;
    localOffset: number;
    nameRaw: Buffer;
    hasDescriptor: boolean;
  }
  const raw: RawEntry[] = [];
  const seenLower = new Set<string>();
  let totalUncompressed = 0;
  let pos = cdOffset;
  for (let n = 0; n < entriesTotal; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CEN_SIG) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 中央目录损坏');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const diskStart = buf.readUInt16LE(pos + 34);
    const extAttr = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen + commentLen > buf.length) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 中央目录损坏');
    }
    // ZIP64 占位（条目级）
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      return fail('ZIP_ZIP64', 'ZIP 条目或ZIP64不支持');
    }
    if (diskStart !== 0) return fail('ZIP_MULTI_VOLUME', 'ZIP 多卷、ZIP64、条目超限或目录异常（多卷）');

    // 步 5：标志与算法
    if (flags & 0x1) return fail('ZIP_ENCRYPTED', 'ZIP 加密、链接或压缩方式不支持（加密）');
    if (flags & ~ALLOWED_FLAGS) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 加密、链接或压缩方式不支持（未知标志位）');
    }
    if (method !== 0 && method !== 8) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 加密、链接或压缩方式不支持（压缩方法）');
    }
    if (((extAttr >>> 16) & 0xf000) === 0xa000) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 加密、链接或压缩方式不支持（符号链接）');
    }

    // 步 6：文件名编码
    const nameRaw = buf.subarray(nameStart, nameEnd);
    const utf8Flag = (flags & 0x0800) !== 0;
    if (!utf8Flag && nameRaw.some((b) => b >= 0x80)) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 文件名须使用UTF-8编码');
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(nameRaw);
    } catch {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 文件名须使用UTF-8编码（解码失败）');
    }

    // 步 7：路径合法（NFC 后）
    const isDirectory = decoded.endsWith('/');
    const path = normalizeZipPath(isDirectory ? decoded.slice(0, -1) : decoded);
    if (path === null) return fail('ZIP_PATH_TRAVERSAL', 'ZIP 含非法或过深路径', decoded);

    // 步 8：重名（小写归一）
    const lower = (isDirectory ? `${path}/` : path).toLowerCase();
    if (seenLower.has(lower)) return fail('ZIP_PATH_TRAVERSAL', 'ZIP 含重复路径', path);
    seenLower.add(lower);

    // 步 9：尺寸上限
    if (uncompSize > MAX_SINGLE) return fail('ZIP_LIMIT_EXCEEDED', 'ZIP 解压大小超限（单文件 >10MB）', path);
    totalUncompressed += uncompSize;
    if (totalUncompressed > MAX_TOTAL) {
      return fail('ZIP_LIMIT_EXCEEDED', 'ZIP 解压大小超限（总展开 >25MB）');
    }

    raw.push({
      path,
      isDirectory,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      crc32: crc,
      method: method as 0 | 8,
      dataOffset: 0, // 步 10 回填
      flags,
      localOffset,
      nameRaw: Buffer.from(nameRaw),
      hasDescriptor: (flags & 0x8) !== 0,
    });
    pos = nameEnd + extraLen + commentLen;
  }

  // 步 15a：目录遍历结束位置等于 EOCD 声明区间
  if (pos !== cdOffset + cdSize || pos !== eocd) {
    return fail('ZIP_FORMAT_INVALID', 'ZIP 目录长度不一致');
  }

  // 步 10~14：逐条本地头/描述符/重叠/内容
  const intervals: Array<[number, number]> = [];
  const filePaths = new Set(raw.filter((e) => !e.isDirectory).map((e) => e.path));
  for (const e of raw) {
    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== LOC_SIG) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 本地头损坏', e.path);
    }
    const lFlags = buf.readUInt16LE(lp + 6);
    const lMethod = buf.readUInt16LE(lp + 8);
    const lCrc = buf.readUInt32LE(lp + 14);
    const lComp = buf.readUInt32LE(lp + 18);
    const lUncomp = buf.readUInt32LE(lp + 22);
    const lNameLen = buf.readUInt16LE(lp + 26);
    const lExtraLen = buf.readUInt16LE(lp + 28);
    const lName = buf.subarray(lp + 30, lp + 30 + lNameLen);
    if (lFlags !== e.flags || lMethod !== e.method || !lName.equals(e.nameRaw)) {
      return fail('ZIP_FORMAT_INVALID', '本地头与目录不一致', e.path);
    }
    if (!e.hasDescriptor && (lComp !== e.compressedSize || lUncomp !== e.uncompressedSize || lCrc !== e.crc32)) {
      return fail('ZIP_CRC_MISMATCH', '本地长度或校验不一致', e.path);
    }
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + e.compressedSize;
    if (dataEnd > buf.length) return fail('ZIP_FORMAT_INVALID', 'ZIP 本地头损坏', e.path);
    e.dataOffset = dataStart;

    // 步 11：数据描述符
    if (e.hasDescriptor) {
      const ddPos = dataEnd;
      let ddCrc: number, ddComp: number, ddUncomp: number;
      if (ddPos + 16 <= buf.length && buf.readUInt32LE(ddPos) === DD_SIG) {
        ddCrc = buf.readUInt32LE(ddPos + 4);
        ddComp = buf.readUInt32LE(ddPos + 8);
        ddUncomp = buf.readUInt32LE(ddPos + 12);
      } else if (ddPos + 12 <= buf.length) {
        ddCrc = buf.readUInt32LE(ddPos);
        ddComp = buf.readUInt32LE(ddPos + 4);
        ddUncomp = buf.readUInt32LE(ddPos + 8);
      } else {
        return fail('ZIP_FORMAT_INVALID', 'ZIP 数据描述符损坏', e.path);
      }
      if (ddCrc !== e.crc32 || ddComp !== e.compressedSize || ddUncomp !== e.uncompressedSize) {
        return fail('ZIP_FORMAT_INVALID', 'ZIP 数据描述符损坏', e.path);
      }
    }

    // 步 12：数据区重叠
    for (const [s, t] of intervals) {
      if (dataStart < t && s < dataEnd) return fail('ZIP_ENTRY_OVERLAP', 'ZIP 数据区重叠', e.path);
    }
    intervals.push([dataStart, dataEnd]);

    // 步 14：目录条目带非零内容
    if (e.isDirectory && (e.compressedSize !== 0 || e.uncompressedSize !== 0)) {
      return fail('ZIP_FORMAT_INVALID', 'ZIP 目录含异常内容', e.path);
    }

    // 步 15b：文件路径与目录路径前缀冲突（任一祖先段已是文件）
    const segs = e.path.split('/');
    for (let i = 1; i < segs.length; i++) {
      if (filePaths.has(segs.slice(0, i).join('/'))) {
        return fail('ZIP_PATH_TRAVERSAL', 'ZIP 文件与目录路径冲突', e.path);
      }
    }
  }

  // 步 13：内容校验（展开长度 + CRC32；流式超额即中断以 maxOutputLength 实现）
  for (const e of raw) {
    if (e.isDirectory) continue;
    const data = buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
    let content: Buffer;
    if (e.method === 0) {
      content = Buffer.from(data);
    } else {
      try {
        content = inflateRawSync(data, { maxOutputLength: MAX_SINGLE + 1 });
      } catch {
        return fail('ZIP_LIMIT_EXCEEDED', 'ZIP 解压大小超限（解压中断）', e.path);
      }
    }
    if (content.length !== e.uncompressedSize) {
      return fail('ZIP_CRC_MISMATCH', 'ZIP 内容长度或CRC错误（长度）', e.path);
    }
    if (crc32(content) !== e.crc32) {
      return fail('ZIP_CRC_MISMATCH', 'ZIP 内容长度或CRC错误（CRC32）', e.path);
    }
  }

  const entries: ZipEntryInfo[] = raw.map(({ path, isDirectory, compressedSize, uncompressedSize, crc32: c, method, dataOffset }) => ({
    path,
    isDirectory,
    compressedSize,
    uncompressedSize,
    crc32: c,
    method,
    dataOffset,
  }));
  return { ok: true, entries, totalUncompressed };
}

/** 解压单条内容（校验通过后方可调用；T1-06 行内解压复用） */
export function inflateEntry(buf: Buffer, entry: ZipEntryInfo): Buffer {
  const data = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  return entry.method === 0 ? Buffer.from(data) : inflateRawSync(data);
}
