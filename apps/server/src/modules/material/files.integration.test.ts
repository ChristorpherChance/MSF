/** 双目录树/文件列表/详情集成测试（T1-07/T1-08，需 DB+MinIO；A03-5/6/7） */
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { FilesService, type TreeNode } from './files.service.js';
import { StorageService } from '../platform/storage.service.js';
import { UploadsService } from './uploads.service.js';
import { ZipExtractService } from './zip-extract.service.js';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PID = '00000000-0000-0000-0000-0000000000e3';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };

function buildStoreZip(files: Array<{ name: string; content: Buffer }>): Buffer {
  const enc = new TextEncoder();
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(enc.encode(f.name));
    const crc = crc32(f.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.content.length, 18);
    local.writeUInt32LE(f.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(Buffer.concat([local, name, f.content]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.content.length, 20);
    central.writeUInt32LE(f.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += parts[parts.length - 1]?.length ?? 0;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM mat_files LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('FilesService（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const storage = new StorageService();
  const uploads = new UploadsService(storage);
  const extract = new ZipExtractService(storage);
  const svc = new FilesService(storage);
  resetCommands();
  uploads.onModuleInit();
  extract.onModuleInit();

  let rootFileId = '';
  let nestedFileId = '';

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm1-files-test') ON CONFLICT (id) DO NOTHING", [PID]);
    // 根层一直传文件 + 一个含嵌套目录的 ZIP 解压
    const content = Buffer.from('# 根层文件');
    const s = await uploads.create(PID, { fileName: 'root.md', size: content.length, sha256: sha256(content) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, content);
    rootFileId = ((await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string } }).file.id;

    const zip = buildStoreZip([{ name: 'sub/inner.md', content: Buffer.from('# 内层') }]);
    const zs = await uploads.create(PID, { fileName: 'pack.zip', size: zip.length, sha256: sha256(zip) }, CTX);
    await uploads.uploadPart(PID, zs.uploadId, 1, zip);
    const zipFileId = ((await uploads.complete(PID, zs.uploadId, CTX)) as { file: { id: string } }).file.id;
    await extract.extract(PID, zipFileId, 'reject', CTX);
    const inner = await query<{ id: string }>(
      "SELECT id FROM mat_files WHERE project_id=$1 AND name='inner.md'",
      [PID],
    );
    nestedFileId = inner.rows[0]?.id ?? '';

    // 手工登记一条文件解析稿（解析链路 T1-09 前的查询面测试桩）
    const md = '# 根层文件（解析稿）';
    await query(
      `INSERT INTO mat_parsed (id, project_id, file_id, kind, body_md, content_fingerprint, status, created_by)
       VALUES ($1,$2,$3,'file_parse',$4,$5,'draft','local')`,
      [randomUUID(), PID, rootFileId, md, sha256(Buffer.from(md))],
    );
  });
  afterAll(async () => {
    await query('DELETE FROM mat_parsed WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1 AND zip_parent_id IS NOT NULL', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query('UPDATE mat_folder_tree SET mirror_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_folder_tree WHERE project_id=$1 AND parent_id IS NOT NULL', [PID]);
    await query('DELETE FROM mat_folder_tree WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  it('A03-5 双树：原件树含嵌套结构，解析稿树只挂有解析稿的文件', async () => {
    const { originalTree, parsedTree } = await svc.tree(PID);
    const names = (ns: TreeNode[]): string[] => ns.map((n) => n.name).sort();
    expect(names(originalTree)).toEqual(['pack', 'pack.zip', 'root.md']);
    const pack = originalTree.find((n) => n.name === 'pack');
    const sub = pack?.children?.find((n) => n.name === 'sub');
    expect(sub?.children?.[0]).toMatchObject({ type: 'file', name: 'inner.md', status: 'pending' });
    // 解析稿树：目录骨架一一对应，文件仅 root.md（已登记解析稿）
    expect(names(parsedTree)).toEqual(['pack', 'root.md']);
  });

  it('A03-6 列表：状态过滤 + 分页默认 20', async () => {
    const all = await svc.list(PID, {});
    expect(all.total).toBe(3); // root.md / pack.zip / inner.md
    expect(all.pageSize).toBe(20);
    const pending = await svc.list(PID, { status: 'pending' });
    expect(pending.items.every((i) => i.status === 'pending')).toBe(true);
    const page = await svc.list(PID, { page: 2, pageSize: 2 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('A03-7 详情：parsed 视图回解析稿；source 视图回签名直链', async () => {
    const parsed = (await svc.detail(PID, rootFileId, 'parsed')) as { parsedMd: string };
    expect(parsed.parsedMd).toContain('解析稿');
    const none = (await svc.detail(PID, nestedFileId, 'parsed')) as { parsedMd: unknown };
    expect(none.parsedMd).toBeNull();
    const source = (await svc.detail(PID, rootFileId, 'source')) as { url: string };
    expect(source.url).toContain('sha256/');
  });
});
