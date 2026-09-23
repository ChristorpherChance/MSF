import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { NotificationsService } from '../platform/notifications.service.js';
import { assertNotBlocked, computeBasisFingerprint, lockBatch, nextCode, qof, sha256hex } from './test-common.js';

interface ReportRow {
  id: string; batch_id: string; code: string; basis_fingerprint: string;
  summary: Record<string, unknown>; verdict: string | null; status: string;
  finalized_by: string | null; finalized_at: string | null;
}

/**
 * 验收报告与交付决定（A07-10/11/12；REQ-508/509/510）。
 * 报告：自动汇总执行+缺陷 → verdict pass|fail（未通过项或未关闭缺陷即 fail），登记 basis 指纹；
 * 定稿走策略点 test.report.finalize（人工），basis 复核不符 REPORT_BASIS_MISMATCH；可定稿不通过；定稿≠放行。
 * 交付决定：策略点 test.release（人工）；normal 需 verdict=pass 且无未关闭缺陷；
 * 条件放行仅豁免 P2/P3 且须覆盖全部未关闭缺陷，P0/P1/必测未执行/模拟失真 → WAIVER_NOT_ALLOWED；
 * 决定为不可变工件（tst_decisions），放行后置批次 released。
 */
@Injectable()
export class TstReportsService {
  constructor(
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(NotificationsService) private readonly notices: NotificationsService,
  ) {}

  onModuleInit(): void {
    // A07-10 报告生成（自动汇总执行与缺陷；登记 basis 指纹）
    registerCommand('tst.report.generate', async (client, payload, ctx) => {
      const { projectId, batchId } = payload as { projectId: string; batchId: string };
      const b = await lockBatch(client, projectId, batchId);
      assertNotBlocked(b);
      if (!['executing', 'reported'].includes(b.status)) {
        throw new DomainError('INVALID_STATE', `批次状态 ${b.status} 不可生成报告（须先执行）`, batchId);
      }
      const run = await client.query<{ id: string; code: string; conclusion: string | null; is_simulated: boolean }>(
        'SELECT id, code, conclusion, is_simulated FROM tst_runs WHERE batch_id=$1 ORDER BY created_at DESC LIMIT 1', [b.id]);
      if (!run.rows[0]) throw new DomainError('INVALID_STATE', '尚无执行运行，不可生成报告', batchId);
      const cases = await client.query(
        `SELECT c.code, c.title, c.must_run, cr.result, cr.is_simulated
         FROM tst_case_runs cr JOIN tst_cases c ON c.id=cr.case_id
         WHERE cr.run_id=$1 ORDER BY c.code`, [run.rows[0].id]);
      const defects = await client.query(
        'SELECT code, title, severity, status FROM tst_defects WHERE batch_id=$1 ORDER BY code', [b.id]);
      const basisFp = await computeBasisFingerprint(client, b.id);
      const issues: string[] = [];
      for (const c of cases.rows as Array<Record<string, unknown>>) {
        if (c.result !== 'pass' && c.result !== 'not-applicable') issues.push(`${c.code}：${c.result}`);
      }
      const unclosed = (defects.rows as Array<Record<string, unknown>>).filter((d) => d.status !== 'closed');
      for (const d of unclosed) issues.push(`${d.code}：未关闭缺陷（${d.status}）`);
      const simulated = (cases.rows as Array<Record<string, unknown>>).some((c) => c.is_simulated) || run.rows[0].is_simulated;
      const verdict = issues.length === 0 ? 'pass' : 'fail';
      const code = await nextCode(client, 'tst_reports', 'batch_id=$1', [b.id], 'AR');
      const prev = await client.query<{ id: string }>(
        'SELECT id FROM tst_reports WHERE batch_id=$1 ORDER BY created_at DESC LIMIT 1', [b.id]);
      const summary = {
        runId: run.rows[0].code, runConclusion: run.rows[0].conclusion,
        cases: cases.rows, defects: defects.rows, unclosedDefects: unclosed.map((d) => d.code),
        simulated, simulationNote: simulated ? '含模拟执行，结论不得用于正式放行依据' : null,
      };
      await client.query(
        `INSERT INTO tst_reports (batch_id, code, previous_report_id, basis_fingerprint, summary, verdict, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [b.id, code, prev.rows[0]?.id ?? null, basisFp, JSON.stringify(summary), verdict, ctx.actorId]);
      return { reportId: code, conclusion: verdict, issues, status: 'draft', basisFingerprint: `sha256:${basisFp}` };
    });

    // A07-10 报告定稿（策略点 test.report.finalize；basis 复核；可定稿不通过；定稿≠放行）
    registerCommand('tst.report.finalize', async (client, payload, ctx) => {
      const { projectId, reportId, confirm } = payload as { projectId: string; reportId: string; confirm?: boolean };
      const gate = await this.policy.evaluate(projectId, 'test.report.finalize');
      if (gate.mode === 'manual' && ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '报告定稿确认点为人工模式，AI 通道不可调用', 'test.report.finalize');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '报告定稿须人工确认（confirm:true）', 'confirm');
      const r = await lockReport(client, projectId, reportId);
      if (r.status !== 'draft') throw new DomainError('INVALID_STATE', '仅草稿报告可定稿', reportId);
      const b = await client.query<{ id: string; code: string; status: string }>('SELECT id, code, status FROM tst_batches WHERE id=$1 FOR UPDATE', [r.batch_id]);
      if (b.rows[0]?.status === 'blocked') {
        throw new DomainError('INVALID_STATE', '批次处于阻断态，一切推进命令拒绝', b.rows[0].code);
      }
      const now = await computeBasisFingerprint(client, r.batch_id);
      if (now !== r.basis_fingerprint) {
        throw new DomainError('REPORT_BASIS_MISMATCH', '执行或缺陷已变化（basis 指纹不符），请重新生成报告', reportId);
      }
      await client.query(
        'UPDATE tst_reports SET status=$2, finalized_by=$3, finalized_at=now() WHERE id=$1', [r.id, 'finalized', ctx.actorId]);
      if (b.rows[0]?.status === 'executing') {
        await client.query("UPDATE tst_batches SET status='reported' WHERE id=$1", [r.batch_id]);
      }
      return { reportId, status: 'finalized', verdict: r.verdict, finalizedBy: ctx.actorId };
    });

    // A07-11 交付决定（策略点 test.release；normal/conditional/reject；豁免校验）
    registerCommand('tst.delivery.authorize', async (client, payload, ctx) => {
      const { projectId, reportId, type, waivers, confirm } = payload as {
        projectId: string; reportId: string; type?: string;
        waivers?: Array<{ defectId: string; justification: string }>; confirm?: boolean;
      };
      const gate = await this.policy.evaluate(projectId, 'test.release');
      if (gate.mode === 'manual' && ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '交付决定确认点为人工模式，AI 通道不可调用', 'test.release');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '交付决定须人工确认（confirm:true）', 'confirm');
      if (!['normal', 'conditional', 'reject'].includes(type ?? '')) {
        throw new DomainError('VALIDATION_FAILED', '决定类型枚举 normal|conditional|reject', 'type');
      }
      const r = await lockReport(client, projectId, reportId);
      if (r.status !== 'finalized') throw new DomainError('GATE_BLOCKED', '报告未定稿，不可作交付决定', reportId);
      const b = await client.query<{ id: string; code: string; status: string }>(
        'SELECT id, code, status FROM tst_batches WHERE id=$1 FOR UPDATE', [r.batch_id]);
      if (b.rows[0]?.status === 'blocked') {
        throw new DomainError('INVALID_STATE', '批次处于阻断态，一切推进命令拒绝', b.rows[0].code);
      }
      const summary = r.summary as {
        cases?: Array<Record<string, unknown>>; unclosedDefects?: string[]; simulated?: boolean;
      };
      const unclosed = summary.unclosedDefects ?? [];
      const notRun = (summary.cases ?? []).filter((c) => c.must_run && c.result === 'not-run');
      const notAllowed: Array<{ code: string; message: string }> = [];
      if (type === 'normal' && (r.verdict !== 'pass' || unclosed.length > 0)) {
        throw new DomainError('GATE_BLOCKED', '正常放行前置：报告结论 pass 且无未关闭缺陷', reportId,
          { issues: [{ code: 'VERDICT_NOT_PASS', message: `verdict=${r.verdict}，未关闭缺陷 ${unclosed.length} 项` }] });
      }
      let exemptions: Array<Record<string, unknown>> = [];
      if (type === 'conditional') {
        // 不可豁免项：P0/P1、必测未执行、模拟失真
        if (notRun.length > 0) {
          notAllowed.push({ code: 'MUST_RUN_NOT_EXECUTED', message: `必测未执行：${notRun.map((c) => c.code).join(',')}` });
        }
        if (summary.simulated) notAllowed.push({ code: 'SIMULATION_DISTORTION', message: '含模拟执行，证据失真不可豁免' });
        const waiverIds = (waivers ?? []).map((w) => w.defectId);
        const unclosedRows = unclosed.length
          ? await client.query('SELECT code, severity FROM tst_defects WHERE batch_id=$1 AND code = ANY($2)', [r.batch_id, unclosed])
          : { rows: [] as Array<Record<string, unknown>> };
        for (const d of unclosedRows.rows) {
          if (d.severity === 'P0' || d.severity === 'P1') {
            notAllowed.push({ code: 'SEVERITY_NOT_WAIVABLE', message: `${d.code} 严重度 ${d.severity} 不可豁免` });
          }
          if (!waiverIds.includes(d.code as string)) {
            notAllowed.push({ code: 'WAIVER_INCOMPLETE', message: `${d.code} 未在豁免清单中（须覆盖全部未关闭缺陷）` });
          }
        }
        for (const w of waivers ?? []) {
          if (!unclosed.includes(w.defectId)) {
            notAllowed.push({ code: 'WAIVER_UNKNOWN', message: `${w.defectId} 非本批未关闭缺陷` });
          }
        }
        if (notAllowed.length > 0) {
          throw new DomainError('WAIVER_NOT_ALLOWED', '存在不可豁免项，条件放行拒绝', reportId, { issues: notAllowed });
        }
        exemptions = (waivers ?? []).map((w) => {
          const d = unclosedRows.rows.find((x) => x.code === w.defectId);
          return { defect_code: w.defectId, severity: d?.severity ?? null, reason: w.justification };
        });
      }
      const decision = type === 'normal' ? 'release' : type === 'conditional' ? 'conditional_release' : 'reject';
      const code = await nextCode(client, 'tst_decisions', 'batch_id=$1', [r.batch_id], 'AD');
      const reportFp = sha256hex(fingerprint(JSON.parse(JSON.stringify({
        reportId, batchId: b.rows[0]?.code, verdict: r.verdict, basis: r.basis_fingerprint,
      }))));
      const decisionFp = sha256hex(fingerprint(JSON.parse(JSON.stringify({
        decisionId: code, reportId, decision, exemptions, actor: ctx.actorId,
      }))));
      await client.query(
        `INSERT INTO tst_decisions (batch_id, code, report_id, report_fingerprint, decision, exemptions, decided_by, decision_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.batch_id, code, r.id, reportFp, decision, JSON.stringify(exemptions), ctx.actorId, decisionFp]);
      if (decision !== 'reject') {
        await client.query("UPDATE tst_batches SET status='released' WHERE id=$1", [r.batch_id]);
      }
      return {
        decisionId: code, type, reportId, reportFingerprint: reportFp, batchId: b.rows[0]?.code,
        waiversAccepted: exemptions.map((e) => ({ defectId: e.defect_code, severity: e.severity })), actor: ctx.actorId,
      };
    });

    // A07-12 报告导出（报告+决定打包 JSON 落 MinIO，含证据引用清单）
    registerCommand('tst.report.export', async (client, payload) => {
      const { projectId, reportId } = payload as { projectId: string; reportId: string };
      const r = await lockReport(client, projectId, reportId);
      const decisions = await client.query(
        `SELECT code, decision, exemptions, decided_by, decided_at, decision_fingerprint
         FROM tst_decisions WHERE report_id=$1 ORDER BY decided_at`, [r.id]);
      const evidence = await client.query(
        `SELECT cr.evidence_ids FROM tst_case_runs cr
         JOIN tst_runs rn ON rn.id=cr.run_id
         WHERE rn.batch_id=$1 AND cr.evidence_ids <> '[]'::jsonb`, [r.batch_id]);
      const bundle = {
        reportId, verdict: r.verdict, status: r.status, basisFingerprint: `sha256:${r.basis_fingerprint}`,
        summary: r.summary, finalizedBy: r.finalized_by, finalizedAt: r.finalized_at,
        decisions: decisions.rows, evidenceRefs: evidence.rows.flatMap((e: Record<string, unknown>) => e.evidence_ids as unknown[]),
      };
      const objectKey = `exports/${projectId}/report-${reportId}.json`;
      await this.storage.putObject(objectKey, Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));
      await client.query('UPDATE tst_reports SET export_object_key=$2 WHERE id=$1', [r.id, objectKey]);
      return { downloadUrl: await this.storage.presignedGet(objectKey), reportId };
    });
  }

  // ---------- 命令入口 ----------

  async generate(projectId: string, batchId: string, ctx: CommandContext) {
    return executeCommand('tst.report.generate', { projectId, batchId }, { ...ctx, projectId });
  }

  async finalize(projectId: string, reportId: string, confirm: boolean, ctx: CommandContext) {
    return executeCommand('tst.report.finalize', { projectId, reportId, confirm }, { ...ctx, projectId });
  }

  async authorize(
    projectId: string, reportId: string,
    body: { type: string; waivers?: Array<{ defectId: string; justification: string }>; confirm: boolean },
    ctx: CommandContext,
  ) {
    const r = await executeCommand('tst.delivery.authorize', { projectId, reportId, ...body }, { ...ctx, projectId });
    // 交付决定产通知行+领域事件（M7 回销 M5 差异⑤；BR-10）
    const typeName = body.type === 'normal' ? '正常放行' : body.type === 'conditional' ? '条件放行' : '拒收';
    await this.notices.emit({ ...ctx, projectId }, {
      type: 'tst.delivery.decided', eventKind: 'delivery.decided', link: '/test',
      text: `报告 ${reportId} 交付决定：${typeName}`,
    });
    return r;
  }

  /** A07-12 报告导出（报告+决定打包，含证据引用清单） */
  async export(projectId: string, reportId: string, ctx: CommandContext) {
    const r = await executeCommand('tst.report.export', { projectId, reportId }, { ...ctx, projectId });
    return r;
  }

  // ---------- 查询面 ----------

  /** A07-12 决定查询 */
  async decisions(projectId: string, batchId?: string) {
    const params: unknown[] = [projectId];
    let sql = `SELECT dc.code, dc.decision, dc.exemptions, dc.decided_by, dc.decided_at, dc.decision_fingerprint,
                      r.code AS report_code, b.code AS batch_code
               FROM tst_decisions dc
               JOIN tst_reports r ON r.id=dc.report_id
               JOIN tst_batches b ON b.id=dc.batch_id
               WHERE b.project_id=$1`;
    if (batchId) { params.push(batchId); sql += ` AND b.code=$${params.length}`; }
    sql += ' ORDER BY dc.decided_at DESC';
    const r = await query(sql, params);
    return {
      items: r.rows.map((d: Record<string, unknown>) => ({
        decisionId: d.code, type: d.decision === 'release' ? 'normal' : d.decision === 'conditional_release' ? 'conditional' : 'reject',
        reportId: d.report_code, batchId: d.batch_code, exemptions: d.exemptions,
        actor: d.decided_by, at: d.decided_at, decisionFingerprint: d.decision_fingerprint,
      })),
    };
  }

  /** 批次报告列表 */
  async reportsOfBatch(projectId: string, batchId: string) {
    const b = await qof(null)<{ id: string }>(
      'SELECT id FROM tst_batches WHERE project_id=$1 AND code=$2', [projectId, batchId]);
    if (!b.rows[0]) throw new DomainError('NOT_FOUND', '批次不存在', batchId);
    const r = await query(
      `SELECT code, verdict, status, basis_fingerprint, summary, finalized_by, finalized_at, created_at
       FROM tst_reports WHERE batch_id=$1 ORDER BY created_at DESC`, [b.rows[0].id]);
    return {
      items: r.rows.map((x: Record<string, unknown>) => ({
        reportId: x.code, verdict: x.verdict, status: x.status,
        basisFingerprint: `sha256:${String(x.basis_fingerprint)}`,
        summary: x.summary, finalizedBy: x.finalized_by ?? null, finalizedAt: x.finalized_at ?? null, createdAt: x.created_at,
      })),
    };
  }
}

async function lockReport(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: ReportRow[] }> }, projectId: string, code: string): Promise<ReportRow> {
  const r = await client.query(
    `SELECT r.* FROM tst_reports r JOIN tst_batches b ON b.id=r.batch_id
     WHERE b.project_id=$1 AND r.code=$2 FOR UPDATE OF r`, [projectId, code]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', '报告不存在', code);
  return r.rows[0];
}
