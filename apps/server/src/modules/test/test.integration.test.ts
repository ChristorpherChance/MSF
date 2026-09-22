/** 测试验收域集成测试（T5-03~09，需 DB+MinIO；F02-8/9/10、A07-1~14、REQ-501~511） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { ReqDocsService } from '../req/docs.service.js';
import { DesignDocsService } from '../design/docs.service.js';
import { DesignGenerateService, designGenTiming } from '../design/generate.service.js';
import { CatalogService } from '../design/catalog.service.js';
import { PrototypeService } from '../design/prototype.service.js';
import { DevTasksService } from '../dev/tasks.service.js';
import { DevPlansService } from '../dev/plans.service.js';
import { DevBoardService } from '../dev/board.service.js';
import { DevAutopilotService, devAutopilotTiming } from '../dev/autopilot.service.js';
import { DevBuildService } from '../dev/build.service.js';
import { DevSelftestService } from '../dev/selftest.service.js';
import { DevTransferService } from '../dev/transfer.service.js';
import { TstBatchesService } from './batches.service.js';
import { TstPlansService } from './plans.service.js';
import { TstRunsService } from './runs.service.js';
import { TstDefectsService } from './defects.service.js';
import { TstReportsService } from './reports.service.js';

const PID = '00000000-0000-0000-0000-0000000000f4';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };
const AI_CTX: CommandContext = { projectId: PID, actorKind: 'assistant', actorId: 'ai' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM tst_batches LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

const waitFor = async (fn: () => Promise<boolean>, ms = 30000): Promise<void> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
};

describe('Tst 测试验收域（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }
  designGenTiming.chunkDelayMs = 0;
  devAutopilotTiming.tickDelayMs = 0;
  const policy = new PolicyService();
  const storage = new StorageService();
  const reqDocs = new ReqDocsService(policy);
  const docs = new DesignDocsService();
  const gen = new DesignGenerateService(docs);
  const catalog = new CatalogService(docs);
  const proto = new PrototypeService(docs, catalog, storage, policy);
  const tasks = new DevTasksService();
  const devPlans = new DevPlansService(policy);
  const board = new DevBoardService();
  const build = new DevBuildService(storage);
  const selftest = new DevSelftestService(storage);
  const transfer = new DevTransferService(policy, selftest);
  const autopilot = new DevAutopilotService(board, build, selftest);
  const batches = new TstBatchesService(storage);
  const plans = new TstPlansService(policy);
  const runs = new TstRunsService();
  const defects = new TstDefectsService();
  const reports = new TstReportsService(policy, storage);
  resetCommands();
  reqDocs.onModuleInit();
  docs.onModuleInit();
  gen.onModuleInit();
  catalog.onModuleInit();
  proto.onModuleInit();
  tasks.onModuleInit();
  devPlans.onModuleInit();
  board.onModuleInit();
  autopilot.onModuleInit();
  build.onModuleInit();
  selftest.onModuleInit();
  transfer.onModuleInit();
  batches.onModuleInit();
  plans.onModuleInit();
  runs.onModuleInit();
  defects.onModuleInit();
  reports.onModuleInit();

  let baselineFp = '';
  let handoffId = '';
  let buildFp = '';
  let reportFp = '';
  let batchId = '';
  let planDraftId = '';
  let planApprovedId = '';
  let runId1 = '';
  let defectId = '';

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm5-tst-test') ON CONFLICT (id) DO NOTHING", [PID]);
    await reqDocs.listDocs(PID, CTX);
    await docs.listDocs(PID, CTX);
  });
  afterAll(async () => {
    await query('DELETE FROM tst_decisions WHERE batch_id IN (SELECT id FROM tst_batches WHERE project_id=$1)', [PID]);
    await query('DELETE FROM tst_reports WHERE batch_id IN (SELECT id FROM tst_batches WHERE project_id=$1)', [PID]);
    await query('DELETE FROM tst_defects WHERE project_id=$1', [PID]);
    await query('DELETE FROM tst_case_runs WHERE run_id IN (SELECT id FROM tst_runs WHERE project_id=$1)', [PID]);
    await query('DELETE FROM tst_runs WHERE project_id=$1', [PID]);
    await query('DELETE FROM tst_cases WHERE plan_id IN (SELECT id FROM tst_plans WHERE batch_id IN (SELECT id FROM tst_batches WHERE project_id=$1))', [PID]);
    await query('DELETE FROM tst_plans WHERE batch_id IN (SELECT id FROM tst_batches WHERE project_id=$1)', [PID]);
    await query('DELETE FROM tst_batches WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_selftest_pages WHERE selftest_id IN (SELECT id FROM dev_selftests WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dev_transfer WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_reports WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_selftests WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_ci_reports WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_prs WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_impacts WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_runs WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_authorizations WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_operations WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_builds WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_plans WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_tasks WHERE project_id=$1', [PID]);
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
    await query('DELETE FROM audit_log WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_records WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  it('T1 前置：M1~M4 全链（基线→识别→计划→autopilot→交接 handoff）', async () => {
    // PRD 锚点 + HLD 定稿
    const rp = (await reqDocs.getDoc(PID, 'prd')) as unknown as { cur: number; contentFingerprint: string };
    await reqDocs.saveDraft(PID, 'prd', {
      secId: 's0',
      md: '产品需求\n\n## REQ-001 门户首页\n\n承接：CR-001\n\n设计锚点：DSG-U03-2\n\n## REQ-002 检索\n\n承接：CR-001\n\n设计锚点：DSG-U03-2',
      baseVersion: rp.cur, baseFingerprint: rp.contentFingerprint,
    }, CTX);
    const rp2 = (await reqDocs.getDoc(PID, 'prd')) as unknown as { cur: number };
    await reqDocs.commit(PID, 'prd', 'PRD 初稿', rp2.cur, CTX);
    await reqDocs.finalize(PID, 'prd', 2, 2, true, CTX);
    const hd = (await docs.getDoc(PID, 'hld')) as unknown as { cur: number; contentFingerprint: string };
    await docs.saveDraft(PID, 'hld', { secId: 's0', md: '总体架构 v1', baseVersion: hd.cur, baseFingerprint: hd.contentFingerprint }, CTX);
    const hd2 = (await docs.getDoc(PID, 'hld')) as unknown as { cur: number };
    await docs.commit(PID, 'hld', '初稿', hd2.cur, CTX);
    await docs.finalize(PID, 'hld', 2, 2, true, true, CTX);
    // 原型基线
    const plan = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    const g = (await proto.generate(PID, plan.planId, plan.fingerprint, CTX)) as { prototypeVersionId: string };
    const chk = (await proto.check(PID, g.prototypeVersionId, CTX)) as { reportId: string; status: string };
    await proto.finalize(PID, g.prototypeVersionId, chk.reportId, true, CTX);
    const bls = (await proto.baselines(PID)) as { items: Array<{ baselineId: string; fingerprint: string }> };
    baselineFp = bls.items[0]!.fingerprint;
    // 识别 + 计划批准 + autopilot
    await tasks.identify(PID, bls.items[0]!.baselineId, baselineFp, CTX);
    const codes = ((await tasks.list(PID)) as { items: Array<{ code: string }> }).items.map((t) => t.code);
    const sub = (await devPlans.submit(PID, codes, 'm5 前置轮', CTX)) as { revision: string; fingerprint: string };
    await devPlans.approve(PID, sub.revision, sub.fingerprint, true, CTX);
    await autopilot.approveStart(PID, sub.revision, sub.fingerprint, CTX);
    await waitFor(async () => {
      const s = (await autopilot.status(PID)) as { run: { status: string } | null };
      return s.run?.status === 'awaiting-transfer';
    });
    // 交接
    const reps = (await selftest.reports(PID)) as { items: Array<{ id: string; report_fingerprint: string }> };
    reportFp = reps.items[0]!.report_fingerprint;
    const h = (await transfer.transfer(PID, reps.items[0]!.id, `sha256:${reportFp}`, true, CTX)) as {
      handoffId: string; batchCandidate: { buildFingerprint: string };
    };
    handoffId = h.handoffId;
    buildFp = h.batchCandidate.buildFingerprint;
    expect(buildFp).toMatch(/^sha256:/);
  }, 90000);

  it('T2 批次接收：校验链 + 不可变快照 + 幂等（A07-1/2；F02-8；REQ-501/502）', async () => {
    const env = { os: 'test-linux', browser: 'chromium-mock' };
    // 交接不存在 → HANDOFF_INVALID
    await expect(batches.receive(PID, {
      handoffId: '00000000-0000-0000-0000-000000000000', buildFingerprint: buildFp,
      selftestReportFingerprint: `sha256:${reportFp}`, designBaselineFingerprint: baselineFp, environment: env,
    }, CTX)).rejects.toMatchObject({ code: 'HANDOFF_INVALID' });
    // 构建指纹不符 → STALE_EVIDENCE
    await expect(batches.receive(PID, {
      handoffId, buildFingerprint: `sha256:${'0'.repeat(64)}`,
      selftestReportFingerprint: `sha256:${reportFp}`, designBaselineFingerprint: baselineFp, environment: env,
    }, CTX)).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    // 基线指纹不符 → STALE_EVIDENCE
    await expect(batches.receive(PID, {
      handoffId, buildFingerprint: buildFp,
      selftestReportFingerprint: `sha256:${reportFp}`, designBaselineFingerprint: `sha256:${'0'.repeat(64)}`, environment: env,
    }, CTX)).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    // 正常接收
    const r = (await batches.receive(PID, {
      handoffId, buildFingerprint: buildFp,
      selftestReportFingerprint: `sha256:${reportFp}`, designBaselineFingerprint: baselineFp, environment: env,
    }, CTX)) as { batchId: string; status: string; deduplicated: boolean; snapshotFingerprint: string };
    expect(r.status).toBe('received');
    expect(r.deduplicated).toBe(false);
    expect(r.snapshotFingerprint).toMatch(/^sha256:/);
    batchId = r.batchId;
    expect(batchId).toMatch(/^TB-/);
    // 幂等：同交接指纹重复接收 → deduplicated
    const r2 = (await batches.receive(PID, {
      handoffId, buildFingerprint: buildFp,
      selftestReportFingerprint: `sha256:${reportFp}`, designBaselineFingerprint: baselineFp, environment: env,
    }, CTX)) as { batchId: string; deduplicated: boolean };
    expect(r2.deduplicated).toBe(true);
    expect(r2.batchId).toBe(batchId);
    // 详情：快照七元组齐
    const det = (await batches.detail(PID, batchId)) as {
      status: string; immutable: boolean;
      snapshot: { handoff: unknown; build: { build_fingerprint: string }; devReport: { report_fingerprint: string };
        designBaseline: { baseline_fingerprint: string }; acceptanceTerms: unknown; environment: unknown; environmentFingerprint: string };
    };
    expect(det.immutable).toBe(true);
    expect(det.snapshot.build.build_fingerprint).toBe(buildFp.replace(/^sha256:/, ''));
    expect(det.snapshot.devReport.report_fingerprint).toBe(reportFp);
    expect(det.snapshot.designBaseline.baseline_fingerprint).toBe(baselineFp.replace(/^sha256:/, ''));
    expect(det.snapshot.environmentFingerprint).toMatch(/^sha256:/);
    // 快照导出
    const exp = (await batches.export(PID, batchId, CTX)) as { downloadUrl: string };
    expect(exp.downloadUrl).toContain('http');
  });

  it('T3 计划起草/批准：目录派生用例 + 强制人工走查 + 批准新版本链（A07-3；REQ-503）', async () => {
    const d = (await plans.draft(PID, batchId, CTX)) as { planId: string; status: string; cases: Array<{ id: string; mode: string }> };
    expect(d.status).toBe('draft');
    planDraftId = d.planId;
    expect(d.cases.length).toBeGreaterThanOrEqual(1);
    expect(d.cases.some((c) => c.id === 'AT-MANUAL' && c.mode === 'manual')).toBe(true);
    // 批次 → planned
    const det = (await batches.detail(PID, batchId)) as { status: string };
    expect(det.status).toBe('planned');
    // 批准：AI 通道拒绝 / confirm 必填
    await expect(plans.approve(PID, batchId, planDraftId, true, AI_CTX)).rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    await expect(plans.approve(PID, batchId, planDraftId, false, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ap = (await plans.approve(PID, batchId, planDraftId, true, CTX)) as { planId: string; status: string; previousId: string };
    expect(ap.status).toBe('approved');
    expect(ap.previousId).toBe(planDraftId);
    planApprovedId = ap.planId;
    // 批次 → approved；当前计划=批准版，用例已冻结复制（content_hash 一致）
    const cur = (await plans.current(PID, batchId)) as {
      plan: { planId: string; state: string; hasManualWalkthrough: boolean };
      cases: Array<{ code: string; contentHash: string }>;
    };
    expect(cur.plan.planId).toBe(planApprovedId);
    expect(cur.plan.hasManualWalkthrough).toBe(true);
    expect(cur.cases.length).toBe(d.cases.length);
    const det2 = (await batches.detail(PID, batchId)) as { status: string };
    expect(det2.status).toBe('approved');
  });

  it('T4 自动执行：mock 执行器 + 两级模型 + 未完成不美化（A07-4；F02-9；REQ-504）', async () => {
    // 未批准计划执行拒绝
    await expect(runs.execute(PID, batchId, planDraftId, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const r = (await runs.execute(PID, batchId, planApprovedId, CTX)) as { runId: string; conclusion: string };
    runId1 = r.runId;
    expect(runId1).toMatch(/^TR-/);
    // 人工走查未录入 → 结论 blocked（不美化）
    expect(r.conclusion).toBe('blocked');
    const det = (await batches.detail(PID, batchId)) as { status: string };
    expect(det.status).toBe('executing');
    const v = (await runs.runsOfBatch(PID, batchId)) as {
      items: Array<{ runId: string; conclusion: string }>;
      cases: Array<{ code: string; result: string; executor_kind: string; evidence_ids: unknown[] }>;
    };
    expect(v.items[0]!.runId).toBe(runId1);
    const manual = v.cases.find((c) => c.code === 'AT-MANUAL')!;
    expect(manual.result).toBe('not-run');
    const autos = v.cases.filter((c) => c.executor_kind === 'auto');
    for (const a of autos) {
      expect(a.result).toBe('pass'); // mock 执行器
      expect(a.evidence_ids.length).toBeGreaterThan(0); // 证据行 seq 落库
    }
  });

  it('T5 人工录入：证据必填 + 追加新版本 + 自动行原样拷贝（A07-5；REQ-505）', async () => {
    // 缺证据 → EVIDENCE_REQUIRED
    await expect(runs.manualRecord(PID, runId1, 'AT-MANUAL', { status: 'pass', evidence: '' }, CTX))
      .rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    // 非法枚举
    await expect(runs.manualRecord(PID, runId1, 'AT-MANUAL', { status: 'skip', evidence: 'x' }, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 自动用例不可人工代填
    const v0 = (await runs.runsOfBatch(PID, batchId)) as { cases: Array<{ code: string; executor_kind: string }> };
    const auto = v0.cases.find((c) => c.executor_kind === 'auto');
    if (auto) {
      await expect(runs.manualRecord(PID, runId1, auto.code, { status: 'fail', evidence: '代填' }, CTX))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    // 正常录入 → 新 TR 版本
    const r = (await runs.manualRecord(PID, runId1, 'AT-MANUAL',
      { status: 'pass', evidence: '人工走查通过：关键路径无阻断' }, CTX)) as { runId: string; previousRunId: string; status: string };
    expect(r.previousRunId).toBe(runId1);
    expect(r.runId).not.toBe(runId1);
    // 旧运行已变化 → STALE_EVIDENCE
    await expect(runs.manualRecord(PID, runId1, 'AT-MANUAL', { status: 'pass', evidence: '晚到录入' }, CTX))
      .rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    // 新版本：自动行原样拷贝，结论 pass
    const v = (await runs.runsOfBatch(PID, batchId)) as {
      items: Array<{ runId: string; conclusion: string; previousRunId: boolean }>;
      cases: Array<{ code: string; result: string; executor_kind: string }>;
    };
    expect(v.items[0]!.conclusion).toBe('pass');
    expect(v.items[0]!.previousRunId).toBe(true);
    expect(v.cases.every((c) => c.result === 'pass')).toBe(true);
  });

  it('T6 缺陷登记/确认/修复/待回归（A07-6/7/8；F02-10；REQ-506）', async () => {
    // 造一条 fail 记录（人工走查失败，新运行版本）
    const latest = (await runs.runsOfBatch(PID, batchId)) as unknown as { latestRunId: string };
    const fr = (await runs.manualRecord(PID, latest.latestRunId, 'AT-MANUAL',
      { status: 'fail', evidence: '走查发现：提交按钮二次点击重复提交' }, CTX)) as { runId: string };
    // 非 fail 记录登记拒绝
    await expect(defects.create(PID, {
      batchId, runId: runId1, caseId: 'AT-MANUAL', title: 'x', evidence: '非失败记录',
    }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 缺证据
    await expect(defects.create(PID, {
      batchId, runId: fr.runId, caseId: 'AT-MANUAL', title: 'x', evidence: '',
    }, CTX)).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    const c = (await defects.create(PID, {
      batchId, runId: fr.runId, caseId: 'AT-MANUAL', title: '提交按钮重复提交', evidence: '录屏+复现步骤',
    }, CTX)) as { defectId: string; status: string; deduplicated: boolean };
    expect(c.status).toBe('new');
    expect(c.deduplicated).toBe(false);
    defectId = c.defectId;
    expect(defectId).toMatch(/^DF-/);
    // 幂等：同 runId+caseId
    const c2 = (await defects.create(PID, {
      batchId, runId: fr.runId, caseId: 'AT-MANUAL', title: '重复登记', evidence: 'x',
    }, CTX)) as { defectId: string; deduplicated: boolean };
    expect(c2.deduplicated).toBe(true);
    expect(c2.defectId).toBe(defectId);
    // 确认：严重度枚举 + 依据必填
    await expect(defects.confirm(PID, defectId, { severity: '高', reason: 'x' }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(defects.confirm(PID, defectId, { severity: 'P2', reason: '' }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const cf = (await defects.confirm(PID, defectId, { severity: 'P2', reason: '一般功能缺陷，不阻断主流程' }, CTX)) as { status: string };
    expect(cf.status).toBe('confirmed');
    // 确认后不可重复确认
    await expect(defects.confirm(PID, defectId, { severity: 'P2', reason: 'x' }, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // 修复开始 → 待回归（新构建 ≠ 源批次构建）
    await defects.fixStart(PID, defectId, { assignee: 'dev-a', reworkTaskIds: ['T-001'] }, CTX);
    await expect(defects.markFixed(PID, defectId, { newBuildFingerprint: buildFp }, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // 同构建不构成交付修复
    const NEW_BFP = 'd'.repeat(64);
    const mf = (await defects.markFixed(PID, defectId, { newBuildFingerprint: `sha256:${NEW_BFP}`, note: '已修复' }, CTX)) as { status: string };
    expect(mf.status).toBe('pending_regression');
  });

  it('T7 回归关联四要素 + 关闭人工复核 + 重开事件（A07-9；REQ-507）', async () => {
    // 要素①：同批次关联拒绝
    const latest = (await runs.runsOfBatch(PID, batchId)) as unknown as { latestRunId: string };
    await expect(defects.linkRegression(PID, defectId, { batchId, runId: latest.latestRunId, caseId: 'AT-MANUAL' }, CTX))
      .rejects.toMatchObject({ code: 'REGRESSION_EVIDENCE_MISMATCH' });
    // 场景模拟：新批次（新构建=开发侧标记构建）+ 同版用例 pass（SQL 直造，遵循 M4 场景模拟模式）
    const srcCase = await query<{ content_hash: string; plan_id: string }>(
      `SELECT c.content_hash, c.plan_id FROM tst_cases c
       JOIN tst_plans p ON p.id=c.plan_id JOIN tst_batches b ON b.id=p.batch_id
       WHERE b.project_id=$1 AND c.code='AT-MANUAL' ORDER BY p.version_no DESC LIMIT 1`, [PID]);
    const realBl = await query<{ id: string; baseline_fingerprint: string }>(
      'SELECT id, baseline_fingerprint FROM dsg_baselines WHERE project_id=$1 ORDER BY confirmed_at DESC LIMIT 1', [PID]);
    const realRep = await query<{ id: string; report_fingerprint: string }>(
      'SELECT id, report_fingerprint FROM dev_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [PID]);
    const nb = await query<{ id: string }>(
      `INSERT INTO tst_batches (project_id, code, handoff_fingerprint, handoff, build_snapshot, dev_report_snapshot,
         baseline_snapshot, acceptance_terms, environment, environment_fingerprint, received_by, status)
       VALUES ($1,'TB-900',$2,'{}',$3,$4,$5,'{}','{}',$6,'test','executing') RETURNING id`,
      [PID, 'e'.repeat(64),
        JSON.stringify({ build_id: 'B-900', build_fingerprint: 'd'.repeat(64) }),
        JSON.stringify({ report_id: realRep.rows[0]!.id, report_fingerprint: realRep.rows[0]!.report_fingerprint, status: 'pass' }),
        JSON.stringify({ baseline_id: realBl.rows[0]!.id, baseline_fingerprint: realBl.rows[0]!.baseline_fingerprint }),
        'f'.repeat(64)]);
    const np = await query<{ id: string }>(
      `INSERT INTO tst_plans (batch_id, code, version_no, scope, has_manual_walkthrough, state, created_by)
       VALUES ($1,'TP-900',1,'[]',true,'approved','test') RETURNING id`, [nb.rows[0]!.id]);
    const nc = await query<{ id: string }>(
      `INSERT INTO tst_cases (plan_id, code, title, mode, must_run, steps, content_hash, created_by)
       VALUES ($1,'AT-MANUAL','人工走查：关键路径端到端','manual',true,'[]',$2,'test') RETURNING id`,
      [np.rows[0]!.id, srcCase.rows[0]!.content_hash]);
    const nr = await query<{ id: string }>(
      `INSERT INTO tst_runs (project_id, batch_id, plan_id, code, conclusion, environment_fingerprint, started_at, finished_at, created_by)
       VALUES ($1,$2,$3,'TR-900','pass',$4,now(),now(),'test') RETURNING id`,
      [PID, nb.rows[0]!.id, np.rows[0]!.id, 'f'.repeat(64)]);
    await query(
      `INSERT INTO tst_case_runs (run_id, case_id, result, executor_kind, executed_by)
       VALUES ($1,$2,'pass','human','test')`, [nr.rows[0]!.id, nc.rows[0]!.id]);
    // 关联成功
    const lr = (await defects.linkRegression(PID, defectId, { batchId: 'TB-900', runId: 'TR-900', caseId: 'AT-MANUAL' }, CTX)) as {
      status: string; regression: { batchId: string };
    };
    expect(lr.status).toBe('pending_regression');
    expect(lr.regression.batchId).toBe('TB-900');
    // 关闭：AI 通道拒绝（仅测试侧人工）
    await expect(defects.close(PID, defectId, AI_CTX)).rejects.toMatchObject({ code: 'DEFECT_CLOSE_DENIED' });
    // 指纹篡改 → REGRESSION_EVIDENCE_MISMATCH（篡改后恢复）
    const orig = await query<{ regression_fingerprint: string }>(
      'SELECT regression_fingerprint FROM tst_defects WHERE project_id=$1 AND code=$2', [PID, defectId]);
    await query('UPDATE tst_defects SET regression_fingerprint=$3 WHERE project_id=$1 AND code=$2', [PID, defectId, '0'.repeat(64)]);
    await expect(defects.close(PID, defectId, CTX)).rejects.toMatchObject({ code: 'REGRESSION_EVIDENCE_MISMATCH' });
    await query('UPDATE tst_defects SET regression_fingerprint=$3 WHERE project_id=$1 AND code=$2',
      [PID, defectId, orig.rows[0]!.regression_fingerprint]);
    const cl = (await defects.close(PID, defectId, CTX)) as { status: string };
    expect(cl.status).toBe('closed');
    // 重开：事件而非状态 → confirmed，历史保留
    await expect(defects.reopen(PID, defectId, '', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ro = (await defects.reopen(PID, defectId, '复测复现：问题回归', CTX)) as { status: string; event: string };
    expect(ro.status).toBe('confirmed');
    expect(ro.event).toBe('reopened');
    const list = (await defects.list(PID, { batchId })) as { items: Array<{ defectId: string; status: string; reopenedCount: number }> };
    const row = list.items.find((d) => d.defectId === defectId)!;
    expect(row.status).toBe('confirmed');
    expect(row.reopenedCount).toBe(1);
  });

  it('T8 报告生成/定稿：basis 指纹复核 + 可定稿不通过（A07-10；REQ-508）', async () => {
    // 最新运行 fail（T6 的 fail 记录仍为最新）→ 先补一条 pass 使案例全过（缺陷未关闭 → verdict 仍 fail）
    const latest = (await runs.runsOfBatch(PID, batchId)) as unknown as { latestRunId: string };
    await runs.manualRecord(PID, latest.latestRunId, 'AT-MANUAL', { status: 'pass', evidence: '重开前走查补充' }, CTX);
    const g = (await reports.generate(PID, batchId, CTX)) as {
      reportId: string; conclusion: string; issues: string[]; status: string; basisFingerprint: string;
    };
    expect(g.status).toBe('draft');
    expect(g.conclusion).toBe('fail'); // DF 未关闭
    expect(g.issues.some((i) => i.includes(defectId))).toBe(true);
    expect(g.basisFingerprint).toMatch(/^sha256:/);
    // basis 变化（缺陷状态流转）→ 定稿拒绝
    await defects.fixStart(PID, defectId, { assignee: 'dev-a' }, CTX);
    await expect(reports.finalize(PID, g.reportId, true, CTX)).rejects.toMatchObject({ code: 'REPORT_BASIS_MISMATCH' });
    // 重新生成 → 定稿（AI 拒绝 / confirm 必填 / 人工成功；可定稿不通过）
    const g2 = (await reports.generate(PID, batchId, CTX)) as { reportId: string; conclusion: string };
    expect(g2.conclusion).toBe('fail');
    await expect(reports.finalize(PID, g2.reportId, true, AI_CTX)).rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    await expect(reports.finalize(PID, g2.reportId, false, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const fz = (await reports.finalize(PID, g2.reportId, true, CTX)) as { status: string; verdict: string };
    expect(fz.status).toBe('finalized');
    expect(fz.verdict).toBe('fail'); // 定稿≠放行
    const det = (await batches.detail(PID, batchId)) as { status: string };
    expect(det.status).toBe('reported');
    // 导出（报告+决定打包）
    const exp = (await reports.export(PID, g2.reportId, CTX)) as { downloadUrl: string };
    expect(exp.downloadUrl).toContain('http');
  });

  it('T9 交付决定：normal 门禁 + 条件放行豁免边界（A07-11/12；REQ-509/510）', async () => {
    const reps = (await reports.reportsOfBatch(PID, batchId)) as { items: Array<{ reportId: string; status: string }> };
    const fin = reps.items.find((r) => r.status === 'finalized')!;
    // normal：verdict fail → GATE_BLOCKED
    await expect(reports.authorize(PID, fin.reportId, { type: 'normal', confirm: true }, CTX))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    // 策略点：AI 拒绝 / confirm 必填
    await expect(reports.authorize(PID, fin.reportId, { type: 'reject', confirm: true }, AI_CTX))
      .rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    await expect(reports.authorize(PID, fin.reportId, { type: 'reject', confirm: false }, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 条件放行：豁免清单未覆盖全部未关闭缺陷 → WAIVER_NOT_ALLOWED
    await expect(reports.authorize(PID, fin.reportId, { type: 'conditional', waivers: [], confirm: true }, CTX))
      .rejects.toMatchObject({ code: 'WAIVER_NOT_ALLOWED' });
    // 豁免非本批缺陷 → WAIVER_NOT_ALLOWED
    await expect(reports.authorize(PID, fin.reportId, {
      type: 'conditional', waivers: [{ defectId: 'DF-999', justification: 'x' }], confirm: true,
    }, CTX)).rejects.toMatchObject({ code: 'WAIVER_NOT_ALLOWED' });
    // P0/P1 不可豁免（场景模拟：临时改严重度）
    const sev = await query<{ severity: string }>(
      'SELECT severity FROM tst_defects WHERE project_id=$1 AND code=$2', [PID, defectId]);
    await query("UPDATE tst_defects SET severity='P1' WHERE project_id=$1 AND code=$2", [PID, defectId]);
    await expect(reports.authorize(PID, fin.reportId, {
      type: 'conditional', waivers: [{ defectId, justification: '体验问题下版本修复' }], confirm: true,
    }, CTX)).rejects.toMatchObject({ code: 'WAIVER_NOT_ALLOWED' });
    await query('UPDATE tst_defects SET severity=$3 WHERE project_id=$1 AND code=$2', [PID, defectId, sev.rows[0]!.severity]);
    // 条件放行成功（P2 全覆盖豁免）
    const ad = (await reports.authorize(PID, fin.reportId, {
      type: 'conditional', waivers: [{ defectId, justification: '低等级体验问题，下版本修复' }], confirm: true,
    }, CTX)) as { decisionId: string; type: string; waiversAccepted: Array<{ defectId: string; severity: string }>; actor: string };
    expect(ad.decisionId).toMatch(/^AD-/);
    expect(ad.type).toBe('conditional');
    expect(ad.waiversAccepted).toEqual([{ defectId, severity: 'P2' }]);
    // 批次 → released（终态）
    const det = (await batches.detail(PID, batchId)) as { status: string };
    expect(det.status).toBe('released');
    // 决定查询
    const ds = (await reports.decisions(PID, batchId)) as { items: Array<{ decisionId: string; type: string; exemptions: unknown[] }> };
    expect(ds.items[0]!.decisionId).toBe(ad.decisionId);
    expect(ds.items[0]!.exemptions.length).toBe(1);
  });

  it('T10 批次阻断/恢复：异常终态 + 快照实时复核（A07-13/14；F02-8 blocked）', async () => {
    // 已 released 终态拒绝阻断
    await expect(batches.block(PID, batchId, 'x', CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // TB-900（executing，场景模拟行）：阻断
    await expect(batches.block(PID, 'TB-900', '  ', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const bl = (await batches.block(PID, 'TB-900', '构建工件复核存疑', CTX)) as { status: string; previousStatus: string };
    expect(bl.status).toBe('blocked');
    expect(bl.previousStatus).toBe('executing');
    // blocked 期间推进命令拒绝
    await expect(runs.execute(PID, 'TB-900', 'TP-900', CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(plans.draft(PID, 'TB-900', CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // 恢复：快照身份与实时不符（dev_builds 最新 ≠ 快照构建）→ STALE_EVIDENCE 须新批次
    await expect(batches.unblock(PID, 'TB-900', '恢复', CTX)).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    // 场景模拟：登记新构建（=开发侧标记构建）使快照实时一致
    await query(
      `INSERT INTO dev_builds (project_id, code, plan_revision, commit_refs, artifact_object_key, ui_artifact_object_key,
         build_fingerprint, ui_artifact_fingerprint, source_manifest, status, created_by)
       VALUES ($1,'B-900',1,'[]','build/sim/b900.json','build/sim/b900-ui.html',$2,$3,'{}','pass','test')`,
      [PID, 'd'.repeat(64), 'f'.repeat(64)]);
    await expect(batches.unblock(PID, 'TB-900', '', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ub = (await batches.unblock(PID, 'TB-900', '工件复核通过，恢复执行', CTX)) as { status: string; restoredFrom: string };
    expect(ub.status).toBe('executing'); // 恢复阻断前状态
    expect(ub.restoredFrom).toBe('blocked');
  });
});
