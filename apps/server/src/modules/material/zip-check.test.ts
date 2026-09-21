import { deflateRawSync, crc32 as zCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { validateZipPackage, inflateEntry, normalizeZipPath } from './zip-check.js';

/**
 * ZIP 十五步校验链负向用例（T1-05 验收：全部拒绝条件逐条覆盖）。
 * 测试 ZIP 由最小构造器现造（STORE/DEFLATE），各用例只改一处违规。
 */

interface EntrySpec {
  name: string;
  content?: Buffer;
  method?: 0 | 8;
  flags?: number; // 额外标志位（叠加在 UTF-8 位上）
  crcOverride?: number;
  uncompOverride?: number;
  isDir?: boolean;
  extAttr?: number;
  extra?: Buffer; // 中央目录额外字段
}

function buildZip(entries: EntrySpec[], eocdComment = Buffer.alloc(0)): Buffer {
  const encoder = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = e.isDir ? `${e.name}/` : e.name;
    const nameBytes = Buffer.from(encoder.encode(name));
    const content = e.isDir ? Buffer.alloc(0) : (e.content ?? Buffer.alloc(0));
    const method = e.isDir ? 0 : (e.method ?? 0);
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const crc = e.crcOverride ?? zCrc32(content);
    const uncomp = e.uncompOverride ?? content.length;
    const flags = 0x0800 | (e.flags ?? 0); // UTF-8 位
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncomp, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(Buffer.concat([local, nameBytes, compressed]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncomp, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(e.extra?.length ?? 0, 30);
    central.writeUInt32LE(e.extAttr ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes, e.extra ?? Buffer.alloc(0)]));

    offset += locals[locals.length - 1]?.length ?? 0;
  }
  const cdOffset = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(eocdComment.length, 20);
  return Buffer.concat([...locals, cd, eocd, eocdComment]);
}

const file = (name: string, text: string): EntrySpec => ({ name, content: Buffer.from(text) });

describe('validateZipPackage（F09-1 十五步）', () => {
  it('合法包通过：STORE+DEFLATE+目录条目混合，解压内容一致', () => {
    const buf = buildZip([
      { name: 'docs', isDir: true },
      file('docs/a.txt', 'hello'),
      { name: 'b.md', content: Buffer.from('x'.repeat(5000)), method: 8 },
    ]);
    const r = validateZipPackage(buf);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(3);
      const b = r.entries.find((e) => e.path === 'b.md');
      expect(b && inflateEntry(buf, b).toString()).toBe('x'.repeat(5000));
    }
  });

  it('步1：<22 字节拒（ZIP_FORMAT_INVALID）', () => {
    const r = validateZipPackage(Buffer.alloc(10));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步2：找不到 EOCD 拒', () => {
    const r = validateZipPackage(Buffer.alloc(100, 1));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步3：EOCD 多卷标记拒（ZIP_MULTI_VOLUME）', () => {
    const buf = buildZip([file('a.txt', 'a')]);
    buf.writeUInt16LE(1, buf.length - 22 + 4); // diskNo=1
    const r = validateZipPackage(buf);
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_MULTI_VOLUME' }] });
  });

  it('步3：ZIP64 占位拒（ZIP_ZIP64）', () => {
    const buf = buildZip([file('a.txt', 'a')]);
    buf.writeUInt16LE(0xffff, buf.length - 22 + 8); // entriesDisk=0xFFFF（避免先命中多卷判定）
    buf.writeUInt16LE(0xffff, buf.length - 22 + 10); // entriesTotal=0xFFFF
    const r = validateZipPackage(buf);
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_ZIP64' }] });
  });

  it('步3：条目 >100 拒（ZIP_LIMIT_EXCEEDED）', () => {
    const entries = Array.from({ length: 101 }, (_, i) => file(`f${i}.txt`, 'x'));
    const r = validateZipPackage(buildZip(entries));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_LIMIT_EXCEEDED' }] });
  });

  it('步5：加密位拒（ZIP_ENCRYPTED）', () => {
    const r = validateZipPackage(buildZip([{ ...file('a.txt', 'a'), flags: 0x1 }]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_ENCRYPTED' }] });
  });

  it('步5：未知标志位拒', () => {
    const r = validateZipPackage(buildZip([{ ...file('a.txt', 'a'), flags: 0x40 }]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步5：压缩方法非 STORE/DEFLATE 拒', () => {
    const spec = file('a.txt', 'a');
    const buf = buildZip([spec]);
    buf.writeUInt16LE(9, 8); // 本地头 method=9
    buf.writeUInt16LE(9, 30 + 5 + 1 + 10); // 中央目录 method=9
    const r = validateZipPackage(buf);
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步5：符号链接属性拒', () => {
    const r = validateZipPackage(buildZip([{ ...file('a.txt', 'a'), extAttr: 0xa1ff0000 }]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步6：未置 UTF-8 位且含高位字节拒', () => {
    // 构造无 UTF-8 位的包：直接把 UTF-8 位清掉
    const buf = buildZip([file('中文名.txt', 'a')]);
    buf.writeUInt16LE(0, 6); // 本地头 flags=0
    buf.writeUInt16LE(0, 30 + 12 + 1 + 8); // 中央目录 flags=0（nameLen=12 中文名 4 字×3）
    const r = validateZipPackage(buf);
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it.each([
    ['/abs.txt', '绝对路径'],
    ['a\\b.txt', '反斜杠'],
    ['a:b.txt', '冒号'],
    ['a//b.txt', '空段'],
    ['a/./b.txt', '点段'],
    ['../escape.txt', '上级'],
    ['dir /f.txt', '段尾空格'],
    ['dir./f.txt', '段尾点'],
  ])('步7：非法路径拒 %s（%s）', (name) => {
    const r = validateZipPackage(buildZip([file(name, 'a')]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_PATH_TRAVERSAL' }] });
  });

  it('步7：深度 >24 拒', () => {
    const deep = Array.from({ length: 25 }, (_, i) => `d${i}`).join('/') + '/f.txt';
    const r = validateZipPackage(buildZip([file(deep, 'a')]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_PATH_TRAVERSAL' }] });
  });

  it('步8：小写归一重名拒', () => {
    const r = validateZipPackage(buildZip([file('A.txt', 'a'), file('a.TXT', 'b')]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_PATH_TRAVERSAL' }] });
  });

  it('步9：单文件展开 >10MB 拒', () => {
    const r = validateZipPackage(
      buildZip([{ name: 'big.bin', content: Buffer.alloc(1), uncompOverride: 11 * 1024 * 1024 }]),
    );
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_LIMIT_EXCEEDED' }] });
  });

  it('步9：总展开 >25MB 拒', () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      name: `f${i}.bin`,
      content: Buffer.alloc(1),
      uncompOverride: 9 * 1024 * 1024,
    }));
    const r = validateZipPackage(buildZip(entries));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_LIMIT_EXCEEDED' }] });
  });

  it('步10：本地头签名错拒', () => {
    const buf = buildZip([file('a.txt', 'a')]);
    buf.writeUInt32LE(0xdeadbeef, 0);
    const r = validateZipPackage(buf);
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步13：CRC32 不等拒（ZIP_CRC_MISMATCH）', () => {
    const r = validateZipPackage(buildZip([{ ...file('a.txt', 'abc'), crcOverride: 0x12345678 }]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_CRC_MISMATCH' }] });
  });

  it('步14：目录条目带非零内容拒', () => {
    // 目录条目声明非零展开大小（'docs/'：本地头 30+5=35 字节，中央目录起于 35）
    const buf = buildZip([{ name: 'docs', isDir: true }]);
    buf.writeUInt32LE(1, 22); // 本地头 uncomp=1
    buf.writeUInt32LE(1, 35 + 24); // 中央目录 uncomp=1（与本地头一致，单测步14）
    const r = validateZipPackage(buf);
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步15：文件与目录路径前缀冲突拒', () => {
    const r = validateZipPackage(buildZip([file('a', 'x'), file('a/b.txt', 'y')]));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_PATH_TRAVERSAL' }] });
  });

  // 带数据描述符（bit3）的包构造：本地头长度/CRC 置 0，数据后跟 16 字节描述符
  function buildDescriptorZip(name: string, content: Buffer, opts: { badDescriptor?: boolean } = {}): Buffer {
    const nameBytes = Buffer.from(new TextEncoder().encode(name));
    const crc = zCrc32(content);
    const flags = 0x0800 | 0x8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(opts.badDescriptor ? content.length + 1 : content.length, 8);
    descriptor.writeUInt32LE(content.length, 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    const cdOffset = local.length + nameBytes.length + content.length + descriptor.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBytes.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    return Buffer.concat([local, nameBytes, content, descriptor, central, nameBytes, eocd]);
  }

  it('步11：数据描述符置位且数值相符 → 放行', () => {
    const r = validateZipPackage(buildDescriptorZip('dd.txt', Buffer.from('descriptor-ok')));
    expect(r.ok).toBe(true);
  });

  it('步11：描述符数值与中央目录不符 → 拒', () => {
    const r = validateZipPackage(buildDescriptorZip('dd.txt', Buffer.from('x'), { badDescriptor: true }));
    expect(r).toMatchObject({ ok: false, violations: [{ code: 'ZIP_FORMAT_INVALID' }] });
  });

  it('步12：数据区重叠拒（ZIP_ENTRY_OVERLAP）', () => {
    // 两条目，第二条 localOffset 指向第一条数据区内
    const buf = buildZip([file('a.txt', 'aaaa'), file('b.txt', 'bbbb')]);
    const centralStart = buf.length - 22 - (46 + 5) * 2;
    buf.writeUInt32LE(32, centralStart + 46 + 5 + 42); // 第二条 localOffset=32（第一条数据区内）
    const r = validateZipPackage(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['ZIP_ENTRY_OVERLAP', 'ZIP_FORMAT_INVALID']).toContain(r.violations[0]?.code);
  });

  it('normalizeZipPath：NFC 归一后合法路径放行', () => {
    expect(normalizeZipPath('docs/招标文件.pdf')).toBe('docs/招标文件.pdf');
    expect(normalizeZipPath('é.txt')).toBe('é.txt'); // NFD→NFC
  });
});
