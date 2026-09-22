import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { latestBaseline, liveBaselineFingerprint } from './gate-common.js';

/**
 * 变更影响与失效传播（A06-20；REQ-419/420）：
 * 再定稿/基线变化 → 影响单（受影响任务/证据可见）；resolution rework → 任务 rev++/回 queue（F02-5 影响返工行）；
 * accept → 基线人工重确认（任务 input_artifacts 对齐新基线）；输入变化 → 计划/自测报告失效。
 */
@Injectable()
export class DevImpactService {
  onModuleInit(): void {
    // 输入失效观察（input.observe：比对任务绑定输入 vs 当前基线，生成影响单；幂等——同触发指纹不重复开单）
    registerCommand('dev.input.observe', async (client, payload, ctx) => {
      const { projectId } = payload as { projectId: string };
      const bl = await latestBaseline(client, projectId);
      if (!bl) return { impacts: [], reason: 'no-baseline' };
      const live = await liveBaselineFingerprint(client, projectId);
      // 基线本身失效（上游变化）→ 计划失效 + 运行中自测标 stale
      if (live !== bl.baseline_fingerprint) {
        await client.query(
          "UPDATE dev_plans SET state='invalidated', invalidated_reason='baseline-stale' WHERE project_id=$1 AND state IN ('submitted','approved')",
          [projectId]);
        await client.query(
          "UPDATE dev_selftests SET status='stale' WHERE project_id=$1 AND status='running'", [projectId]);
      }
      const tasks = await client.query<{ id: string; code: string; col: string; input_artifacts: Array<{ fingerprint: string | null }> }>(
        "SELECT id, code, col, input_artifacts FROM dev_tasks WHERE project_id=$1 AND col <> 'done' AND archived=false", [projectId]);
      const currentFps = new Set(bl.items.map((i) => i.fingerprint));
      const affected = tasks.rows.filter((t) =>
        t.input_artifacts.length > 0 && t.input_artifacts.some((a) => a.fingerprint && !currentFps.has(a.fingerprint)));
      if (affected.length === 0) return { impacts: [] };
      const trigger = `baseline:${bl.code}:${bl.baseline_fingerprint.slice(0, 12)}`;
      const exist = await client.query<{ code: string }>(
        "SELECT code FROM dev_impacts WHERE project_id=$1 AND trigger=$2 AND status='pending-assessment'", [projectId, trigger]);
      if (exist.rows[0]) return { impacts: [exist.rows[0].code], deduplicated: true };
      const seq = await client.query<{ n: string }>('SELECT count(*) AS n FROM dev_impacts WHERE project_id=$1', [projectId]);
      const code = `IM-${String(Number(seq.rows[0]?.n ?? 0) + 1).padStart(3, '0')}`;
      await client.query(
        `INSERT INTO dev_impacts (project_id, code, trigger, affected_tasks, affected_evidence, status, created_by)
         VALUES ($1,$2,$3,$4,'[]','pending-assessment',$5)`,
        [projectId, code, trigger, JSON.stringify(affected.map((t) => t.code)), ctx.actorId]);
      return { impacts: [code], affectedTasks: affected.map((t) => t.code) };
    });

    // 影响处置（resolution rework|accept；rework 走 F02-5 影响返工行）
    registerCommand('dev.impact.apply', async (client, payload, ctx) => {
      const { projectId, impactIds, resolution, note } = payload as {
        projectId: string; impactIds: string[]; resolution: 'rework' | 'accept'; note?: string;
      };
      if (!['rework', 'accept'].includes(resolution)) {
        throw new DomainError('VALIDATION_FAILED', '处置方式限 rework|accept', 'resolution');
      }
      const bl = await latestBaseline(client, projectId);
      let resolved = 0;
      for (const code of impactIds) {
        const im = await client.query<{ id: string; status: string; affected_tasks: string[] }>(
          'SELECT * FROM dev_impacts WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, code]);
        if (!im.rows[0]) throw new DomainError('NOT_FOUND', '影响单不存在', code);
        if (im.rows[0].status !== 'pending-assessment') throw new DomainError('INVALID_STATE', '影响单已处置', code);
        if (resolution === 'rework') {
          const tasks = await client.query<{ id: string; code: string }>(
            'SELECT id, code FROM dev_tasks WHERE project_id=$1 AND code = ANY($2) FOR UPDATE', [projectId, im.rows[0].affected_tasks]);
          for (const t of tasks.rows) {
            await client.query("UPDATE dev_prs SET status='stale', updated_at=now() WHERE task_id=$1 AND status IN ('review','changes')", [t.id]);
            await client.query(
              `UPDATE dev_tasks SET rev=rev+1, code_rev=code_rev+1, col='queue', prog=0, run_status='rework',
                 updated_by=$2, updated_at=now() WHERE id=$1`, [t.id, ctx.actorId]);
          }
          await client.query(
            "UPDATE dev_plans SET state='invalidated', invalidated_reason=$2 WHERE project_id=$1 AND state='approved'",
            [projectId, `impact rework: ${code}`]);
        } else if (bl) {
          // accept：基线人工重确认——受影响任务输入身份对齐当前基线
          const inputArtifacts = bl.items.map((i) => ({ doc_kind: i.artifact, version_id: i.version_id, fingerprint: i.fingerprint }));
          await client.query(
            'UPDATE dev_tasks SET input_artifacts=$3, updated_by=$4, updated_at=now() WHERE project_id=$1 AND code = ANY($2)',
            [projectId, im.rows[0].affected_tasks, JSON.stringify(inputArtifacts), ctx.actorId]);
        }
        await client.query(
          "UPDATE dev_impacts SET status=$2, resolution=$3, note=$4, updated_at=now() WHERE id=$1",
          [im.rows[0].id, resolution === 'rework' ? 'rework' : 'accepted', resolution, note ?? null]);
        resolved++;
      }
      return { resolved };
    });

    // 基线人工重确认（A06-20 devConfirmBaseline 独立入口：全部 pending 影响单 accept 口径）
    registerCommand('dev.baseline.confirm', async (client, payload, ctx) => {
      const { projectId, note } = payload as { projectId: string; note?: string };
      const pending = await client.query<{ code: string; affected_tasks: string[]; id: string }>(
        "SELECT id, code, affected_tasks FROM dev_impacts WHERE project_id=$1 AND status='pending-assessment' FOR UPDATE",
        [projectId]);
      if (pending.rows.length === 0) return { resolved: 0 };
      const bl = await latestBaseline(client, projectId);
      if (bl) {
        const inputArtifacts = bl.items.map((i) => ({ doc_kind: i.artifact, version_id: i.version_id, fingerprint: i.fingerprint }));
        const allTasks = [...new Set(pending.rows.flatMap((r) => r.affected_tasks))];
        await client.query(
          'UPDATE dev_tasks SET input_artifacts=$3, updated_by=$4, updated_at=now() WHERE project_id=$1 AND code = ANY($2)',
          [projectId, allTasks, JSON.stringify(inputArtifacts), ctx.actorId]);
      }
      await client.query(
        "UPDATE dev_impacts SET status='accepted', resolution='accept', note=$2, updated_at=now() WHERE project_id=$1 AND status='pending-assessment'",
        [projectId, note ?? '基线人工重确认']);
      return { resolved: pending.rows.length };
    });
  }

  async observe(projectId: string, ctx: CommandContext) {
    return executeCommand('dev.input.observe', { projectId }, { ...ctx, projectId });
  }

  async apply(projectId: string, impactIds: string[], resolution: 'rework' | 'accept', note: string | undefined, ctx: CommandContext) {
    return executeCommand('dev.impact.apply', { projectId, impactIds, resolution, note }, { ...ctx, projectId });
  }

  async confirmBaseline(projectId: string, note: string | undefined, ctx: CommandContext) {
    return executeCommand('dev.baseline.confirm', { projectId, note }, { ...ctx, projectId });
  }

  /** A06-20 影响单查询 */
  async list(projectId: string, status?: string) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (status) { params.push(status); where += ' AND status=$2'; }
    const r = await query(
      `SELECT id, code, trigger, affected_tasks, status, resolution, note, created_at, updated_at
       FROM dev_impacts WHERE ${where} ORDER BY created_at DESC`, params);
    return { items: r.rows };
  }
}
