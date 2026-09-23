/** 双目录树/文件列表/详情集成测试（T1-07/T1-08，需 DB+MinIO；A03-5/6/7） */
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { FilesService, type TreeNode } from './files.service.js';
import { ParseService } from './parse.service.js';
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
  const parseSvc = new ParseService(storage);
  resetCommands();
  uploads.onModuleInit();
  extract.onModuleInit();
  svc.onModuleInit();
  parseSvc.onModuleInit();

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
    await query('DELETE FROM mat_batch_items WHERE job_id IN (SELECT id FROM mat_batch_jobs WHERE project_id=$1)', [PID]);
    await query('DELETE FROM mat_batch_jobs WHERE project_id=$1', [PID]);
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

  it('W4 文件双向同步删除（material.file.delete）：引用守卫/理由必填/ZIP 子件随行/解析稿 discarded', async () => {
    const parse = parseSvc;
    const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 't' };

    // 理由必填
    await expect(parse.deleteFile(PID, rootFileId, '', CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 引用守卫：解析稿 referenced_by 非空 → GATE_BLOCKED
    await query('UPDATE mat_parsed SET referenced_by=$2 WHERE file_id=$1',
      [rootFileId, JSON.stringify([{ kind: 'req', id: 'x' }])]);
    await expect(parse.deleteFile(PID, rootFileId, '清理', CTX))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await query('UPDATE mat_parsed SET referenced_by=$2 WHERE file_id=$1', [rootFileId, '[]']);

    // 正常删除 root.md：解析稿 discarded、文件行删除
    const r = await parse.deleteFile(PID, rootFileId, '重复资料清理', CTX) as { parsedDiscarded: number };
    expect(r.parsedDiscarded).toBe(1);
    const gone = await query('SELECT id FROM mat_files WHERE id=$1', [rootFileId]);
    expect(gone.rows).toHaveLength(0);
    const discarded = await query<{ status: string }>('SELECT status FROM mat_parsed WHERE file_id=$1', [rootFileId]);
    expect(discarded.rows[0]!.status).toBe('discarded');

    // ZIP 双向同步：删 pack.zip → 子件 inner.md 随行
    const zip = await query<{ id: string }>(
      "SELECT id FROM mat_files WHERE project_id=$1 AND name='pack.zip'", [PID]);
    const rz = await parse.deleteFile(PID, zip.rows[0]!.id, '压缩包清理', CTX) as { children: number };
    expect(rz.children).toBe(1);
    const inner = await query('SELECT id FROM mat_files WHERE id=$1', [nestedFileId]);
    expect(inner.rows).toHaveLength(0);
  });

  it('实机走查：文件有批量作业留痕仍可删除（mat_batch_items.file_id 解挂置 NULL）', async () => {
    const parse = parseSvc;
    const content = Buffer.from('# 待删');
    const s = await uploads.create(PID, { fileName: 'batched.md', size: content.length, sha256: sha256(content) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, content);
    const fileId = ((await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string } }).file.id;
    // 直接落一条批量作业留痕（走过批量解析/定稿是主流程，不能成为删除阻塞）
    const jobId = randomUUID();
    await query(
      `INSERT INTO mat_batch_jobs (id, project_id, code, kind, status, basis_start, created_by)
       VALUES ($1,$2,'BJ-T','parse','done','{}','local')`,
      [jobId, PID],
    );
    await query('INSERT INTO mat_batch_items (id, job_id, file_id) VALUES ($1,$2,$3)', [randomUUID(), jobId, fileId]);

    await parse.deleteFile(PID, fileId, '清理', CTX);
    const gone = await query('SELECT id FROM mat_files WHERE id=$1', [fileId]);
    expect(gone.rows).toHaveLength(0);
    const item = await query<{ file_id: string | null }>('SELECT file_id FROM mat_batch_items WHERE job_id=$1', [jobId]);
    expect(item.rows[0]!.file_id).toBeNull(); // 留痕行保留，引用解挂
  });

  it('material.folder.delete：空目录双树镜像同行删除；非空 INVALID_STATE', async () => {
    // 双树各插一个互指镜像目录
    const oId = randomUUID();
    const pId = randomUUID();
    await query(
      `INSERT INTO mat_folder_tree (id, project_id, tree, name, created_by) VALUES ($1,$2,'original','空目录','local')`,
      [oId, PID],
    );
    await query(
      `INSERT INTO mat_folder_tree (id, project_id, tree, name, mirror_id, created_by) VALUES ($1,$2,'parsed','空目录',$3,'local')`,
      [pId, PID, oId],
    );
    await query('UPDATE mat_folder_tree SET mirror_id=$1 WHERE id=$2', [pId, oId]);

    // 非空（含子目录）→ INVALID_STATE
    const childId = randomUUID();
    await query(
      `INSERT INTO mat_folder_tree (id, project_id, tree, parent_id, name, created_by) VALUES ($1,$2,'original',$3,'子目录','local')`,
      [childId, PID, oId],
    );
    await expect(svc.deleteFolder(PID, oId, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    // 删子目录（空，无镜像）→ 再删父目录：original+parsed 镜像同行删除
    await svc.deleteFolder(PID, childId, CTX);
    // 镜像目录下挂一条 discarded 解析稿留痕（file.delete 后的残骸）——不阻塞目录删除
    await query(
      `INSERT INTO mat_parsed (id, project_id, file_id, kind, body_md, content_fingerprint, status, folder_id, created_by)
       VALUES ($1,$2,$3,'file_parse','x',$4,'discarded',$5,'local')`,
      [randomUUID(), PID, randomUUID(), sha256(Buffer.from('x')), pId],
    );
    await svc.deleteFolder(PID, oId, CTX);
    const left = await query('SELECT id FROM mat_folder_tree WHERE id = ANY($1::uuid[])', [[oId, pId, childId]]);
    expect(left.rows).toHaveLength(0);
  });
});
