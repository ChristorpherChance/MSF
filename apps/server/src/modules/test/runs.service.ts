import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { aggregateConclusion, assertNotBlocked, lockBatch, nextCode } from './test-common.js';

/**
 * 用例执行两级模型（A07-4/5；F02-9；REQ-504/505）。
 * 自动用例由 mock 执行器执行（产 pass+证据行；M6 换真实执行器，模型不变）；
 * 人工走查保持 not-run 等人工录入；人工录入=追加新 run 版本（自动行原样拷贝）。
 */
@Injectable()
export class TstRunsService {
  onModuleInit(): void {
    // A07-4 创建运行（执行批准计划）
    registerCommand('tst.run.execute', async (client, payload, ctx) => {
      const { projectId, batchId, planId } = payload as { projectId: string; batchId: string; planId: string };
      const b = await lockBatch(client, projectId, batchId);
      assertNotBlocked(b);
      if (b.status !== 'approved' && b.status !== 'executing') {
        throw new DomainError('INVALID_STATE', `批次状态 ${b.status} 不可执行（须先批准计划）`, batchId);
      }
      const p = await client.query<{ id: string; state: string }>(
        'SELECT id, state FROM tst_plans WHERE batch_id=$1 AND code=$2', [b.id, planId]);
      if (!p.rows[0] || p.rows[0].state !== 'approved') {
        throw new DomainError('INVALID_STATE', '计划未批准，执行入口拒绝', planId);
      }
      const cases = await client.query<{ id: string; code: string; mode: string }>(
        'SELECT id, code, mode FROM tst_cases WHERE plan_id=$1 ORDER BY code', [p.rows[0].id]);
      if (cases.rows.length === 0) throw new DomainError('ZERO_CASES_FORBIDDEN', '零用例不得通过', planId);
      const code = await nextCode(client, 'tst_runs', 'batch_id=$1', [b.id], 'TR');
      const prev = await client.query<{ id: string }>(
        'SELECT id FROM tst_runs WHERE batch_id=$1 ORDER BY created_at DESC LIMIT 1', [b.id]);
      const results: string[] = [];
      const run = await client.query<{ id: string }>(
        `INSERT INTO tst_runs (project_id, batch_id, plan_id, code, previous_run_id, environment_fingerprint, started_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7) RETURNING id`,
        [projectId, b.id, p.rows[0].id, code, prev.rows[0]?.id ?? null, b.environment_fingerprint, ctx.actorId]);
      for (const c of cases.rows) {
        if (c.mode === 'auto') {
          // mock 自动执行器：通过路径 + 证据行（M6 换真实执行器）
          const ev = await appendEvidence(client, {
            projectId, kind: 'test-exec',
            payload: { batchId, runCode: code, caseCode: c.code, mode: 'auto', result: 'pass', evidence: 'mock 执行器：按步骤通过（M6 换真实执行器）' },
          });
          await client.query(
            `INSERT INTO tst_case_runs (run_id, case_id, result, executor_kind, evidence_ids, executed_by, note)
             VALUES ($1,$2,'pass','auto',$3,$4,'mock 执行器')`,
            [run.rows[0]!.id, c.id, JSON.stringify([ev]), ctx.actorId]);
          results.push('pass');
        } else {
          await client.query(
            `INSERT INTO tst_case_runs (run_id, case_id, result, executor_kind, executed_by, note)
             VALUES ($1,$2,'not-run','human',$3,'人工走查待录入')`,
            [run.rows[0]!.id, c.id, ctx.actorId]);
          results.push('not-run');
        }
      }
      const conclusion = aggregateConclusion(results);
      await client.query('UPDATE tst_runs SET conclusion=$2, finished_at=now() WHERE id=$1', [run.rows[0]!.id, conclusion]);
      if (b.status === 'approved') {
        await client.query("UPDATE tst_batches SET status='executing' WHERE id=$1", [b.id]);
      }
      return { runId: code, operationId: `op_run_${run.rows[0]!.id.slice(0, 8)}`, conclusion };
    });

    // A07-5 人工执行记录（追加新 run 版本；自动行原样拷贝）
    registerCommand('tst.run.manual.record', async (client, payload, ctx) => {
      const { projectId, runId, caseCode, status, evidence, simulation } = payload as {
        projectId: string; runId: string; caseCode: string; status: string; evidence?: string; simulation?: boolean;
      };
      if (!['pass', 'fail', 'blocked'].includes(status)) {
        throw new DomainError('VALIDATION_FAILED', '人工结论枚举 pass|fail|blocked', 'status');
      }
      if (!evidence?.trim()) throw new DomainError('EVIDENCE_REQUIRED', '人工执行必须附验证证据', 'evidence');
      const run = await client.query<{ id: string; batch_id: string; plan_id: string; code: string }>(
        'SELECT * FROM tst_runs WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, runId]);
      if (!run.rows[0]) throw new DomainError('NOT_FOUND', '运行不存在', runId);
      // 录入时校验 run 未变（manualRunId 匹配；当前运行已变化拒绝）
      const latest = await client.query<{ code: string }>(
        'SELECT code FROM tst_runs WHERE batch_id=$1 ORDER BY created_at DESC LIMIT 1', [run.rows[0].batch_id]);
      if (latest.rows[0]?.code !== runId) {
        throw new DomainError('STALE_EVIDENCE', '当前运行已变化，请基于最新运行录入', runId);
      }
      const b = await client.query<{ status: string; blocked_reason: string | null; environment_fingerprint: string; project_id: string }>(
        'SELECT status, blocked_reason, environment_fingerprint, project_id FROM tst_batches WHERE id=$1 FOR UPDATE', [run.rows[0].batch_id]);
      if (b.rows[0]?.status === 'blocked') {
        throw new DomainError('INVALID_STATE', `批次处于阻断态（${b.rows[0].blocked_reason ?? ''}）`, runId);
      }
      const cs = await client.query<{ id: string; mode: string }>(
        'SELECT id, mode FROM tst_cases WHERE plan_id=$1 AND code=$2', [run.rows[0].plan_id, caseCode]);
      if (!cs.rows[0]) throw new DomainError('NOT_FOUND', '用例不存在', caseCode);
      if (cs.rows[0].mode !== 'manual') throw new DomainError('VALIDATION_FAILED', '人工录入仅适用人工走查用例（自动用例结论不由人工代填）', caseCode);
      const code = await nextCode(client, 'tst_runs', 'batch_id=$1', [run.rows[0].batch_id], 'TR');
      const newRun = await client.query<{ id: string }>(
        `INSERT INTO tst_runs (project_id, batch_id, plan_id, code, previous_run_id, is_simulated, environment_fingerprint, started_at, finished_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now(),$8) RETURNING id`,
        [projectId, run.rows[0].batch_id, run.rows[0].plan_id, code, run.rows[0].id,
          !!simulation, b.rows[0]!.environment_fingerprint, ctx.actorId]);
      // 自动行原样拷贝
      await client.query(
        `INSERT INTO tst_case_runs (run_id, case_id, result, is_simulated, executor_kind, evidence_ids, executed_by, executed_at, note)
         SELECT $1, case_id, result, is_simulated, executor_kind, evidence_ids, executed_by, executed_at, note
         FROM tst_case_runs WHERE run_id=$2 AND case_id <> $3`,
        [newRun.rows[0]!.id, run.rows[0].id, cs.rows[0].id]);
      // 人工行更新
      const ev = await appendEvidence(client, {
        projectId, kind: 'test-manual',
        payload: { runCode: code, caseCode, result: status, evidence, simulation: !!simulation },
      });
      await client.query(
        `INSERT INTO tst_case_runs (run_id, case_id, result, is_simulated, executor_kind, evidence_ids, executed_by, note)
         VALUES ($1,$2,$3,$4,'human',$5,$6,$7)`,
        [newRun.rows[0]!.id, cs.rows[0].id, status, !!simulation, JSON.stringify([ev]), ctx.actorId, evidence]);
      const all = await client.query<{ result: string }>('SELECT result FROM tst_case_runs WHERE run_id=$1', [newRun.rows[0]!.id]);
      const conclusion = aggregateConclusion(all.rows.map((r) => r.result));
      await client.query('UPDATE tst_runs SET conclusion=$2 WHERE id=$1', [newRun.rows[0]!.id, conclusion]);
      return { runId: code, previousRunId: runId, caseId: caseCode, status };
    });
  }

  // ---------- 命令入口 ----------

  async execute(projectId: string, batchId: string, planId: string, ctx: CommandContext) {
    return executeCommand('tst.run.execute', { projectId, batchId, planId }, { ...ctx, projectId });
  }

  async manualRecord(
    projectId: string, runId: string, caseCode: string,
    body: { status: string; evidence: string; simulation?: boolean }, ctx: CommandContext,
  ) {
    return executeCommand('tst.run.manual.record',
      { projectId, runId, caseCode, status: body.status, evidence: body.evidence, simulation: body.simulation },
      { ...ctx, projectId });
  }

  // ---------- 查询面 ----------

  /** 批次运行列表 + 指定（默认最新）运行用例行 */
  async runsOfBatch(projectId: string, batchId: string) {
    const b = await query<{ id: string }>(
      'SELECT id FROM tst_batches WHERE project_id=$1 AND code=$2', [projectId, batchId]);
    if (!b.rows[0]) throw new DomainError('NOT_FOUND', '批次不存在', batchId);
    const runs = await query(
      `SELECT code, conclusion, is_simulated, previous_run_id, created_at FROM tst_runs
       WHERE batch_id=$1 ORDER BY created_at DESC`, [b.rows[0].id]);
    const latest = runs.rows[0] as Record<string, unknown> | undefined;
    let cases: unknown[] = [];
    if (latest) {
      const cr = await query(
        `SELECT cr.result, cr.is_simulated, cr.executor_kind, cr.evidence_ids, cr.executed_by, cr.note,
                c.code, c.title, c.mode, c.must_run, c.priority
         FROM tst_case_runs cr JOIN tst_cases c ON c.id=cr.case_id
         WHERE cr.run_id=(SELECT id FROM tst_runs WHERE batch_id=$1 AND code=$2)
         ORDER BY c.code`, [b.rows[0].id, latest.code]);
      cases = cr.rows;
    }
    return {
      items: runs.rows.map((r: Record<string, unknown>) => ({
        runId: r.code, conclusion: r.conclusion, isSimulated: r.is_simulated,
        previousRunId: r.previous_run_id ? true : false, createdAt: r.created_at,
      })),
      latestRunId: latest?.code ?? null,
      cases,
    };
  }
}
