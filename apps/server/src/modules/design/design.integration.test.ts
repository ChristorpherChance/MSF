/** 设计域集成测试（T3-02~10，需 DB+MinIO；F02-2、A05、REQ-301~312） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { ReqDocsService } from '../req/docs.service.js';
import { DesignDocsService } from './docs.service.js';
import { DesignGenerateService, designGenTiming } from './generate.service.js';
import { CatalogService } from './catalog.service.js';
import { PrototypeService } from './prototype.service.js';
import { ReviewService } from './review.service.js';
import { DesignExportService } from './export.service.js';

const PID = '00000000-0000-0000-0000-0000000000f2';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dsg_documents LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('Design 设计域（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  designGenTiming.chunkDelayMs = 0;
  const policy = new PolicyService();
  const reqDocs = new ReqDocsService(policy);
  const docs = new DesignDocsService();
  const gen = new DesignGenerateService(docs);
  const catalog = new CatalogService(docs);
  const proto = new PrototypeService(docs, catalog, new StorageService(), policy);
  const reviews = new ReviewService();
  const exp = new DesignExportService(new StorageService());
  resetCommands();
  reqDocs.onModuleInit();
  docs.onModuleInit();
  gen.onModuleInit();
  catalog.onModuleInit();
  exp.onModuleInit();
  proto.onModuleInit();
  reviews.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm3-design-test') ON CONFLICT (id) DO NOTHING", [PID]);
    await reqDocs.listDocs(PID, CTX); // 自举 CRD/PRD 模板
  });
  afterAll(async () => {
    await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_catalog_refs WHERE item_id IN (SELECT id FROM dsg_catalog_items WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_catalog_items WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_prototype_checks WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_baselines WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_plans WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_reviews WHERE project_id=$1', [PID]);
    await query('UPDATE dsg_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_versions WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_links WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_health WHERE project_id=$1', [PID]);
    await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_events WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  interface DocView {
    cur: number; modified: boolean; finalized: boolean; contentFingerprint: string;
    secs: Array<{ id: string; title: string; md: string; pending: string | null }>;
  }
  const view = async (kind: string) => (await docs.getDoc(PID, kind)) as unknown as DocView;

  it('八册自举 + 生命周期 + 未决评审二次确认（T3-02/04）', async () => {
    const list = (await docs.listDocs(PID, CTX)) as { items: Array<{ kind: string; cur: number; book: string }> };
    expect(list.items).toHaveLength(8);
    expect(list.items.map((i) => i.book).sort()).toEqual(['a', 'd', 'g', 'h', 'k', 'n', 'o', 'u']);

    // 编辑→提交 v2
    let d = await view('hld');
    await docs.saveDraft(PID, 'hld', { secId: 's0', md: '总体架构 v1', baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX);
    d = await view('hld');
    const c = (await docs.commit(PID, 'hld', '初稿', d.cur, CTX)) as { v: number };
    expect(c.v).toBe(2);

    // 评审种子 + 定稿被未决 DR 阻断 → 二次确认放行
    const rv = (await reviews.list(PID, CTX)) as { items: Array<{ id: string; status: string }> };
    expect(rv.items.length).toBeGreaterThanOrEqual(3);
    await expect(docs.finalize(PID, 'hld', 2, 2, true, false, CTX)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    // AI 通道拒绝
    await expect(
      docs.finalize(PID, 'hld', 2, 2, true, true, { projectId: PID, actorKind: 'assistant', actorId: 'ai' }),
    ).rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    const fin = (await docs.finalize(PID, 'hld', 2, 2, true, true, CTX)) as { finalVer: number; openReviews: number };
    expect(fin.finalVer).toBe(2);
    expect(fin.openReviews).toBeGreaterThanOrEqual(3);
    // 结论留痕
    await reviews.conclude(PID, 'DR-01', 'pass', '逐条核对完成', CTX);
    const rv2 = (await reviews.list(PID, CTX)) as { items: Array<{ id: string; status: string; conclusion: string }> };
    expect(rv2.items.find((x) => x.id === 'DR-01')).toMatchObject({ status: 'done', conclusion: expect.stringContaining('pass') });
    // 定稿态锁
    const d2 = await view('hld');
    await expect(
      docs.saveDraft(PID, 'hld', { secId: 's0', md: '原地改', baseVersion: 2, baseFingerprint: d2.contentFingerprint }, CTX),
    ).rejects.toMatchObject({ code: 'VERSION_LOCKED' });
    await docs.unlock(PID, 'hld', CTX);
  });

  it('生成门禁链：LLD←HLD 定稿、HLD←PRD 定稿（T3-03）', async () => {
    // PRD 未定稿 → HLD 生成 GATE_BLOCKED
    await expect(gen.start(PID, 'hld', { referenceFileIds: [], referenceFingerprints: {} }, CTX))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    // HLD 未再定稿（上个用例定稿后解锁）→ mod 生成 GATE_BLOCKED
    await expect(gen.start(PID, 'mod', { referenceFileIds: [], referenceFingerprints: {} }, CTX))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });

    // 定稿 PRD（内容含 REQ+DSG 锚点，供原型识别与 L0c）
    const rp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: 's0',
      md: '产品需求\n\n## REQ-001 门户首页\n\n承接：CR-001\n\n设计锚点：DSG-U03-2\n\n## REQ-002 检索\n\n承接：CR-001\n\n设计锚点：DSG-U03-2',
      baseVersion: rp.cur, baseFingerprint: rp.contentFingerprint,
    }, CTX);
    const rp2 = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'PRD 初稿', rp2.cur, CTX);
    await reqDocs.finalize(PID, 'prd', 2, 2, true, CTX); // CRD 无 R/CR → 空分母记 1，门禁通过

    // HLD 生成 → 补丁不落稿 → 接受 → 提交
    const { operationId } = await gen.start(PID, 'hld', { referenceFileIds: [], referenceFingerprints: {} }, CTX);
    const deltas: string[] = [];
    const fin = await gen.drive(operationId, CTX, (t) => deltas.push(t));
    expect(fin.status).toBe('done');
    expect(deltas.length).toBeGreaterThan(1);
    let patches = (await docs.listPatches(PID, 'hld')) as { items: Array<{ patchId: string; status: string }> };
    expect(patches.items.filter((p) => p.status === 'pending').length).toBeGreaterThanOrEqual(3);
    for (const p of patches.items.filter((x) => x.status === 'pending')) {
      await docs.acceptPatch(PID, 'hld', p.patchId, CTX);
    }
    const d = await view('hld');
    expect(d.secs.some((s) => /^h-\d/.test(s.title))).toBe(true);
    await docs.commit(PID, 'hld', 'AI 初稿', d.cur, CTX);
    await docs.finalize(PID, 'hld', 3, 3, true, true, CTX);
    // mod 册现在可生成
    const m = await gen.start(PID, 'mod', { referenceFileIds: [], referenceFingerprints: {} }, CTX);
    const fin2 = await gen.drive(m.operationId, CTX, () => {});
    expect(fin2.status).toBe('done');
    patches = (await docs.listPatches(PID, 'mod')) as { items: Array<{ patchId: string; status: string }> };
    expect(patches.items.some((p) => p.status === 'pending')).toBe(true);
  });

  it('原型流水：plan→generate→preview→check→finalize→baseline（T3-05~08）', async () => {
    // plan：PRD 已定稿 → 目录快照 + 追溯引用
    const plan = (await catalog.plan(PID, CTX)) as { planId: string; complete: boolean; fingerprint: string };
    expect(plan.complete).toBe(true);
    const cat = (await catalog.getCatalog(PID)) as {
      catalogVersion: string; groups: Record<string, Array<{ code: string; source: string; anchors?: Array<{ refKind: string; anchor: string | null }> }>>;
    };
    expect(cat.catalogVersion).toBe('V3-1');
    expect(cat.groups.page!.length).toBeGreaterThanOrEqual(3); // REQ-001/002 + P-HOME
    expect(cat.groups.viewport!.map((v) => v.code)).toEqual(['vp-1280', 'vp-1440', 'vp-1920']);
    // L8：A05-4 条目带追溯锚点（REQ 章节来源页面 → prd 锚点）
    const p1 = cat.groups.page!.find((x) => x.code === 'P-001');
    expect(p1?.anchors?.some((a) => a.refKind === 'prd')).toBe(true);

    // 来源审计：锚点指纹与现行定稿一致 → ok
    const audit0 = (await catalog.sourceAudit(PID)) as { ok: boolean };
    expect(audit0.ok).toBe(true);

    // generate：规划指纹不符 → VERSION_CONFLICT；正确 → 版本+对象
    await expect(proto.generate(PID, plan.planId, 'sha256:bad', CTX)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const g = (await proto.generate(PID, plan.planId, plan.fingerprint, CTX)) as { prototypeVersionId: string; v: number };
    expect(g.v).toBe(1);
    const prev = (await proto.preview(PID, 'P-001')) as { previewUrl: string; htmlFingerprint: string };
    expect(prev.previewUrl).toContain('http');

    // check：全过（标记完整）
    const chk = (await proto.check(PID, g.prototypeVersionId, CTX)) as { reportId: string; status: string };
    expect(chk.status).toBe('pass');

    // finalize：门禁 + 策略人工 + 基线落库
    await expect(proto.finalize(PID, g.prototypeVersionId, chk.reportId, true, { projectId: PID, actorKind: 'assistant', actorId: 'ai' }))
      .rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    const fin = (await proto.finalize(PID, g.prototypeVersionId, chk.reportId, true, CTX)) as { baselineId: string; code: string };
    expect(fin.code).toMatch(/^BL-\d{4}$/);
    const st = (await proto.status(PID)) as { status: string };
    expect(st.status).toBe('finalized');
    const bls = (await proto.baselines(PID)) as { items: Array<{ valid: boolean; current: boolean; items: unknown[] }> };
    expect(bls.items[0]).toMatchObject({ valid: true, current: true });
    expect(bls.items[0]!.items.length).toBe(3); // PRD/HLD/PROTOTYPE

    // develop 门禁：基线有效 + L0c=1（REQ 全有 DSG 锚点）→ ok
    const gate = (await proto.gates(PID, 'develop')) as { ok: boolean; issues: unknown[] };
    expect(gate.ok).toBe(true);
  });

  it('目录人工增删 + 检查 unverified 不静默（T3-05/07）', async () => {
    const added = (await catalog.addItem(PID, { itemType: 'page', code: 'P-CUSTOM', title: '设置-审计', note: '人工补充' }, CTX)) as { itemId: string; source: string; catalogVersion: string };
    expect(added.source).toBe('manual');
    expect(added.catalogVersion).toBe('V3-2'); // 增删=新版本
    // 识别条目不可直删
    const cat = (await catalog.getCatalog(PID)) as { groups: Record<string, Array<{ itemId: string; code: string; source: string }>> };
    const identified = cat.groups.page!.find((p) => p.source === 'identified')!;
    await expect(catalog.removeItem(PID, identified.itemId, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // manual 条目可删
    await catalog.removeItem(PID, added.itemId, CTX);
    const cat2 = (await catalog.getCatalog(PID)) as { catalogVersion: string; groups: Record<string, Array<{ code: string }>> };
    expect(cat2.catalogVersion).toBe('V3-3');
    expect(cat2.groups.page!.some((p) => p.code === 'P-CUSTOM')).toBe(false);
  });

  it('失效传播：PRD 变化 → 规划 PLAN_STALE + 来源审计失败 + 基线 BASELINE_STALE（T3-08~10）', async () => {
    // 改 PRD（unlock→编辑 REQ-001 节→提交→定稿）
    await reqDocs.unlock(PID, 'prd', CTX);
    const rp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    const sec = rp.secs.find((s) => s.title.includes('REQ-001'))!;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: sec.id, md: `${sec.md}\n\n补充：首页增加公告位`,
      baseVersion: rp.cur, baseFingerprint: rp.contentFingerprint,
    }, CTX);
    const rp2 = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'REQ-001 修订', rp2.cur, CTX);
    await reqDocs.finalize(PID, 'prd', 3, 3, true, CTX);

    // 来源审计：REQ-001 锚点内容已变 → SOURCE_SEMANTIC_UNVERIFIED
    const audit = (await catalog.sourceAudit(PID)) as { ok: boolean; issues: Array<{ code: string; target: string }> };
    expect(audit.ok).toBe(false);
    expect(audit.issues.some((i) => i.code === 'SOURCE_SEMANTIC_UNVERIFIED')).toBe(true);

    // 规划过期：gates generate → PLAN_STALE
    const g = (await proto.gates(PID, 'generate')) as { ok: boolean; issues: Array<{ code: string }> };
    expect(g.ok).toBe(false);
    expect(g.issues.some((i) => i.code === 'PLAN_STALE')).toBe(true);

    // 基线实时失效
    const bls = (await proto.baselines(PID)) as { items: Array<{ valid: boolean; staleReason: string | null }> };
    expect(bls.items[0]!.valid).toBe(false);
    expect(bls.items[0]!.staleReason).toBeTruthy();

    // develop 门禁：BASELINE_STALE
    const dev = (await proto.gates(PID, 'develop')) as { ok: boolean; issues: Array<{ code: string }> };
    expect(dev.ok).toBe(false);
    expect(dev.issues.some((i) => i.code === 'BASELINE_STALE')).toBe(true);

    // 恢复路径（F02-2 stale→planning）：重规划→解除原型定稿→重生成→重检查→重定稿 → develop 放行
    const plan2 = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    await proto.unlock(PID, CTX);
    const g2 = (await proto.generate(PID, plan2.planId, plan2.fingerprint, CTX)) as { prototypeVersionId: string };
    const chk2 = (await proto.check(PID, g2.prototypeVersionId, CTX)) as { reportId: string; status: string };
    expect(chk2.status).toBe('pass');
    await proto.finalize(PID, g2.prototypeVersionId, chk2.reportId, true, CTX);
    const dev2 = (await proto.gates(PID, 'develop')) as { ok: boolean };
    expect(dev2.ok).toBe(true);
  });

  it('RTM 反向派生（#15）：PRD 去锚 → L0C 缺口带引导；设计册回引 REQ 提交后冪等重建解锁', async () => {
    // ① PRD 摘掉 REQ-002 的 DSG 锚点 → 缺口出现，报错带两条修复路径引导
    await reqDocs.unlock(PID, 'prd', CTX);
    const rp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    const sec = rp.secs.find((s) => s.title.includes('REQ-002'))!;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: sec.id, md: sec.md.replace('设计锚点：DSG-U03-2', ''),
      baseVersion: rp.cur, baseFingerprint: rp.contentFingerprint,
    }, CTX);
    const rp2 = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'REQ-002 去锚', rp2.cur, CTX);
    const g1 = (await proto.gates(PID, 'develop')) as { issues: Array<{ code: string; message: string; target?: string }> };
    const gap = g1.issues.find((i) => i.code === 'L0C_BELOW' && i.target === 'REQ-002');
    expect(gap).toBeTruthy();
    expect(gap!.message).toContain('设计承接：DSG-*');
    expect(gap!.message).toContain('设计册');

    // ② HLD 章节回引 REQ-002（无 DSG 锚点）→ commit 触发 rtm.rebuild → 册级链 DSG-H 解锁（W3-004 单字母前缀）
    await docs.unlock(PID, 'hld', CTX);
    const hd = await view('hld');
    const hsec = hd.secs[0]!;
    await docs.saveDraft(PID, 'hld', {
      secId: hsec.id, md: `${hsec.md}\n\n本章承接 REQ-002 的检索链路设计。`,
      baseVersion: hd.cur, baseFingerprint: hd.contentFingerprint,
    }, CTX);
    const hd2 = await view('hld');
    await docs.commit(PID, 'hld', 'REQ-002 回引', hd2.cur, CTX);

    const link = await query(
      `SELECT 1 FROM rtm_links WHERE project_id=$1 AND from_kind='req' AND from_code='REQ-002'
       AND to_kind='dsg' AND to_code='DSG-H' AND relation='implements'`, [PID]);
    expect(link.rowCount).toBe(1);
    const g2 = (await proto.gates(PID, 'develop')) as { issues: Array<{ code: string; target?: string }> };
    expect(g2.issues.filter((i) => i.code === 'L0C_BELOW')).toEqual([]);
  });

  it('设计册导出（L1）：md/docx/pdf 落 MinIO + 签名 URL + 审计留痕', async () => {
    const hd = (await docs.getDoc(PID, 'hld')) as { cur: number };
    const m = (await exp.export(PID, 'hld', hd.cur, 'md', CTX)) as { downloadUrl: string };
    expect(m.downloadUrl).toContain('.md');
    for (const [fmt, magic] of [['docx', 'PK'], ['pdf', '%PDF-']] as const) {
      const x = (await exp.export(PID, 'hld', hd.cur, fmt, CTX)) as { downloadUrl: string };
      expect(x.downloadUrl).toContain(`.${fmt}`);
      const bytes = Buffer.from(await (await fetch(x.downloadUrl)).arrayBuffer());
      expect(bytes.subarray(0, magic.length).toString('latin1')).toBe(magic);
    }
    const audit = await query(
      "SELECT 1 FROM audit_log WHERE project_id=$1 AND command='design.doc.export' AND payload->>'format'='pdf'", [PID]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('W7-002 回归：人工目录增项后重新规划不丢 manual 条目（按 type+code 去重）', async () => {
    // 前置：上游 RTM 测试把 PRD 改到 v4 未再定稿——plan 门禁要求 PRD 定稿，先补
    const rp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView & { finalized: boolean };
    if (!rp.finalized) await reqDocs.finalize(PID, 'prd', rp.cur, rp.cur, true, CTX);
    const added = (await catalog.addItem(PID, { itemType: 'page', code: 'P-W7002', title: '巡检履历', note: '人工补充' }, CTX)) as { itemId: string; source: string };
    expect(added.source).toBe('manual');
    const plan = (await catalog.plan(PID, CTX)) as { planId: string };
    const snap = await query<{ snapshot: { items: Array<{ type: string; code: string }> } }>(
      'SELECT snapshot FROM dsg_plans WHERE id=$1', [plan.planId]);
    const codes = snap.rows[0]!.snapshot.items.map((i) => `${i.type}:${i.code}`);
    expect(codes).toContain('page:P-W7002'); // 修复前：re-plan 全量重导派生项，人工增项静默丢失
    // cleanup：删除人工条目，避免影响后续口径
    await catalog.removeItem(PID, added.itemId, CTX);
  });

  it('W7-003 回归：原型定稿后可解锁定稿重新生成（迭代回路闭合）', async () => {
    // 定稿态生成被门禁拦（修复前：提示「须先解除定稿」但全系统无任何解锁通道，迭代回路断裂）
    const g0 = (await proto.gates(PID, 'generate')) as { ok: boolean; issues: Array<{ code: string }> };
    expect(g0.ok).toBe(false);
    expect(g0.issues.some((i) => i.code === 'PROTOTYPE_FINALIZED')).toBe(true);

    // 解锁 → 旧基线实时失效 + PROTOTYPE_FINALIZED 门禁解除
    await proto.unlock(PID, CTX);
    const bls = (await proto.baselines(PID)) as { items: Array<{ valid: boolean }> };
    expect(bls.items.length).toBeGreaterThan(0);
    expect(bls.items.every((b) => !b.valid)).toBe(true);
    const g1 = (await proto.gates(PID, 'generate')) as { issues: Array<{ code: string }> };
    expect(g1.issues.some((i) => i.code === 'PROTOTYPE_FINALIZED')).toBe(false);

    // 重新规划→生成→检查→再定稿 → 新基线 + develop 放行
    const plan = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    const gen = (await proto.generate(PID, plan.planId, plan.fingerprint, CTX)) as { prototypeVersionId: string };
    const chk = (await proto.check(PID, gen.prototypeVersionId, CTX)) as { reportId: string; status: string };
    expect(chk.status).toBe('pass');
    await proto.finalize(PID, gen.prototypeVersionId, chk.reportId, true, CTX);
    const dev = (await proto.gates(PID, 'develop')) as { ok: boolean };
    expect(dev.ok).toBe(true);
  });

  it('上游变更联动：PRD 新版→设计八册派生「上游已变」；本册跟随提交后消除', async () => {
    const PID9 = '00000000-0000-0000-0000-0000000000d2';
    const CTX9 = { projectId: PID9, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 'dsg-upstream-stale') ON CONFLICT (id) DO NOTHING", [PID9]);
    try {
      await docs.listDocs(PID9, CTX9); // 八册模板 v1 自举（t0）
      await new Promise((r) => setTimeout(r, 5));
      // 无 PRD：不标（「未生成」而非「滞后」）
      let list = (await docs.listDocs(PID9, CTX9)) as { items: Array<{ kind: string; upstreamStale?: boolean; upstreamVersionNo?: number }> };
      expect(list.items.every((i) => !i.upstreamStale)).toBe(true);
      // PRD 模板自举（t1>t0）→ 八册全部派生 stale
      await reqDocs.listDocs(PID9, CTX9);
      list = (await docs.listDocs(PID9, CTX9)) as { items: Array<{ kind: string; upstreamStale?: boolean; upstreamVersionNo?: number }> };
      expect(list.items.length).toBe(8);
      expect(list.items.every((i) => i.upstreamStale === true)).toBe(true);
      expect(list.items.every((i) => i.upstreamVersionNo === 1)).toBe(true);
      const hd = (await docs.getDoc(PID9, 'hld')) as unknown as DocView & { upstreamStale?: boolean };
      expect(hd.upstreamStale).toBe(true);
      // HLD 跟随提交 v2 → 本册消除、其余七册仍 stale
      let d = (await docs.getDoc(PID9, 'hld')) as unknown as DocView;
      await docs.saveDraft(PID9, 'hld', { secId: 's0', md: '总体架构 v2（跟随 PRD）', baseVersion: d.cur, baseFingerprint: d.contentFingerprint }, CTX9);
      d = (await docs.getDoc(PID9, 'hld')) as unknown as DocView;
      await docs.commit(PID9, 'hld', 'v2', d.cur, CTX9);
      list = (await docs.listDocs(PID9, CTX9)) as { items: Array<{ kind: string; upstreamStale?: boolean }> };
      expect(list.items.find((i) => i.kind === 'hld')!.upstreamStale).toBe(false);
      expect(list.items.filter((i) => i.upstreamStale === true).length).toBe(7);
    } finally {
      await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID9]);
      await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID9]);
      await query('UPDATE dsg_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID9]);
      await query('DELETE FROM dsg_versions WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID9]);
      await query('DELETE FROM dsg_documents WHERE project_id=$1', [PID9]);
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID9]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID9]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID9]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID9]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID9]);
      await query('DELETE FROM rtm_links WHERE project_id=$1', [PID9]);
      await query('DELETE FROM rtm_health WHERE project_id=$1', [PID9]);
      await query('DELETE FROM projects WHERE id=$1', [PID9]);
    }
  });

  it('对话改设计册：design.doc.propose_edits 旁路提案→接受落稿；守卫人话+rewrite 单条 replace', async () => {
    const PIDA = '00000000-0000-0000-0000-0000000000d3';
    const CTXA = { projectId: PIDA, actorKind: 'human' as const, actorId: 'local' };
    await query("INSERT INTO projects (id, name) VALUES ($1, 'dsg-chat-edit') ON CONFLICT (id) DO NOTHING", [PIDA]);
    try {
      await docs.listDocs(PIDA, CTXA); // 模板 v1 自举
      const { getExternalTool } = await import('../platform/external-tools.js');
      const tool = getExternalTool('design.doc.propose_edits')!;
      const call = (args: Record<string, unknown>) =>
        tool(PIDA, { sessionId: 's', messageId: 'm', args }, CTXA) as Promise<{ ok: boolean; patchCount?: number; route?: string; reason?: string }>;
      // 枚举守卫人话（不落码）
      const bad = await call({ kind: 'xyz', instruction: 'x' });
      expect(bad.ok).toBe(false);
      expect(bad.reason).toContain('kind 枚举');
      // mock patch：模板无锚点节 → 产 add；提案落 dsg_pendings
      const r = await call({ kind: 'hld', instruction: '补充部署形态说明' });
      expect(r.ok).toBe(true);
      expect(r.patchCount).toBeGreaterThan(0);
      expect(r.route).toBe('/design');
      const patches = (await docs.listPatches(PIDA, 'hld')) as { items: Array<{ patchId: string; status: string }> };
      expect(patches.items.filter((p) => p.status === 'pending').length).toBe(r.patchCount);
      // 有 pending 拒新提案（守卫人话）
      const again = await call({ kind: 'hld', instruction: '再来一条' });
      expect(again.ok).toBe(false);
      expect(again.reason).toContain('待确认补丁');
      // 全部接受落稿
      for (const p of patches.items.filter((x) => x.status === 'pending')) await docs.acceptPatch(PIDA, 'hld', p.patchId, CTXA);
      const d = (await docs.getDoc(PIDA, 'hld')) as unknown as { secs: Array<{ title: string }> };
      expect(d.secs.some((s) => s.title === '对话补充条目')).toBe(true);
      // rewrite 通道：单条 replace 补丁（整篇重写，人工确认后生效）
      const rw = await call({ kind: 'hld', instruction: '整篇重写', mode: 'rewrite' });
      expect(rw.ok).toBe(true);
      expect(rw.patchCount).toBe(1);
      // 需求阶段模式推广：改后接受（newText 覆盖提案新文，reason 记「改后接受」落库留痕）
      const rwPatches = (await docs.listPatches(PIDA, 'hld')) as { items: Array<{ patchId: string; status: string }> };
      const rwPend = rwPatches.items.find((p) => p.status === 'pending')!;
      await docs.acceptPatch(PIDA, 'hld', rwPend.patchId, CTXA, undefined, '# 概要设计说明书\n\n（人工改后接受的整篇内容）');
      const accRow = await query<{ status: string; reason: string | null }>(
        'SELECT status, reason FROM dsg_pendings WHERE id=$1', [rwPend.patchId]);
      expect(accRow.rows[0]!.status).toBe('accepted');
      expect(accRow.rows[0]!.reason).toContain('改后接受');
      const dv = (await docs.getDoc(PIDA, 'hld')) as unknown as { secs: Array<{ md: string }> };
      expect(dv.secs.some((s) => s.md.includes('人工改后接受的整篇内容'))).toBe(true);
      // 拒绝理由落库（dsg_pendings.reason 迁移 0026）
      const r2 = await call({ kind: 'hld', instruction: '再补一节部署拓扑' });
      expect(r2.ok).toBe(true);
      const p2 = (await docs.listPatches(PIDA, 'hld')) as { items: Array<{ patchId: string; status: string }> };
      const pend2 = p2.items.find((p) => p.status === 'pending')!;
      await docs.rejectPatch(PIDA, 'hld', pend2.patchId, CTXA, '与现有部署节重复');
      const rejRow = await query<{ status: string; reason: string | null }>(
        'SELECT status, reason FROM dsg_pendings WHERE id=$1', [pend2.patchId]);
      expect(rejRow.rows[0]!.status).toBe('rejected');
      expect(rejRow.rows[0]!.reason).toBe('与现有部署节重复');
    } finally {
      await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PIDA]);
      await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PIDA]);
      await query('UPDATE dsg_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PIDA]);
      await query('DELETE FROM dsg_versions WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PIDA]);
      await query('DELETE FROM dsg_documents WHERE project_id=$1', [PIDA]);
      await query('DELETE FROM projects WHERE id=$1', [PIDA]);
    }
  });
});
