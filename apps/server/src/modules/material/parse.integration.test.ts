/** 解析状态机/定稿/内容稿集成测试（T1-09~T1-12，需 DB+MinIO；F02-3、A03-8~14） */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@msf/shared';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { ParseService } from './parse.service.js';
import { StorageService } from './storage.service.js';
import { UploadsService } from './uploads.service.js';

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const PID = '00000000-0000-0000-0000-0000000000e4';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM mat_files LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('ParseService（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const storage = new StorageService();
  const uploads = new UploadsService(storage);
  const svc = new ParseService(storage);
  resetCommands();
  uploads.onModuleInit();
  svc.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm1-parse-test') ON CONFLICT (id) DO NOTHING", [PID]);
  });
  afterAll(async () => {
    await query('DELETE FROM mat_parsed WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  async function uploadFile(name: string, content: Buffer): Promise<string> {
    const s = await uploads.create(PID, { fileName: name, size: content.length, sha256: sha256(content) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, content);
    return ((await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string } }).file.id;
  }
  async function statusOf(fileId: string): Promise<string> {
    const r = await query<{ parse_status: string }>('SELECT parse_status FROM mat_files WHERE id=$1', [fileId]);
    return r.rows[0]?.parse_status ?? '';
  }
  async function parseAndWait(fileId: string, retry = false): Promise<void> {
    const op = (await svc.parse(PID, fileId, CTX, retry, { autoRun: false })) as { operationId: string };
    await svc.runParse(PID, fileId, op.operationId, CTX);
  }

  it('A03-8/10 全链：pending→parsing→parsed 落解析稿；失败→failed→重试→parsed 留痕', async () => {
    const okId = await uploadFile('a.md', Buffer.from('# 正文'));
    const op = (await svc.parse(PID, okId, CTX, false, { autoRun: false })) as { operationId: string; status: string };
    expect(op.status).toBe('parsing');
    expect(await statusOf(okId)).toBe('parsing');
    await svc.runParse(PID, okId, op.operationId, CTX);
    expect(await statusOf(okId)).toBe('parsed');
    const parsed = await query('SELECT body_md FROM mat_parsed WHERE file_id=$1 AND kind=\'file_parse\' AND status!=\'discarded\'', [okId]);
    expect(parsed.rows[0]?.body_md).toBe('# 正文');

    // 解析中再发解析 → INVALID_STATE
    const again = await uploadFile('b.md', Buffer.from('x'));
    await svc.parse(PID, again, CTX, false, { autoRun: false });
    await expect(svc.parse(PID, again, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    // 失败注入 → failed + parse_error；retry → parsed；audit_trail 留 retry_parse
    const failId = await uploadFile('c.md', Buffer.from('PARSE_FAIL 坏文件'));
    const fop = (await svc.parse(PID, failId, CTX, false, { autoRun: false })) as { operationId: string };
    await svc.runParse(PID, failId, fop.operationId, CTX);
    expect(await statusOf(failId)).toBe('failed');
    const errRow = await query<{ parse_error: string }>('SELECT parse_error FROM mat_files WHERE id=$1', [failId]);
    expect(errRow.rows[0]?.parse_error).toContain('mock 解析失败');
    await parseAndWait(failId, true);
    expect(await statusOf(failId)).toBe('failed'); // 内容仍含 PARSE_FAIL → 重试亦失败，留痕
    const trail = await query<{ audit_trail: Array<{ op: string }> }>('SELECT audit_trail FROM mat_files WHERE id=$1', [failId]);
    expect(trail.rows[0]?.audit_trail.map((t) => t.op)).toContain('retry_parse');
  });

  it('A03-11/12 定稿链：parsed→file_final→content_final；解锁回退；非法迁移拒绝', async () => {
    const id = await uploadFile('fin.md', Buffer.from('# 定稿链'));
    await expect(svc.finalizeFile(PID, id, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' }); // pending 不可定稿
    await parseAndWait(id);
    await svc.finalizeFile(PID, id, CTX);
    expect(await statusOf(id)).toBe('file_final');
    // 内容稿未保存 → 内容定稿拒绝
    await expect(svc.finalizeContent(PID, id, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // 解锁回 parsed，再定稿，存内容稿后内容定稿
    await svc.unfinalizeFile(PID, id, CTX);
    expect(await statusOf(id)).toBe('parsed');
    await svc.finalizeFile(PID, id, CTX);
    const fpRow = await query<{ content_fingerprint: string }>(
      "SELECT content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
      [id],
    );
    const saved = (await svc.saveDraft(PID, id, '# 整理稿', `sha256:${fpRow.rows[0]?.content_fingerprint}`, CTX)) as {
      contentFingerprint: string;
    };
    expect(saved.contentFingerprint).toMatch(/^sha256:/);
    await svc.finalizeContent(PID, id, CTX);
    expect(await statusOf(id)).toBe('content_final');
  });

  it('A03-13 编辑乐观锁：baseFingerprint 不符 → VERSION_CONFLICT', async () => {
    const id = await uploadFile('edit.md', Buffer.from('# 编辑'));
    await parseAndWait(id);
    const fp = await query<{ content_fingerprint: string }>(
      "SELECT content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
      [id],
    );
    const v1 = (await svc.saveDraft(PID, id, 'v1', `sha256:${fp.rows[0]?.content_fingerprint}`, CTX)) as {
      contentFingerprint: string;
    };
    // 旧 base 再存 → 冲突
    await expect(
      svc.saveDraft(PID, id, 'v2-bad', `sha256:${fp.rows[0]?.content_fingerprint}`, CTX),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    // 新 base → 通过（版本推进）
    const v2 = (await svc.saveDraft(PID, id, 'v2', v1.contentFingerprint, CTX)) as { contentFingerprint: string };
    expect(v2.contentFingerprint).not.toBe(v1.contentFingerprint);
  });

  it('A03-14 删除守卫：依赖存在 → GATE_BLOCKED+DEPENDENCY_EXISTS；守卫通过 → discarded+回 pending，原件不动', async () => {
    const id = await uploadFile('del.md', Buffer.from('# 删除'));
    await parseAndWait(id);
    const row = await query<{ id: string }>(
      "SELECT id FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
      [id],
    );
    const rowId = row.rows[0]?.id ?? '';
    // 理由必填
    await expect(svc.deleteRow(PID, rowId, '', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 引用依赖注入 → 守卫拦截
    await query('UPDATE mat_parsed SET referenced_by=$2 WHERE id=$1', [rowId, JSON.stringify([{ kind: 'req', id: 'REQ-001' }])]);
    try {
      await svc.deleteRow(PID, rowId, '测试', CTX);
      expect.unreachable();
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe('GATE_BLOCKED');
      const details = err.details as { issues: Array<{ code: string }> };
      expect(details.issues[0]?.code).toBe('DEPENDENCY_EXISTS');
    }
    // 清依赖 → 删除通过：行 discarded、文件回 pending、原件行仍在
    await query('UPDATE mat_parsed SET referenced_by=$2 WHERE id=$1', [rowId, '[]']);
    const r = (await svc.deleteRow(PID, rowId, '测试删除', CTX)) as { deleted: boolean };
    expect(r.deleted).toBe(true);
    expect(await statusOf(id)).toBe('pending');
    const kept = await query('SELECT id FROM mat_files WHERE id=$1', [id]);
    expect(kept.rows).toHaveLength(1);
    const discarded = await query<{ status: string }>('SELECT status FROM mat_parsed WHERE id=$1', [rowId]);
    expect(discarded.rows[0]?.status).toBe('discarded');
  });
});
