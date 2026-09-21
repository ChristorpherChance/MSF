/** 批量解析/加工/定稿 + 参考输入门禁集成测试（T1-13~T1-16，需 DB+MinIO；F02-4、A03-9/12/15/16/17） */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@msf/shared';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { BatchService } from './batch.service.js';
import { FilesService } from './files.service.js';
import { ParseService } from './parse.service.js';
import { StorageService } from './storage.service.js';
import { UploadsService } from './uploads.service.js';

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
/** 最小合法 ZIP：空中央目录 EOCD（22 字节） */
function emptyZip(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return eocd;
}
const PID = '00000000-0000-0000-0000-0000000000e5';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM mat_batch_jobs LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('BatchService（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const storage = new StorageService();
  const uploads = new UploadsService(storage);
  const parse = new ParseService(storage);
  const files = new FilesService(storage);
  const svc = new BatchService(parse);
  resetCommands();
  uploads.onModuleInit();
  parse.onModuleInit();
  svc.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm1-batch-test') ON CONFLICT (id) DO NOTHING", [PID]);
  });
  afterAll(async () => {
    await query('DELETE FROM mat_batch_items WHERE job_id IN (SELECT id FROM mat_batch_jobs WHERE project_id=$1)', [PID]);
    await query('DELETE FROM mat_batch_jobs WHERE project_id=$1', [PID]);
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
  async function parseFile(fileId: string): Promise<void> {
    const op = (await parse.parse(PID, fileId, CTX, false, { autoRun: false })) as { operationId: string };
    await parse.runParse(PID, fileId, op.operationId, CTX);
  }
  /** 推进到 file_final 并保存内容稿 */
  async function toFileFinal(name: string, withDraft = true): Promise<string> {
    const id = await uploadFile(name, Buffer.from(`# ${name}`));
    await parseFile(id);
    await parse.finalizeFile(PID, id, CTX);
    if (withDraft) {
      const fp = await query<{ content_fingerprint: string }>(
        "SELECT content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
        [id],
      );
      await parse.saveDraft(PID, id, `# ${name} 整理稿`, `sha256:${fp.rows[0]?.content_fingerprint}`, CTX);
    }
    return id;
  }

  it('A03-9 批量解析：onlyPending 过滤拒绝项，逐条成功/失败，作业 done', async () => {
    const ok1 = await uploadFile('bp1.md', Buffer.from('# 1'));
    const fail = await uploadFile('bp2.md', Buffer.from('PARSE_FAIL'));
    const zip = await uploadFile('bp.zip', emptyZip()); // ext zip → archive 拒绝
    const parsedAlready = await uploadFile('bp3.md', Buffer.from('# 3'));
    await parseFile(parsedAlready);

    const r = await svc.batchParse(PID, [ok1, fail, zip, parsedAlready], true, CTX, { autoRun: false });
    expect(r.accepted).toBe(2);
    expect(r.rejected).toEqual([
      { fileId: zip, reason: 'archive' },
      { fileId: parsedAlready, reason: 'not_pending' },
    ]);
    await svc.runParseBatch(PID, r.jobId ?? '', [ok1, fail], CTX);
    const job = await svc.getJob(PID, r.jobId ?? '');
    expect(job.status).toBe('done');
    const byId = new Map(job.items.map((i) => [i.fileId, i.status]));
    expect(byId.get(ok1)).toBe('succeeded');
    expect(byId.get(fail)).toBe('failed'); // 失败文件停留待解析区（failed 可重试）
  });

  it('A03-12 批量内容定稿：confirm 强制 + 逐条结果（INV-BULK-1）', async () => {
    const ok = await toFileFinal('cf-ok.md');
    const noDraft = await toFileFinal('cf-nodraft.md', false);
    const pending = await uploadFile('cf-pending.md', Buffer.from('x'));

    await expect(svc.batchFinalizeContent(PID, [ok], false, CTX)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const r = await svc.batchFinalizeContent(PID, [ok, noDraft, pending], true, CTX);
    const byId = new Map(r.results.map((x) => [x.fileId, x]));
    expect(byId.get(ok)).toEqual({ fileId: ok, ok: true });
    expect(byId.get(noDraft)).toMatchObject({ ok: false, reason: '内容稿未保存' });
    expect(byId.get(pending)).toMatchObject({ ok: false });
    const st = await query<{ parse_status: string }>('SELECT parse_status FROM mat_files WHERE id=$1', [ok]);
    expect(st.rows[0]?.parse_status).toBe('content_final');
  });

  it('A03-15/16 加工作业五态：idle→confirm(running)→done，行 ops 落账', async () => {
    const f1 = await toFileFinal('pj1.md');
    const f2 = await toFileFinal('pj2.md');
    const created = await svc.createJob(PID, 'mask', [f1, f2], { patterns: ['name'] }, CTX);
    expect(created.basisFingerprint).toMatch(/^sha256:/);
    let job = await svc.getJob(PID, created.jobId);
    expect(job.status).toBe('idle');

    await svc.confirmJob(PID, created.jobId, CTX, { autoRun: false });
    job = await svc.getJob(PID, created.jobId);
    expect(job.status).toBe('running');

    await svc.runProcessJob(PID, created.jobId, CTX);
    job = await svc.getJob(PID, created.jobId);
    expect(job.status).toBe('done');
    expect(job.items.every((i) => i.status === 'succeeded')).toBe(true);
    const ops = await query<{ ops: Array<{ op: string }> }>(
      "SELECT ops FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
      [f1],
    );
    expect(ops.rows[0]?.ops[0]?.op).toBe('mask');
  });

  it('A03-15 开始复核不一致 → STALE_EVIDENCE 整批拒绝且不留作业行', async () => {
    const f1 = await toFileFinal('stale.md');
    const created = await svc.createJob(PID, 'translate', [f1], undefined, CTX);
    // 弹窗登记后源变化（解析稿指纹改变）
    await query(
      "UPDATE mat_parsed SET content_fingerprint='deadbeef' WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
      [f1],
    );
    try {
      await svc.confirmJob(PID, created.jobId, CTX, { autoRun: false });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('STALE_EVIDENCE');
    }
    const gone = await query('SELECT 1 FROM mat_batch_jobs WHERE id=$1', [created.jobId]);
    expect(gone.rows).toHaveLength(0); // 不留作业行
  });

  it('A03-15 执行中源变化行逐行 skipped（不整批拒绝）；停止与单条重试', async () => {
    const f1 = await toFileFinal('sk1.md');
    const f2 = await toFileFinal('sk2.md');
    const created = await svc.createJob(PID, 'index', [f1, f2], undefined, CTX);
    await svc.confirmJob(PID, created.jobId, CTX, { autoRun: false });
    // confirm 后 f2 源变化 → 二次比对 skipped
    await query(
      "UPDATE mat_parsed SET content_fingerprint='cafe' WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
      [f2],
    );
    await svc.runProcessJob(PID, created.jobId, CTX);
    let job = await svc.getJob(PID, created.jobId);
    expect(job.status).toBe('done');
    const byId = new Map(job.items.map((i) => [i.fileId, i.status]));
    expect(byId.get(f1)).toBe('succeeded');
    expect(byId.get(f2)).toBe('skipped');

    // f2 恢复一致后单条重试（行仍 file_final）
    const fp = await query<{ content_fingerprint: string }>(
      "SELECT content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'",
      [f2],
    );
    await query('UPDATE mat_batch_jobs SET basis_commit=$2 WHERE id=$1', [
      created.jobId,
      JSON.stringify([{ file_id: f1, content_fingerprint: 'x' }, { file_id: f2, content_fingerprint: fp.rows[0]?.content_fingerprint }]),
    ]);
    await svc.retryItem(PID, created.jobId, f2, CTX, { autoRun: false });
    await svc.runProcessJob(PID, created.jobId, CTX);
    job = await svc.getJob(PID, created.jobId);
    expect(job.items.filter((i) => i.fileId === f2 && i.status === 'succeeded')).toHaveLength(1);

    // 停止：running → stopped，待处理行 skipped
    const g1 = await toFileFinal('stop1.md');
    const g2 = await toFileFinal('stop2.md');
    const j2 = await svc.createJob(PID, 'mask', [g1, g2], undefined, CTX);
    await svc.confirmJob(PID, j2.jobId, CTX, { autoRun: false });
    await svc.stopJob(PID, j2.jobId, CTX);
    const stopped = await svc.getJob(PID, j2.jobId);
    expect(stopped.status).toBe('stopped');
    expect(stopped.items.every((i) => i.status === 'skipped')).toBe(true);
    // 停后行处理不再推进
    await svc.runProcessJob(PID, j2.jobId, CTX);
  });

  it('A03-17 参考输入：仅 content_final 入选；REFERENCE_STALE 基线校验', async () => {
    const id = await toFileFinal('ref.md');
    let refs = await files.references(PID);
    expect(refs.items.find((i) => i.fileId === id)).toBeUndefined(); // file_final 不入选
    await parse.finalizeContent(PID, id, CTX);
    refs = await files.references(PID);
    const item = refs.items.find((i) => i.fileId === id);
    expect(item?.status).toBe('content_final');
    await files.verifyReferences(PID, [{ fileId: id, contentFingerprint: item?.contentFingerprint ?? '' }]);
    await expect(
      files.verifyReferences(PID, [{ fileId: id, contentFingerprint: 'sha256:stale' }]),
    ).rejects.toMatchObject({ code: 'REFERENCE_STALE' });
  });
});
