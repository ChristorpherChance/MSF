/** 页级原型集成测试（需 DB+MinIO；dsg_prototype_pages 补充表 + 汇总/滞后门禁/preview 分流/真接 stub，差异登记） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { executeCommand, resetCommands } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { AiUsageService } from '../ai/usage.service.js';
import type { AiProvider } from '../ai/ai-provider.interface.js';
import { ReqDocsService } from '../req/docs.service.js';
import { DesignDocsService } from './docs.service.js';
import { CatalogService } from './catalog.service.js';
import { PrototypeService } from './prototype.service.js';
import { PrototypePagesService } from './prototype-pages.service.js';
import { ProtoThemesService } from './proto-themes.service.js';
import { buildThemeCss, wrapPageEnvelope } from './prototype-pages.js';

// fb：与 test.integration.test.ts 的 f4 撞车隔离（共享 PID 并发跑全量套件互踩，单跑均绿）
const PID = '00000000-0000-0000-0000-0000000000fb';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };
const MODEL_ID = '00000000-0000-0000-0000-00000000aa24';

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dsg_documents LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

interface DocView {
  cur: number; modified: boolean; finalized: boolean; contentFingerprint: string;
  secs: Array<{ id: string; title: string; md: string; pending: string | null }>;
}

/** 指定 AiProvider 的 stub（kind:'pi'，stream 吐固定文本） */
function stubAi(text: string, modelId?: string): AiProvider {
  return {
    kind: 'pi',
    createSession: async () => ({
      sessionId: 'stub',
      stream: () => ({
        deltas: (async function* () { yield text; })(),
        result: Promise.resolve({ text, usage: { inputTokens: 10, outputTokens: 20 }, ...(modelId ? { modelId } : {}) }),
      }),
      steer: () => {},
      stop: () => {},
    }),
  };
}

describe('PrototypePages 页级原型（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
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
  const themes = new ProtoThemesService();
  const usage = new AiUsageService();
  resetCommands();
  reqDocs.onModuleInit();
  docs.onModuleInit();
  catalog.onModuleInit();
  proto.onModuleInit();
  pages.onModuleInit();
  themes.onModuleInit();
  usage.onModuleInit();

  let planId = '';
  let planFp = '';
  let pageCodes: string[] = [];
  let stateCodes: string[] = [];

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'pgen-pages-test') ON CONFLICT (id) DO NOTHING", [PID]);
    await query(
      `INSERT INTO ai_models (id, name, provider, base_url, model_code, created_by)
       VALUES ($1,'pgen-stub','gateway','http://127.0.0.1:9','mstub','t') ON CONFLICT (id) DO NOTHING`, [MODEL_ID]);
    await reqDocs.listDocs(PID, CTX); // 自举 CRD/PRD 模板
    // PRD：两条 REQ + DSG 锚点 → plan 识别出页面目录
    const rp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: 's0',
      md: '产品需求\n\n## REQ-001 门户首页\n\n承接：CR-001\n\n设计锚点：DSG-U03-2\n\n## REQ-002 检索列表\n\n承接：CR-001\n\n设计锚点：DSG-U03-2',
      baseVersion: rp.cur, baseFingerprint: rp.contentFingerprint,
    }, CTX);
    const rp2 = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'PRD 初稿', rp2.cur, CTX);
    await reqDocs.finalize(PID, 'prd', 2, 2, true, CTX);
    const plan = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    planId = plan.planId;
    planFp = plan.fingerprint;
    const cat = (await catalog.getCatalog(PID)) as {
      groups: Record<string, Array<{ code: string }>>;
    };
    pageCodes = (cat.groups.page ?? []).map((p) => p.code);
    stateCodes = (cat.groups.state ?? []).map((s) => s.code);
    expect(pageCodes.length).toBeGreaterThanOrEqual(3); // REQ-001/002 + P-HOME
  });
  afterAll(async () => {
    await query('DELETE FROM ai_usage WHERE project_id=$1', [PID]);
    await query('DELETE FROM ai_models WHERE id=$1', [MODEL_ID]);
    await query("DELETE FROM proto_themes WHERE name LIKE 'it-theme-%'", []);
    await query('DELETE FROM dsg_prototype_pages WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_proto_page_proposals WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_catalog_refs WHERE item_id IN (SELECT id FROM dsg_catalog_items WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_catalog_items WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_prototype_checks WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_baselines WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_plans WHERE project_id=$1', [PID]);
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
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  it('① mock 降级：页生成落行 + 对象存在 + 指纹一致 + source=mock', async () => {
    const code = pageCodes[0]!;
    const st = await pages.start(PID, code, '', CTX);
    expect(st.source).toBe('mock');
    let acc = '';
    const fin = await pages.drive(st.operationId, CTX, (t) => { acc += t; });
    expect(fin.status).toBe('done');
    expect(fin.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(acc).toContain('msf:body-begin');
    const row = await query<{ source: string; object_key: string; html_fingerprint: string }>(
      'SELECT * FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, code]);
    expect(row.rows[0]!.source).toBe('mock');
    expect(row.rows[0]!.html_fingerprint).toBe(fin.fingerprint);
    const obj = await storage.getObject(row.rows[0]!.object_key);
    expect(obj.toString('utf8')).toContain(`data-page-block="${code}"`);
  });

  it('② 并发去重：同页进行中再启动 → INVALID_STATE', async () => {
    const code = pageCodes[0]!;
    const s1 = await pages.start(PID, code, '', CTX);
    await expect(pages.start(PID, code, '', CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    pages.abort(s1.operationId);
    // 「✏️ 按意见调整」instruction 闸（2026-10-17 前端开放入参）：>1000 字 VALIDATION_FAILED；=1000 字放行
    await expect(pages.start(PID, code, 'x'.repeat(1001), CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', target: 'instruction' });
    const s2 = await pages.start(PID, code, 'x'.repeat(1000), CTX);
    pages.abort(s2.operationId);
  });

  it('③ 汇总：manifest 记录页对象/指纹、未生成页占位；status.pages 派生；preview 分流', async () => {
    const code = pageCodes[0]!;
    const other = pageCodes[1]!;
    const g = (await proto.generate(PID, planId, planFp, CTX)) as { prototypeVersionId: string; v: number };
    expect(g.v).toBe(1);
    const ver = await query<{ content: string; note: string }>('SELECT content, note FROM dsg_versions WHERE id=$1', [g.prototypeVersionId]);
    expect(ver.rows[0]!.note).toContain('原型汇总');
    const manifest = JSON.parse(ver.rows[0]!.content) as {
      pages: Array<{ code: string; objectKey?: string; fingerprint?: string; placeholder?: boolean }>;
    };
    expect(manifest.pages.find((p) => p.code === code)).toMatchObject({ source: 'mock' });
    expect(manifest.pages.find((p) => p.code === code)!.objectKey).toBeTruthy();
    expect(manifest.pages.find((p) => p.code === other)).toMatchObject({ placeholder: true });

    const st = (await proto.status(PID)) as {
      pages: Array<{ code: string; state: string }>; pagesStale: boolean;
    };
    expect(st.pages.find((p) => p.code === code)).toMatchObject({ state: 'assembled' });
    expect(st.pages.find((p) => p.code === other)).toMatchObject({ state: 'none' });
    expect(st.pagesStale).toBe(false);

    // preview：已生成页直签单页（无 #hash）；未生成页回落整份 + #hash；两路签名均带 content-type 覆盖（渲染而非下载）
    const p1 = (await proto.preview(PID, code)) as { previewUrl: string };
    expect(p1.previewUrl).not.toContain('#');
    expect(p1.previewUrl).toContain('response-content-type');
    const p2 = (await proto.preview(PID, other)) as { previewUrl: string };
    expect(p2.previewUrl).toContain(`#${encodeURIComponent(other)}`);
    expect(p2.previewUrl).toContain('response-content-type');
  });

  it('④ 页重生成 → check/finalize 门禁亮 PROTOTYPE_DIRTY（target=页码）→ 再汇总清除', async () => {
    const code = pageCodes[0]!;
    // mock 页确定性（同指纹不滞后）——真接形态下重生成产物不同才有滞后语义，用 stub 产出新版 HTML
    const sections = stateCodes.map((s) => `<section data-page="${code}" data-state="${s}">v2</section>`).join('');
    const v2 = wrapPageEnvelope(
      code, '首页', `#pg-${code} { color: blue; }`,
      `<div id="pg-${code}" data-page-block="${code}">${sections}</div>`, '(function(){})();',
    );
    const real = new PrototypePagesService(docs, storage, stubAi(v2));
    const st = await real.start(PID, code, '', CTX);
    await real.drive(st.operationId, CTX, () => {});
    const gc = (await proto.gates(PID, 'check')) as { ok: boolean; issues: Array<{ code: string; target?: string }> };
    expect(gc.ok).toBe(false);
    expect(gc.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === code)).toBe(true);
    const gf = (await proto.gates(PID, 'finalize')) as { issues: Array<{ code: string; target?: string }> };
    expect(gf.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === code)).toBe(true);

    // 再汇总（generate 门禁不吃滞后——它正是消除滞后的动作）→ 滞后清除 → check pass
    const g2 = (await proto.generate(PID, planId, planFp, CTX)) as { prototypeVersionId: string };
    const gc2 = (await proto.gates(PID, 'check')) as { ok: boolean; issues: Array<{ code: string }> };
    expect(gc2.issues.filter((i) => i.code === 'PROTOTYPE_DIRTY')).toEqual([]);
    const chk = (await proto.check(PID, g2.prototypeVersionId, CTX)) as { reportId: string; status: string };
    expect(chk.status).toBe('pass');

    // 定稿 → 页生成被 PROTOTYPE_FINALIZED 拦 → 解锁放行
    await proto.finalize(PID, g2.prototypeVersionId, chk.reportId, true, CTX);
    await expect(pages.start(PID, code, '', CTX)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await proto.unlock(PID, CTX);
    const st2 = await pages.start(PID, code, '', CTX);
    await pages.drive(st2.operationId, CTX, () => {});
  });

  it('⑤ 真接 stub：合规产物 source=model + ai.usage.record 落账；不合规产物重试后 VALIDATION_FAILED', async () => {
    const code = pageCodes[1]!;
    const sections = stateCodes.map((s) => `<section data-page="${code}" data-state="${s}">x</section>`).join('');
    const compliant = wrapPageEnvelope(
      code, '列表页',
      `#pg-${code} { color: red; }`,
      `<div id="pg-${code}" data-page-block="${code}">${sections}</div>`,
      '(function(){})();',
    );
    // 命令已注册（pages.onModuleInit），stub 服务不再 onModuleInit（重复注册拒绝）
    const real = new PrototypePagesService(docs, storage, stubAi(compliant, MODEL_ID));
    const st = await real.start(PID, code, '', CTX);
    expect(st.source).toBe('model');
    const fin = await real.drive(st.operationId, CTX, () => {});
    expect(fin.status).toBe('done');
    const row = await query<{ source: string }>(
      'SELECT source FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, code]);
    expect(row.rows[0]!.source).toBe('model');
    const use = await query(
      "SELECT 1 FROM ai_usage WHERE project_id=$1 AND model_id=$2 AND purpose='generation'", [PID, MODEL_ID]);
    expect(use.rowCount).toBeGreaterThan(0);

    // 不合规产物（无封装标记）→ 重试一次后 VALIDATION_FAILED
    const bad = new PrototypePagesService(docs, storage, stubAi('<html><body>no markers</body></html>'));
    const st2 = await bad.start(PID, pageCodes[2]!, '', CTX);
    const fin2 = await bad.drive(st2.operationId, CTX, () => {});
    expect(fin2.status).toBe('failed');
    expect(fin2.error).toBe('VALIDATION_FAILED');

    // 风格基线纪律（2026-10-17）：结构合规但页样式写死 hex 色 → VALIDATION_FAILED（配色必须 var(--p-*)）
    const hexSections = stateCodes.map((s) => `<section data-page="${code}" data-state="${s}">x</section>`).join('');
    const hexed = wrapPageEnvelope(
      code, '列表页',
      `#pg-${code} { color: #1f2937; }`,
      `<div id="pg-${code}" data-page-block="${code}">${hexSections}</div>`, '(function(){})();',
    );
    const hexSvc = new PrototypePagesService(docs, storage, stubAi(hexed));
    const st3 = await hexSvc.start(PID, code, '', CTX);
    const fin3 = await hexSvc.drive(st3.operationId, CTX, () => {});
    expect(fin3.status).toBe('failed');
    expect(fin3.error).toBe('VALIDATION_FAILED');
  });

  it('⑥ 页行存在但对象缺失：汇总回落占位不阻断（manifest warnings）', async () => {
    const code = pageCodes[0]!;
    await query(
      "UPDATE dsg_prototype_pages SET object_key='sha256/nonexistent-deadbeef' WHERE project_id=$1 AND page_code=$2",
      [PID, code]);
    const g = (await proto.generate(PID, planId, planFp, CTX)) as { prototypeVersionId: string };
    const ver = await query<{ content: string }>('SELECT content FROM dsg_versions WHERE id=$1', [g.prototypeVersionId]);
    const manifest = JSON.parse(ver.rows[0]!.content) as {
      pages: Array<{ code: string; placeholder?: boolean }>; warnings?: string[];
    };
    expect(manifest.pages.find((p) => p.code === code)).toMatchObject({ placeholder: true });
    expect(manifest.warnings?.some((w) => w.includes(code))).toBe(true);
  });

  it('⑦ data-nav 穿流契约校验（覆盖检测 §3）：目标非目录页码 → VALIDATION_FAILED；目标存在 → 落库', async () => {
    const code = pageCodes[1]!;
    const target = pageCodes[0]!;
    const sections = stateCodes.map((s) => `<section data-page="${code}" data-state="${s}">x</section>`).join('');
    const mk = (nav: string) => wrapPageEnvelope(
      code, '列表页', `#pg-${code} { color: red; }`,
      `<div id="pg-${code}" data-page-block="${code}">${sections}${nav}</div>`, '(function(){})();',
    );
    // 非法：目标页不在目录 → 重试一次后 VALIDATION_FAILED（问题描述透传给模型修正）
    const bad = new PrototypePagesService(docs, storage, stubAi(mk(`<a data-nav="#P-999">x</a>`)));
    const st1 = await bad.start(PID, code, '', CTX);
    const fin1 = await bad.drive(st1.operationId, CTX, () => {});
    expect(fin1.status).toBe('failed');
    expect(fin1.error).toBe('VALIDATION_FAILED');
    // 合法：页码+状态均在目录 → done，落库产物含 data-nav 委托脚本
    const good = new PrototypePagesService(docs, storage, stubAi(mk(`<a data-nav="#${target}">x</a><a data-nav="#${target}/${stateCodes[0]}">y</a>`)));
    const st2 = await good.start(PID, code, '', CTX);
    const fin2 = await good.drive(st2.operationId, CTX, () => {});
    expect(fin2.status).toBe('done');
    const row = await query<{ object_key: string }>(
      'SELECT object_key FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, code]);
    const obj = (await storage.getObject(row.rows[0]!.object_key)).toString('utf8');
    expect(obj).toContain(`data-nav="#${target}"`);
    expect(obj).toContain("closest('[data-nav]')");
  });

  it('⑧ flow 校验进 check + 汇总流程视图 + manifest 扩展（覆盖检测 §3）', async () => {
    // ⑥ 弄坏了 P-001 对象——mock 重生成修复（顺带让汇总产物带 mock 穿流按钮）
    const st0 = await pages.start(PID, pageCodes[0]!, '', CTX);
    await pages.drive(st0.operationId, CTX, () => {});
    const g3 = (await proto.generate(PID, planId, planFp, CTX)) as { prototypeVersionId: string; objectKey: string };
    // 汇总含流程视图：F-001 原始 steps=REQ 章节标题（旧格式）→ 纯文本步骤不挂 data-nav；
    // mock 页穿流按钮进 dataNavTargets 清单；manifest 含 flows 快照
    const obj3 = (await storage.getObject(g3.objectKey)).toString('utf8');
    expect(obj3).toContain('data-flow="F-001"');
    expect(obj3).toContain('<li class="msf-flow-step">REQ-001 门户首页</li>');
    expect(obj3).toContain(`data-nav="#${pageCodes[1]}"`); // P-001 mock 穿流按钮
    const ver3 = await query<{ content: string }>('SELECT content FROM dsg_versions WHERE id=$1', [g3.prototypeVersionId]);
    const manifest3 = JSON.parse(ver3.rows[0]!.content) as {
      flows?: Array<{ code: string; steps: string[] }>; dataNavTargets?: string[];
    };
    expect(manifest3.flows?.find((f) => f.code === 'F-001')?.steps).toContain('REQ-001 门户首页');
    expect(manifest3.dataNavTargets).toContain(`#${pageCodes[1]}`);

    // flow 新格式引用校验：存在 → check pass（旧格式 REQ 标题步骤不校验，兼容口径）
    const cat = (await catalog.getCatalog(PID)) as { groups: Record<string, Array<{ itemId: string; code: string }>> };
    const flowId = cat.groups.flow![0]!.itemId;
    const u1 = (await catalog.updateItem(PID, flowId, { steps: ['P-001', '#P-HOME/ST-empty', 'REQ-001 门户首页'] }, CTX)) as { itemId: string };
    const chk1 = (await proto.check(PID, g3.prototypeVersionId, CTX)) as { status: string; issues: Array<{ code: string }> };
    expect(chk1.status).toBe('pass');
    expect(chk1.issues.filter((i) => i.code === 'FLOW_REF_MISSING')).toEqual([]);
    // 引用不存在页面/状态 → FLOW_REF_MISSING 逐条报、check fail（拦定稿走 CHECK_REQUIRED 既有链）
    await catalog.updateItem(PID, u1.itemId, { steps: ['P-999', 'P-001/ST-nope'] }, CTX);
    const chk2 = (await proto.check(PID, g3.prototypeVersionId, CTX)) as { status: string; issues: Array<{ code: string; message: string }> };
    expect(chk2.status).toBe('fail');
    expect(chk2.issues.filter((i) => i.code === 'FLOW_REF_MISSING')).toHaveLength(2);

    // 步骤改回合法引用 → re-plan（随行保留人工 steps）→ 重新汇总：新格式步骤渲染为可点 data-nav
    const cat2 = (await catalog.getCatalog(PID)) as { groups: Record<string, Array<{ itemId: string; code: string }>> };
    await catalog.updateItem(PID, cat2.groups.flow![0]!.itemId, { steps: ['P-001'] }, CTX);
    const plan2 = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    const g4 = (await proto.generate(PID, plan2.planId, plan2.fingerprint, CTX)) as { prototypeVersionId: string; v: number; objectKey: string };
    const ver4 = await query<{ content: string }>('SELECT content FROM dsg_versions WHERE id=$1', [g4.prototypeVersionId]);
    const obj4 = (await storage.getObject(g4.objectKey)).toString('utf8');
    expect(obj4).toContain('data-nav="#P-001"');
    const manifest4 = JSON.parse(ver4.rows[0]!.content) as { flows?: Array<{ code: string; steps: string[] }> };
    expect(manifest4.flows?.find((f) => f.code === 'F-001')?.steps).toEqual(['P-001']);
  });

  it('⑨ 对话提案链（0032）：propose→pending→同页重复拒→放弃可再提→目录版本漂移门禁→采用落页工件', async () => {
    const code = pageCodes[2]!;
    // 提案（mock 降级路径：无 AI_PROVIDER 的 pages 服务 → buildMockPage 产物入提案）
    const r1 = await pages.proposeFromChat(PID, code, '把主色改成蓝色', CTX);
    expect(r1.ok).toBe(true);
    expect(r1.pageCode).toBe(code);
    expect(r1.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r1.route).toBe(`/design?tab=prototype&page=${code}`);
    const pend = await pages.listPendingProposals(PID);
    const mine = pend.filter((p) => p.pageCode === code);
    expect(mine.map((p) => p.id)).toEqual([r1.proposalId]);
    expect(mine[0]!.instruction).toBe('把主色改成蓝色');

    // 提案预览：内容寻址直签 + 渲染 content-type（对比视图右栏）
    const pv = (await pages.proposalPreview(PID, r1.proposalId!)) as { previewUrl: string; htmlFingerprint: string };
    expect(pv.previewUrl).toContain('response-content-type');
    expect(pv.htmlFingerprint).toBe(r1.fingerprint);

    // 同页 pending 唯一：再提 → ok:false 人话（不落码）
    const r2 = await pages.proposeFromChat(PID, code, '再改一版', CTX);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('待处置');
    // 页不在目录/不存在的页：preparePage 守卫 → ok:false 人话（不抛异常打断对话流）
    const rBad = await pages.proposeFromChat(PID, 'P-999', 'x', CTX);
    expect(rBad.ok).toBe(false);
    expect(rBad.reason).toBeTruthy();

    // 放弃 → discarded，同页可再提
    const d1 = (await pages.decideProposal(PID, r1.proposalId!, 'discard', CTX)) as { pageCode: string; decision: string };
    expect(d1).toMatchObject({ pageCode: code, decision: 'discard' });
    const s1 = await query<{ status: string }>('SELECT status FROM dsg_proto_page_proposals WHERE id=$1', [r1.proposalId]);
    expect(s1.rows[0]!.status).toBe('discarded');
    // 已处置提案不可二次处置
    await expect(pages.decideProposal(PID, r1.proposalId!, 'accept', CTX))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await pages.listPendingProposals(PID)).some((p) => p.pageCode === code)).toBe(false);

    // 再提 → 目录版本漂移门禁：提案 catalog_version 落后于最新 plan → accept GATE_BLOCKED
    const r3 = await pages.proposeFromChat(PID, code, '第二版提案', CTX);
    expect(r3.ok).toBe(true);
    await query("UPDATE dsg_proto_page_proposals SET catalog_version='CV-OLD' WHERE id=$1", [r3.proposalId]);
    await expect(pages.decideProposal(PID, r3.proposalId!, 'accept', CTX))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    // 恢复对齐后采用 → 页工件 upsert（指纹=提案指纹、source=mock）+ 提案标 accepted
    await query(
      `UPDATE dsg_proto_page_proposals SET catalog_version=(
         SELECT catalog_version FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1) WHERE id=$2`,
      [PID, r3.proposalId]);
    const d2 = (await pages.decideProposal(PID, r3.proposalId!, 'accept', CTX)) as { decision: string; fingerprint: string };
    expect(d2.decision).toBe('accept');
    const pg = await query<{ html_fingerprint: string; source: string }>(
      'SELECT html_fingerprint, source FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2', [PID, code]);
    expect(pg.rows[0]!.html_fingerprint).toBe(d2.fingerprint);
    expect(pg.rows[0]!.source).toBe('mock');
    expect((await query('SELECT status FROM dsg_proto_page_proposals WHERE id=$1', [r3.proposalId])).rows[0])
      .toMatchObject({ status: 'accepted' });
    // 采用即页工件更新 → 原型滞后门禁亮（页待重汇总），与 🎨 重新生成同口径
    const gc = (await proto.gates(PID, 'check')) as { issues: Array<{ code: string; target?: string }> };
    expect(gc.issues.some((i) => i.code === 'PROTOTYPE_DIRTY' && i.target === code)).toBe(true);
  });

  it('⑩ 项目主题定制落库（0033）：theme_set 首写胜出，并发/重复派生静默丢弃不覆盖', async () => {
    const lp = await query<{ id: string }>(
      'SELECT id FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [PID]);
    const latestPlanId = lp.rows[0]!.id;
    const r1 = (await executeCommand('design.prototype.theme_set',
      { projectId: PID, planId: latestPlanId, theme: { primary: '#16a34a' } }, CTX)) as { written: boolean };
    expect(r1.written).toBe(true);
    // 第二笔（重复派生/并发晚到）→ theme 已非 NULL → 不写入
    const r2 = (await executeCommand('design.prototype.theme_set',
      { projectId: PID, planId: latestPlanId, theme: { primary: '#dc2626' } }, CTX)) as { written: boolean };
    expect(r2.written).toBe(false);
    const row = await query<{ theme: Record<string, string>; theme_id: string }>('SELECT theme, theme_id FROM dsg_plans WHERE id=$1', [latestPlanId]);
    expect(row.rows[0]!.theme).toEqual({ primary: '#16a34a' });
    expect(row.rows[0]!.theme_id).toBe('ai'); // 0034：懒派生标记来源
  });

  it('⑪ 主题方案库 CRUD（0034）：内置+AI 恒在；自定义增改删；内置不可改删/不可同名；重名拒', async () => {
    const l0 = await themes.list();
    expect(l0.items[0]!.id).toBe('ai');
    expect(l0.items.filter((x) => x.id.startsWith('builtin:')).length).toBe(5);
    // 新建自定义（非法令牌被滤）
    const c = await themes.create({ name: 'it-theme-暖阳', tokens: { primary: '#ea580c', hack: 'x' } as Record<string, string> }, CTX);
    const l1 = await themes.list();
    const mine = l1.items.find((x) => x.id === c.themeId);
    expect(mine).toMatchObject({ name: 'it-theme-暖阳', builtin: false, tokens: { primary: '#ea580c' } });
    // 重名拒 / 与内置同名拒 / 空名拒
    await expect(themes.create({ name: 'it-theme-暖阳', tokens: {} }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(themes.create({ name: '科技蓝（默认）', tokens: {} }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(themes.create({ name: ' ', tokens: {} }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 内置不可改删
    await expect(themes.update('builtin:violet', { name: 'x', tokens: {} }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(themes.remove('builtin:violet', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(themes.remove('ai', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 自定义可改可删
    await themes.update(c.themeId, { name: 'it-theme-暖阳2', tokens: { primary: '#ea580c', radius: '14px' } }, CTX);
    const l2 = await themes.list();
    expect(l2.items.find((x) => x.id === c.themeId)).toMatchObject({ name: 'it-theme-暖阳2', tokens: { primary: '#ea580c', radius: '14px' } });
    await themes.remove(c.themeId, CTX);
    expect((await themes.list()).items.some((x) => x.id === c.themeId)).toBe(false);
    await expect(themes.remove(c.themeId, CTX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('⑫ 换肤链（0034）：applyTheme 覆盖写 plan.theme_id/theme + 全页主题段重合成（内容不动）；之后 AI 懒派生不再覆盖人工选择', async () => {
    const lp = await query<{ id: string; catalog_version: string }>(
      'SELECT id, catalog_version FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [PID]);
    const latestPlan = lp.rows[0]!;
    // 取一个已生成页记录换肤前指纹
    const before = await query<{ page_code: string; html_fingerprint: string }>(
      'SELECT page_code, html_fingerprint FROM dsg_prototype_pages WHERE project_id=$1 ORDER BY page_code', [PID]);
    expect(before.rows.length).toBeGreaterThan(0);
    const r = await pages.applyTheme(PID, 'builtin:violet', CTX);
    expect(r).toMatchObject({ themeId: 'builtin:violet', name: '游戏紫', reskinned: before.rows.length });
    // plan 覆盖写（⑩ 的 AI 派生主题被人工选择覆盖）
    const planRow = await query<{ theme: Record<string, string>; theme_id: string }>(
      'SELECT theme, theme_id FROM dsg_plans WHERE id=$1', [latestPlan.id]);
    expect(planRow.rows[0]!.theme_id).toBe('builtin:violet');
    expect(planRow.rows[0]!.theme).toMatchObject({ primary: '#6d28d9' });
    // 页工件换肤：指纹变化 + 新对象含新主色 + 正文保留（data-page-block 在）
    const after = await query<{ page_code: string; object_key: string; html_fingerprint: string }>(
      'SELECT page_code, object_key, html_fingerprint FROM dsg_prototype_pages WHERE project_id=$1 ORDER BY page_code', [PID]);
    expect(after.rows[0]!.html_fingerprint).not.toBe(before.rows[0]!.html_fingerprint);
    const html = (await storage.getObject(after.rows[0]!.object_key)).toString('utf8');
    expect(html).toContain(buildThemeCss({ primary: '#6d28d9' }).slice(0, 40));
    expect(html).toContain('data-page-block');
    // AI 懒派生不再覆盖人工选择（theme 非空 → theme_set no-op）
    const w = (await executeCommand('design.prototype.theme_set',
      { projectId: PID, planId: latestPlan.id, theme: { primary: '#000000' } }, CTX)) as { written: boolean };
    expect(w.written).toBe(false);
    // 换肤后页指纹偏离汇总清单 → 原型滞后门禁亮（待重汇总）
    const gc = (await proto.gates(PID, 'check')) as { issues: Array<{ code: string }> };
    expect(gc.issues.some((i) => i.code === 'PROTOTYPE_DIRTY')).toBe(true);
    // 不存在方案 → NOT_FOUND
    await expect(pages.applyTheme(PID, 'builtin:nope', CTX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
