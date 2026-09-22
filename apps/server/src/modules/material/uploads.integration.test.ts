/** 上传会话集成测试（T1-03/T1-04：需 DB + MinIO，见 storage.service.test.ts 头注） */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@msf/shared';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { StorageService } from '../platform/storage.service.js';
import { UploadsService } from './uploads.service.js';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PID = '00000000-0000-0000-0000-0000000000m1'.replace('m1', '01');
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM mat_uploads LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('UploadsService（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const svc = new UploadsService(new StorageService());
  resetCommands();
  svc.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm1-upload-test') ON CONFLICT (id) DO NOTHING", [PID]);
  });
  afterAll(async () => {
    await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  it('A03-1 预校验：格式不支持 → UPLOAD_REJECTED', async () => {
    try {
      await svc.create(PID, { fileName: 'x.exe', size: 10, sha256: 'a'.repeat(64) }, CTX);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('UPLOAD_REJECTED');
    }
  });

  it('A03-1 预校验：>50MB 未声明分片 → UPLOAD_REJECTED', async () => {
    try {
      await svc.create(PID, { fileName: 'big.pdf', size: 51 * 1024 * 1024, sha256: 'a'.repeat(64) }, CTX);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('UPLOAD_REJECTED');
    }
  });

  it('A03-1/2/3 全链路：分片上传 → 合并 → mat_files 建行 → 会话 completed → 暂存回收', async () => {
    const part1 = Buffer.from('msf-part-1-');
    const part2 = Buffer.from('msf-part-2');
    const whole = Buffer.concat([part1, part2]);
    const session = await svc.create(
      PID,
      { fileName: '说明.md', size: whole.length, sha256: sha256(whole), partSize: part1.length },
      CTX,
    );
    expect(session.parts).toBe(2);
    expect(session.uploadId).toMatch(/^upl_/);

    const r1 = await svc.uploadPart(PID, session.uploadId, 1, part1);
    expect(r1.received).toBe(part1.length);

    // 天然键幂等：同分片号重传覆盖同内容，不重复登记
    const r1b = await svc.uploadPart(PID, session.uploadId, 1, part1);
    expect(r1b.partNumber).toBe(1);
    let s = await svc.getSession(session.uploadId);
    expect(s.parts).toHaveLength(1);

    await svc.uploadPart(PID, session.uploadId, 2, part2);
    const done = (await svc.complete(PID, session.uploadId, CTX)) as {
      file: { id: string; code: string; parse_status: string; source: string };
      zipCheck: unknown;
    };
    expect(done.file.code).toBe('F-0001');
    expect(done.file.parse_status).toBe('pending');
    expect(done.file.source).toBe('upload');
    expect(done.zipCheck).toBeNull();

    s = await svc.getSession(session.uploadId);
    expect(s.status).toBe('completed');
    expect(s.file_id).toBe(done.file.id);

    // 暂存分片已回收
    const storage = new StorageService();
    await expect(storage.getObject(`uploads/${session.uploadId}/1`)).rejects.toThrow();

    // 审计链留痕（complete 命令同事务审计）
    const audit = await query<{ command: string }>(
      "SELECT command FROM audit_log WHERE project_id=$1 AND command LIKE 'material.upload.%' ORDER BY seq",
      [PID],
    );
    expect(audit.rows.map((r) => r.command)).toEqual([
      'material.upload.create',
      'material.upload.part',
      'material.upload.part',
      'material.upload.part',
      'material.upload.complete',
    ]);
  });

  it('项目内同内容去重：重复上传命中既有 (project_id, object_key) 行，不新建', async () => {
    const content = Buffer.from('dup-content');
    const a = await svc.create(PID, { fileName: 'a.md', size: content.length, sha256: sha256(content) }, CTX);
    await svc.uploadPart(PID, a.uploadId, 1, content);
    const fa = (await svc.complete(PID, a.uploadId, CTX)) as { file: { id: string } };

    const b = await svc.create(PID, { fileName: 'b.md', size: content.length, sha256: sha256(content) }, CTX);
    await svc.uploadPart(PID, b.uploadId, 1, content);
    const fb = (await svc.complete(PID, b.uploadId, CTX)) as { file: { id: string } };
    expect(fb.file.id).toBe(fa.file.id); // 回链既有行
  });

  it('A03-3 整体 SHA-256 与声明不一致 → UPLOAD_REJECTED 且零写（无半截 mat_files）', async () => {
    const content = Buffer.from('tampered');
    const session = await svc.create(
      PID,
      { fileName: 'evil.md', size: content.length, sha256: 'b'.repeat(64) },
      CTX,
    );
    await svc.uploadPart(PID, session.uploadId, 1, content);
    await expect(svc.complete(PID, session.uploadId, CTX)).rejects.toMatchObject({
      code: 'UPLOAD_REJECTED',
    });
    const files = await query("SELECT id FROM mat_files WHERE project_id=$1 AND name='evil.md'", [PID]);
    expect(files.rows).toHaveLength(0); // 审计失败零写同纪律：拒绝即整体回滚
  });

  it('A03-2 分片大小与声明不符 → VALIDATION_FAILED', async () => {
    const content = Buffer.from('1234567890');
    const session = await svc.create(
      PID,
      { fileName: 'size.md', size: content.length, sha256: sha256(content), partSize: 4 },
      CTX,
    );
    await expect(svc.uploadPart(PID, session.uploadId, 1, Buffer.from('12345'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('A03-18 中止：uploading→aborted，后续分片拒绝（INVALID_STATE）', async () => {
    const content = Buffer.from('abort-me');
    const session = await svc.create(
      PID,
      { fileName: 'abort.md', size: content.length, sha256: sha256(content) },
      CTX,
    );
    await svc.uploadPart(PID, session.uploadId, 1, content);
    const r = (await svc.abort(PID, session.uploadId, CTX)) as { status: string };
    expect(r.status).toBe('aborted');
    await expect(svc.uploadPart(PID, session.uploadId, 1, content)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(svc.complete(PID, session.uploadId, CTX)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    // 再次中止（终态）→ INVALID_STATE
    await expect(svc.abort(PID, session.uploadId, CTX)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('ZIP 整包校验接入：违规 ZIP 在 complete 拒绝且 details.violations 带注册子码', async () => {
    // 最小非法 ZIP：含 ../ 穿越条目（复用 zip-check 测试构造器的最小形态——此处直接手工拼）
    const name = Buffer.from('../evil.txt', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(name.length, 28);
    const cdOffset = local.length + name.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const zip = Buffer.concat([local, name, central, name, eocd]);

    const session = await svc.create(
      PID,
      { fileName: 'evil.zip', size: zip.length, sha256: sha256(zip) },
      CTX,
    );
    await svc.uploadPart(PID, session.uploadId, 1, zip);
    try {
      await svc.complete(PID, session.uploadId, CTX);
      expect.unreachable();
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe('UPLOAD_REJECTED');
      const details = err.details as { violations: Array<{ code: string }> };
      expect(details.violations[0]?.code).toBe('ZIP_PATH_TRAVERSAL');
    }
  });
});
