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
import { sha256Text } from '../platform/doc-sections.js';
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
  const gen = new GenerateService(undefined, docs); // 第 2 参 docs：RTM 覆盖闭环取实时健康度
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
    await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_events WHERE project_id=$1', [PID]);
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
    /** 上游变更联动：PRD 专有（可选字段，crd 无） */
    upstreamStale?: boolean; upstreamVersionNo?: number;
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

  it('编辑态增删章节：add 定位插入/校验守卫，del 二次守卫+undo 恢复', async () => {
    let d = await view('crd');
    const s0 = d.secs[0]!.id; // 文首
    const s1 = d.secs[1]!.id; // CR-001
    // 增：s0 下方插入新节
    const add = (await docs.addSection(PID, 'crd', {
      secId: s0, title: 'CR-900 新增章节', md: '新节正文', baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)) as { title: string };
    expect(add.title).toBe('CR-900 新增章节');
    d = await view('crd');
    expect(d.secs.map((s) => s.title)).toEqual(['', 'CR-900 新增章节', 'CR-001 门户首页']);
    expect(d.secs[1]!.md).toBe('新节正文');
    const sNew = d.secs[1]!.id;
    // 增守卫：空标题 / md 带节标题 / 指纹失配
    await expect(docs.addSection(PID, 'crd', {
      secId: s0, title: '  ', baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(docs.addSection(PID, 'crd', {
      secId: s0, title: 'x', md: '## 夹带标题', baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(docs.addSection(PID, 'crd', {
      secId: s0, title: 'x', baseVersion: d.cur, baseFingerprint: 'sha256:bad',
    }, CTX)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(docs.addSection(PID, 'crd', {
      secId: 's999', title: 'x', baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 删：新节整节移除
    const del = (await docs.delSection(PID, 'crd', {
      secId: sNew, baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)) as { removedTitle: string };
    expect(del.removedTitle).toBe('CR-900 新增章节');
    d = await view('crd');
    expect(d.secs.map((s) => s.title)).toEqual(['', 'CR-001 门户首页']);
    // undo 恢复被删节（写草稿自带 undo 栈）
    await docs.undo(PID, 'crd', CTX);
    d = await view('crd');
    expect(d.secs.map((s) => s.title)).toEqual(['', 'CR-900 新增章节', 'CR-001 门户首页']);
    // 删守卫：s0 文首不可删 / 不存在节 / 至少保留一节（删到只剩 s0+一节时拒绝再删章节）
    await expect(docs.delSection(PID, 'crd', {
      secId: s0, baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(docs.delSection(PID, 'crd', {
      secId: 's999', baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await docs.delSection(PID, 'crd', { secId: sNew, baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX);
    d = await view('crd');
    await expect(docs.delSection(PID, 'crd', {
      secId: s1, baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // 只剩 s0+CR-001，再删即清空
    // 收尾：undo 两步回起点（先恢复被删节、再撤销增节→草稿消亡回 clean），后续用例状态不受污染
    await docs.undo(PID, 'crd', CTX);
    await docs.undo(PID, 'crd', CTX);
    d = await view('crd');
    expect(d.modified).toBe(false);
    expect(d.secs.map((s) => s.title)).toEqual(['', 'CR-001 门户首页']);
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
    // add 补丁 reject（L2：带处置理由）→ 不落稿，理由落库并随查询返回
    await docs.rejectPatch(PID, 'crd', proposed.patchIds[1]!, CTX, '与 CR-001 范围重复，不并入');
    const patches = (await docs.listPatches(PID, 'crd')) as { items: Array<{ patchId: string; status: string; reason: string | null }> };
    // W2-024：撤回基点后，草稿期接受的补丁回转 pending（可再处置，不再内容蒸发）
    expect(patches.items.map((p) => p.status).sort()).toEqual(['pending', 'rejected']);
    const rejected = patches.items.find((p) => p.status === 'rejected');
    expect(rejected?.reason).toBe('与 CR-001 范围重复，不并入');
    const restored = patches.items.find((p) => p.status === 'pending');
    expect(restored?.reason).toBeNull(); // 回转清空处置痕迹
    // 清理：拒绝回转补丁，保持工作区无 pending（不干扰后续生成用例）
    await docs.rejectPatch(PID, 'crd', restored!.patchId, CTX, 'W2-024 回转验证完毕');
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

  it('W7-001 回归：先挂参考（建行无版本）再首访列表 → 模板 v1 自举，补丁可接受', async () => {
    const PID2 = '00000000-0000-0000-0000-0000000000fa';
    const CTX2 = { projectId: PID2, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 'w7-001-reg') ON CONFLICT (id) DO NOTHING", [PID2]);
    try {
      // 造 content_final 参考（同 makeReference，但落在 PID2）
      const content = Buffer.from('# W7-001 参考\n\n离线点检要求。');
      const s = await uploads.create(PID2, { fileName: 'w7-001.md', size: content.length, sha256: sha256(content) }, CTX2);
      await uploads.uploadPart(PID2, s.uploadId, 1, content);
      const done = (await uploads.complete(PID2, s.uploadId, CTX2)) as { file: { id: string } };
      const fileId = done.file.id;
      const op = (await parse.parse(PID2, fileId, CTX2, false, { autoRun: false })) as { operationId: string };
      await parse.runParse(PID2, fileId, op.operationId, CTX2);
      await parse.finalizeFile(PID2, fileId, CTX2);
      const fp = await query<{ content_fingerprint: string }>(
        "SELECT content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status!='discarded'", [fileId]);
      await parse.saveDraft(PID2, fileId, '# W7-001 内容稿', `sha256:${fp.rows[0]!.content_fingerprint}`, CTX2);
      await parse.finalizeContent(PID2, fileId, CTX2);
      // 关键顺序：先挂参考（lockOrCreateDoc 建行不建版本），再首访列表
      await docs.addReference(PID2, 'crd', fileId, CTX2);
      const list = (await docs.listDocs(PID2, CTX2)) as { items: Array<{ kind: string; cur: number | null }> };
      const crd = list.items.find((i) => i.kind === 'CRD')!;
      expect(crd.cur).toBe(1); // 模板 v1 已自举（修复前为 null → accept-pending 409 死锁）
      const d = (await docs.getDoc(PID2, 'crd')) as unknown as DocView;
      await docs.saveDraft(PID2, 'crd', { secId: d.secs[0]!.id, md: '引言 ok', baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX2);
    } finally {
      await query('DELETE FROM req_doc_refs WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID2]);
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID2]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID2]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID2]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID2]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID2]);
      await query('DELETE FROM rtm_links WHERE project_id=$1', [PID2]);
      await query('DELETE FROM rtm_health WHERE project_id=$1', [PID2]);
      await query('DELETE FROM mat_parsed WHERE project_id=$1', [PID2]);
      await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID2]);
      await query('DELETE FROM mat_files WHERE project_id=$1', [PID2]);
      await query('DELETE FROM projects WHERE id=$1', [PID2]);
    }
  });

  it('T16 回归：草稿有未提交修改时重新生成——基准取草稿优先（不再 PATCH_BASE_STALE）', async () => {
    const PID3 = '00000000-0000-0000-0000-0000000000fc';
    const CTX3 = { projectId: PID3, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 't16-draft-base') ON CONFLICT (id) DO NOTHING", [PID3]);
    try {
      // 自举模板 v1（已有提交版本）
      await docs.listDocs(PID3, CTX3);
      const d0 = (await docs.getDoc(PID3, 'crd')) as unknown as DocView;
      // 改一节存草稿 → 草稿≠版本（未提交修改）
      await docs.saveDraft(PID3, 'crd', {
        secId: d0.secs[0]!.id, md: '引言：草稿未提交修改',
        baseVersion: d0.cur, baseFingerprint: d0.contentFingerprint,
      }, CTX3);
      const draftRow = await query<{ content: string }>(
        `SELECT t.content FROM req_drafts t JOIN req_documents d2 ON d2.id=t.document_id
         WHERE d2.project_id=$1 AND d2.doc_kind='crd'`, [PID3]);
      const draftFp = sha256Text(draftRow.rows[0]!.content);
      // 重新生成（增量指令，mock 分支）：drive 落 propose-pending，基准必须是草稿而非版本
      const { operationId } = await gen.start(PID3, 'crd', {
        referenceFileIds: [], referenceFingerprints: {}, instruction: '重新生成一版',
      }, CTX3);
      const fin = await gen.drive(operationId, CTX3, () => {});
      expect(fin.status).toBe('done'); // 修复前：failed / PATCH_BASE_STALE
      const pend = await query<{ target_fingerprint: string }>(
        `SELECT p.target_fingerprint FROM req_pendings p JOIN req_documents d2 ON d2.id=p.document_id
         WHERE d2.project_id=$1 AND d2.doc_kind='crd'`, [PID3]);
      expect(pend.rows.length).toBeGreaterThan(0);
      expect([...new Set(pend.rows.map((r) => r.target_fingerprint))]).toEqual([draftFp]);
    } finally {
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID3]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID3]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID3]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID3]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID3]);
      await query('DELETE FROM projects WHERE id=$1', [PID3]);
    }
  });

  it('T16b 回归：整篇重生成大章补丁带 after 锚点 → 逐条 accept 按模型输出顺序落位（不文末逆序堆叠）', async () => {
    const PID4 = '00000000-0000-0000-0000-0000000000fd';
    const CTX4 = { projectId: PID4, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 't16-add-after') ON CONFLICT (id) DO NOTHING", [PID4]);
    try {
      await docs.listDocs(PID4, CTX4); // 自举模板 v1
      let d = (await docs.getDoc(PID4, 'crd')) as unknown as DocView;
      // 既有文档：前言 + CR-001 + CR-002（s0 为全文口，允许整篇替换式写入）
      await docs.saveDraft(PID4, 'crd', {
        secId: d.secs[0]!.id,
        md: ['初稿引言。', '', '## CR-001 门户首页', '', '承接：R-001', '', '## CR-002 界面检索', '', '承接：R-002'].join('\n'),
        baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
      }, CTX4);
      d = (await docs.getDoc(PID4, 'crd')) as unknown as DocView;
      const fp = d.contentFingerprint.replace(/^sha256:/, '');
      // 模型整篇重出的三条大章 add（带 after 落位锚点），走 doc.propose-pending → accept-pending 真实命令链路
      const proposed = (await executeCommand('doc.propose-pending', {
        projectId: PID4, kind: 'crd',
        patches: [
          { type: 'add', secId: 's0', title: '一、背景与目标', new: '背景。', after: '' },
          { type: 'add', secId: 's0', title: '二、功能需求', new: '功能引言。', after: '一、背景与目标' },
          { type: 'add', secId: 's0', title: '三、非功能需求', new: '性能。', after: 'CR-002 界面检索' },
        ],
        targetFingerprint: fp, proposedBy: 'assistant',
      }, CTX4)) as { patchIds: string[] };
      expect(proposed.patchIds).toHaveLength(3);
      for (const id of proposed.patchIds) await docs.acceptPatch(PID4, 'crd', id, CTX4);
      d = (await docs.getDoc(PID4, 'crd')) as unknown as DocView;
      expect(d.secs.map((s) => s.title)).toEqual([
        '', '一、背景与目标', '二、功能需求', 'CR-001 门户首页', 'CR-002 界面检索', '三、非功能需求',
      ]);
      // 锚点落空退化：append 文末不抛错、不阻塞人工处置
      const fp2 = d.contentFingerprint.replace(/^sha256:/, '');
      const p2 = (await executeCommand('doc.propose-pending', {
        projectId: PID4, kind: 'crd',
        patches: [{ type: 'add', secId: 's0', title: '四、附录', new: '附录。', after: '不存在的大章' }],
        targetFingerprint: fp2, proposedBy: 'assistant',
      }, CTX4)) as { patchIds: string[] };
      await docs.acceptPatch(PID4, 'crd', p2.patchIds[0]!, CTX4);
      d = (await docs.getDoc(PID4, 'crd')) as unknown as DocView;
      expect(d.secs.map((s) => s.title).at(-1)).toBe('四、附录');
      // I-1 混合批：add 大章（after='' 文首插入，既有节位置后移、重切分 id 重派）+ 两条 modify 既有节
      // （secId 按 propose 时刻位置产：s3=CR-001/s4=CR-002）按序 accept——修复前 add 后库存 secId 错位 → PATCH_BASE_STALE 卡死
      const fp3 = d.contentFingerprint.replace(/^sha256:/, '');
      expect(d.secs.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']); // 钉住 propose 时刻位置口径
      const mixed = (await executeCommand('doc.propose-pending', {
        projectId: PID4, kind: 'crd',
        patches: [
          { type: 'add', secId: 's0', title: '零、总体说明', new: '总体。', after: '' },
          { type: 'modify', secId: 's3', title: 'CR-001 门户首页', old: '承接：R-001', new: '承接：R-001、R-003' },
          { type: 'modify', secId: 's4', title: 'CR-002 界面检索', old: '承接：R-002', new: '承接：R-002、R-004' },
        ],
        targetFingerprint: fp3, proposedBy: 'assistant',
      }, CTX4)) as { patchIds: string[] };
      for (const id of mixed.patchIds) await docs.acceptPatch(PID4, 'crd', id, CTX4);
      d = (await docs.getDoc(PID4, 'crd')) as unknown as DocView;
      expect(d.secs.map((s) => s.title)).toEqual([
        '', '零、总体说明', '一、背景与目标', '二、功能需求', 'CR-001 门户首页', 'CR-002 界面检索', '三、非功能需求', '四、附录',
      ]);
      expect(d.secs.find((s) => s.title === 'CR-001 门户首页')!.md).toContain('R-003');
      expect(d.secs.find((s) => s.title === 'CR-002 界面检索')!.md).toContain('R-004');
      expect(d.secs.find((s) => s.title === '二、功能需求')!.md).not.toContain('承接'); // 未误落错节
    } finally {
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID4]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID4]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID4]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID4]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID4]);
      await query('DELETE FROM projects WHERE id=$1', [PID4]);
    }
  });

  it('T16 实机抓修：同批补丁 created_at 事务同值 → seq 列钉住 listPatches 提案顺序（不乱序）', async () => {
    const PID5 = '00000000-0000-0000-0000-0000000000fe';
    const CTX5 = { projectId: PID5, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 't16-pendings-seq') ON CONFLICT (id) DO NOTHING", [PID5]);
    // 测试基建不自动跑迁移（vitest 直测 dev 库，迁移走 pnpm migrate/dist）→ 兜底手工 ALTER，与 0025 幂等同形
    await query('ALTER TABLE req_pendings ADD COLUMN IF NOT EXISTS seq int');
    try {
      await docs.listDocs(PID5, CTX5); // 自举模板 v1
      const d = (await docs.getDoc(PID5, 'crd')) as unknown as DocView;
      const fp = d.contentFingerprint.replace(/^sha256:/, '');
      // 单事务一批提 3 条（模拟整篇重生成批）：created_at 在 pg 中取事务开始时间 → 全同值
      const proposed = (await executeCommand('doc.propose-pending', {
        projectId: PID5, kind: 'crd',
        patches: [
          { type: 'add', secId: 's0', title: '一、批序甲', new: '甲。', after: '' },
          { type: 'add', secId: 's0', title: '二、批序乙', new: '乙。', after: '一、批序甲' },
          { type: 'add', secId: 's0', title: '三、批序丙', new: '丙。', after: '二、批序乙' },
        ],
        targetFingerprint: fp, proposedBy: 'assistant',
      }, CTX5)) as { patchIds: string[] };
      expect(proposed.patchIds).toHaveLength(3);
      // 钉死 seq 列值 = 批内序号 0,1,2（修复前列不存在 → 红）
      const seqs = await query<{ seq: number | null }>(
        `SELECT p.seq FROM req_pendings p JOIN req_documents d2 ON d2.id=p.document_id
         WHERE d2.project_id=$1 ORDER BY p.seq`, [PID5]);
      expect(seqs.rows.map((r) => r.seq)).toEqual([0, 1, 2]);
      // listPatches 返回序 == 提案数组序（修复前 ORDER BY created_at 同值不稳 → 大概率红）
      const list = (await docs.listPatches(PID5, 'crd')) as { items: Array<{ patchId: string; title: string }> };
      expect(list.items.map((x) => x.title)).toEqual(['一、批序甲', '二、批序乙', '三、批序丙']);
      expect(list.items.map((x) => x.patchId)).toEqual(proposed.patchIds);
    } finally {
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID5]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID5]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID5]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID5]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID5]);
      await query('DELETE FROM projects WHERE id=$1', [PID5]);
    }
  });

  it('改后接受：accept-pending 带 newText 覆盖提案新文再并入（审计 reason 记「改后接受」；del 补丁拒绝覆盖）', async () => {
    const PID6 = '00000000-0000-0000-0000-0000000000ff';
    const CTX6 = { projectId: PID6, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 'accept-override') ON CONFLICT (id) DO NOTHING", [PID6]);
    try {
      await docs.listDocs(PID6, CTX6); // 自举模板 v1
      let d = (await docs.getDoc(PID6, 'crd')) as unknown as DocView;
      // 既有节 CR-001，提案 modify 其正文
      await docs.saveDraft(PID6, 'crd', {
        secId: d.secs[0]!.id,
        md: ['引言。', '', '## CR-001 门户', '', '承接：R-001', '', '## CR-002 检索', '', '承接：R-002'].join('\n'),
        baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
      }, CTX6);
      d = (await docs.getDoc(PID6, 'crd')) as unknown as DocView;
      const fp = d.contentFingerprint.replace(/^sha256:/, '');
      const proposed = (await executeCommand('doc.propose-pending', {
        projectId: PID6, kind: 'crd',
        patches: [
          { type: 'modify', secId: 's1', title: 'CR-001 门户', old: '承接：R-001', new: '承接：R-001、R-009' },
          { type: 'del', secId: 's2', title: 'CR-002 检索', old: '承接：R-002' },
        ],
        targetFingerprint: fp, proposedBy: 'assistant',
      }, CTX6)) as { patchIds: string[] };
      // 人工编辑新文后接受：落稿内容=覆盖文，而非提案原文
      await docs.acceptPatch(PID6, 'crd', proposed.patchIds[0]!, CTX6, undefined, '承接：R-001、R-009（人工修订：仅首页）');
      d = (await docs.getDoc(PID6, 'crd')) as unknown as DocView;
      const sec1 = d.secs.find((s) => s.title === 'CR-001 门户')!;
      expect(sec1.md).toContain('仅首页');
      expect(sec1.md).not.toContain('承接：R-001、R-009\n'); // 提案原文未落稿（覆盖生效）
      // 决策留痕：reason 记「改后接受」
      const row = await query<{ status: string; reason: string | null }>(
        `SELECT status, reason FROM req_pendings WHERE id=$1`, [proposed.patchIds[0]!]);
      expect(row.rows[0]!.status).toBe('accepted');
      expect(row.rows[0]!.reason).toContain('改后接受');
      // del 补丁无新文：覆盖拒绝（VALIDATION_FAILED）；不带 newText 时 del 正常接受
      await expect(docs.acceptPatch(PID6, 'crd', proposed.patchIds[1]!, CTX6, undefined, 'x'))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(docs.acceptPatch(PID6, 'crd', proposed.patchIds[1]!, CTX6)).resolves.toBeTruthy();
      const row2 = await query<{ status: string }>(`SELECT status FROM req_pendings WHERE id=$1`, [proposed.patchIds[1]!]);
      expect(row2.rows[0]!.status).toBe('accepted');
    } finally {
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID6]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID6]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID6]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID6]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID6]);
      await query('DELETE FROM projects WHERE id=$1', [PID6]);
    }
  });

  it('上游变更联动：CRD 提交新版→PRD 派生「上游已变」+通知+事件；PRD 跟随提交后消除', async () => {
    const PID7 = '00000000-0000-0000-0000-0000000000d1';
    const CTX7 = { projectId: PID7, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 'upstream-stale') ON CONFLICT (id) DO NOTHING", [PID7]);
    try {
      await docs.listDocs(PID7, CTX7); // 模板 v1 自举（crd+prd 同刻，互不 stale）
      // PRD 先提交 v2（先于 CRD 后续提交）
      let dp = (await docs.getDoc(PID7, 'prd')) as unknown as DocView;
      await docs.saveDraft(PID7, 'prd', { secId: dp.secs[0]!.id, md: 'PRD 引言 v2', baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint }, CTX7);
      dp = (await docs.getDoc(PID7, 'prd')) as unknown as DocView;
      await docs.commit(PID7, 'prd', 'PRD v2', dp.cur, CTX7);
      await new Promise((r) => setTimeout(r, 5)); // 跨事务 submitted_at 严格递增保险
      let list = (await docs.listDocs(PID7, CTX7)) as { items: Array<{ kind: string; upstreamStale?: boolean; upstreamVersionNo?: number }> };
      expect(list.items.find((i) => i.kind === 'PRD')!.upstreamStale).toBe(false);
      // CRD 提交 v2 → PRD 立即派生 stale + 通知 + 事件
      let dc = (await docs.getDoc(PID7, 'crd')) as unknown as DocView;
      await docs.saveDraft(PID7, 'crd', { secId: dc.secs[0]!.id, md: 'CRD 引言 v2\n\n## CR-001 X', baseVersion: dc.cur, baseFingerprint: dc.contentFingerprint }, CTX7);
      dc = (await docs.getDoc(PID7, 'crd')) as unknown as DocView;
      const c2 = (await docs.commit(PID7, 'crd', 'CRD v2', dc.cur, CTX7)) as { v: number; noticeId?: string };
      expect(c2.v).toBe(2);
      expect(c2.noticeId).toBeTruthy(); // 命中下游滞后→通知（同事务落库）
      list = (await docs.listDocs(PID7, CTX7)) as { items: Array<{ kind: string; upstreamStale?: boolean; upstreamVersionNo?: number }> };
      const prd = list.items.find((i) => i.kind === 'PRD')!;
      expect(prd.upstreamStale).toBe(true);
      expect(prd.upstreamVersionNo).toBe(2);
      const dv = (await docs.getDoc(PID7, 'prd')) as unknown as DocView;
      expect(dv.upstreamStale).toBe(true);
      const notice = await query<{ type: string; text: string; link: string }>(
        "SELECT type, text, link FROM sys_notifications WHERE project_id=$1 AND type='req.upstream.changed' ORDER BY created_at DESC LIMIT 1", [PID7]);
      expect(notice.rows[0]!.text).toContain('CRD 已提交 v2');
      expect(notice.rows[0]!.text).toContain('PRD 仍停留在 v2');
      expect(notice.rows[0]!.link).toBe('/req?tab=prd');
      const ev = await query<{ payload: { downstream: string; upstreamVersionNo: number } }>(
        "SELECT payload FROM evd_events WHERE project_id=$1 AND kind='req.upstream.changed' ORDER BY created_at DESC LIMIT 1", [PID7]);
      expect(ev.rows[0]!.payload.downstream).toBe('prd');
      expect(ev.rows[0]!.payload.upstreamVersionNo).toBe(2);
      // PRD 跟随提交 v3 → stale 消除（本次提交不再产 crd→prd 通知）
      await new Promise((r) => setTimeout(r, 5));
      dp = (await docs.getDoc(PID7, 'prd')) as unknown as DocView;
      await docs.saveDraft(PID7, 'prd', { secId: dp.secs[0]!.id, md: 'PRD 引言 v3（跟随 CRD v2）', baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint }, CTX7);
      dp = (await docs.getDoc(PID7, 'prd')) as unknown as DocView;
      await docs.commit(PID7, 'prd', 'PRD v3', dp.cur, CTX7);
      list = (await docs.listDocs(PID7, CTX7)) as { items: Array<{ kind: string; upstreamStale?: boolean }> };
      expect(list.items.find((i) => i.kind === 'PRD')!.upstreamStale).toBe(false);
    } finally {
      await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID7]);
      await query('DELETE FROM evd_events WHERE project_id=$1', [PID7]);
      await query('DELETE FROM rtm_links WHERE project_id=$1', [PID7]);
      await query('DELETE FROM rtm_health WHERE project_id=$1', [PID7]);
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID7]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID7]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID7]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID7]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID7]);
      await query('DELETE FROM projects WHERE id=$1', [PID7]);
    }
  });

  it('RTM 覆盖闭环：重建检查出缺口 → AI 补齐定向提案 → 接受提交 → 再检查转绿（幂等）', async () => {
    const PID8 = '00000000-0000-0000-0000-0000000000d4';
    const CTX8 = { projectId: PID8, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 'rtm-coverage-loop') ON CONFLICT (id) DO NOTHING", [PID8]);
    try {
      await docs.listDocs(PID8, CTX8); // 模板自举
      // CRD：R-001/R-002 → CR-001/CR-002 全承接（L0a 先绿，聚焦 L0b 闭环）
      let dc = (await docs.getDoc(PID8, 'crd')) as unknown as DocView;
      await docs.saveDraft(PID8, 'crd', { secId: dc.secs[0]!.id, md: [
        '引言。', '', '## CR-001 门户', '', '承接：R-001', '', '## CR-002 检索', '', '承接：R-002',
      ].join('\n'), baseVersion: dc.cur, baseFingerprint: dc.contentFingerprint }, CTX8);
      dc = (await docs.getDoc(PID8, 'crd')) as unknown as DocView;
      await docs.commit(PID8, 'crd', 'CRD v2', dc.cur, CTX8);
      // PRD：只承接 CR-001 → L0b 缺口 CR-002
      let dp = (await docs.getDoc(PID8, 'prd')) as unknown as DocView;
      await docs.saveDraft(PID8, 'prd', { secId: dp.secs[0]!.id, md: [
        '引言。', '', '## REQ-001 门户页', '', '承接：CR-001',
      ].join('\n'), baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint }, CTX8);
      dp = (await docs.getDoc(PID8, 'prd')) as unknown as DocView;
      await docs.commit(PID8, 'prd', 'PRD v2', dp.cur, CTX8);
      // ①重建映射并检查：L0b 未达标、缺口 CR-002（rtm.rebuild 幂等重建 + 实时健康度）
      const h1 = (await rtm.rebuildAndCheck(PID8, CTX8)) as { ok: boolean; l0b: number; gaps: Array<{ code: string; target: string }> };
      expect(h1.ok).toBe(false);
      expect(h1.l0b).toBe(0.5);
      expect(h1.gaps.some((g) => g.code === 'RTM_HEALTH' && g.target === 'CR-002')).toBe(true);
      // ②AI 补齐缺口（mock 定向锚点补丁：承接 CR-002、编号顺延）
      const fix = await gen.coverageFixFromGaps(PID8, CTX8);
      expect(fix.ok).toBe(true);
      expect(fix.results.length).toBe(1);
      expect(fix.results[0]!.kind).toBe('prd');
      expect(fix.results[0]!.patchCount).toBe(1);
      const patches = (await docs.listPatches(PID8, 'prd')) as { items: Array<{ patchId: string; status: string; title?: string }> };
      const pend = patches.items.filter((p) => p.status === 'pending');
      expect(pend.length).toBe(1);
      expect(pend[0]!.title).toContain('CR-002');
      // ③接受 → 提交 → 再检查转绿（闭环成立）
      await docs.acceptPatch(PID8, 'prd', pend[0]!.patchId, CTX8);
      dp = (await docs.getDoc(PID8, 'prd')) as unknown as DocView;
      await docs.commit(PID8, 'prd', 'PRD v3 补齐', dp.cur, CTX8);
      const h2 = (await rtm.rebuildAndCheck(PID8, CTX8)) as { l0b: number };
      expect(h2.l0b).toBe(1);
      // 无缺口幂等：results 空（覆盖检查已通过）
      const fix2 = await gen.coverageFixFromGaps(PID8, CTX8);
      expect(fix2.ok).toBe(true);
      expect(fix2.results.length).toBe(0);
    } finally {
      await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID8]);
      await query('DELETE FROM evd_events WHERE project_id=$1', [PID8]);
      await query('DELETE FROM rtm_links WHERE project_id=$1', [PID8]);
      await query('DELETE FROM rtm_health WHERE project_id=$1', [PID8]);
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID8]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID8]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID8]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID8]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID8]);
      await query('DELETE FROM projects WHERE id=$1', [PID8]);
    }
  });
});
