import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { developGateIssues, latestBaseline, liveBaselineFingerprint } from './gate-common.js';
import { applySpecPatch, buildTaskSpecs, improveSpecPatch, specIssues, type SpecPatch } from './tasks.service.js';

/**
 * 开发计划（A06-6/7；REQ-404/420）：提交→人工批准→版本固定；修订只增。
 * 批准走策略确认点 dev.plan.approve（人工 confirm + 指纹复核 STALE_EVIDENCE）；
 * 上游基线变化 → 计划失效（invalidated，F04-4）。
 * L4b 准备两级流程（原型 v18-preparation；LLD-2 F02-6 L253 / LLD-3 DSG-C06-2）：
 *   dev.plan.prepare 生成 draft 修订（suggestions + preparation_fingerprint，冻结列既有）→
 *   dev.plan.suggestion.resolve 逐条处置并追加新草稿修订（旧修订只读失效）→
 *   dev.plan.approve 接受 draft：全部建议已处置 + 新鲜度复核 → 同事务应用建议（落任务池）并批准。
 */

/** 准备建议（LLD-3 DSG-C06-2 suggestions[] + 原型 v18 proposals；state 闭集 pending/accepted/rejected，修订以 edited 标记） */
interface PlanSuggestion {
  id: string; kind: 'create-task' | 'patch-task';
  state: 'pending' | 'accepted' | 'rejected'; edited: boolean;
  targetCode: string; sourceFingerprint: string;
  task: Record<string, unknown>;
  reason: string; sourceRefs: string[]; confidence: 'high' | 'medium'; humanRequired: boolean;
}

/** 最新目录的 page/flow 条目（prepare/resolve 覆盖重算共用） */
const LATEST_CATALOG_SQL = `SELECT item_type, code, payload FROM dsg_catalog_items
  WHERE project_id=$1 AND catalog_version=(
    SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY substring(catalog_version from 4)::int DESC LIMIT 1)
  AND item_type IN ('page','flow') ORDER BY code`;

/** fingerprint 入参为 shared 闭包 Json 类型；DB 行/规格对象经此显式收窄（纯类型层，无运行时成本） */
const asJson = (v: unknown) => v as Parameters<typeof fingerprint>[0];
@Injectable()
export class DevPlansService {
  constructor(@Inject(PolicyService) private readonly policy: PolicyService) {}

  onModuleInit(): void {
    // A06-6 提交计划（追加修订；新提交使旧 approved 失效 superseded）
    registerCommand('dev.plan.submit', async (client, payload, ctx) => {
      const { projectId, taskIds, note } = payload as { projectId: string; taskIds: string[]; note?: string };
      // 入参兜底：空/非数组 taskIds 必须 400 VALIDATION_FAILED，不得裸 TypeError 落 500（实机走查修复）
      if (!Array.isArray(taskIds) || taskIds.length === 0) {
        throw new DomainError('VALIDATION_FAILED', '任务集为空或缺失（taskIds）', 'taskIds');
      }
      const bl = await latestBaseline(client, projectId);
      if (!bl) throw new DomainError('GATE_BLOCKED', '尚无设计基线', 'dev.plan', { issues: [{ code: 'BASELINE_REQUIRED', message: '尚无设计基线' }] });
      const tasks = await client.query<{ code: string; batch_no: number | null; deps: string[] }>(
        'SELECT code, batch_no, deps FROM dev_tasks WHERE project_id=$1 AND code = ANY($2) AND archived=false AND excluded=false',
        [projectId, taskIds]);
      if (tasks.rows.length !== taskIds.length) {
        throw new DomainError('VALIDATION_FAILED', '任务集含不存在/已排除任务', 'taskIds');
      }
      // 覆盖核对结论随计划快照固定（REQ-403）
      const cov = await client.query<{ code: string; source_ids: string[] }>(
        'SELECT code, source_ids FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false', [projectId]);
      const cat = await client.query<{ code: string }>(
        `SELECT code FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=(
           SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY substring(catalog_version from 4)::int DESC LIMIT 1)
         AND item_type IN ('page','flow')`, [projectId]);
      const covered = new Set(cov.rows.flatMap((t) => t.source_ids));
      const uncovered = cat.rows.map((c) => c.code).filter((c) => !covered.has(c));
      // W2-052：revision max+1 属 check-then-act——咨询锁串行化「取号→插入」临界区
      await lockCodeGen(client, `msf:code:plan:${projectId}`);
      const maxRev = await client.query<{ r: number | null }>(
        'SELECT max(revision) AS r FROM dev_plans WHERE project_id=$1', [projectId]);
      const revision = (maxRev.rows[0]?.r ?? 0) + 1;
      const snapshot = {
        taskIds, note: note ?? null,
        batches: [...new Set(tasks.rows.map((t) => t.batch_no ?? 0))].sort((a, b) => a - b),
        order: taskIds,
      };
      const coverageReport = { ok: uncovered.length === 0, uncoveredDesignItems: uncovered, unmatchedTasks: [] };
      const planFp = fingerprint({ projectId, revision, snapshot, baselineFingerprint: bl.baseline_fingerprint });
      await client.query(
        "UPDATE dev_plans SET state='invalidated', invalidated_reason='superseded' WHERE project_id=$1 AND state IN ('approved','draft')",
        [projectId]);
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_plans (project_id, revision, state, snapshot, coverage_report, baseline_id, baseline_fingerprint, plan_fingerprint, submitted_by, submitted_at)
         VALUES ($1,$2,'submitted',$3,$4,$5,$6,$7,$8,now()) RETURNING id`,
        [projectId, revision, JSON.stringify(snapshot), JSON.stringify(coverageReport), bl.id, bl.baseline_fingerprint, planFp, ctx.actorId],
      );
      return { planId: r.rows[0]!.id, revision: `plan-r${revision}`, fingerprint: `sha256:${planFp}`, status: 'submitted' };
    });

    // L4b 准备计划（原型 devPreparePlan/v18BuildPreparationRevision；LLD-5 无对应端点，差异登记）：
    // 识别遗漏（未覆盖目录项 → create-task 建议，默认采用）+ 规格缺口（patch-task 建议，默认待处理须人工判断），
    // 产出 draft 修订（suggestions + preparation_fingerprint + snapshot.basedOn 新鲜度基座）；准备不会启动开发。
    registerCommand('dev.plan.prepare', async (client, payload) => {
      const { projectId } = payload as { projectId: string };
      const issues = await developGateIssues(client, projectId);
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '开发入口门禁未通过', 'dev', { issues });
      const bl = (await latestBaseline(client, projectId))!;
      const live = await liveBaselineFingerprint(client, projectId);
      if (live !== bl.baseline_fingerprint) {
        throw new DomainError('STALE_EVIDENCE', '基线已变化，请先重确认输入基线', 'dev.plan');
      }
      const tasks = await client.query<Record<string, unknown>>(
        'SELECT * FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false', [projectId]);
      const catVerRow = await client.query<{ v: string }>(
        'SELECT catalog_version AS v FROM dsg_catalog_items WHERE project_id=$1 ORDER BY substring(catalog_version from 4)::int DESC LIMIT 1',
        [projectId]);
      const catalogVersion = catVerRow.rows[0]?.v ?? null;
      const cat = await client.query<{ item_type: string; code: string; payload: Record<string, unknown> }>(
        LATEST_CATALOG_SQL, [projectId]);

      // 建议生成（原型种子口径：create-task 补未覆盖 + patch-task 修规格问题）
      const suggestions: PlanSuggestion[] = [];
      const covered = new Set(tasks.rows.flatMap((t) => (t.source_ids as string[]) ?? []));
      const uncovered = cat.rows.filter((c) => !covered.has(c.code));
      const haveTitles = new Set(tasks.rows.map((t) => String(t.title)));
      // W2-052：建议 T- 预发号与任务发号同序列——同键串行（正式落池在 approve，另有 dup 护栏）
      await lockCodeGen(client, `msf:code:task:${projectId}`);
      let seq = Number((await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM dev_tasks WHERE project_id=$1', [projectId])).rows[0]?.n ?? '0');
      if (uncovered.length > 0) {
        // 与识别同幂等口径：同名任务已存在则不再建议（骨架任务 sourceIds 为空不承接覆盖）
        const specs = buildTaskSpecs(uncovered).filter((sp) => sp.sourceIds.length > 0 && !haveTitles.has(sp.title));
        for (const sp of specs) {
          seq += 1;
          const code = `T-${String(seq).padStart(3, '0')}`;
          suggestions.push({
            id: `sg-${code}`, kind: 'create-task', state: 'accepted', edited: false,
            targetCode: code, sourceFingerprint: fingerprint(asJson({ code, spec: sp })),
            task: { code, ...sp },
            reason: `来源 ${sp.sourceIds.join('、')} 尚无承接任务，按目录定义生成完整规格`,
            sourceRefs: sp.sourceIds, confidence: 'high', humanRequired: false,
          });
        }
      }
      for (const t of tasks.rows) {
        if (t.col !== 'queue') continue; // 规格仅排队中可编辑（dev.task.save 同口径），非队列任务不出 patch 建议
        const iss = specIssues(t);
        if (iss.length === 0) continue;
        const patch = improveSpecPatch(t);
        if (!patch) continue;
        suggestions.push({
          id: `sg-${String(t.code)}`, kind: 'patch-task', state: 'pending', edited: false,
          targetCode: String(t.code),
          sourceFingerprint: fingerprint({ code: String(t.code), rev: Number(t.rev), issues: iss.map((i) => i.code) }),
          task: patch as unknown as Record<string, unknown>,
          reason: `规格待完善：${iss.map((i) => i.message).join('；')}`,
          sourceRefs: (t.source_ids as string[]) ?? [], confidence: 'medium', humanRequired: true,
        });
      }

      // 投影快照：既有任务 + 未驳回的 create-task 建议；覆盖按投影重算
      // 顺序必须按 (batch_no, code) 编排——autopilot 按快照顺序派发，dev.task.start 批次门禁要求更早批次全部完成（U-026）
      const batchOrder = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
        const ba = (a.batch_no as number | null) ?? 999;
        const bb = (b.batch_no as number | null) ?? 999;
        return ba !== bb ? ba - bb : String(a.code).localeCompare(String(b.code));
      };
      const orderedTasks = [...tasks.rows].sort(batchOrder);
      const createCodes = suggestions.filter((s) => s.kind === 'create-task').map((s) => s.targetCode);
      const projectedIds = [...orderedTasks.map((t) => String(t.code)), ...createCodes];
      const projCovered = new Set([...covered, ...suggestions.filter((s) => s.kind === 'create-task').flatMap((s) => s.sourceRefs)]);
      const stillUncovered = cat.rows.map((c) => c.code).filter((c) => !projCovered.has(c));
      // W2-052：revision max+1 属 check-then-act——咨询锁串行化「取号→插入」临界区
      await lockCodeGen(client, `msf:code:plan:${projectId}`);
      const maxRev = await client.query<{ r: number | null }>(
        'SELECT max(revision) AS r FROM dev_plans WHERE project_id=$1', [projectId]);
      const revision = (maxRev.rows[0]?.r ?? 0) + 1;
      const basedOn = {
        taskRevisions: Object.fromEntries(tasks.rows.map((t) => [String(t.code), t.rev])),
        catalogVersion,
      };
      const snapshot = {
        taskIds: projectedIds, note: null,
        batches: [...new Set(tasks.rows.map((t) => (t.batch_no as number | null) ?? 0))].sort((a, b) => a - b),
        order: projectedIds, basedOn,
      };
      const coverageReport = { ok: stillUncovered.length === 0, uncoveredDesignItems: stillUncovered, unmatchedTasks: [] };
      const prepFp = fingerprint(asJson({ baselineFingerprint: bl.baseline_fingerprint, suggestions, snapshot }));
      const planFp = fingerprint(asJson({ projectId, revision, snapshot, suggestions, baselineFingerprint: bl.baseline_fingerprint }));
      // 新准备使旧 draft 失效（superseded；修订只增）
      await client.query(
        "UPDATE dev_plans SET state='invalidated', invalidated_reason='superseded' WHERE project_id=$1 AND state='draft'",
        [projectId]);
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_plans (project_id, revision, state, snapshot, coverage_report, suggestions,
           baseline_id, baseline_fingerprint, preparation_fingerprint, plan_fingerprint)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [projectId, revision, JSON.stringify(snapshot), JSON.stringify(coverageReport), JSON.stringify(suggestions),
          bl.id, bl.baseline_fingerprint, prepFp, planFp]);
      return {
        planId: r.rows[0]!.id, revision: `plan-r${revision}`, fingerprint: `sha256:${planFp}`,
        preparationFingerprint: `sha256:${prepFp}`, suggestions: suggestions.length, status: 'draft',
      };
    });

    // L4b 建议处置（原型 devRevisePreparation：处置即追加新草稿修订，旧修订保持只读；LLD-5 无对应端点，差异登记）
    registerCommand('dev.plan.suggestion.resolve', async (client, payload) => {
      const { projectId, revision, fingerprint: fp, suggestionId, decision, task } = payload as {
        projectId: string; revision: string; fingerprint: string; suggestionId: string;
        decision: 'accepted' | 'rejected' | 'pending'; task?: Record<string, unknown>;
      };
      if (typeof revision !== 'string' || !revision) {
        throw new DomainError('VALIDATION_FAILED', '计划修订号缺失（revision）', 'revision');
      }
      if (typeof fp !== 'string' || !fp) {
        throw new DomainError('VALIDATION_FAILED', '计划指纹缺失（fingerprint）', 'fingerprint');
      }
      if (!['accepted', 'rejected', 'pending'].includes(decision)) {
        throw new DomainError('VALIDATION_FAILED', 'decision 枚举 accepted|rejected|pending', 'decision');
      }
      const revNo = Number(revision.replace(/^plan-r/, ''));
      // 畸形修订号(如 plan-rplan-r1→NaN)须 400 而非落 SQL 500(2026-10-22 全链实测实抓)
      if (!Number.isInteger(revNo) || revNo < 1) {
        throw new DomainError('VALIDATION_FAILED', '计划修订号形态非法(应为 plan-r<N>)', 'revision');
      }
      const plan = await client.query<Record<string, unknown>>(
        'SELECT * FROM dev_plans WHERE project_id=$1 AND revision=$2 FOR UPDATE', [projectId, revNo]);
      const p = plan.rows[0];
      if (!p) throw new DomainError('NOT_FOUND', '计划修订不存在', revision);
      if (p.state !== 'draft') {
        throw new DomainError('INVALID_STATE', `计划状态 ${String(p.state)} 不可处置建议（仅准备中修订可处置）`, revision);
      }
      if (p.plan_fingerprint !== fp.replace(/^sha256:/, '')) {
        throw new DomainError('STALE_EVIDENCE', '展示的修订/指纹非最新', revision);
      }
      const suggestions = ((p.suggestions as PlanSuggestion[]) ?? []).map((s) => ({ ...s }));
      const sg = suggestions.find((s) => s.id === suggestionId);
      if (!sg) throw new DomainError('NOT_FOUND', '建议不存在', String(suggestionId));
      sg.state = decision;
      // 修订保存：编辑内容并入建议任务草稿（原型 devSavePreparationEdit → decision='edited'，本实现以 edited 标记保持 state 闭集）
      if (decision === 'accepted' && task && typeof task === 'object') {
        sg.task = { ...sg.task, ...task };
        sg.edited = true;
      }
      // 快照随处置重投影：驳回的 create-task 建议移出任务集，覆盖按投影重算
      const rejectedCreates = new Set(
        suggestions.filter((s) => s.kind === 'create-task' && s.state === 'rejected').map((s) => s.targetCode));
      const oldSnapshot = p.snapshot as { taskIds: string[]; note: string | null; batches: number[]; basedOn: unknown };
      const taskIds = oldSnapshot.taskIds.filter((c) => !rejectedCreates.has(c));
      const covered = new Set((await client.query<{ source_ids: string[] }>(
        'SELECT source_ids FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false', [projectId]))
        .rows.flatMap((t) => t.source_ids));
      for (const s of suggestions.filter((x) => x.kind === 'create-task' && x.state !== 'rejected')) {
        for (const src of s.sourceRefs) covered.add(src);
      }
      const cat = await client.query<{ code: string }>(LATEST_CATALOG_SQL, [projectId]);
      const uncovered = cat.rows.map((c) => c.code).filter((c) => !covered.has(c));
      const snapshot = { ...oldSnapshot, taskIds, order: taskIds };
      const coverageReport = { ok: uncovered.length === 0, uncoveredDesignItems: uncovered, unmatchedTasks: [] };
      // W2-052：revision max+1 属 check-then-act——咨询锁串行化「取号→插入」临界区
      await lockCodeGen(client, `msf:code:plan:${projectId}`);
      const maxRev = await client.query<{ r: number | null }>(
        'SELECT max(revision) AS r FROM dev_plans WHERE project_id=$1', [projectId]);
      const next = (maxRev.rows[0]?.r ?? 0) + 1;
      const prepFp = fingerprint(asJson({ baselineFingerprint: p.baseline_fingerprint, suggestions, snapshot }));
      const planFp = fingerprint(asJson({ projectId, revision: next, snapshot, suggestions, baselineFingerprint: String(p.baseline_fingerprint) }));
      await client.query(
        "UPDATE dev_plans SET state='invalidated', invalidated_reason='superseded' WHERE id=$1", [p.id]);
      await client.query(
        `INSERT INTO dev_plans (project_id, revision, state, snapshot, coverage_report, suggestions,
           baseline_id, baseline_fingerprint, preparation_fingerprint, plan_fingerprint)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9)`,
        [projectId, next, JSON.stringify(snapshot), JSON.stringify(coverageReport), JSON.stringify(suggestions),
          p.baseline_id, p.baseline_fingerprint, prepFp, planFp]);
      return {
        revision: `plan-r${next}`, fingerprint: `sha256:${planFp}`,
        preparationFingerprint: `sha256:${prepFp}`, decision: { suggestionId, state: decision },
      };
    });

    // A06-7 批准计划（策略确认点 dev.plan.approve；人工 confirm + 展示指纹复核）
    registerCommand('dev.plan.approve', async (client, payload, ctx) => {
      const { projectId, revision, fingerprint: fp, confirm } = payload as {
        projectId: string; revision: string; fingerprint: string; confirm?: boolean;
      };
      const gate = await this.policy.evaluate(projectId, 'dev.plan.approve');
      if (gate.mode === 'manual' && ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '计划批准确认点为人工模式，AI 通道不可调用', 'dev.plan.approve');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '计划批准须人工确认（confirm:true）', 'confirm');
      // 入参兜底：缺 revision/fingerprint 不得裸 TypeError 落 500（实机走查修复）
      if (typeof revision !== 'string' || !revision) {
        throw new DomainError('VALIDATION_FAILED', '计划修订号缺失（revision）', 'revision');
      }
      if (typeof fp !== 'string' || !fp) {
        throw new DomainError('VALIDATION_FAILED', '计划指纹缺失（fingerprint）', 'fingerprint');
      }
      const revNo = Number(revision.replace(/^plan-r/, ''));
      // 畸形修订号(如 plan-rplan-r1→NaN)须 400 而非落 SQL 500(2026-10-22 全链实测实抓)
      if (!Number.isInteger(revNo) || revNo < 1) {
        throw new DomainError('VALIDATION_FAILED', '计划修订号形态非法(应为 plan-r<N>)', 'revision');
      }
      const plan = await client.query<{
        id: string; state: string; plan_fingerprint: string; baseline_fingerprint: string;
        snapshot: { taskIds?: string[]; basedOn?: unknown }; suggestions: PlanSuggestion[] | null;
      }>(
        'SELECT * FROM dev_plans WHERE project_id=$1 AND revision=$2 FOR UPDATE', [projectId, revNo]);
      const p = plan.rows[0];
      if (!p) throw new DomainError('NOT_FOUND', '计划修订不存在', revision);
      if (p.state !== 'submitted' && p.state !== 'draft') {
        throw new DomainError('INVALID_STATE', `计划状态 ${p.state} 不可批准`, revision);
      }
      if (p.plan_fingerprint !== fp.replace(/^sha256:/, '')) {
        throw new DomainError('STALE_EVIDENCE', '展示的修订/指纹非最新', revision);
      }
      // 基线实时复核（REQ-420：输入变化即失效，不以旧快照批准）
      const live = await liveBaselineFingerprint(client, projectId);
      if (live !== p.baseline_fingerprint) {
        await client.query("UPDATE dev_plans SET state='invalidated', invalidated_reason='baseline-stale' WHERE id=$1", [p.id]);
        throw new DomainError('STALE_EVIDENCE', '计划依据的设计基线已失效（本次提交已作废）', revision);
      }
      let applied = 0;
      if (p.state === 'draft') {
        // L4b 准备批准（LLD-2 F02-6 L253：应用准备建议→批准计划同一事务；原型 devApproveAndRun 前置口径）
        const suggestions = p.suggestions ?? [];
        const pending = suggestions.filter((s) => s.state === 'pending');
        if (pending.length > 0) {
          throw new DomainError('GATE_BLOCKED', '存在未处置的准备建议（逐条采用/不采用后再批准）', 'dev.plan', {
            issues: pending.map((s) => ({ code: 'PLAN_REQUIRED' as const, message: `${s.targetCode} 建议待处置（采用/不采用）`, target: s.targetCode })),
          });
        }
        // 新鲜度复核（原型 v18PreparationFresh 的 taskRevisions/catalogRevisions 口径）：准备后任务池/目录未变化
        const nowRows = await client.query<{ code: string; rev: number }>(
          'SELECT code, rev FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false', [projectId]);
        const catVer = await client.query<{ v: string }>(
          'SELECT catalog_version AS v FROM dsg_catalog_items WHERE project_id=$1 ORDER BY substring(catalog_version from 4)::int DESC LIMIT 1',
          [projectId]);
        const nowBase = {
          taskRevisions: Object.fromEntries(nowRows.rows.map((t) => [t.code, t.rev])),
          catalogVersion: catVer.rows[0]?.v ?? null,
        };
        if (fingerprint(asJson(nowBase)) !== fingerprint(asJson(p.snapshot.basedOn ?? null))) {
          // 命令事务失败整体回滚：此处不写作废标记（写了也会回滚），draft 保留可重试/重新准备（原型 stale 标记口径）
          throw new DomainError('STALE_EVIDENCE', '任务池或目录在准备后已变化（请重新准备）', revision);
        }
        // 应用已采用建议落任务池（批准前不写入任务池——原型同口径）
        // W2-052：create-task 建议落池与任务发号共用 T- 序列——同键串行（dup 护栏兜底保留）
        await lockCodeGen(client, `msf:code:task:${projectId}`);
        const bl = await latestBaseline(client, projectId);
        const inputArtifacts = (bl?.items ?? []).map((i) => ({ doc_kind: i.artifact, version_id: i.version_id, fingerprint: i.fingerprint }));
        for (const sg of suggestions.filter((s) => s.state === 'accepted')) {
          if (sg.kind === 'create-task') {
            const t = sg.task as {
              code: string; title: string; kind: string; asgType?: string; owner?: string;
              goal?: string; scope?: string; boundary?: string; sourceIds?: string[];
              work?: unknown[]; inputs?: unknown[]; deliverables?: unknown[]; acceptance?: unknown[];
              quality?: unknown; deps?: string[]; writeScopes?: string[]; batchNo?: number; effort?: string;
            };
            const dup = await client.query('SELECT 1 FROM dev_tasks WHERE project_id=$1 AND code=$2', [projectId, t.code]);
            if (dup.rows[0]) {
              throw new DomainError('INVALID_STATE', `建议任务 ${t.code} 已存在（任务池已变化，请重新准备）`, t.code);
            }
            const sourceIds = t.sourceIds ?? sg.sourceRefs;
            const cov = sourceIds.map((s) => ({ item_id: s, status: 'pending', task_rev: 1 }));
            await client.query(
              `INSERT INTO dev_tasks (project_id, code, title, kind, owner, asg_type, goal, scope, boundary,
                 source_ids, input_artifacts, work, inputs, deliverables, acceptance, quality, deps, write_scopes, batch_no, effort, coverage, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
              [projectId, t.code, t.title, t.kind, t.owner ?? 'mock-agent', t.asgType ?? 'agent',
                t.goal ?? '', t.scope ?? '', t.boundary ?? '',
                JSON.stringify(sourceIds), JSON.stringify(inputArtifacts), JSON.stringify(t.work ?? []),
                JSON.stringify(t.inputs ?? []), JSON.stringify(t.deliverables ?? []), JSON.stringify(t.acceptance ?? []),
                JSON.stringify(t.quality ?? {}), JSON.stringify(t.deps ?? []), JSON.stringify(t.writeScopes ?? []),
                t.batchNo ?? null, t.effort ?? 'M', JSON.stringify(cov), ctx.actorId]);
          } else {
            const row = await client.query<{ id: string; col: string }>(
              'SELECT id, col FROM dev_tasks WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, sg.targetCode]);
            const t = row.rows[0];
            if (!t) throw new DomainError('NOT_FOUND', '建议目标任务不存在', sg.targetCode);
            if (t.col !== 'queue') {
              throw new DomainError('INVALID_STATE', '任务已离排队，建议不可应用（请返工或重新准备）', sg.targetCode);
            }
            await applySpecPatch(client, projectId, t.id, sg.task as unknown as SpecPatch, ctx.actorId);
          }
          applied++;
        }
        // 新批准使旧 approved 失效（与 submit 同口径 superseded）
        await client.query(
          "UPDATE dev_plans SET state='invalidated', invalidated_reason='superseded' WHERE project_id=$1 AND state='approved'",
          [projectId]);
      }
      await client.query(
        "UPDATE dev_plans SET state='approved', approved_by=$2, approved_at=now() WHERE id=$1", [p.id, ctx.actorId]);
      return { revision, status: 'approved', approvedBy: ctx.actorId, approvedAt: new Date().toISOString(), applied };
    });
  }

  // ---------- 命令入口 ----------

  async submit(projectId: string, taskIds: string[], note: string | undefined, ctx: CommandContext) {
    return executeCommand('dev.plan.submit', { projectId, taskIds, note }, { ...ctx, projectId });
  }

  async approve(projectId: string, revision: string, fp: string, confirm: boolean, ctx: CommandContext) {
    return executeCommand('dev.plan.approve', { projectId, revision, fingerprint: fp, confirm }, { ...ctx, projectId });
  }

  async prepare(projectId: string, ctx: CommandContext) {
    return executeCommand('dev.plan.prepare', { projectId }, { ...ctx, projectId });
  }

  async resolveSuggestion(
    projectId: string,
    body: { revision: string; fingerprint: string; suggestionId: string; decision: 'accepted' | 'rejected' | 'pending'; task?: Record<string, unknown> },
    ctx: CommandContext,
  ) {
    return executeCommand('dev.plan.suggestion.resolve', { projectId, ...body }, { ...ctx, projectId });
  }

  // ---------- 查询面 ----------

  async current(projectId: string) {
    const r = await query(
      'SELECT * FROM dev_plans WHERE project_id=$1 ORDER BY revision DESC LIMIT 5', [projectId]);
    return {
      items: r.rows.map((p: Record<string, unknown>) => ({
        planId: p.id, revision: `plan-r${String(p.revision)}`, state: p.state,
        fingerprint: `sha256:${String(p.plan_fingerprint)}`,
        snapshot: p.snapshot, coverageReport: p.coverage_report,
        // L4b：准备建议与准备指纹随查询面返回（draft 修订驱动 proposals 卡）
        suggestions: p.suggestions ?? [],
        preparationFingerprint: p.preparation_fingerprint ? `sha256:${String(p.preparation_fingerprint)}` : null,
        baselineFingerprint: `sha256:${String(p.baseline_fingerprint)}`,
        approvedBy: p.approved_by ?? null, approvedAt: p.approved_at ?? null,
        invalidatedReason: p.invalidated_reason ?? null,
      })),
    };
  }
}
