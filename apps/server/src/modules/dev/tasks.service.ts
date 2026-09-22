import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { developGateIssues, latestBaseline } from './gate-common.js';

/**
 * 任务识别与任务池（A06-1~5；REQ-401/402/403）。
 * mock 识别口径：设计目录页面条目 → frontend 任务（逐页）+ common/integration 骨架任务；
 * 任务规格字段全量（kind/owner/scope/writeScopes/deps/acceptance/quality，REQ-402）；
 * 识别幂等：同基线指纹重复识别不产生重复任务（已存在的 code 跳过）。
 */
@Injectable()
export class DevTasksService {
  onModuleInit(): void {
    // A06-1 任务识别（前置 develop 门禁；绑定输入身份 REQ-420）
    registerCommand('dev.identify.complete', async (client, payload, ctx) => {
      const { projectId, baselineId, baselineFingerprint } = payload as {
        projectId: string; baselineId: string; baselineFingerprint: string;
      };
      const issues = await developGateIssues(client, projectId);
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '任务识别门禁未通过', 'dev', { issues });
      const bl = await latestBaseline(client, projectId);
      if (!bl || bl.id !== baselineId || `sha256:${bl.baseline_fingerprint}` !== baselineFingerprint) {
        throw new DomainError('STALE_EVIDENCE', '基线身份与当前有效基线不符', baselineId);
      }
      const cat = await client.query<{ catalog_version: string }>(
        'SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY catalog_version DESC LIMIT 1',
        [projectId]);
      const catVer = cat.rows[0]?.catalog_version;
      if (!catVer) throw new DomainError('GATE_BLOCKED', '无设计目录', 'dev', { issues: [{ code: 'PLAN_REQUIRED', message: '无设计目录' }] });
      const items = await client.query<{ item_type: string; code: string; payload: Record<string, unknown> }>(
        'SELECT item_type, code, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY code',
        [projectId, catVer]);
      const existing = await client.query<{ title: string }>(
        'SELECT title FROM dev_tasks WHERE project_id=$1', [projectId]);
      const have = new Set(existing.rows.map((r) => r.title));
      const inputArtifacts = bl.items.map((i) => ({ doc_kind: i.artifact, version_id: i.version_id, fingerprint: i.fingerprint }));

      const specs = buildTaskSpecs(items.rows);
      let identified = 0;
      const taskIds: string[] = [];
      let seq = (await client.query<{ n: string }>('SELECT count(*) AS n FROM dev_tasks WHERE project_id=$1', [projectId])).rows[0]?.n ?? '0';
      for (const s of specs) {
        if (have.has(s.title)) continue; // 识别幂等：同基线重复识别不产生重复任务
        seq = String(Number(seq) + 1);
        const code = `T-${String(seq).padStart(3, '0')}`;
        await client.query(
          `INSERT INTO dev_tasks (project_id, code, title, kind, owner, asg_type, goal, scope, boundary,
             source_ids, input_artifacts, work, inputs, deliverables, acceptance, quality, deps, write_scopes, batch_no, effort, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [projectId, code, s.title, s.kind, 'mock-agent', s.asgType, s.goal, s.scope, s.boundary,
            JSON.stringify(s.sourceIds), JSON.stringify(inputArtifacts), JSON.stringify(s.work),
            JSON.stringify(s.inputs), JSON.stringify(s.deliverables), JSON.stringify(s.acceptance),
            JSON.stringify(s.quality), JSON.stringify(s.deps), JSON.stringify(s.writeScopes),
            s.batchNo, s.effort, ctx.actorId],
        );
        identified++;
        taskIds.push(code);
      }
      return { identified, taskIds, poolRevision: Number(seq) };
    });

    // 任务规格编辑（排队中可编辑；运行/评审/合并须先返工，LLD-6 §3.5）
    registerCommand('dev.task.save', async (client, payload, ctx) => {
      const { projectId, taskId, title, goal, scope, boundary, acceptance, writeScopes, deps } = payload as {
        projectId: string; taskId: string; title?: string; goal?: string; scope?: string; boundary?: string;
        acceptance?: unknown[]; writeScopes?: string[]; deps?: string[];
      };
      const t = await client.query<{ id: string; col: string }>(
        'SELECT * FROM dev_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE', [taskId, projectId]);
      if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
      if (t.rows[0].col !== 'queue') {
        throw new DomainError('INVALID_STATE', '仅排队中任务可编辑规格；运行/评审/合并须先返工', taskId);
      }
      await client.query(
        `UPDATE dev_tasks SET title=COALESCE($3,title), goal=COALESCE($4,goal), scope=COALESCE($5,scope),
           boundary=COALESCE($6,boundary), acceptance=COALESCE($7,acceptance),
           write_scopes=COALESCE($8,write_scopes), deps=COALESCE($9,deps), updated_by=$10, updated_at=now()
         WHERE id=$1 AND project_id=$2`,
        [taskId, projectId, title ?? null, goal ?? null, scope ?? null, boundary ?? null,
          acceptance ? JSON.stringify(acceptance) : null, writeScopes ? JSON.stringify(writeScopes) : null,
          deps ? JSON.stringify(deps) : null, ctx.actorId],
      );
      return { id: taskId };
    });

    // 覆盖核对确认（单条/全部；REQ-403）
    const confirmCoverage = async (client: PoolClient, projectId: string, taskId: string, itemId: string | null, by: string) => {
      const t = await client.query<{ coverage: Array<{ item_id: string; status: string; task_rev: number }>; rev: number }>(
        'SELECT coverage, rev FROM dev_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE', [taskId, projectId]);
      if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
      const cov = t.rows[0].coverage.map((c) =>
        itemId === null || c.item_id === itemId ? { ...c, status: 'confirmed', task_rev: t.rows[0]!.rev } : c);
      await client.query('UPDATE dev_tasks SET coverage=$3, updated_by=$4, updated_at=now() WHERE id=$1 AND project_id=$2',
        [taskId, projectId, JSON.stringify(cov), by]);
      return { id: taskId, confirmed: itemId ?? 'all' };
    };
    registerCommand('dev.coverage.confirm', async (client, payload, ctx) => {
      const { projectId, taskId, itemId } = payload as { projectId: string; taskId: string; itemId: string };
      return confirmCoverage(client, projectId, taskId, itemId, ctx.actorId);
    });
    registerCommand('dev.coverage.confirm-all', async (client, payload, ctx) => {
      const { projectId, taskId } = payload as { projectId: string; taskId: string };
      return confirmCoverage(client, projectId, taskId, null, ctx.actorId);
    });
  }

  // ---------- 命令入口 ----------

  async identify(projectId: string, baselineId: string, baselineFingerprint: string, ctx: CommandContext) {
    return executeCommand('dev.identify.complete', { projectId, baselineId, baselineFingerprint }, { ...ctx, projectId });
  }

  async saveTask(projectId: string, taskId: string, patch: Record<string, unknown>, ctx: CommandContext) {
    return executeCommand('dev.task.save', { projectId, taskId, ...patch }, { ...ctx, projectId });
  }

  async confirmCoverage(projectId: string, taskId: string, itemId: string | null, ctx: CommandContext) {
    return executeCommand(itemId ? 'dev.coverage.confirm' : 'dev.coverage.confirm-all',
      itemId ? { projectId, taskId, itemId } : { projectId, taskId }, { ...ctx, projectId });
  }

  // ---------- 查询面 ----------

  /** A06-2 任务池查询 */
  async list(projectId: string, col?: string) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1 AND archived=false AND excluded=false';
    if (col) {
      params.push(col.split(','));
      where += ' AND col = ANY($2)';
    }
    const r = await query(
      `SELECT id, code, title, kind, owner, asg_type, col, run_status, prog, blocked, blocked_reason,
              rev, code_rev, batch_no, deps, write_scopes, quality, source_ids, acceptance
       FROM dev_tasks WHERE ${where} ORDER BY batch_no NULLS LAST, code`, params);
    return { items: r.rows.map((t) => this.toView(t as Record<string, unknown>)), total: r.rows.length };
  }

  /** A06-3 任务详情（规格全字段+证据+PR+反查设计项） */
  async detail(projectId: string, taskId: string) {
    const t = await query('SELECT * FROM dev_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId]);
    if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
    const prs = await query(
      'SELECT code_rev, pr_ref, status, checklist, merge_basis, commit_id, created_at FROM dev_prs WHERE task_id=$1 ORDER BY code_rev DESC',
      [taskId]);
    const evd = await query(
      `SELECT seq, kind, payload, created_at FROM evd_records
       WHERE project_id=$1 AND payload->>'taskId'=$2 ORDER BY created_at DESC LIMIT 20`,
      [projectId, taskId]);
    const ci = await query(
      `SELECT commit_sha, conclusion, matched, received_at FROM dev_ci_reports
       WHERE project_id=$1 AND task_codes ? (SELECT code FROM dev_tasks WHERE id=$2)
       ORDER BY received_at DESC LIMIT 5`,
      [projectId, taskId]);
    return { ...this.toView(t.rows[0] as Record<string, unknown>, true), prs: prs.rows, evidence: evd.rows, ci: ci.rows };
  }

  /** A06-4 写入范围冲突（与进行中任务重叠可检出） */
  async conflicts(projectId: string) {
    const r = await query<{ write_scopes: string[]; code: string; col: string }>(
      "SELECT code, col, write_scopes FROM dev_tasks WHERE project_id=$1 AND col='ing'", [projectId]);
    const byScope = new Map<string, string[]>();
    for (const t of r.rows) {
      for (const s of t.write_scopes) {
        byScope.set(s, [...(byScope.get(s) ?? []), t.code]);
      }
    }
    const conflicts = [...byScope.entries()]
      .filter(([, codes]) => codes.length > 1)
      .map(([writeScope, taskIds]) => ({ writeScope, taskIds }));
    return { conflicts };
  }

  /** A06-5 计划覆盖检查（设计项 ↔ 任务双向；缺口可见） */
  async coverage(projectId: string): Promise<{ ok: boolean; uncoveredDesignItems: string[]; unmatchedTasks: string[] }> {
    const cat = await query<{ catalog_version: string }>(
      'SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY catalog_version DESC LIMIT 1', [projectId]);
    const catVer = cat.rows[0]?.catalog_version ?? null;
    const items = catVer
      ? await query<{ code: string }>(
          "SELECT code FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 AND item_type IN ('page','flow')",
          [projectId, catVer])
      : { rows: [] as Array<{ code: string }> };
    const tasks = await query<{ code: string; source_ids: string[] }>(
      "SELECT code, source_ids FROM dev_tasks WHERE project_id=$1 AND archived=false AND excluded=false", [projectId]);
    const covered = new Set(tasks.rows.flatMap((t) => t.source_ids));
    const uncoveredDesignItems = items.rows.map((i) => i.code).filter((c) => !covered.has(c));
    const designCodes = new Set(items.rows.map((i) => i.code));
    const unmatchedTasks = tasks.rows
      .filter((t) => t.source_ids.length > 0 && t.source_ids.every((s) => !designCodes.has(s)))
      .map((t) => t.code);
    return { ok: uncoveredDesignItems.length === 0 && unmatchedTasks.length === 0, uncoveredDesignItems, unmatchedTasks };
  }

  private toView(t: Record<string, unknown>, full = false) {
    const base = {
      id: t.id, code: t.code, title: t.title, kind: t.kind, owner: t.owner, ownerType: t.asg_type,
      col: t.col, runStatus: t.run_status, prog: t.prog,
      blocked: t.blocked, blockedReason: t.blocked_reason,
      rev: t.rev, codeRev: t.code_rev, batchNo: t.batch_no,
      deps: t.deps, writeScopes: t.write_scopes, sourceIds: t.source_ids,
      quality: t.quality, acceptance: t.acceptance,
    };
    if (!full) return base;
    return { ...base, goal: t.goal, scope: t.scope, boundary: t.boundary, work: t.work, inputs: t.inputs, deliverables: t.deliverables, inputArtifacts: t.input_artifacts, coverage: t.coverage };
  }
}

/** mock 任务规格派生：页面条目 → frontend 任务；骨架 common/integration（REQ-402 规格全字段） */
function buildTaskSpecs(items: Array<{ item_type: string; code: string; payload: Record<string, unknown> }>) {
  const pages = items.filter((i) => i.item_type === 'page');
  const flows = items.filter((i) => i.item_type === 'flow'); // 流程条目由端到端联调承接（覆盖闭环 REQ-403）
  const quality = {
    object: '单元测试', line: 80, branch: 70,
    scenarios: [
      { type: 'normal', applicable: true, case: '正常路径', expected: '通过', pass: false },
      { type: 'boundary', applicable: true, case: '边界输入', expected: '通过', pass: false },
      { type: 'exception', applicable: true, case: '异常处理', expected: '通过', pass: false },
    ],
  };
  const specs: Array<{
    title: string; kind: string; asgType: string; goal: string; scope: string; boundary: string;
    sourceIds: string[]; work: unknown[]; inputs: unknown[]; deliverables: unknown[]; acceptance: unknown[];
    quality: typeof quality; deps: string[]; writeScopes: string[]; batchNo: number; effort: string;
  }> = [];
  pages.forEach((p, i) => {
    specs.push({
      title: `页面实现：${(p.payload.title as string) ?? p.code}`,
      kind: 'frontend', asgType: 'agent',
      goal: `实现页面 ${p.code}`, scope: `src/pages/${p.code}`, boundary: '不改动共享组件库',
      sourceIds: [p.code],
      work: [`按目录定义实现 ${p.code} 页面与状态`],
      inputs: [p.code], deliverables: [`src/pages/${p.code}/index.tsx`],
      acceptance: [{ item: `页面 ${p.code} 渲染符合目录定义`, pass: false }],
      quality, deps: [], writeScopes: [`src/pages/${p.code}`], batchNo: 1 + Math.floor(i / 3), effort: 'M',
    });
  });
  specs.push({
    title: '平台基线接线', kind: 'common', asgType: 'agent',
    goal: '公共基础设施接线', scope: 'src/platform', boundary: '不动页面代码',
    sourceIds: [], work: ['公共模块'], inputs: [], deliverables: ['src/platform/index.ts'],
    acceptance: [{ item: '公共模块可用', pass: false }], quality, deps: [], writeScopes: ['src/platform'], batchNo: 1, effort: 'S',
  });
  specs.push({
    title: '端到端联调', kind: 'integration', asgType: 'agent',
    goal: '全链路联调', scope: 'e2e', boundary: '只读页面产物',
    sourceIds: flows.map((f) => f.code), work: ['联调与冒烟脚本'], inputs: flows.map((f) => f.code), deliverables: ['e2e/smoke.ts'],
    acceptance: [{ item: '冒烟通过', pass: false }], quality,
    deps: [], writeScopes: ['e2e'], batchNo: 99, effort: 'M',
  });
  return specs;
}
