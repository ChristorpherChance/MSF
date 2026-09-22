/** 开发域集成测试（T4-03~12，需 DB+MinIO；F02-5/6/7、F05、F07、A06、REQ-401~420） */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprint } from '@msf/shared';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { ReqDocsService } from '../req/docs.service.js';
import { DesignDocsService } from '../design/docs.service.js';
import { DesignGenerateService, designGenTiming } from '../design/generate.service.js';
import { CatalogService } from '../design/catalog.service.js';
import { PrototypeService } from '../design/prototype.service.js';
import { DevTasksService } from './tasks.service.js';
import { DevPlansService } from './plans.service.js';
import { DevBoardService } from './board.service.js';
import { DevAutopilotService, devAutopilotTiming } from './autopilot.service.js';
import { DevBuildService } from './build.service.js';
import { DevSelftestService } from './selftest.service.js';
import { DevTransferService } from './transfer.service.js';
import { DevImpactService } from './impact.service.js';
import { DevCiService } from './ci.service.js';

const PID = '00000000-0000-0000-0000-0000000000f3';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };
const AI_CTX: CommandContext = { projectId: PID, actorKind: 'assistant', actorId: 'ai' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dev_tasks LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

const waitFor = async (fn: () => Promise<boolean>, ms = 20000): Promise<void> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
};

interface TaskView {
  id: string; code: string; title: string; kind: string; col: string; runStatus: string;
  prog: number; rev: number; codeRev: number; batchNo: number | null;
}

describe('Dev 开发域（集成，需 DB+MinIO）', async () => {
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
  const plans = new DevPlansService(policy);
  const board = new DevBoardService();
  const build = new DevBuildService(storage);
  const selftest = new DevSelftestService(storage);
  const transfer = new DevTransferService(policy, selftest);
  const impact = new DevImpactService();
  const ci = new DevCiService();
  const autopilot = new DevAutopilotService(board, build, selftest);
  resetCommands();
  reqDocs.onModuleInit();
  docs.onModuleInit();
  gen.onModuleInit();
  catalog.onModuleInit();
  proto.onModuleInit();
  tasks.onModuleInit();
  plans.onModuleInit();
  board.onModuleInit();
  autopilot.onModuleInit();
  build.onModuleInit();
  selftest.onModuleInit();
  transfer.onModuleInit();
  impact.onModuleInit();
  ci.onModuleInit();

  let baselineId = '';
  let baselineFp = '';
  let pageTasks: TaskView[] = [];
  let commonTask: TaskView;
  let integrationTask: TaskView;

  const listTasks = async () =>
    ((await tasks.list(PID)) as { items: TaskView[] }).items;

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm4-dev-test') ON CONFLICT (id) DO NOTHING", [PID]);
    await reqDocs.listDocs(PID, CTX); // 自举 CRD/PRD
    await docs.listDocs(PID, CTX); // 自举设计八册
  });
  afterAll(async () => {
    await query('DELETE FROM dev_selftest_pages WHERE selftest_id IN (SELECT id FROM dev_selftests WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dev_transfer WHERE project_id=$1', [PID]); // 先于 dev_reports（FK dev_transfer_report_id_fkey）
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
    await query('DELETE FROM sys_webhook_secrets WHERE project_id=$1', [PID]);
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

  it('T1 前置：PRD/HLD 定稿 + 原型基线（复用 M3 链路）', async () => {
    // PRD：REQ 锚点（L0c=1 供 develop 门禁）
    const rp = (await reqDocs.getDoc(PID, 'prd')) as unknown as { cur: number; contentFingerprint: string };
    await reqDocs.saveDraft(PID, 'prd', {
      secId: 's0',
      md: '产品需求\n\n## REQ-001 门户首页\n\n承接：CR-001\n\n设计锚点：DSG-U03-2\n\n## REQ-002 检索\n\n承接：CR-001\n\n设计锚点：DSG-U03-2',
      baseVersion: rp.cur, baseFingerprint: rp.contentFingerprint,
    }, CTX);
    const rp2 = (await reqDocs.getDoc(PID, 'prd')) as unknown as { cur: number };
    await reqDocs.commit(PID, 'prd', 'PRD 初稿', rp2.cur, CTX);
    await reqDocs.finalize(PID, 'prd', 2, 2, true, CTX);
    // HLD 定稿（允许未决 DR）
    const hd = (await docs.getDoc(PID, 'hld')) as unknown as { cur: number; contentFingerprint: string };
    await docs.saveDraft(PID, 'hld', { secId: 's0', md: '总体架构 v1', baseVersion: hd.cur, baseFingerprint: hd.contentFingerprint }, CTX);
    const hd2 = (await docs.getDoc(PID, 'hld')) as unknown as { cur: number };
    await docs.commit(PID, 'hld', '初稿', hd2.cur, CTX);
    await docs.finalize(PID, 'hld', 2, 2, true, true, CTX);
    // 原型：plan→generate→check→finalize → 基线
    const plan = (await catalog.plan(PID, CTX)) as { planId: string; fingerprint: string };
    const g = (await proto.generate(PID, plan.planId, plan.fingerprint, CTX)) as { prototypeVersionId: string };
    const chk = (await proto.check(PID, g.prototypeVersionId, CTX)) as { reportId: string; status: string };
    expect(chk.status).toBe('pass');
    await proto.finalize(PID, g.prototypeVersionId, chk.reportId, true, CTX);
    const bls = (await proto.baselines(PID)) as { items: Array<{ baselineId: string; fingerprint: string; valid: boolean }> };
    expect(bls.items[0]!.valid).toBe(true);
    baselineId = bls.items[0]!.baselineId;
    baselineFp = bls.items[0]!.fingerprint;
  });

  it('T2 任务识别：门禁 + 目录驱动任务池 + 覆盖核对（T4-03；REQ-401/402/403）', async () => {
    // 基线身份不符 → STALE_EVIDENCE
    await expect(tasks.identify(PID, baselineId, 'sha256:bad', CTX)).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    const r = (await tasks.identify(PID, baselineId, baselineFp, CTX)) as { identified: number; taskIds: string[] };
    expect(r.identified).toBeGreaterThanOrEqual(4); // 页面×N + common + integration
    // 幂等：同基线重复识别零新增
    const r2 = (await tasks.identify(PID, baselineId, baselineFp, CTX)) as { identified: number };
    expect(r2.identified).toBe(0);

    const items = await listTasks();
    pageTasks = items.filter((t) => t.kind === 'frontend');
    commonTask = items.find((t) => t.title === '平台基线接线')!;
    integrationTask = items.find((t) => t.title === '端到端联调')!;
    expect(pageTasks.length).toBeGreaterThanOrEqual(2);
    expect(integrationTask.batchNo).toBe(99);
    expect(pageTasks[0]!.code).toMatch(/^T-\d{3}$/);

    // 覆盖核对：设计项 ↔ 任务双向
    const cov = (await tasks.coverage(PID)) as { ok: boolean; uncoveredDesignItems: string[] };
    expect(cov.ok).toBe(true);
    // 冲突：无进行中任务 → 空
    const cf = (await tasks.conflicts(PID)) as { conflicts: unknown[] };
    expect(cf.conflicts).toHaveLength(0);
    // 规格编辑：queue 可编辑
    await tasks.saveTask(PID, pageTasks[0]!.id, { goal: '实现页面（已补充验收口径）' }, CTX);
    // 覆盖确认（全量）
    const cfa = (await tasks.confirmCoverage(PID, pageTasks[0]!.id, null, CTX)) as { confirmed: string };
    expect(cfa.confirmed).toBe('all');
    // 开始门禁预览：无批准计划 → PLAN_REQUIRED
    const gate = await board.startGate(PID, pageTasks[0]!.id);
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((i) => i.code === 'PLAN_REQUIRED')).toBe(true);
  });

  it('T3 计划提交/批准：指纹复核 + 人工确认点（T4-04；REQ-404/405）', async () => {
    const codes = (await listTasks()).map((t) => t.code);
    const sub = (await plans.submit(PID, codes, '首轮全覆盖', CTX)) as { revision: string; fingerprint: string; status: string };
    expect(sub.revision).toBe('plan-r1');
    expect(sub.status).toBe('submitted');
    // 展示指纹不符 → STALE_EVIDENCE
    await expect(plans.approve(PID, 'plan-r1', 'sha256:bad', true, CTX)).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    // AI 通道拒绝 + confirm 必填
    await expect(plans.approve(PID, 'plan-r1', sub.fingerprint, true, AI_CTX)).rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    await expect(plans.approve(PID, 'plan-r1', sub.fingerprint, false, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ap = (await plans.approve(PID, 'plan-r1', sub.fingerprint, true, CTX)) as { status: string };
    expect(ap.status).toBe('approved');
    // 重复批准 → INVALID_STATE
    await expect(plans.approve(PID, 'plan-r1', sub.fingerprint, true, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const cur = (await plans.current(PID)) as { items: Array<{ revision: string; state: string }> };
    expect(cur.items[0]).toMatchObject({ revision: 'plan-r1', state: 'approved' });
  });

  it('T4 看板人工全链 + 三类合并依据（T4-05；F02-5、REQ-406~411）', async () => {
    const [t1, t2] = pageTasks;
    // t1：manual-checklist 全链
    await board.transition(PID, t1!.id, 'ing', undefined, CTX);
    await board.transition(PID, t1!.id, 'pause', undefined, CTX);
    await board.transition(PID, t1!.id, 'resume', undefined, CTX); // 恢复重过门禁
    await board.run(PID, t1!.id, CTX);
    await board.transition(PID, t1!.id, 'review', undefined, CTX);
    // checklist 键闭集
    await expect(board.toggleCheck(PID, t1!.id, 'hack', true, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 无单测/CI 证据 → 合并自动门禁阻断
    await expect(board.merge(PID, t1!.id, 'manual-checklist', undefined, undefined, CTX)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await board.quality(PID, t1!.id, CTX);
    await board.aiReview(PID, t1!.id, CTX);
    // checklist 未全勾 → QUALITY_INVALID
    await expect(board.merge(PID, t1!.id, 'manual-checklist', undefined, undefined, CTX)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    for (const k of ['acceptance', 'standards', 'design']) await board.toggleCheck(PID, t1!.id, k, true, CTX);
    const m1 = (await board.merge(PID, t1!.id, 'manual-checklist', undefined, undefined, CTX)) as { merged: boolean; basis: { type: string } };
    expect(m1.merged).toBe(true);
    expect(m1.basis.type).toBe('manual-checklist');
    // 非法依据类型
    await expect(board.merge(PID, t1!.id, 'auto-approve', undefined, undefined, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // done 态不可再流转
    await expect(board.transition(PID, t1!.id, 'pause', undefined, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    // t2：manual-skip（理由必填）
    await board.transition(PID, t2!.id, 'ing', undefined, CTX);
    await board.run(PID, t2!.id, CTX);
    await board.transition(PID, t2!.id, 'review', undefined, CTX);
    await board.quality(PID, t2!.id, CTX);
    await board.aiReview(PID, t2!.id, CTX);
    await expect(board.skip(PID, t2!.id, '  ', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await board.skip(PID, t2!.id, '视觉微调项经负责人豁免', CTX);
    const m2 = (await board.merge(PID, t2!.id, 'manual-skip', undefined, undefined, CTX)) as { basis: { type: string } };
    expect(m2.basis.type).toBe('manual-skip');

    // common：legacy-manual
    await board.transition(PID, commonTask.id, 'ing', undefined, CTX);
    await board.run(PID, commonTask.id, CTX);
    await board.transition(PID, commonTask.id, 'review', undefined, CTX);
    await board.quality(PID, commonTask.id, CTX);
    await board.aiReview(PID, commonTask.id, CTX);
    const m3 = (await board.merge(PID, commonTask.id, 'legacy-manual', undefined, undefined, CTX)) as { basis: { type: string } };
    expect(m3.basis.type).toBe('legacy-manual');

    // 详情视图：PR/证据/CI 齐
    const det = (await tasks.detail(PID, t1!.id)) as unknown as { prs: unknown[]; evidence: unknown[]; ci: unknown[] };
    expect(det.prs.length).toBe(1);
    expect(det.evidence.length).toBeGreaterThanOrEqual(2); // unit + ai-review
    expect(det.ci.length).toBeGreaterThanOrEqual(1);
  });

  it('T5 驳回回路：rework → rev++/PR stale/计划失效（F02-5 task.rework）', async () => {
    const t3 = pageTasks[2] ?? pageTasks[0]!;
    await board.transition(PID, t3.id, 'ing', undefined, CTX);
    await board.run(PID, t3.id, CTX);
    await board.transition(PID, t3.id, 'review', undefined, CTX);
    await board.quality(PID, t3.id, CTX);
    // 无理由驳回 → VALIDATION_FAILED
    await expect(board.transition(PID, t3.id, 'rework', undefined, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const rw = (await board.transition(PID, t3.id, 'rework', '评审驳回：验收口径不符', CTX)) as { col: string; rework: boolean };
    expect(rw).toMatchObject({ col: 'queue', rework: true });
    const after = (await listTasks()).find((t) => t.id === t3.id)!;
    expect(after.rev).toBe(t3.rev + 1);
    expect(after.runStatus).toBe('rework');
    // 旧 PR 转 stale
    const det = (await tasks.detail(PID, t3.id)) as unknown as { prs: Array<{ status: string }> };
    expect(det.prs[0]!.status).toBe('stale');
    // 计划失效 → 重新启动被门禁阻断
    const cur = (await plans.current(PID)) as { items: Array<{ state: string; invalidatedReason: string | null }> };
    expect(cur.items[0]!.state).toBe('invalidated');
    expect(cur.items[0]!.invalidatedReason).toContain('task.rework');
    const gate = await board.startGate(PID, t3.id);
    expect(gate.issues.some((i) => i.code === 'PLAN_REQUIRED')).toBe(true);
    await expect(board.transition(PID, t3.id, 'ing', undefined, CTX)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
  });

  it('T6 变更影响：observe → rework/accept/confirmBaseline（T4-11；REQ-419/420）', async () => {
    // 场景模拟：上游基线重登（SQL 直造新基线行，live 重算与存储不符 → 失效传播）
    const fake = (code: string, fp: string, plusMin: number) =>
      query(
        `INSERT INTO dsg_baselines (project_id, code, finalization_id, items, baseline_fingerprint, confirmed_by, confirmed_at)
         VALUES ($1,$2,'sim',$3,$4,'test', now() + make_interval(mins => $5))`,
        [PID, code, JSON.stringify([{ artifact: 'PRD', version_id: 'vX', fingerprint: fp }]), fp, plusMin]);
    await fake('BL-9001', 'a'.repeat(64), 1);
    const ob = (await impact.observe(PID, CTX)) as { impacts: string[]; affectedTasks?: string[] };
    expect(ob.impacts).toEqual(['IM-001']);
    expect(ob.affectedTasks).toContain(integrationTask.code);
    // 同触发幂等
    const ob2 = (await impact.observe(PID, CTX)) as { deduplicated?: boolean };
    expect(ob2.deduplicated).toBe(true);
    // 处置：rework → 受影响任务 rev++/queue
    const before = (await listTasks()).find((t) => t.code === integrationTask.code)!;
    const ap = (await impact.apply(PID, ['IM-001'], 'rework', '按新基线返工', CTX)) as { resolved: number };
    expect(ap.resolved).toBe(1);
    const afterRework = (await listTasks()).find((t) => t.code === integrationTask.code)!;
    expect(afterRework.rev).toBe(before.rev + 1);
    expect(afterRework.col).toBe('queue');
    // 已处置单不可重复处置
    await expect(impact.apply(PID, ['IM-001'], 'accept', undefined, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // accept：输入身份对齐新基线
    await fake('BL-9002', 'b'.repeat(64), 2);
    const ob3 = (await impact.observe(PID, CTX)) as { impacts: string[] };
    expect(ob3.impacts).toEqual(['IM-002']);
    await impact.apply(PID, ['IM-002'], 'accept', '确认输入仍适用', CTX);
    // confirmBaseline： pending 全量 accept
    await fake('BL-9003', 'c'.repeat(64), 3);
    await impact.observe(PID, CTX);
    const cb = (await impact.confirmBaseline(PID, '基线人工重确认', CTX)) as { resolved: number };
    expect(cb.resolved).toBe(1);
    const pend = (await impact.list(PID, 'pending-assessment')) as { items: unknown[] };
    expect(pend.items).toHaveLength(0);
    // 清掉模拟基线，回到真实基线
    await query("DELETE FROM dsg_baselines WHERE project_id=$1 AND code LIKE 'BL-900%'", [PID]);
  });

  it('T7 autopilot 自动主线：批准启动 → 全链跑到 awaiting-transfer（T4-06；F02-6/F07）', async () => {
    const codes = (await listTasks()).map((t) => t.code);
    const sub = (await plans.submit(PID, codes, 'autopilot 轮', CTX)) as { revision: string; fingerprint: string };
    await plans.approve(PID, sub.revision, sub.fingerprint, true, CTX);
    // 指纹不符 / AI 通道拒绝
    await expect(autopilot.approveStart(PID, sub.revision, 'sha256:bad', CTX)).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    await expect(autopilot.approveStart(PID, sub.revision, sub.fingerprint, AI_CTX)).rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    const st = (await autopilot.approveStart(PID, sub.revision, sub.fingerprint, CTX)) as { runId: string; authorizationId: string; status: string };
    expect(st.status).toBe('running');
    // 未终态运行存在 → 重复启动拒绝
    await expect(autopilot.approveStart(PID, sub.revision, sub.fingerprint, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // 授权 scope 深冻结：transferToTest 永 false
    const s0 = (await autopilot.status(PID)) as { authorization: { scope: { transferToTest: boolean } } };
    expect(s0.authorization.scope.transferToTest).toBe(false);

    await waitFor(async () => {
      const s = (await autopilot.status(PID)) as { run: { status: string } | null };
      return s.run?.status === 'awaiting-transfer';
    });
    // 计划任务全部完成
    const items = await listTasks();
    expect(items.every((t) => t.col === 'done')).toBe(true);
    // 构建 + 自测报告 pass
    const b = (await build.current(PID)) as { build: { buildFingerprint?: string; fingerprint?: string } | null };
    expect(b.build).toBeTruthy();
    const reps = (await selftest.reports(PID)) as { items: Array<{ id: string; code: string; status: string }> };
    expect(reps.items[0]!.status).toBe('pass');
    const det = (await selftest.reportDetail(PID, reps.items[0]!.id)) as {
      gates: Record<string, { ok: boolean }>; pages: unknown[]; tampered: boolean; immutable: boolean;
    };
    expect(Object.values(det.gates).every((g) => g.ok)).toBe(true);
    expect(det.pages.length).toBeGreaterThan(0); // 页面×视口矩阵
    expect(det.tampered).toBe(false);
    // 导出（md/html 落 MinIO）
    const exp = (await selftest.export(PID, reps.items[0]!.id, 'md', CTX)) as { downloadUrl: string };
    expect(exp.downloadUrl).toContain('http');
    // 双侧对照：原型 vs 构建 UI 工件（不同源校验）
    const cmp = (await selftest.comparison(PID, 'P-001')) as { sameObjectGuard: { distinct: boolean } };
    expect(cmp.sameObjectGuard.distinct).toBe(true);
    // 自测门禁放行
    const gate = await selftest.gate(PID);
    expect(gate.ok).toBe(true);
  }, 60000);

  it('T8 转测试交接：门禁 + 人工确认 + 幂等回执（T4-09；REQ-418、§15(c)）', async () => {
    const g = await transfer.gate(PID);
    expect(g.ok).toBe(true);
    const reps = (await selftest.reports(PID)) as { items: Array<{ id: string; report_fingerprint: string }> };
    const rep = reps.items[0]!;
    await expect(transfer.transfer(PID, rep.id, 'sha256:bad', true, CTX)).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    await expect(transfer.transfer(PID, rep.id, `sha256:${rep.report_fingerprint}`, true, AI_CTX)).rejects.toMatchObject({ code: 'POLICY_MANUAL_REQUIRED' });
    await expect(transfer.transfer(PID, rep.id, `sha256:${rep.report_fingerprint}`, false, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const h = (await transfer.transfer(PID, rep.id, `sha256:${rep.report_fingerprint}`, true, CTX)) as {
      handoffId: string; tokenRotated: boolean; batchCandidate: { buildFingerprint: string; selftestReportFingerprint: string };
    };
    expect(h.tokenRotated).toBe(true);
    expect(h.batchCandidate.buildFingerprint).toMatch(/^sha256:/);
    expect(h.batchCandidate.selftestReportFingerprint).toBe(`sha256:${rep.report_fingerprint}`);
    // 幂等：同交接指纹返回既有回执
    const h2 = (await transfer.transfer(PID, rep.id, `sha256:${rep.report_fingerprint}`, true, CTX)) as { handoffId: string; deduplicated?: boolean };
    expect(h2.deduplicated).toBe(true);
    expect(h2.handoffId).toBe(h.handoffId);
    // 原子交接：run transferred + 授权 consumed
    const s = (await autopilot.status(PID)) as { run: { status: string }; authorization: { status: string } };
    expect(s.run.status).toBe('transferred');
    expect(s.authorization.status).toBe('consumed');
  });

  it('T9 复测语义：RETEST_REQUIRED / RETEST_WITHOUT_CHANGE / 实质返工放行（F02-7）', async () => {
    // 场景模拟：造一张失败报告（remediation 指纹=当前状态）
    const b = await query<{ id: string; build_fingerprint: string }>(
      'SELECT id, build_fingerprint FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [PID]);
    const tk = await query<{ code: string; rev: number; code_rev: number }>(
      'SELECT code, rev, code_rev FROM dev_tasks WHERE project_id=$1 ORDER BY code', [PID]);
    const remFp = fingerprint({
      build: b.rows[0]!.build_fingerprint,
      tasks: tk.rows.map((t) => `${t.code}:${t.rev}:${t.code_rev}`),
    });
    const st = await query<{ id: string }>(
      `INSERT INTO dev_selftests (project_id, build_id, build_fingerprint, gate_function, gate_smoke, gate_ui, gate_review,
         status, basis_fingerprint, remediation_fingerprint, started_by, finished_at)
       VALUES ($1,$2,$3,'{}','{}','{}','{}','fail',$4,$5,'test',now()) RETURNING id`,
      [PID, b.rows[0]!.id, b.rows[0]!.build_fingerprint, remFp, remFp]);
    await query(
      `INSERT INTO dev_reports (project_id, code, selftest_id, based_on, summary, status, report_fingerprint, created_by)
       VALUES ($1,'SR-9001',$2,$3,'{"gates":{}}','fail',$4,'test')`,
      [PID, st.rows[0]!.id, JSON.stringify({ build_fingerprint: b.rows[0]!.build_fingerprint }), fingerprint({ crafted: 1 })]);
    // 最近报告 fail：普通启动 → RETEST_REQUIRED
    await expect(selftest.start(PID, CTX)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    // 无实质返工复测 → RETEST_WITHOUT_CHANGE
    await expect(selftest.retest(PID, '直接复测', CTX)).rejects.toMatchObject({ code: 'RETEST_WITHOUT_CHANGE' });
    // 实质返工（任务修订变化，场景模拟）→ 复测放行
    await query('UPDATE dev_tasks SET rev=rev+1 WHERE project_id=$1 AND code=$2', [PID, pageTasks[0]!.code]);
    const rt = (await selftest.retest(PID, '修复后复测', CTX)) as unknown as { status: string; retestOfReportId: string };
    expect(rt.status).toBe('pass');
    expect(rt.retestOfReportId).toBeTruthy();
  });

  it('T10 CI 回传：secret 只写不读 + HMAC 正/负/幂等/unknown/matched=false（T4-12；A06-21/22）', async () => {
    const SECRET = 'ci-webhook-secret-0123456789abcdefg';
    await expect(ci.setSecret(PID, 'short', CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const set = (await ci.setSecret(PID, SECRET, CTX)) as { enabled: boolean; secretMasked: string };
    expect(set.enabled).toBe(true);
    expect(set.secretMasked).toContain('…');
    const st = (await ci.secretStatus(PID)) as { enabled: boolean; secretMasked: string };
    expect(st.enabled).toBe(true);
    expect(st.secretMasked).not.toContain(SECRET); // 只写不读

    const sign = (raw: Buffer, ts: string) =>
      `sha256=${createHmac('sha256', SECRET).update(`${ts}.`).update(raw).digest('hex')}`;
    const call = (body: Record<string, unknown>, delivery: string, bad = false) => {
      const raw = Buffer.from(JSON.stringify(body));
      const ts = String(Math.floor(Date.now() / 1000));
      return ci.callback(PID, raw, {
        timestamp: ts, signature: sign(raw, ts) + (bad ? 'ff' : ''), delivery,
      }, { projectId: PID, actorKind: 'system', actorId: 'ci-webhook' });
    };
    const body = { provider: 'gitea-actions', commitSha: 'c'.repeat(40), taskCodes: [pageTasks[0]!.code], conclusion: 'pass' };
    // 正常回传
    const r1 = (await call(body, 'd-001')) as { receiptId: string; matched: boolean; deduplicated: boolean };
    expect(r1.matched).toBe(true);
    expect(r1.deduplicated).toBe(false);
    // 投递幂等
    const r2 = (await call(body, 'd-001')) as { deduplicated: boolean };
    expect(r2.deduplicated).toBe(true);
    // unknown 如实落库
    const r3 = (await call({ ...body, conclusion: 'unknown' }, 'd-002')) as { matched: boolean };
    expect(r3.matched).toBe(true);
    // taskCodes 不匹配不拒收
    const r4 = (await call({ ...body, taskCodes: ['T-999'] }, 'd-003')) as { matched: boolean };
    expect(r4.matched).toBe(false);
    // 非法 conclusion 枚举
    await expect(call({ ...body, conclusion: 'green' }, 'd-004')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 签名失败 → UNAUTHENTICATED 且不落业务行
    await expect(call(body, 'd-005', true)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const rows = await query('SELECT 1 FROM dev_ci_reports WHERE project_id=$1 AND delivery_id=$2', [PID, 'd-005']);
    expect(rows.rows).toHaveLength(0);
    const aud = await query(
      "SELECT 1 FROM audit_log WHERE project_id=$1 AND command='dev.ci.callback' AND payload->>'rejected'='true'", [PID]);
    expect(aud.rows.length).toBeGreaterThanOrEqual(1);
    // 时间戳超窗
    const raw = Buffer.from(JSON.stringify(body));
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    await expect(ci.callback(PID, raw, { timestamp: oldTs, signature: sign(raw, oldTs), delivery: 'd-006' },
      { projectId: PID, actorKind: 'system', actorId: 'ci-webhook' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('T11 人工任务阻断 + 接管/恢复/停止 + 晚到回调零写（F02-6/F07；REQ-410）', async () => {
    // 场景模拟：集成任务转人工并重置排队
    await query(
      "UPDATE dev_tasks SET asg_type='human', col='queue', prog=0, run_status='manual' WHERE project_id=$1 AND id=$2",
      [PID, integrationTask.id]);
    const sub = (await plans.submit(PID, [integrationTask.code], '人工任务轮', CTX)) as { revision: string; fingerprint: string };
    await plans.approve(PID, sub.revision, sub.fingerprint, true, CTX);
    const st = (await autopilot.approveStart(PID, sub.revision, sub.fingerprint, CTX)) as { runId: string };
    await waitFor(async () => {
      const s = (await autopilot.status(PID)) as { run: { status: string; blocker: { code: string } | null } | null };
      return s.run?.status === 'blocked' && s.run.blocker?.code === 'HUMAN_TASK_REQUIRED';
    });

    // 晚到回调：token 不匹配 → OPERATION_STALE 严格零写
    await query(
      `INSERT INTO dev_operations (project_id, operation_id, token, action, owner_kind, run_id, idempotency_key, status, parent_fingerprint, created_by)
       VALUES ($1,'op-late-1','tok-a','dev.task.run','autopilot',$2,'ik-late-1','running',$3,'test')`,
      [PID, st.runId, 'f'.repeat(64)]);
    await expect(autopilot.lateCallback(PID, 'op-late-1', 'tok-b')).rejects.toMatchObject({ code: 'OPERATION_STALE' });
    const okCb = (await autopilot.lateCallback(PID, 'op-late-1', 'tok-a')) as { ok: boolean };
    expect(okCb.ok).toBe(true);

    // 接管 → 恢复（可恢复阻断码白名单）→ 再阻断 → 停止（撤授权）
    const tk = (await autopilot.control(PID, 'takeover', CTX)) as { status: string };
    expect(tk.status).toBe('taken-over');
    await autopilot.control(PID, 'resume', CTX);
    await waitFor(async () => {
      const s = (await autopilot.status(PID)) as { run: { status: string } | null };
      return s.run?.status === 'blocked'; // 人工任务仍在 → 恢复后再次阻断（不空转：一 tick 一阻断即停）
    });
    const sp = (await autopilot.control(PID, 'stop', CTX)) as { status: string };
    expect(sp.status).toBe('stopped');
    const s = (await autopilot.status(PID)) as { run: { status: string }; authorization: { status: string } };
    expect(s.run.status).toBe('stopped');
    expect(s.authorization.status).toBe('revoked');
    // 停止后不可恢复
    await expect(autopilot.control(PID, 'resume', CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  }, 30000);
});
