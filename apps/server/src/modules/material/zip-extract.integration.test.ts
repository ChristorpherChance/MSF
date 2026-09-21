/** ZIP 行内解压集成测试（T1-06，需 DB+MinIO；A03-4/REQ-104） */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@msf/shared';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { StorageService } from './storage.service.js';
import { UploadsService } from './uploads.service.js';
import { ZipExtractService } from './zip-extract.service.js';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PID = '00000000-0000-0000-0000-0000000000e2';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };

/** 最小 STORE ZIP 构造器（与 zip-check.test.ts 同款，仅 STORE 无目录条目） */
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

describe('ZipExtractService（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const storage = new StorageService();
  const uploads = new UploadsService(storage);
  const svc = new ZipExtractService(storage);
  resetCommands();
  uploads.onModuleInit();
  svc.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm1-extract-test') ON CONFLICT (id) DO NOTHING", [PID]);
  });
  afterAll(async () => {
    // FK 顺序：mat_uploads.file_id → mat_files、mat_files.zip_parent_id 自引用、folder mirror 互指
    await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1 AND zip_parent_id IS NOT NULL', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query('UPDATE mat_folder_tree SET mirror_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_folder_tree WHERE project_id=$1 AND parent_id IS NOT NULL', [PID]);
    await query('DELETE FROM mat_folder_tree WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  async function uploadZip(zip: Buffer, name = 'pack.zip'): Promise<string> {
    const s = await uploads.create(PID, { fileName: name, size: zip.length, sha256: sha256(zip) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, zip);
    const done = (await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string } };
    return done.file.id;
  }

  it('行内解压：双树建同名文件夹、文件建行 source=zip_extract、zip_parent 回链、原包保留', async () => {
    const zip = buildStoreZip([
      { name: 'docs/a.md', content: Buffer.from('# A') },
      { name: 'b.txt', content: Buffer.from('B') },
    ]);
    const zipFileId = await uploadZip(zip);
    const r = await svc.extract(PID, zipFileId, 'reject', CTX);
    expect(r.extracted).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.renamedTo).toBeNull();
    expect(r.operationId).toMatch(/^op_/);

    // 目标文件夹双树互指
    const folders = await query<{ id: string; tree: string; name: string; mirror_id: string }>(
      'SELECT id, tree, name, mirror_id FROM mat_folder_tree WHERE project_id=$1 ORDER BY tree',
      [PID],
    );
    expect(folders.rows).toHaveLength(4); // pack + docs，双树各二
    const packOriginal = folders.rows.find((f) => f.tree === 'original' && f.name === 'pack');
    const packParsed = folders.rows.find((f) => f.tree === 'parsed' && f.name === 'pack');
    expect(packOriginal?.mirror_id).toBe(packParsed?.id);
    expect(packParsed?.mirror_id).toBe(packOriginal?.id);

    // 文件行：source/父链/目录归属
    const files = await query<{ name: string; source: string; zip_parent_id: string; code: string }>(
      'SELECT name, source, zip_parent_id, code FROM mat_files WHERE project_id=$1 AND zip_parent_id=$2 ORDER BY name',
      [PID, zipFileId],
    );
    expect(files.rows).toHaveLength(2);
    expect(files.rows[0]?.source).toBe('zip_extract');
    expect(files.rows[0]?.code).toMatch(/^F-\d{4}$/);

    // 原包保留
    const zipRow = await query('SELECT id FROM mat_files WHERE id=$1', [zipFileId]);
    expect(zipRow.rows).toHaveLength(1);

    // 已解压 → 重复解压 INVALID_STATE
    await expect(svc.extract(PID, zipFileId, 'reject', CTX)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('同名冲突默认拒绝；rename 自动追加序号', async () => {
    const zip = buildStoreZip([{ name: 'x.md', content: Buffer.from('x') }]);
    const first = await uploadZip(zip, 'conflict.zip');
    await svc.extract(PID, first, 'reject', CTX);

    const second = await uploadZip(buildStoreZip([{ name: 'y.md', content: Buffer.from('y') }]), 'conflict.zip');
    await expect(svc.extract(PID, second, 'reject', CTX)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const renamed = await svc.extract(PID, second, 'rename', CTX);
    expect(renamed.renamedTo).toBe('conflict (2)');
  });

  it('同内容条目项目内去重计 skipped', async () => {
    const same = Buffer.from('identical-bytes');
    const zip = buildStoreZip([
      { name: 'p.md', content: same },
      { name: 'q.md', content: same },
    ]);
    const zipFileId = await uploadZip(zip, 'dup.zip');
    const r = await svc.extract(PID, zipFileId, 'reject', CTX);
    expect(r.extracted).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('非 ZIP 文件 :extract → INVALID_STATE', async () => {
    const content = Buffer.from('plain');
    const s = await uploads.create(PID, { fileName: 'plain.md', size: content.length, sha256: sha256(content) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, content);
    const done = (await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string } };
    try {
      await svc.extract(PID, done.file.id, 'reject', CTX);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('INVALID_STATE');
    }
  });
});
