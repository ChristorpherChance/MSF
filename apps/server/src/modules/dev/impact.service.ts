import { Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { latestBaseline, liveBaselineFingerprint, liveBaselineItems } from './gate-common.js';

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
      // W2-044：处置理由服务端强制（与前端 modal 同口径——审计链须含判断依据）
      if (!note?.trim()) throw new DomainError('VALIDATION_FAILED', '处置理由必填（判断依据或返工范围）', 'note');
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

    // 基线人工重确认（A06-20 devConfirmBaseline 独立入口；W2-043 修复：
    // LLD-2 §540/LLD-4 DSG-D05-7——人工核对差异后重登 dsg_baselines 新行（reconfirmed_of 链），
    // 确认本身使计划失效、任务覆盖核对回 pending（须重新核对/提交/批准）；全部 pending 影响单 accept 口径）
    registerCommand('dev.baseline.confirm', async (client, payload, ctx) => {
      const { projectId, note } = payload as { projectId: string; note?: string };
      if (!note?.trim()) throw new DomainError('VALIDATION_FAILED', '重确认理由必填（核对差异结论）', 'note');
      const bl = await latestBaseline(client, projectId);
      if (!bl) throw new DomainError('INVALID_STATE', '尚无设计基线，请先在设计域完成原型定稿', projectId);
      // ① live 实况重算（与门禁同口径）
      const items = await liveBaselineItems(client, projectId);
      const liveFp = fingerprint({ items });
      // ② 基线行重登：live ≠ 最新行指纹（或行已失效）→ 追加新行，reconfirmed_of 链接旧行（append-only，旧行不改写）
      let baselineId: string = bl.id;
      let code: string = bl.code;
      let reconfirmed = false;
      if (bl.baseline_fingerprint !== liveFp || !bl.valid) {
        const seq = await client.query<{ n: string }>('SELECT count(*) AS n FROM dsg_baselines WHERE project_id=$1', [projectId]);
        code = `BL-${String(Number(seq.rows[0]?.n ?? 0) + 1).padStart(4, '0')}`;
        const recSeq = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM evd_records WHERE kind='baseline-reconfirm' AND project_id=$1", [projectId]);
        const ins = await client.query<{ id: string }>(
          `INSERT INTO dsg_baselines (project_id, code, finalization_id, items, baseline_fingerprint, valid, confirmed_by, reconfirmed_of)
           VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id`,
          [projectId, code, `rec_${Number(recSeq.rows[0]?.n ?? 0) + 1}`, JSON.stringify(items), liveFp, ctx.actorId, bl.id],
        );
        baselineId = ins.rows[0]!.id;
        reconfirmed = true;
        // ③ LLD-2 §540：确认基线本身使计划失效（须重新核对/提交/批准）+ 任务覆盖核对全部回 pending
        await client.query(
          "UPDATE dev_plans SET state='invalidated', invalidated_reason='baseline-reconfirm' WHERE project_id=$1 AND state IN ('submitted','approved')",
          [projectId]);
        await client.query(
          `UPDATE dev_tasks SET coverage=(SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id',c->>'item_id','status','pending','task_rev',rev)),'[]'::jsonb)
             FROM jsonb_array_elements(coverage) c), updated_by=$2, updated_at=now()
           WHERE project_id=$1 AND jsonb_array_length(coverage) > 0`,
          [projectId, ctx.actorId]);
      }
      // ④ pending 影响单全部 accept + 受影响任务输入对齐（重登后=新行/live；未重登=现行基线行）
      const pending = await client.query<{ code: string; affected_tasks: string[]; id: string }>(
        "SELECT id, code, affected_tasks FROM dev_impacts WHERE project_id=$1 AND status='pending-assessment' FOR UPDATE",
        [projectId]);
      if (pending.rows.length > 0) {
        const inputArtifacts = (reconfirmed ? items : bl.items).map((i) => ({ doc_kind: i.artifact, version_id: i.version_id, fingerprint: i.fingerprint }));
        const allTasks = [...new Set(pending.rows.flatMap((r) => r.affected_tasks))];
        await client.query(
          'UPDATE dev_tasks SET input_artifacts=$3, updated_by=$4, updated_at=now() WHERE project_id=$1 AND code = ANY($2)',
          [projectId, allTasks, JSON.stringify(inputArtifacts), ctx.actorId]);
        await client.query(
          "UPDATE dev_impacts SET status='accepted', resolution='accept', note=$2, updated_at=now() WHERE project_id=$1 AND status='pending-assessment'",
          [projectId, note.trim()]);
      }
      // ⑤ 证据行（重确认=独立证据类，区别于定稿 finalize）
      if (reconfirmed) {
        await appendEvidence(client, {
          projectId,
          kind: 'baseline-reconfirm',
          payload: { baselineId, code, reconfirmedOf: bl.id, baselineFingerprint: liveFp, note: note.trim(), by: ctx.actorId },
        });
      }
      return { resolved: pending.rows.length, baselineId, code, fingerprint: `sha256:${liveFp}`, reconfirmed };
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
