/** 需求域集成测试（T2-02~07，需 DB+MinIO；F02-1/F06、A04、REQ-201~210） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@msf/shared';
import { pool, query } from '../../db/pool.js';
import { resetCommands, executeCommand } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { UploadsService } from '../material/uploads.service.js';
import { ParseService } from '../material/parse.service.js';
import { ReqDocsService } from './docs.service.js';
import { GenerateService, genTiming } from './generate.service.js';
import { RtmService } from './rtm.service.js';
import { ReqExportService } from './export.service.js';
import { createHash } from 'node:crypto';

const PID = '00000000-0000-0000-0000-0000000000f1';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM req_documents LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('ReqDocs/Rtm/Generate（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  genTiming.chunkDelayMs = 0;
  const storage = new StorageService();
  const uploads = new UploadsService(storage);
  const parse = new ParseService(storage);
  const docs = new ReqDocsService(new PolicyService());
  const gen = new GenerateService();
  const rtm = new RtmService(docs);
  const exp = new ReqExportService(storage);
  resetCommands();
  uploads.onModuleInit();
  parse.onModuleInit();
  docs.onModuleInit();
  gen.onModuleInit();
  rtm.onModuleInit();
  exp.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm2-req-test') ON CONFLICT (id) DO NOTHING", [PID]);
  });
  afterAll(async () => {
    await query('DELETE FROM req_doc_refs WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_links WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_health WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_batch_items WHERE job_id IN (SELECT id FROM mat_batch_jobs WHERE project_id=$1)', [PID]);
    await query('DELETE FROM mat_batch_jobs WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_parsed WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query('DELETE FROM audit_log WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_records WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  /** 造一份 content_final 参考（走 M1 真实链路） */
  async function makeReference(name: string): Promise<string> {
    const content = Buffer.from(`# ${name}\n\n客户要求若干。`);
    const s = await uploads.create(PID, { fileName: name, size: content.length, sha256: sha256(content) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, content);
    const done = (await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string } };
    const fileId = done.file.id;
    const op = (await parse.parse(PID, fileId, CTX, false, { autoRun: false })) as { operationId: string };
    await parse.runParse(PID, fileId, op.operationId, CTX);
    await parse.finalizeFile(PID, fileId, CTX);
    const fp = await query<{ content_fingerprint: string }>(
      "SELECT content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'", [fileId]);
    await parse.saveDraft(PID, fileId, `# ${name} 内容稿`, `sha256:${fp.rows[0]!.content_fingerprint}`, CTX);
    await parse.finalizeContent(PID, fileId, CTX);
    return fileId;
  }

  interface DocView {
    cur: number; modified: boolean; finalized: boolean; contentFingerprint: string;
    secs: Array<{ id: string; title: string; md: string; pending: string | null }>;
  }
  const view = async (kind: 'crd' | 'prd') => (await docs.getDoc(PID, kind)) as unknown as DocView;

  it('生命周期：自举→编辑（乐观锁/NO_CHANGE）→undo/redo→提交→切换→定稿→定稿态锁→解锁', async () => {
    const list = (await docs.listDocs(PID, CTX)) as { items: Array<{ kind: string; cur: number }> };
    expect(list.items.map((i) => i.kind).sort()).toEqual(['CRD', 'PRD']);
    expect(list.items[0]!.cur).toBe(1); // 模板 v1

    let d = await view('crd');
    const s0 = d.secs[0]!.id;
    // NO_CHANGE
    await expect(
      docs.saveDraft(PID, 'crd', { secId: s0, md: d.secs[0]!.md, baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX),
    ).rejects.toMatchObject({ code: 'NO_CHANGE' });
    // 乐观锁：错误指纹
    await expect(
      docs.saveDraft(PID, 'crd', { secId: s0, md: 'x', baseVersion: d.cur, baseFingerprint: 'sha256:bad' }, CTX),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    // 正常编辑两次
    await docs.saveDraft(PID, 'crd', { secId: s0, md: '引言 v1', baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX);
    d = await view('crd');
    await docs.saveDraft(PID, 'crd', { secId: s0, md: '引言 v2', baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX);
    // undo → 引言 v1；再 undo → 回基点草稿消亡
    const u1 = (await docs.undo(PID, 'crd', CTX)) as { canUndo: boolean };
    expect(u1.canUndo).toBe(true);
    d = await view('crd');
    expect(d.secs[0]!.md).toBe('引言 v1');
    await docs.undo(PID, 'crd', CTX);
    d = await view('crd');
    expect(d.modified).toBe(false); // 撤回基点回 clean
    // redo 需要草稿存在；重新编辑后 undo→redo 对称
    await docs.saveDraft(PID, 'crd', { secId: s0, md: '引言 A', baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX);
    d = await view('crd');
    await docs.undo(PID, 'crd', CTX);
    d = await view('crd');
    expect(d.modified).toBe(false);

    // 重新编辑并提交 v2（内容含 RTM 锚点）
    d = await view('crd');
    await docs.saveDraft(PID, 'crd', {
      secId: s0,
      md: '引言定稿版\n\n## CR-001 门户首页\n\n承接：R-001、R-002',
      baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX);
    d = await view('crd');
    const committed = (await docs.commit(PID, 'crd', 'v2 提交', d.cur, CTX)) as { v: number };
    expect(committed.v).toBe(2);
    d = await view('crd');
    expect(d.modified).toBe(false);
    // 版本历史只读 + 切换
    const vers = (await docs.listVersions(PID, 'crd')) as { items: Array<{ v: number; readonly: boolean }> };
    expect(vers.items.map((x) => x.v)).toEqual([2, 1]);
    await docs.switchVersion(PID, 'crd', 1, CTX);
    d = await view('crd');
    expect(d.cur).toBe(1);
    await docs.switchVersion(PID, 'crd', 2, CTX);

    // 定稿（manual 确认点 + confirm）→ 定稿态写拒绝 → 解锁恢复
    const fin = (await docs.finalize(PID, 'crd', 2, 2, true, CTX)) as { finalVer: number; finalizationId: string };
    expect(fin.finalVer).toBe(2);
    expect(fin.finalizationId).toMatch(/^fin_\d+$/);
    d = await view('crd');
    expect(d.finalized).toBe(true);
    await expect(
      docs.saveDraft(PID, 'crd', { secId: s0, md: '原地改', baseVersion: 2, baseFingerprint: d.contentFingerprint }, CTX),
    ).rejects.toMatchObject({ code: 'VERSION_LOCKED' });
    await docs.unlock(PID, 'crd', CTX);
    d = await view('crd');
    expect(d.finalized).toBe(false);
    // AI 通道调用人工确认点 → POLICY_MANUAL_REQUIRED
    await expect(
      docs.finalize(PID, 'crd', 2, 2, true, { projectId: PID, actorKind: 'assistant', actorId: 'ai' }),
    ).rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
  });

  it('待确认补丁：propose→accept 落草稿入 undo 栈→reject；from 失配 PATCH_BASE_STALE', async () => {
    const d0 = await view('crd');
    const fp = d0.contentFingerprint.replace(/^sha256:/, '');
    // 目标指纹不符 → PATCH_BASE_STALE
    await expect(
      executeCommand('doc.propose-pending', {
        projectId: PID, kind: 'crd',
        patches: [{ type: 'modify', secId: 's0', old: '引言定稿版', new: 'x' }],
        targetFingerprint: 'deadbeef', proposedBy: 'assistant',
      }, CTX),
    ).rejects.toMatchObject({ code: 'PATCH_BASE_STALE' });
    // 正确指纹 propose（modify + add）
    const proposed = (await executeCommand('doc.propose-pending', {
      projectId: PID, kind: 'crd',
      patches: [
        { type: 'modify', secId: 's0', old: '引言定稿版', new: '引言修订版' },
        { type: 'add', secId: 's0', title: 'CR-002 检索', new: '承接：R-003' },
      ],
      targetFingerprint: fp, proposedBy: 'assistant',
    }, CTX)) as { patchIds: string[] };
    expect(proposed.patchIds).toHaveLength(2);
    const d1 = await view('crd');
    expect(d1.secs.some((s) => s.pending)).toBe(true);
    // modify 补丁 accept → 落草稿
    await docs.acceptPatch(PID, 'crd', proposed.patchIds[0]!, CTX);
    const d2 = await view('crd');
    expect(d2.modified).toBe(true);
    expect(d2.secs[0]!.md).toContain('引言修订版');
    // undo 可撤回补丁落稿
    await docs.undo(PID, 'crd', CTX);
    const d3 = await view('crd');
    expect(d3.modified).toBe(false);
    // add 补丁 reject → 不落稿
    await docs.rejectPatch(PID, 'crd', proposed.patchIds[1]!, CTX);
    const patches = (await docs.listPatches(PID, 'crd')) as { items: Array<{ status: string }> };
    expect(patches.items.map((p) => p.status).sort()).toEqual(['accepted', 'rejected']);
  });

  it('生成 mock：参考门禁 REFERENCE_NOT_FINAL → 定稿参考后生成→补丁→接受→提交；PRD 门禁 CRD 定稿', async () => {
    const refId = await makeReference('客户访谈.md');
    // 非定稿参考拒绝：新建一个未 content_final 的文件
    const raw = Buffer.from('# 未定稿参考');
    const s = await uploads.create(PID, { fileName: 'raw.md', size: raw.length, sha256: sha256(raw) }, CTX);
    await uploads.uploadPart(PID, s.uploadId, 1, raw);
    const notFinal = ((await uploads.complete(PID, s.uploadId, CTX)) as { file: { id: string } }).file.id;
    await expect(
      gen.start(PID, 'crd', { referenceFileIds: [notFinal], referenceFingerprints: {} }, CTX),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FINAL' });

    // CRD 生成 → 补丁呈现（不直接落稿）
    const { operationId } = await gen.start(PID, 'crd', { referenceFileIds: [refId], referenceFingerprints: {} }, CTX);
    const deltas: string[] = [];
    const fin = await gen.drive(operationId, CTX, (t) => deltas.push(t));
    expect(fin.status).toBe('done');
    expect(deltas.length).toBeGreaterThan(1); // 目录先行 + 章节增量
    const d = await view('crd');
    expect(d.modified).toBe(false); // 补丁不落稿
    const patches = (await docs.listPatches(PID, 'crd')) as { items: Array<{ patchId: string; status: string; title?: string }> };
    const pending = patches.items.filter((p) => p.status === 'pending');
    expect(pending.length).toBeGreaterThanOrEqual(3); // 背景+原始需求+CR 条目
    // 逐条接受 → 草稿
    for (const p of pending) await docs.acceptPatch(PID, 'crd', p.patchId, CTX);
    const d2 = await view('crd');
    expect(d2.secs.some((x) => x.title === '客户原始需求')).toBe(true);
    const c = (await docs.commit(PID, 'crd', 'AI 初稿', d2.cur, CTX)) as { v: number };
    expect(c.v).toBe(3);

    // PRD 生成门禁：CRD 未定稿 → GATE_BLOCKED；定稿 CRD 后放行
    await expect(gen.start(PID, 'prd', { referenceFileIds: [], referenceFingerprints: {} }, CTX))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await docs.finalize(PID, 'crd', 3, 3, true, CTX);
    const p = await gen.start(PID, 'prd', { referenceFileIds: [], referenceFingerprints: {} }, CTX);
    const fin2 = await gen.drive(p.operationId, CTX, () => {});
    expect(fin2.status).toBe('done');
  });

  it('生成过程控制 pause/resume/stop；REQ-115 流末参考变化 REFERENCE_STALE 不落稿', async () => {
    const refId = await makeReference('基线参考.md');
    await docs.unlock(PID, 'crd', CTX); // 上个用例已把 CRD 定稿，先解锁恢复可生成
    // stop：启动后停止，无补丁残留
    const a = await gen.start(PID, 'crd', { referenceFileIds: [refId], referenceFingerprints: {} }, CTX);
    await gen.control(PID, a.operationId, 'pause', CTX);
    await gen.control(PID, a.operationId, 'resume', CTX);
    await gen.control(PID, a.operationId, 'stop', CTX);
    const r1 = await gen.drive(a.operationId, CTX, () => {}).catch((e) => e);
    expect(r1).toBeInstanceOf(DomainError); // stop 后 op 已作废
    const patches = (await docs.listPatches(PID, 'crd')) as { items: Array<{ status: string }> };
    expect(patches.items.filter((p) => p.status === 'pending')).toHaveLength(0);

    // REQ-115：drive 前篡改参考指纹 → failed/REFERENCE_STALE
    const b = await gen.start(PID, 'crd', { referenceFileIds: [refId], referenceFingerprints: {} }, CTX);
    await query(
      "UPDATE mat_parsed SET content_fingerprint='deadbeef' WHERE file_id=$1 AND kind='content_parse' AND status='final'",
      [refId],
    );
    const r2 = await gen.drive(b.operationId, CTX, () => {});
    expect(r2.status).toBe('failed');
    expect(r2.error).toBe('REFERENCE_STALE');
    const patches2 = (await docs.listPatches(PID, 'crd')) as { items: Array<{ status: string }> };
    expect(patches2.items.filter((p) => p.status === 'pending')).toHaveLength(0);
  });

  it('RTM：提交派生链→健康度四指标→deferred 标记/撤销→PRD 定稿门禁', async () => {
    // 当前 CRD v3（AI 初稿：R-001..n + CR-001..n 承接）；PRD 已有 AI 初稿补丁未接受
    const patches = (await docs.listPatches(PID, 'prd')) as { items: Array<{ patchId: string; status: string }> };
    for (const p of patches.items.filter((x) => x.status === 'pending')) {
      await docs.acceptPatch(PID, 'prd', p.patchId, CTX);
    }
    const dp = await view('prd');
    await docs.commit(PID, 'prd', 'PRD 初稿', dp.cur, CTX);

    const matrix = (await rtm.rtm(PID)) as { rows: Array<{ r: string; cr: string[]; req: string[]; dsg: string[]; state: string }> };
    expect(matrix.rows.length).toBeGreaterThanOrEqual(3);
    expect(matrix.rows[0]!.state).toBe('covered');
    expect(matrix.rows[0]!.dsg).toContain('DSG-U03-2');

    const h = (await rtm.health(PID)) as { ok: boolean; l0a: number; l0b: number; l0c: number; l0d: number };
    expect(h.l0a).toBe(1);
    expect(h.l0b).toBe(1);
    expect(h.l0c).toBe(1);

    // deferred：标记 REQ-001 → L0d=1 且不计分母；撤销恢复
    await rtm.markDeferred(PID, 'req', 'REQ-001', '本期不做', CTX);
    const h2 = (await rtm.health(PID)) as { l0d: number; deferredItems: Array<{ nodeId: string }> };
    expect(h2.l0d).toBe(1);
    expect(h2.deferredItems[0]!.nodeId).toBe('REQ-001');
    await rtm.unmarkDeferred(PID, 'req', 'REQ-001', CTX);
    const h3 = (await rtm.health(PID)) as { l0d: number };
    expect(h3.l0d).toBe(0);

    // PRD 定稿门禁通过（L0a=1 且 L0b=1）→ finalize 成功 + rtm_health 留痕
    const fin = (await docs.finalize(PID, 'prd', 2, 2, true, CTX)) as { finalVer: number };
    expect(fin.finalVer).toBe(2);
    const measured = await query<{ passed: boolean }>(
      'SELECT passed FROM rtm_health WHERE project_id=$1 ORDER BY measured_at DESC LIMIT 1', [PID]);
    expect(measured.rows[0]!.passed).toBe(true);

    // 负向：制造缺口（CRD 加未承接 R）→ PRD 再定稿被 GATE_BLOCKED
    await docs.unlock(PID, 'prd', CTX);
    // CRD 在上一用例已解锁（未再定稿），直接编辑提交 v4
    const dc = await view('crd');
    await docs.saveDraft(PID, 'crd', { secId: 's0', md: `${dc.secs[0]!.md}\n\n- R-099 孤立诉求`, baseVersion: dc.cur, baseFingerprint: dc.contentFingerprint }, CTX);
    const dc2 = await view('crd');
    await docs.commit(PID, 'crd', '引入孤立 R', dc2.cur, CTX);
    const h4 = (await rtm.health(PID)) as { l0a: number; gaps: Array<{ code: string; target: string }> };
    expect(h4.l0a).toBeLessThan(0.95);
    expect(h4.gaps.some((g) => g.code === 'L0A_BELOW' && g.target === 'R-099')).toBe(true);
    const pv = await view('prd');
    await expect(docs.finalize(PID, 'prd', pv.cur, pv.cur, true, CTX)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
  });

  it('导出：md/html/docx/pdf 落 MinIO + 签名 URL（A04-13 + L1 扩展）', async () => {
    const r = (await exp.export(PID, 'crd', 3, 'md', CTX)) as { downloadUrl: string; format: string };
    expect(r.format).toBe('md');
    expect(r.downloadUrl).toContain('http');
    const h = (await exp.export(PID, 'crd', 3, 'html', CTX)) as { downloadUrl: string };
    expect(h.downloadUrl).toContain('.html');
    // L1：docx/pdf 四格式全通（pdf 依赖本机 CJK 字体）
    for (const [fmt, magic] of [['docx', 'PK'], ['pdf', '%PDF-']] as const) {
      const x = (await exp.export(PID, 'crd', 3, fmt, CTX)) as { downloadUrl: string };
      expect(x.downloadUrl).toContain(`.${fmt}`);
      const bytes = Buffer.from(await (await fetch(x.downloadUrl)).arrayBuffer());
      expect(bytes.subarray(0, magic.length).toString('latin1')).toBe(magic);
    }
    await expect(exp.export(PID, 'crd', 3, 'xlsx' as never, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
