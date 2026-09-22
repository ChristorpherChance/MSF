import { Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { nextCode, sha256hex } from './test-common.js';

interface DefectRow {
  id: string; project_id: string; code: string; batch_id: string; run_id: string; case_id: string | null;
  title: string; severity: string | null; status: string; assignee: string | null;
  rework_task_ids: unknown; linked_build_fingerprint: string | null;
  regression_evidence: { batchId?: string; runId?: string; caseId?: string; caseContentHash?: string } | null;
  regression_fingerprint: string | null; events: Array<Record<string, unknown>>;
}

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

/**
 * 缺陷五态闭环（A07-6/7/8/9；F02-10；REQ-506/507）。
 * 状态机 new → confirmed → fixing → pending_regression → closed；
 * reopened 是事件不是状态——回归失败回到 confirmed，不清历史（事件流追加）。
 * 关闭仅测试侧人工 + 回归证据指纹服务端复核（REGRESSION_EVIDENCE_MISMATCH / DEFECT_CLOSE_DENIED）。
 */
@Injectable()
export class TstDefectsService {
  onModuleInit(): void {
    // A07-6 缺陷创建（仅本批实际失败记录；runId+caseId UNIQUE 幂等）
    registerCommand('tst.defect.create', async (client, payload, ctx) => {
      const { projectId, batchId, runId, caseId, title, evidence } = payload as {
        projectId: string; batchId: string; runId: string; caseId: string; title?: string; evidence?: string;
      };
      if (!title?.trim()) throw new DomainError('VALIDATION_FAILED', '缺陷标题必填', 'title');
      if (!evidence?.trim()) throw new DomainError('EVIDENCE_REQUIRED', '缺陷登记必须附失败证据', 'evidence');
      const b = await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM tst_batches WHERE project_id=$1 AND code=$2', [projectId, batchId]);
      if (!b.rows[0]) throw new DomainError('NOT_FOUND', '批次不存在', batchId);
      const run = await client.query<{ id: string; batch_id: string; plan_id: string }>(
        'SELECT id, batch_id, plan_id FROM tst_runs WHERE batch_id=$1 AND code=$2', [b.rows[0].id, runId]);
      if (!run.rows[0]) throw new DomainError('NOT_FOUND', '运行不存在或不属本批', runId);
      const cs = await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM tst_cases WHERE plan_id=$1 AND code=$2', [run.rows[0].plan_id, caseId]);
      if (!cs.rows[0]) throw new DomainError('NOT_FOUND', '用例不存在', caseId);
      // 幂等：同 runId+caseId 已登记则直接返回既有缺陷
      const dup = await client.query<{ code: string; status: string }>(
        'SELECT code, status FROM tst_defects WHERE run_id=$1 AND case_id=$2', [run.rows[0].id, cs.rows[0].id]);
      if (dup.rows[0]) return { defectId: dup.rows[0].code, status: dup.rows[0].status, deduplicated: true };
      // 只能从本批实际失败记录创建
      const cr = await client.query<{ result: string }>(
        'SELECT result FROM tst_case_runs WHERE run_id=$1 AND case_id=$2', [run.rows[0].id, cs.rows[0].id]);
      if (cr.rows[0]?.result !== 'fail') {
        throw new DomainError('VALIDATION_FAILED', '缺陷只能从本批实际失败（fail）记录创建', caseId);
      }
      const code = await nextCode(client, 'tst_defects', 'project_id=$1', [projectId], 'DF');
      const events = [{ event: 'created', at: new Date().toISOString(), actor: ctx.actorId, evidence }];
      await client.query(
        `INSERT INTO tst_defects (project_id, code, batch_id, run_id, case_id, title, events, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, code, b.rows[0].id, run.rows[0].id, cs.rows[0].id, title, JSON.stringify(events), ctx.actorId]);
      return { defectId: code, status: 'new', deduplicated: false };
    });

    // A07-7 缺陷确认（定级）
    registerCommand('tst.defect.confirm', async (client, payload, ctx) => {
      const { projectId, defectId, severity, reason } = payload as {
        projectId: string; defectId: string; severity?: string; reason?: string;
      };
      if (!severity || !SEVERITIES.includes(severity)) {
        throw new DomainError('VALIDATION_FAILED', '严重度枚举 P0|P1|P2|P3', 'severity');
      }
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '确认依据必填', 'reason');
      const d = await lockDefect(client, projectId, defectId);
      if (d.status !== 'new') throw new DomainError('INVALID_STATE', `缺陷状态 ${d.status} 不可确认（仅 new）`, defectId);
      await appendEvent(client, d, { event: 'confirmed', actor: ctx.actorId, severity, reason });
      await client.query(
        'UPDATE tst_defects SET status=$3, severity=$4, updated_by=$5, updated_at=now() WHERE id=$1 AND project_id=$2',
        [d.id, projectId, 'confirmed', severity, ctx.actorId]);
      return { defectId, status: 'confirmed', severity };
    });

    // 修复开始（confirmed → fixing）
    registerCommand('tst.defect.fix-start', async (client, payload, ctx) => {
      const { projectId, defectId, assignee, reworkTaskIds } = payload as {
        projectId: string; defectId: string; assignee?: string; reworkTaskIds?: string[];
      };
      const d = await lockDefect(client, projectId, defectId);
      if (d.status !== 'confirmed') throw new DomainError('INVALID_STATE', `缺陷状态 ${d.status} 不可开始修复（仅 confirmed）`, defectId);
      await appendEvent(client, d, { event: 'fix-start', actor: ctx.actorId, assignee: assignee ?? null, reworkTaskIds: reworkTaskIds ?? [] });
      await client.query(
        'UPDATE tst_defects SET status=$3, assignee=$4, rework_task_ids=$5, updated_by=$6, updated_at=now() WHERE id=$1 AND project_id=$2',
        [d.id, projectId, 'fixing', assignee ?? null, JSON.stringify(reworkTaskIds ?? []), ctx.actorId]);
      return { defectId, status: 'fixing' };
    });

    // A07-8 开发侧标记待回归（fixing → pending_regression；新构建必须 ≠ 源批次构建；开发侧不能关闭）
    registerCommand('tst.defect.mark-fixed', async (client, payload, ctx) => {
      const { projectId, defectId, reworkTaskIds, newBuildFingerprint, note } = payload as {
        projectId: string; defectId: string; reworkTaskIds?: string[]; newBuildFingerprint?: string; note?: string;
      };
      if (!newBuildFingerprint?.trim()) {
        throw new DomainError('VALIDATION_FAILED', '待回归必须关联新构建指纹', 'newBuildFingerprint');
      }
      const d = await lockDefect(client, projectId, defectId);
      if (d.status !== 'fixing') throw new DomainError('INVALID_STATE', `缺陷状态 ${d.status} 不可标记待回归（仅 fixing）`, defectId);
      const srcBuild = await client.query<{ build_snapshot: { build_fingerprint?: string } }>(
        'SELECT build_snapshot FROM tst_batches WHERE id=$1', [d.batch_id]);
      const strip = (s: string) => s.replace(/^sha256:/, '');
      if (srcBuild.rows[0]?.build_snapshot?.build_fingerprint === strip(newBuildFingerprint)) {
        throw new DomainError('VALIDATION_FAILED', '新构建指纹与源批次构建相同，不构成交付修复', defectId);
      }
      await appendEvent(client, d, {
        event: 'mark-fixed', actor: ctx.actorId,
        newBuildFingerprint: strip(newBuildFingerprint), reworkTaskIds: reworkTaskIds ?? [], note: note ?? null,
      });
      await client.query(
        `UPDATE tst_defects SET status=$3, linked_build_fingerprint=$4,
           rework_task_ids=COALESCE($5, rework_task_ids), updated_by=$6, updated_at=now()
         WHERE id=$1 AND project_id=$2`,
        [d.id, projectId, 'pending_regression', strip(newBuildFingerprint),
          reworkTaskIds ? JSON.stringify(reworkTaskIds) : null, ctx.actorId]);
      return { defectId, status: 'pending_regression', linkedBuild: strip(newBuildFingerprint) };
    });

    // A07-9 关联回归证据（四要素：新批次≠源批次 / 构建指纹不同 / 同版用例 content_hash 一致 / 当前批 pass）
    registerCommand('tst.defect.link-regression', async (client, payload, ctx) => {
      const { projectId, defectId, batchId, runId, caseId } = payload as {
        projectId: string; defectId: string; batchId: string; runId: string; caseId: string;
      };
      const d = await lockDefect(client, projectId, defectId);
      if (d.status !== 'pending_regression') {
        throw new DomainError('INVALID_STATE', `缺陷状态 ${d.status} 不可关联回归（仅 pending_regression）`, defectId);
      }
      const nb = await client.query<{ id: string; build_snapshot: { build_fingerprint?: string } }>(
        'SELECT id, build_snapshot FROM tst_batches WHERE project_id=$1 AND code=$2', [projectId, batchId]);
      if (!nb.rows[0]) throw new DomainError('NOT_FOUND', '回归批次不存在', batchId);
      // 要素①：新批次 ≠ 源批次
      if (nb.rows[0].id === d.batch_id) {
        throw new DomainError('REGRESSION_EVIDENCE_MISMATCH', '回归证据①不成立：新批次须不同于源批次', defectId);
      }
      // 要素②：构建指纹不同（且即开发侧标记的新构建）
      const newFp = nb.rows[0].build_snapshot?.build_fingerprint ?? null;
      if (!newFp || newFp === (await srcBuildFp(client, d.batch_id))) {
        throw new DomainError('REGRESSION_EVIDENCE_MISMATCH', '回归证据②不成立：回归批次构建须与源批次构建不同', defectId);
      }
      if (d.linked_build_fingerprint && newFp !== d.linked_build_fingerprint) {
        throw new DomainError('REGRESSION_EVIDENCE_MISMATCH', '回归证据②不成立：回归批次构建非开发侧标记的新构建', defectId);
      }
      const run = await client.query<{ id: string; plan_id: string }>(
        'SELECT id, plan_id FROM tst_runs WHERE batch_id=$1 AND code=$2', [nb.rows[0].id, runId]);
      if (!run.rows[0]) throw new DomainError('NOT_FOUND', '回归运行不存在或不属该批', runId);
      const cs = await client.query<{ id: string; content_hash: string }>(
        'SELECT id, content_hash FROM tst_cases WHERE plan_id=$1 AND code=$2', [run.rows[0].plan_id, caseId]);
      if (!cs.rows[0]) throw new DomainError('NOT_FOUND', '回归用例不存在', caseId);
      // 要素③：同版用例（content_hash 与源用例一致）
      const srcCase = await client.query<{ content_hash: string }>('SELECT content_hash FROM tst_cases WHERE id=$1', [d.case_id]);
      if (srcCase.rows[0] && srcCase.rows[0].content_hash !== cs.rows[0].content_hash) {
        throw new DomainError('REGRESSION_EVIDENCE_MISMATCH', '回归证据③不成立：用例非同版（content_hash 不一致）', defectId);
      }
      // 要素④：当前批该用例 pass
      const cr = await client.query<{ result: string }>(
        'SELECT result FROM tst_case_runs WHERE run_id=$1 AND case_id=$2', [run.rows[0].id, cs.rows[0].id]);
      if (cr.rows[0]?.result !== 'pass') {
        throw new DomainError('REGRESSION_EVIDENCE_MISMATCH', '回归证据④不成立：回归记录须为当前批通过（pass）', defectId);
      }
      const regression = { batchId, runId, caseId, caseContentHash: cs.rows[0].content_hash };
      const regFp = sha256hex(fingerprint(JSON.parse(JSON.stringify({ defectId, ...regression }))));
      await appendEvent(client, d, { event: 'link-regression', actor: ctx.actorId, ...regression });
      await client.query(
        'UPDATE tst_defects SET regression_evidence=$3, regression_fingerprint=$4, updated_by=$5, updated_at=now() WHERE id=$1 AND project_id=$2',
        [d.id, projectId, JSON.stringify(regression), regFp, ctx.actorId]);
      return { defectId, status: 'pending_regression', regression };
    });

    // A07-9 关闭（仅测试侧人工 + 回归证据指纹服务端复核）
    registerCommand('tst.defect.close', async (client, payload, ctx) => {
      const { projectId, defectId } = payload as { projectId: string; defectId: string };
      if (ctx.actorKind !== 'human') {
        throw new DomainError('DEFECT_CLOSE_DENIED', '缺陷关闭仅测试侧人工，自动通道拒绝', defectId);
      }
      const d = await lockDefect(client, projectId, defectId);
      if (d.status !== 'pending_regression' || !d.regression_evidence || !d.regression_fingerprint) {
        throw new DomainError('DEFECT_CLOSE_DENIED', '关闭前置：须处于待回归且已关联回归证据', defectId);
      }
      const re = d.regression_evidence;
      const expect = sha256hex(fingerprint(JSON.parse(JSON.stringify({
        defectId, batchId: re.batchId, runId: re.runId, caseId: re.caseId, caseContentHash: re.caseContentHash,
      }))));
      if (expect !== d.regression_fingerprint) {
        throw new DomainError('REGRESSION_EVIDENCE_MISMATCH', '回归证据指纹复核不一致，拒绝关闭', defectId);
      }
      await appendEvent(client, d, { event: 'closed', actor: ctx.actorId });
      await client.query(
        'UPDATE tst_defects SET status=$3, closed_by=$4, closed_at=now(), updated_by=$4, updated_at=now() WHERE id=$1 AND project_id=$2',
        [d.id, projectId, 'closed', ctx.actorId]);
      return { defectId, status: 'closed' };
    });

    // A07-9 重开（reopened 是事件不是状态：回 confirmed，历史不清）
    registerCommand('tst.defect.reopen', async (client, payload, ctx) => {
      const { projectId, defectId, reason } = payload as { projectId: string; defectId: string; reason?: string };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '重开理由必填（回归失败证据）', 'reason');
      const d = await lockDefect(client, projectId, defectId);
      if (!['pending_regression', 'closed'].includes(d.status)) {
        throw new DomainError('INVALID_STATE', `缺陷状态 ${d.status} 不可重开（仅 pending_regression/closed）`, defectId);
      }
      await appendEvent(client, d, { event: 'reopened', actor: ctx.actorId, reason });
      await client.query(
        'UPDATE tst_defects SET status=$3, updated_by=$4, updated_at=now() WHERE id=$1 AND project_id=$2',
        [d.id, projectId, 'confirmed', ctx.actorId]);
      return { defectId, status: 'confirmed', event: 'reopened' };
    });
  }

  // ---------- 命令入口 ----------

  async create(projectId: string, body: { batchId: string; runId: string; caseId: string; title: string; evidence: string }, ctx: CommandContext) {
    return executeCommand('tst.defect.create', { projectId, ...body }, { ...ctx, projectId });
  }

  async confirm(projectId: string, defectId: string, body: { severity: string; reason: string }, ctx: CommandContext) {
    return executeCommand('tst.defect.confirm', { projectId, defectId, ...body }, { ...ctx, projectId });
  }

  async fixStart(projectId: string, defectId: string, body: { assignee?: string; reworkTaskIds?: string[] }, ctx: CommandContext) {
    return executeCommand('tst.defect.fix-start', { projectId, defectId, ...body }, { ...ctx, projectId });
  }

  async markFixed(projectId: string, defectId: string, body: { reworkTaskIds?: string[]; newBuildFingerprint: string; note?: string }, ctx: CommandContext) {
    return executeCommand('tst.defect.mark-fixed', { projectId, defectId, ...body }, { ...ctx, projectId });
  }

  async linkRegression(projectId: string, defectId: string, body: { batchId: string; runId: string; caseId: string }, ctx: CommandContext) {
    return executeCommand('tst.defect.link-regression', { projectId, defectId, ...body }, { ...ctx, projectId });
  }

  async close(projectId: string, defectId: string, ctx: CommandContext) {
    return executeCommand('tst.defect.close', { projectId, defectId }, { ...ctx, projectId });
  }

  async reopen(projectId: string, defectId: string, reason: string, ctx: CommandContext) {
    return executeCommand('tst.defect.reopen', { projectId, defectId, reason }, { ...ctx, projectId });
  }

  // ---------- 查询面 ----------

  /** A07-6 缺陷列表（status 逗号多值 / batchId 过滤） */
  async list(projectId: string, filter: { status?: string | undefined; batchId?: string | undefined }) {
    const params: unknown[] = [projectId];
    let sql = `SELECT d.code, d.title, d.severity, d.status, d.assignee, d.rework_task_ids, d.regression_evidence,
                      d.events, d.created_at, d.updated_at, b.code AS batch_code
               FROM tst_defects d JOIN tst_batches b ON b.id=d.batch_id
               WHERE d.project_id=$1`;
    if (filter.batchId) { params.push(filter.batchId); sql += ` AND b.code=$${params.length}`; }
    if (filter.status) {
      const sts = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
      params.push(sts); sql += ` AND d.status = ANY($${params.length})`;
    }
    sql += ' ORDER BY d.created_at DESC';
    const r = await query(sql, params);
    return {
      items: r.rows.map((d: Record<string, unknown>) => ({
        defectId: d.code, title: d.title, severity: d.severity, status: d.status,
        assignee: d.assignee, batchId: d.batch_code, reworkTaskIds: d.rework_task_ids,
        regression: d.regression_evidence ?? null,
        reopenedCount: ((d.events as Array<Record<string, unknown>>) ?? []).filter((e) => e.event === 'reopened').length,
        createdAt: d.created_at, updatedAt: d.updated_at,
      })),
    };
  }
}

async function lockDefect(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: DefectRow[] }> }, projectId: string, code: string): Promise<DefectRow> {
  const r = await client.query('SELECT * FROM tst_defects WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, code]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', '缺陷不存在', code);
  return r.rows[0];
}

async function srcBuildFp(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ build_snapshot: { build_fingerprint?: string } }> }> }, batchId: string): Promise<string | null> {
  const r = await client.query('SELECT build_snapshot FROM tst_batches WHERE id=$1', [batchId]);
  return r.rows[0]?.build_snapshot?.build_fingerprint ?? null;
}

async function appendEvent(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  d: DefectRow, event: Record<string, unknown>,
): Promise<void> {
  const events = [...(d.events ?? []), { ...event, at: new Date().toISOString() }];
  await client.query('UPDATE tst_defects SET events=$2 WHERE id=$1', [d.id, JSON.stringify(events)]);
}
