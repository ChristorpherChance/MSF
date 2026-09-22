import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { latestBaseline, liveBaselineFingerprint } from './gate-common.js';

/**
 * 开发计划（A06-6/7；REQ-404/420）：提交→人工批准→版本固定；修订只增。
 * 批准走策略确认点 dev.plan.approve（人工 confirm + 指纹复核 STALE_EVIDENCE）；
 * 上游基线变化 → 计划失效（invalidated，F04-4）。
 */
@Injectable()
export class DevPlansService {
  constructor(@Inject(PolicyService) private readonly policy: PolicyService) {}

  onModuleInit(): void {
    // A06-6 提交计划（追加修订；新提交使旧 approved 失效 superseded）
    registerCommand('dev.plan.submit', async (client, payload, ctx) => {
      const { projectId, taskIds, note } = payload as { projectId: string; taskIds: string[]; note?: string };
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
           SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY catalog_version DESC LIMIT 1)
         AND item_type IN ('page','flow')`, [projectId]);
      const covered = new Set(cov.rows.flatMap((t) => t.source_ids));
      const uncovered = cat.rows.map((c) => c.code).filter((c) => !covered.has(c));
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
        "UPDATE dev_plans SET state='invalidated', invalidated_reason='superseded' WHERE project_id=$1 AND state='approved'",
        [projectId]);
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_plans (project_id, revision, state, snapshot, coverage_report, baseline_id, baseline_fingerprint, plan_fingerprint, submitted_by, submitted_at)
         VALUES ($1,$2,'submitted',$3,$4,$5,$6,$7,$8,now()) RETURNING id`,
        [projectId, revision, JSON.stringify(snapshot), JSON.stringify(coverageReport), bl.id, bl.baseline_fingerprint, planFp, ctx.actorId],
      );
      return { planId: r.rows[0]!.id, revision: `plan-r${revision}`, fingerprint: `sha256:${planFp}`, status: 'submitted' };
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
      const revNo = Number(revision.replace(/^plan-r/, ''));
      const plan = await client.query<{ id: string; state: string; plan_fingerprint: string; baseline_fingerprint: string }>(
        'SELECT * FROM dev_plans WHERE project_id=$1 AND revision=$2 FOR UPDATE', [projectId, revNo]);
      const p = plan.rows[0];
      if (!p) throw new DomainError('NOT_FOUND', '计划修订不存在', revision);
      if (p.state !== 'submitted') throw new DomainError('INVALID_STATE', `计划状态 ${p.state} 不可批准`, revision);
      if (p.plan_fingerprint !== fp.replace(/^sha256:/, '')) {
        throw new DomainError('STALE_EVIDENCE', '展示的修订/指纹非最新', revision);
      }
      // 基线实时复核（REQ-420：输入变化即失效，不以旧快照批准）
      const live = await liveBaselineFingerprint(client, projectId);
      if (live !== p.baseline_fingerprint) {
        await client.query("UPDATE dev_plans SET state='invalidated', invalidated_reason='baseline-stale' WHERE id=$1", [p.id]);
        throw new DomainError('STALE_EVIDENCE', '计划依据的设计基线已失效（本次提交已作废）', revision);
      }
      await client.query(
        "UPDATE dev_plans SET state='approved', approved_by=$2, approved_at=now() WHERE id=$1", [p.id, ctx.actorId]);
      return { revision, status: 'approved', approvedBy: ctx.actorId, approvedAt: new Date().toISOString() };
    });
  }

  // ---------- 命令入口 ----------

  async submit(projectId: string, taskIds: string[], note: string | undefined, ctx: CommandContext) {
    return executeCommand('dev.plan.submit', { projectId, taskIds, note }, { ...ctx, projectId });
  }

  async approve(projectId: string, revision: string, fp: string, confirm: boolean, ctx: CommandContext) {
    return executeCommand('dev.plan.approve', { projectId, revision, fingerprint: fp, confirm }, { ...ctx, projectId });
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
        baselineFingerprint: `sha256:${String(p.baseline_fingerprint)}`,
        approvedBy: p.approved_by ?? null, approvedAt: p.approved_at ?? null,
        invalidatedReason: p.invalidated_reason ?? null,
      })),
    };
  }
}
