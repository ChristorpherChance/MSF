/**
 * design.catalog.update-item（设计覆盖检测与可交互原型 §2/§3，需 DB+MinIO）：
 * ① 字段修订（title/note/steps/exempt）改即新 catalog_version——旧版本行不变、
 *    追溯引用按 type+code 随行迁移、未授权字段（reqIds/route）原值保留、审计留痕；
 * ② exempt 切换：true 落键 / false 删键（豁免口径只看 payload.exempt===true）；
 * ③ 白名单闸：未知字段/空 steps 元素/零可改字段 → VALIDATION_FAILED；不存在条目 → NOT_FOUND；
 * ④ re-plan 幂等复用+页工件 reconcile（2026-10-17 根修）：内容零变化 re-plan 不产新目录版本、
 *    孤儿页工件随行自愈；④b 移除页工件行清除/页 payload 已变不继承（门禁引导重生成）。
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

// e2e PID 注册表（共享库并行跑，撞 PID=FK 级联整组炸，新增套件先查再占）：
// e1~e9+f0~ff+d1~d6 已占用（registry 总表见 rtm-deferred.e2e.test.ts 顶部）；本套件占 d7。
const PID = '00000000-0000-0000-0000-0000000000d7';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dsg_catalog_items LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

interface DocView { cur: number; contentFingerprint: string }
interface CatalogView {
  catalogVersion: string;
  groups: Record<string, Array<{ itemId: string; code: string; payload: Record<string, unknown>; source: string }>>;
}

describe('catalog.update-item（集成，需 DB+MinIO）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  const policy = new PolicyService();
  const reqDocs = new ReqDocsService(policy);
  const docs = new DesignDocsService();
  const catalog = new CatalogService(docs);
  const proto = new PrototypeService(docs, catalog, new StorageService(), policy);
  resetCommands();
  reqDocs.onModuleInit();
  docs.onModuleInit();
  catalog.onModuleInit();
  proto.onModuleInit();

  let planV: { planId: string; fingerprint: string };
  let flowId = '';
  let pageId = '';

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'catalog-update-test') ON CONFLICT (id) DO NOTHING", [PID]);
    await reqDocs.listDocs(PID, CTX); // CRD/PRD 模板自举
    await docs.listDocs(PID, CTX);
    let dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: 's0',
      md: '产品需求\n\n## REQ-001 门户首页\n\n门户首页需求。\n\n## REQ-002 检索列表\n\n检索列表需求。',
      baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint,
    }, CTX);
    dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'PRD 初稿', dp.cur, CTX);
    await reqDocs.finalize(PID, 'prd', 2, 2, true, CTX);
    planV = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    const cat = (await catalog.getCatalog(PID)) as CatalogView;
    flowId = cat.groups.flow!.find((i) => i.code === 'F-001')!.itemId;
    pageId = cat.groups.page!.find((i) => i.code === 'P-001')!.itemId;
  });

  afterAll(async () => {
    await query('DELETE FROM dsg_prototype_pages WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_catalog_refs WHERE item_id IN (SELECT id FROM dsg_catalog_items WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_catalog_items WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_prototype_checks WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_baselines WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_plans WHERE project_id=$1', [PID]);
    await query('DELETE FROM audit_log WHERE project_id=$1', [PID]);
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

  it('① 流程步骤+标题修订：改即新目录版本、旧版本行不变、refs 随行、识别字段保留、审计留痕', async () => {
    const oldFlow = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version='V3-1' AND code='F-001'`, [PID]);
    const refsBefore = await query<{ n: string }>(
      `SELECT count(*) AS n FROM dsg_catalog_refs r JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND i.catalog_version='V3-1'`, [PID]);

    const r = (await catalog.updateItem(PID, flowId, {
      title: '主流程（修订）', note: '人工修订', steps: ['打开门户首页', '提交检索'],
    }, CTX)) as { itemId: string; catalogVersion: string };
    expect(r.catalogVersion).toBe('V3-2');

    // 新版本：steps/title/note 已改，reqIds/route 等识别字段原值保留（flow 无 reqIds——以 page 验证见 ②）
    const cat = (await catalog.getCatalog(PID)) as CatalogView;
    expect(cat.catalogVersion).toBe('V3-2');
    const flow = cat.groups.flow!.find((i) => i.code === 'F-001')!;
    expect(flow.payload).toMatchObject({ title: '主流程（修订）', note: '人工修订', steps: ['打开门户首页', '提交检索'] });
    // 旧版本行不变（目录版本化自包含）
    const oldFlowAfter = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version='V3-1' AND code='F-001'`, [PID]);
    expect(oldFlowAfter.rows[0]!.payload).toEqual(oldFlow.rows[0]!.payload);
    // 追溯引用按 type+code 随行迁移到新版本（审计链不断）
    const refsAfter = await query<{ n: string }>(
      `SELECT count(*) AS n FROM dsg_catalog_refs r JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND i.catalog_version='V3-2'`, [PID]);
    expect(refsAfter.rows[0]!.n).toBe(refsBefore.rows[0]!.n);
    // 审计留痕（命令事务内 appendAudit）
    const audit = await query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE project_id=$1 AND command='design.catalog.update-item'`, [PID]);
    expect(audit.rows[0]!.n).toBe('1');
  });

  it('② exempt 切换：true 落键、false 删键；page 识别字段 reqIds/route 不被改丢；旧版本 itemId 不滚回中间修订', async () => {
    // pageId 取自 beforeAll 的 V3-1——钉「旧版本 itemId 照旧生效且复制源=当前版本」：
    // 若复制源错用 row.catalog_version（V3-1），① 落在 V3-2 的 F-001 steps 修订会被静默回滚
    const r1 = (await catalog.updateItem(PID, pageId, { exempt: true }, CTX)) as { catalogVersion: string };
    expect(r1.catalogVersion).toBe('V3-3');
    let cat = (await catalog.getCatalog(PID)) as CatalogView;
    let p1 = cat.groups.page!.find((i) => i.code === 'P-001')!;
    expect(p1.payload.exempt).toBe(true);
    expect(p1.payload.reqIds).toEqual(['REQ-001']); // 识别字段保留
    expect(p1.payload.route).toBe('/p1');
    expect(cat.groups.flow!.find((i) => i.code === 'F-001')!.payload.steps).toEqual(['打开门户首页', '提交检索']); // ① 修订不丢

    const r2 = (await catalog.updateItem(PID, p1.itemId, { exempt: false }, CTX)) as { catalogVersion: string };
    expect(r2.catalogVersion).toBe('V3-4');
    cat = (await catalog.getCatalog(PID)) as CatalogView;
    p1 = cat.groups.page!.find((i) => i.code === 'P-001')!;
    expect('exempt' in p1.payload).toBe(false); // false 删键而非存 false
  });

  it('③ 白名单闸：未知字段/空步骤元素/零可改字段/steps 类型错位拒绝；不存在条目 NOT_FOUND', async () => {
    const cat = (await catalog.getCatalog(PID)) as CatalogView;
    const flow = cat.groups.flow!.find((i) => i.code === 'F-001')!;
    await expect(catalog.updateItem(PID, flow.itemId, { reqIds: ['REQ-009'] } as never, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(catalog.updateItem(PID, flow.itemId, { steps: ['ok', '  '] }, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(catalog.updateItem(PID, flow.itemId, {}, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // T7 Minor 折入：steps 仅 flow 可改——page 条目带 steps 一律拒绝（防语义错位/静默吞字段）
    const page = cat.groups.page!.find((i) => i.code === 'P-001')!;
    await expect(catalog.updateItem(PID, page.itemId, { steps: ['x'] }, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', target: 'steps' });
    await expect(catalog.updateItem(PID, '00000000-0000-0000-0000-000000000099', { title: 'x' }, CTX))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 拒绝零写：目录版本不前进（当前 V3-4——幂等复用后版本序列见 ④）
    const cat2 = (await catalog.getCatalog(PID)) as CatalogView;
    expect(cat2.catalogVersion).toBe('V3-4');
  });

  it('④ re-plan 幂等复用+页工件 reconcile 自愈（2026-10-17 根修「re-plan 后全部页面变未生成」）', async () => {
    // 汇总钉在 planV 锁定的目录版本（V3-1）；页行登记 V3-1
    await proto.generate(PID, planV.planId, planV.fingerprint, CTX);
    await query(
      `INSERT INTO dsg_prototype_pages (project_id, page_code, catalog_version, object_key, html_fingerprint, source, created_by)
       VALUES ($1, 'P-001', 'V3-1', 'test/p001.html', 'fp-old', 'mock', 'local')`, [PID]);
    // ①~③ 编辑后当前目录 V3-4；re-plan 派生与 V3-4 逐条全同（人工 steps 随行）→ 幂等复用，不产 V3-5
    await catalog.plan(PID, CTX);
    const cat = (await catalog.getCatalog(PID)) as CatalogView;
    expect(cat.catalogVersion).toBe('V3-4');
    const plans = await query<{ n: string }>('SELECT count(*) AS n FROM dsg_plans WHERE project_id=$1', [PID]);
    expect(plans.rows[0]!.n).toBe('2'); // plan 登记照走（governing 重锚），只是不消耗目录版本号
    // 孤儿页工件自愈：P-001 payload 未变 → 随行升级到 V3-4
    const row = await query<{ catalog_version: string }>(
      'SELECT catalog_version FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, 'P-001']);
    expect(row.rows[0]!.catalog_version).toBe('V3-4');
    // 检查门禁：不再报「目录版本已过期」（「已更新未汇总」属正常引导——汇总早于页行登记）
    const g = (await proto.gates(PID, 'check')) as { issues: Array<{ code: string; message: string; target?: string }> };
    expect(g.issues.some((i) => i.message.includes('目录版本已过期'))).toBe(false);
    // re-plan 随行口径不回归：F-001 的人工 steps 按 type+code 迁移进新目录版本
    expect(cat.groups.flow!.find((i) => i.code === 'F-001')!.payload.steps).toEqual(['打开门户首页', '提交检索']);
  });

  it('④b reconcile 两翼：移除页工件行清除（防永久卡死）；页 payload 已变不继承（门禁引导重生成）', async () => {
    // reconcile 只在 plan 事务跑（页工件追踪「最新 plan 锁定的目录版本」而非最新目录版本，
    // 否则 update-item 把页行推前于 plan 版本 → 门禁自报「目录版本已过期」——原型套件 ④⑥⑦/⑧ 回归线）
    // 加人工页 P-CUSTOM（V3-5）并造工件行；P-001 行仍在 ④ 随行后的 V3-4
    const added = (await catalog.addItem(PID, { itemType: 'page', code: 'P-CUSTOM', title: '人工页' }, CTX)) as { itemId: string };
    await query(
      `INSERT INTO dsg_prototype_pages (project_id, page_code, catalog_version, object_key, html_fingerprint, source, created_by)
       VALUES ($1, 'P-CUSTOM', 'V3-5', 'test/pcustom.html', 'fp-custom', 'mock', 'local')`, [PID]);
    // re-plan：人工条目随行 → 幂等复用 V3-5；reconcile 把 P-001 V3-4→V3-5
    await catalog.plan(PID, CTX);
    let p1 = await query<{ catalog_version: string }>(
      'SELECT catalog_version FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, 'P-001']);
    expect(p1.rows[0]!.catalog_version).toBe('V3-5'); // plan reconcile 随行
    // 删除 P-CUSTOM（V3-6）+ re-plan 复用 → 其工件行清除（残留行会被门禁判「目录版本已过期」且永不可再生=永久卡死）
    await catalog.removeItem(PID, added.itemId, CTX);
    await catalog.plan(PID, CTX);
    const gone = await query<{ n: string }>(
      'SELECT count(*) AS n FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, 'P-CUSTOM']);
    expect(gone.rows[0]!.n).toBe('0');
    p1 = await query<{ catalog_version: string }>(
      'SELECT catalog_version FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, 'P-001']);
    expect(p1.rows[0]!.catalog_version).toBe('V3-6'); // 未变页继续随行
    // P-001 标题修订（V3-7）+ re-plan 复用（title 随行）→ 工件行 payload 指纹变不继承，门禁引导「重新生成并汇总」
    const cat6 = (await catalog.getCatalog(PID)) as CatalogView;
    const p1Id = cat6.groups.page!.find((i) => i.code === 'P-001')!.itemId;
    await catalog.updateItem(PID, p1Id, { title: '门户首页·改' }, CTX);
    await catalog.plan(PID, CTX);
    p1 = await query<{ catalog_version: string }>(
      'SELECT catalog_version FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, 'P-001']);
    expect(p1.rows[0]!.catalog_version).toBe('V3-6');
    const g = (await proto.gates(PID, 'check')) as { issues: Array<{ code: string; message: string; target?: string }> };
    expect(g.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === 'P-001' && i.message.includes('目录版本已过期'))).toBe(true);
  });

  it('⑤ I-1 回归：body 携带异项目 projectId/itemId 键不得覆盖路径归属（写+审计都落 path 项目）', async () => {
    const ROGUE = '00000000-0000-0000-0000-000000000099';
    const cat0 = (await catalog.getCatalog(PID)) as CatalogView;
    const flow = cat0.groups.flow!.find((i) => i.code === 'F-001')!;
    const auditCnt = async () => Number((await query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE project_id=$1 AND command='design.catalog.update-item'`, [PID])).rows[0]!.n);
    const before = await auditCnt();
    // 路径参数兜底在后：body 的 projectId/itemId 被丢弃，handler 读写仍按路径归属
    const r = (await catalog.updateItem(PID, flow.itemId,
      { title: '主流程（终审）', projectId: ROGUE, itemId: ROGUE } as never, CTX)) as { catalogVersion: string };
    expect(r.catalogVersion).toBe('V3-8');
    const cat = (await catalog.getCatalog(PID)) as CatalogView;
    expect(cat.catalogVersion).toBe('V3-8');
    expect(cat.groups.flow!.find((i) => i.code === 'F-001')!.payload.title).toBe('主流程（终审）');
    // 审计归属 path 项目（本次调用恰新增一条；异项目侧零留痕零落行）
    expect(await auditCnt()).toBe(before + 1);
    const rogueAudit = await query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_log WHERE project_id=$1', [ROGUE]);
    expect(rogueAudit.rows[0]!.n).toBe('0');
    const rogueItems = await query<{ n: string }>(
      'SELECT count(*) AS n FROM dsg_catalog_items WHERE project_id=$1', [ROGUE]);
    expect(rogueItems.rows[0]!.n).toBe('0');
  });
});
