/**
 * 原型页↔ui 册结构化对应（设计覆盖检测与可交互原型 §2，需 DB+MinIO）：
 * ① plan 落 ref_kind='ui' 引用（快照+指纹，迁移 0031 后）；P-HOME 骨架页自动 exempt；
 * ② 时间基滞后：ui 册新提交（current 版本 submitted_at 晚于页 updated_at）→ 状态查询 uiStale +
 *    PROTOTYPE_DIRTY 门禁（pageDriftIssues 并列）→ 页重生成解脏 → 再汇总全清；
 * ③ 双向一致性：册有页无（UI_SECTION_UNMAPPED）/页有册无（PAGE_UI_UNMAPPED，exempt 豁免）；
 *    新旧目录判别式——全版无 ui refs 不检；
 * ④ re-plan 随行扩：派生条目的 payload.steps/exempt 人工修改按 type+code 迁移保留。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { ReqDocsService } from '../req/docs.service.js';
import { DesignDocsService } from './docs.service.js';
import { CatalogService } from './catalog.service.js';
import { PrototypeService } from './prototype.service.js';
import { PrototypePagesService } from './prototype-pages.service.js';

// e2e PID 注册表（共享库并行跑，撞 PID=FK 级联整组炸，新增套件先查再占）：
// e1~e9+f0~ff+d1~d5 已占用（registry 总表见 rtm-deferred.e2e.test.ts 顶部）；本套件占 d6。
const PID = '00000000-0000-0000-0000-0000000000d6';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dsg_catalog_refs LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

interface DocView {
  cur: number;
  contentFingerprint: string;
  secs: Array<{ id: string; title: string; md: string }>;
}

interface StatusView {
  pages: Array<{
    code: string; title: string; state: string; source?: string;
    reqIds?: string[]; uiRef?: { sectionId: string | null; anchor: string | null } | null; uiStale?: boolean;
  }>;
  pagesStale: boolean;
  uiStalePages?: string[];
}

interface GateView { ok: boolean; issues: Array<{ code: string; message: string; target?: string }> }

/** 编辑 ui 册 s0（整文含 ## 章节）并提交为新版本 */
async function commitUi(docs: DesignDocsService, md: string, note: string): Promise<void> {
  const dv = (await docs.getDoc(PID, 'ui')) as unknown as DocView;
  await docs.saveDraft(PID, 'ui', { secId: 's0', md, baseVersion: dv.cur, baseFingerprint: dv.contentFingerprint }, CTX);
  await docs.commit(PID, 'ui', note, dv.cur, CTX);
}

describe('原型页↔ui 册结构化对应（集成，需 DB+MinIO）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const policy = new PolicyService();
  const reqDocs = new ReqDocsService(policy);
  const docs = new DesignDocsService();
  const catalog = new CatalogService(docs);
  const storage = new StorageService();
  const proto = new PrototypeService(docs, catalog, storage, policy);
  const pages = new PrototypePagesService(docs, storage); // 无 AI_PROVIDER → mock 降级
  resetCommands();
  reqDocs.onModuleInit(); // rtm.rebuild（设计册提交后的反向派生重建依赖）
  docs.onModuleInit();
  catalog.onModuleInit();
  proto.onModuleInit();
  pages.onModuleInit();

  let plan1: { planId: string; fingerprint: string };
  let plan2: { planId: string; fingerprint: string };

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'proto-refs-test') ON CONFLICT (id) DO NOTHING", [PID]);
    await reqDocs.listDocs(PID, CTX); // CRD/PRD 模板自举
    await docs.listDocs(PID, CTX); // 设计八册模板自举（ui 册 v1 模板无页面章节）
    // PRD：REQ-001/002 → plan 回退分支（ui 册未定稿）一页一章
    let dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: 's0',
      md: '产品需求\n\n## REQ-001 门户首页\n\n门户首页需求。\n\n## REQ-002 检索列表\n\n检索列表需求。',
      baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint,
    }, CTX);
    dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'PRD 初稿', dp.cur, CTX);
    await reqDocs.finalize(PID, 'prd', 2, 2, true, CTX);
    plan1 = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
  });

  afterAll(async () => {
    await query('DELETE FROM dsg_prototype_pages WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_catalog_refs WHERE item_id IN (SELECT id FROM dsg_catalog_items WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_catalog_items WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_prototype_checks WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_baselines WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_plans WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
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

  it('① 新旧目录判别式：无 ui refs 的旧目录不检 页有册无/册有页无', async () => {
    const cnt = await query<{ n: string }>(
      `SELECT count(*) AS n FROM dsg_catalog_refs r JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND r.ref_kind='ui'`, [PID]);
    expect(cnt.rows[0]!.n).toBe('0');
    const g = (await proto.generate(PID, plan1.planId, plan1.fingerprint, CTX)) as { prototypeVersionId: string };
    const chk = (await proto.check(PID, g.prototypeVersionId, CTX)) as {
      status: string; issues: Array<{ code: string }>;
    };
    expect(chk.status).toBe('pass');
    expect(chk.issues.filter((i) => i.code === 'UI_SECTION_UNMAPPED' || i.code === 'PAGE_UI_UNMAPPED')).toEqual([]);
  });

  it('② ui 册定稿后 re-plan：落 ref_kind=ui 引用（锚点/快照/指纹）+ P-HOME 骨架页自动豁免', async () => {
    await commitUi(docs, [
      'UI 设计',
      '',
      '## u-1 门户首页（页面）',
      '',
      '承接 REQ-001。布局：顶部导航 + 指标卡。',
      '',
      '## u-2 检索列表界面',
      '',
      '承接 REQ-002。表格 + 筛选。',
    ].join('\n'), 'UI v2');
    await docs.finalize(PID, 'ui', 2, 2, true, false, CTX);
    plan2 = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };

    const refs = await query<{ code: string; doc_kind: string; section_id: string; anchor: string; rule_text: string; ref_fingerprint: string }>(
      `SELECT i.code, r.doc_kind, r.section_id, r.anchor, r.rule_text, r.ref_fingerprint
       FROM dsg_catalog_refs r JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND r.ref_kind='ui' ORDER BY i.code`, [PID]);
    expect(refs.rows.map((r) => r.code)).toEqual(['P-001', 'P-002']);
    expect(refs.rows[0]).toMatchObject({ doc_kind: 'ui', anchor: 'u-1 门户首页（页面）' });
    expect(refs.rows[0]!.rule_text).toContain('顶部导航');
    expect(refs.rows[0]!.ref_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const home = await query<{ payload: { exempt?: boolean } }>(
      `SELECT payload FROM dsg_catalog_items
       WHERE project_id=$1 AND catalog_version=(SELECT max(catalog_version) FROM dsg_catalog_items WHERE project_id=$1)
         AND code='P-HOME'`, [PID]);
    expect(home.rows[0]!.payload.exempt).toBe(true);
    const p1 = await query<{ payload: { reqIds?: string[] } }>(
      `SELECT payload FROM dsg_catalog_items
       WHERE project_id=$1 AND catalog_version=(SELECT max(catalog_version) FROM dsg_catalog_items WHERE project_id=$1)
         AND code='P-001'`, [PID]);
    expect(p1.rows[0]!.payload.reqIds).toContain('REQ-001');
  });

  it('③ 时间基滞后：ui 册新提交 → 状态查询 uiStale + PROTOTYPE_DIRTY 门禁 → 页重生成解脏 → 再汇总全清', async () => {
    // 生成 P-001（mock）+ 汇总，作为干净起点
    const st0 = await pages.start(PID, 'P-001', '', CTX);
    await pages.drive(st0.operationId, CTX, () => {});
    await proto.generate(PID, plan2.planId, plan2.fingerprint, CTX);
    let st = (await proto.status(PID)) as unknown as StatusView;
    expect(st.pages.find((p) => p.code === 'P-001')).toMatchObject({ uiStale: false });
    expect(st.pages.find((p) => p.code === 'P-001')!.uiRef).toMatchObject({ anchor: 'u-1 门户首页（页面）' });

    // 页生成时刻回拨 → ui 册新提交（v3，submitted_at=now）必然晚于页 updated_at
    await query("UPDATE dsg_prototype_pages SET updated_at = now() - interval '2 hours' WHERE project_id=$1 AND page_code='P-001'", [PID]);
    await docs.unlock(PID, 'ui', CTX);
    const dv = (await docs.getDoc(PID, 'ui')) as unknown as DocView;
    const sec1 = dv.secs.find((s) => s.title.includes('u-1'))!;
    await docs.saveDraft(PID, 'ui', {
      secId: sec1.id, md: '承接 REQ-001。布局改版：侧栏导航 + 图表卡。',
      baseVersion: dv.cur, baseFingerprint: dv.contentFingerprint,
    }, CTX);
    await docs.commit(PID, 'ui', 'UI v3 改版', dv.cur, CTX);

    st = (await proto.status(PID)) as unknown as StatusView;
    expect(st.pages.find((p) => p.code === 'P-001')!.uiStale).toBe(true);
    expect(st.pages.find((p) => p.code === 'P-002')!.uiStale).toBe(false); // 未生成的页不标滞后
    expect(st.uiStalePages).toContain('P-001');
    // I-1：check 门禁不拦时间基滞后（降级为报告内 issue，见 ④）；finalize 保留硬门禁
    const gc = (await proto.gates(PID, 'check')) as GateView;
    expect(gc.issues.filter((i) => i.message.includes('已变更'))).toEqual([]);
    const gf = (await proto.gates(PID, 'finalize')) as GateView;
    expect(gf.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === 'P-001' && i.message.includes('已变更'))).toBe(true);

    // 重生成该页 → updated_at 刷新 → 滞后解脏
    const st1 = await pages.start(PID, 'P-001', '', CTX);
    await pages.drive(st1.operationId, CTX, () => {});
    st = (await proto.status(PID)) as unknown as StatusView;
    expect(st.pages.find((p) => p.code === 'P-001')!.uiStale).toBe(false);
    const gc2 = (await proto.gates(PID, 'check')) as GateView;
    expect(gc2.issues.filter((i) => i.message.includes('已变更'))).toEqual([]);

    // 再汇总 → 滞后类 DIRTY 全清
    await proto.generate(PID, plan2.planId, plan2.fingerprint, CTX);
    const gc3 = (await proto.gates(PID, 'check')) as GateView;
    expect(gc3.issues.filter((i) => i.code === 'PROTOTYPE_DIRTY')).toEqual([]);
  });

  it('④ 双向一致性+滞后同报：ui 册变更后 check 可跑（报告同时含 UNMAPPED 与滞后 issue）；finalize 仍硬拦', async () => {
    // ui v4 增「u-3 设置页面」章节（无对应目录页）；不回拨时间——v4 submitted_at 晚于 P-001 updated_at，天然带滞后
    const dv = (await docs.getDoc(PID, 'ui')) as unknown as DocView;
    await docs.saveDraft(PID, 'ui', {
      secId: 's0', md: 'UI 设计\n\n## u-3 设置页面\n\n设置页（无目录页承接）。',
      baseVersion: dv.cur, baseFingerprint: dv.contentFingerprint,
    }, CTX);
    await docs.commit(PID, 'ui', 'UI v4 增设置页', dv.cur, CTX);
    // ③解锁后 final 落空——重新定稿使 v4 成为 plan uiSecs 分支的读取源
    await docs.finalize(PID, 'ui', 4, 4, true, false, CTX);

    const ver = await query<{ current_version_id: string }>(
      "SELECT current_version_id FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype'", [PID]);
    // I-1 新口径：check 可跑（滞后不拦门禁），报告同时含 册有页无 + 时间基滞后
    const chk = (await proto.check(PID, ver.rows[0]!.current_version_id, CTX)) as {
      status: string; issues: Array<{ code: string; target: string; message: string }>;
    };
    expect(chk.status).toBe('fail');
    expect(chk.issues.some((i) => i.code === 'UI_SECTION_UNMAPPED' && i.target.includes('设置页面'))).toBe(true);
    expect(chk.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === 'P-001' && i.message.includes('已变更'))).toBe(true);
    expect(chk.issues.filter((i) => i.code === 'PAGE_UI_UNMAPPED')).toEqual([]); // P-001/P-002 有 ref，P-HOME 已豁免
    // I-1：finalize 保留时间基滞后硬门禁
    const gf = (await proto.gates(PID, 'finalize')) as GateView;
    expect(gf.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === 'P-001' && i.message.includes('已变更'))).toBe(true);

    // 人工补充页（无 ui ref、未豁免）→ 页有册无检出
    await catalog.addItem(PID, { itemType: 'page', code: 'P-CUSTOM', title: '自定义页' }, CTX);
    const chk2 = (await proto.check(PID, ver.rows[0]!.current_version_id, CTX)) as {
      issues: Array<{ code: string; target: string }>;
    };
    expect(chk2.issues.some((i) => i.code === 'PAGE_UI_UNMAPPED' && i.target === 'P-CUSTOM')).toBe(true);
  });

  it('⑤ re-plan 随行扩：派生条目的 payload.steps/exempt 人工修改按 type+code 迁移保留', async () => {
    // 模拟 update-item（Task 5 命令落地前的人工修改通道）：直接改写当前目录版本派生条目 payload
    await query(
      `UPDATE dsg_catalog_items SET payload = jsonb_set(payload, '{steps}', '["自定义步骤A","自定义步骤B"]')
       WHERE project_id=$1 AND item_type='flow' AND code='F-001'
         AND catalog_version=(SELECT max(catalog_version) FROM dsg_catalog_items WHERE project_id=$1)`, [PID]);
    await query(
      `UPDATE dsg_catalog_items SET payload = jsonb_set(payload, '{exempt}', 'true')
       WHERE project_id=$1 AND item_type='page' AND code='P-002'
         AND catalog_version=(SELECT max(catalog_version) FROM dsg_catalog_items WHERE project_id=$1)`, [PID]);

    await catalog.plan(PID, CTX); // re-plan：ui 册现行 3 页面章节 → P-001/P-002/P-003
    const cur = await query<{ v: string }>(
      'SELECT max(catalog_version) AS v FROM dsg_catalog_items WHERE project_id=$1', [PID]);
    const items = await query<{ item_type: string; code: string; payload: Record<string, unknown>; source: string }>(
      'SELECT item_type, code, payload, source FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2',
      [PID, cur.rows[0]!.v]);
    const flow = items.rows.find((i) => i.code === 'F-001')!;
    expect(flow.payload.steps).toEqual(['自定义步骤A', '自定义步骤B']);
    const p2 = items.rows.find((i) => i.code === 'P-002')!;
    expect(p2.payload.exempt).toBe(true);
    // W7-002 既有口径不回归：人工条目整条目随行
    expect(items.rows.some((i) => i.code === 'P-CUSTOM' && i.source === 'manual')).toBe(true);
    // 新目录版本对 ui 册现行三页面章节全量建 ref
    const refs = await query<{ code: string }>(
      `SELECT i.code FROM dsg_catalog_refs r JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND i.catalog_version=$2 AND r.ref_kind='ui' ORDER BY i.code`, [PID, cur.rows[0]!.v]);
    expect(refs.rows.map((r) => r.code)).toEqual(['P-001', 'P-002', 'P-003']);
  });

  it('⑥ S-1 终审修法：编辑目录后 check 报告仍含时间基滞后 issue（版本口径=plan 锁定目录版本）', async () => {
    // 干净起点：P-001 生成（plan3 目录版本）+ 汇总
    const plan3 = (await query<{ id: string; plan_fingerprint: string }>(
      'SELECT id, plan_fingerprint FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [PID])).rows[0]!;
    const st0 = await pages.start(PID, 'P-001', '', CTX);
    await pages.drive(st0.operationId, CTX, () => {});
    const g = (await proto.generate(PID, plan3.id, `sha256:${plan3.plan_fingerprint}`, CTX)) as { prototypeVersionId: string };
    // 页生成时刻回拨 + ui 册新提交（章节集不变，只改正文——不引入 UNMAPPED 干扰）；
    // ui 册在 ④ 已定稿，须先解锁再改；改完再定稿使 ⑦ 的 re-plan 仍走 uiSecs 分支（refs 链不断）
    await query("UPDATE dsg_prototype_pages SET updated_at = now() - interval '2 hours' WHERE project_id=$1 AND page_code='P-001'", [PID]);
    await docs.unlock(PID, 'ui', CTX);
    await commitUi(docs, [
      'UI 设计', '',
      '## u-1 门户首页（页面）', '', '承接 REQ-001。布局：顶部导航 + 指标卡（v5 微调）。', '',
      '## u-2 检索列表界面', '', '承接 REQ-002。表格 + 筛选。', '',
      '## u-3 设置页面', '', '设置页（无目录页承接）。',
    ].join('\n'), 'UI v5');
    await docs.finalize(PID, 'ui', 5, 5, true, false, CTX);
    // 编辑目录（update-item 即产新目录版本 → current≠plan 锁定版本，S-1 旧口径下滞后段空转）
    const cat = (await catalog.getCatalog(PID)) as { groups: Record<string, Array<{ itemId: string; code: string }>> };
    await catalog.updateItem(PID, cat.groups.flow![0]!.itemId, { note: 'S-1 回归：编辑目录' }, CTX);
    const chk = (await proto.check(PID, g.prototypeVersionId, CTX)) as {
      issues: Array<{ code: string; target: string; message: string }>;
    };
    expect(chk.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === 'P-001' && i.message.includes('已变更'))).toBe(true);
  });

  it('⑦ S-2 终审修法：check 通过后编辑目录 → finalize 门禁 CHECK_STALE 强制重跑 check', async () => {
    // 清场：移除 P-CUSTOM（manual 条目无 ui ref 未豁免会 PAGE_UI_UNMAPPED，干扰 pass 态）→ re-plan → 生成+汇总+check pass
    const cat0 = (await catalog.getCatalog(PID)) as { groups: Record<string, Array<{ itemId: string; code: string; source: string }>> };
    const custom = (cat0.groups.page ?? []).find((p) => p.code === 'P-CUSTOM');
    if (custom) await catalog.removeItem(PID, custom.itemId, CTX);
    const plan4 = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    const st0 = await pages.start(PID, 'P-001', '', CTX);
    await pages.drive(st0.operationId, CTX, () => {});
    const g = (await proto.generate(PID, plan4.planId, plan4.fingerprint, CTX)) as { prototypeVersionId: string };
    const chk1 = (await proto.check(PID, g.prototypeVersionId, CTX)) as { status: string };
    expect(chk1.status).toBe('pass');
    const gf0 = (await proto.gates(PID, 'finalize')) as GateView;
    expect(gf0.issues.filter((i) => i.code === 'CHECK_STALE')).toEqual([]);

    // 编辑目录（update-item 产新目录版本）→ 不重跑 check → finalize 门禁亮 CHECK_STALE
    const cat1 = (await catalog.getCatalog(PID)) as { groups: Record<string, Array<{ itemId: string }>> };
    await catalog.updateItem(PID, cat1.groups.flow![0]!.itemId, { note: 'S-2 回归：改后未重跑检查' }, CTX);
    const gf1 = (await proto.gates(PID, 'finalize')) as GateView;
    expect(gf1.issues.some((i) => i.code === 'CHECK_STALE' && i.message.includes('目录'))).toBe(true);

    // 重跑 check → 指纹重新对齐 → CHECK_STALE 解除
    const chk2 = (await proto.check(PID, g.prototypeVersionId, CTX)) as { status: string };
    expect(chk2.status).toBe('pass');
    const gf2 = (await proto.gates(PID, 'finalize')) as GateView;
    expect(gf2.issues.filter((i) => i.code === 'CHECK_STALE')).toEqual([]);
  });
});
