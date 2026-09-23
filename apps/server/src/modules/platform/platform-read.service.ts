import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';

/**
 * 平台只读汇总（M13；A02-4/5/6、A10-3/5；REQ-702/704/703/706/707）：
 * - 阶段准入实时求值（五阶段门禁，issues 缺口具体化；快照变化驱动落 projects.stage_gates）
 * - 任务中心 sys_tasks_view 聚合查询（跨域只读视图，无 import）
 * - 项目事件流 evd_events 游标分页
 * - 审计只读查询/导出（无改删端点，REQ-706）
 * - 用户最简（本地默认身份，REQ-707 分期）
 */

export interface StageIssue { code: string; message: string; target: string }
export interface StageResult { stage: string; ok: boolean; issues: StageIssue[] }

@Injectable()
export class PlatformReadService {
  onModuleInit(): void {
    // 阶段准入快照：仅当求值结果与存量不同才写（变化驱动，GET 求值不直接写）
    registerCommand('platform.stage_gates.snapshot', async (client, payload, ctx) => {
      const p = payload as { stages: StageResult[] };
      await client.query('UPDATE projects SET stage_gates=$2 WHERE id=$1', [ctx.projectId, JSON.stringify(p.stages)]);
      return { snapshotted: true };
    });
  }

  /** A02-4 五阶段准入门禁实时求值（REQ-702；缺口明示） */
  async stages(projectId: string, ctx: CommandContext): Promise<{ stages: StageResult[] }> {
    const pj = await query('SELECT stage_gates FROM projects WHERE id=$1', [projectId]);
    if (!pj.rows[0]) throw new DomainError('NOT_FOUND', '项目不存在', projectId);

    const [mat, prd, rtm, dsg, dev, tst] = await Promise.all([
      query<{ n: number }>("SELECT count(*)::int AS n FROM mat_files WHERE project_id=$1 AND parse_status='content_final'", [projectId]),
      query<{ n: number }>("SELECT count(*)::int AS n FROM req_documents WHERE project_id=$1 AND doc_kind='prd' AND final_version_id IS NOT NULL", [projectId]),
      query<{ passed: boolean }>('SELECT passed FROM rtm_health WHERE project_id=$1 ORDER BY measured_at DESC LIMIT 1', [projectId]),
      query<{ n: number }>('SELECT count(*)::int AS n FROM dsg_baselines WHERE project_id=$1 AND valid', [projectId]),
      query<{ n: number }>("SELECT count(*)::int AS n FROM dev_builds WHERE project_id=$1 AND status='pass'", [projectId]),
      query<{ n: number }>("SELECT count(*)::int AS n FROM tst_batches WHERE project_id=$1 AND status='released'", [projectId]),
    ]);

    const stages: StageResult[] = [
      {
        stage: 'material', ok: mat.rows[0]!.n > 0,
        issues: mat.rows[0]!.n > 0 ? [] : [{ code: 'MATERIAL_EMPTY', message: '无定稿资料（content_final）', target: 'material' }],
      },
      {
        stage: 'req',
        ok: prd.rows[0]!.n > 0 && (rtm.rows[0]?.passed ?? false),
        issues: [
          ...(prd.rows[0]!.n > 0 ? [] : [{ code: 'PRD_NOT_FINAL', message: 'PRD 未定稿', target: 'req' }]),
          ...(rtm.rows[0] && !rtm.rows[0].passed ? [{ code: 'RTM_HEALTH', message: 'RTM 健康度未达标', target: 'rtm' }] : []),
          ...(!rtm.rows[0] && prd.rows[0]!.n > 0 ? [{ code: 'RTM_HEALTH', message: '无 RTM 健康度测量', target: 'rtm' }] : []),
        ],
      },
      {
        stage: 'design', ok: dsg.rows[0]!.n > 0,
        issues: dsg.rows[0]!.n > 0 ? [] : [{ code: 'BASELINE_MISSING', message: '无有效设计基线', target: 'design' }],
      },
      {
        stage: 'dev', ok: dev.rows[0]!.n > 0,
        issues: dev.rows[0]!.n > 0 ? [] : [{ code: 'BUILD_MISSING', message: '无合格构建（pass）', target: 'dev' }],
      },
      {
        stage: 'test', ok: tst.rows[0]!.n > 0,
        issues: tst.rows[0]!.n > 0 ? [] : [{ code: 'RELEASE_MISSING', message: '无放行批次（released）', target: 'test' }],
      },
    ];

    // 变化驱动快照（D03-1：最近一次求值快照；GET 不直接写库，经命令留痕）
    // jsonb 会重排键序，比较须按键排序的稳定序列化，否则每次求值都误判"有变化"
    if (stableStringify(pj.rows[0].stage_gates ?? {}) !== stableStringify(stages)) {
      await executeCommand('platform.stage_gates.snapshot', { stages }, { ...ctx, projectId });
    }
    return { stages };
  }

  /** A02-5 任务中心（REQ-704 判定句：计数=各阶段已产生 Task 总数；行跳回所属阶段由 stage 字段承载） */
  async tasks(projectId: string, q: { stage?: string; status?: string; page?: number; pageSize?: number }) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (q.stage) { params.push(q.stage); where += ` AND stage=$${params.length}`; }
    if (q.status) { params.push(q.status); where += ` AND status=$${params.length}`; }
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const total = await query<{ n: number }>(`SELECT count(*)::int AS n FROM sys_tasks_view WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const r = await query<{
      id: string; stage: string; code: string; title: string; status: string;
      owner: string | null; created_at: string; updated_at: string | null;
    }>(
      `SELECT id, stage, code, title, status, owner, created_at, updated_at FROM sys_tasks_view
       WHERE ${where} ORDER BY coalesce(updated_at, created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    const items = r.rows.map((t) => ({
      id: t.id, stage: t.stage, code: t.code, title: t.title, status: t.status,
      owner: t.owner, createdAt: t.created_at, updatedAt: t.updated_at ?? t.created_at,
    }));
    return { items, total: total.rows[0]!.n, page, pageSize };
  }

  /** A02-6 项目事件流（evd_events 直读，游标分页） */
  async events(projectId: string, q: { cursor?: string; limit?: number }) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (q.cursor) { params.push(q.cursor); where += ` AND created_at < $${params.length}`; }
    params.push((q.limit ?? 30) + 1);
    const r = await query<{ id: string; kind: string; payload: unknown; actor_id: string; created_at: string }>(
      `SELECT id, kind, payload, actor_id, created_at FROM evd_events WHERE ${where}
       ORDER BY created_at DESC LIMIT $${params.length}`, params);
    const items = r.rows.slice(0, q.limit ?? 30).map((e) => ({
      id: e.id, type: e.kind, text: JSON.stringify(e.payload), at: e.created_at, actor: e.actor_id,
    }));
    return { items, nextCursor: r.rows.length > (q.limit ?? 30) ? items[items.length - 1]!.at : null };
  }

  /** A10-3 审计只读查询（REQ-706：哈希链追加存储，无改删端点） */
  async audit(q: { projectId?: string; actor?: string; command?: string; cursor?: string; limit?: number }) {
    const params: unknown[] = [];
    let where = 'true';
    if (q.projectId) { params.push(q.projectId); where += ` AND project_id=$${params.length}`; }
    if (q.actor) { params.push(q.actor); where += ` AND actor_id=$${params.length}`; }
    if (q.command) { params.push(q.command); where += ` AND command=$${params.length}`; }
    if (q.cursor) { params.push(Number(q.cursor)); where += ` AND seq < $${params.length}`; }
    params.push((q.limit ?? 50) + 1);
    const r = await query<{
      seq: string; project_id: string | null; actor_kind: string; actor_id: string;
      command: string; payload: unknown; prev_hash: string | null; hash: string; created_at: string;
    }>(`SELECT * FROM audit_log WHERE ${where} ORDER BY seq DESC LIMIT $${params.length}`, params);
    const items = r.rows.slice(0, q.limit ?? 50).map((row) => ({
      eventId: `aud_${row.seq}`, actor: row.actor_id, actorType: row.actor_kind,
      command: row.command, inputFingerprint: fingerprintOf(row.payload),
      result: 'ok', at: row.created_at, hashChainPrev: row.prev_hash ? `sha256:${row.prev_hash}` : null,
      projectId: row.project_id, hash: `sha256:${row.hash}`,
    }));
    return { items, nextCursor: r.rows.length > (q.limit ?? 50) ? r.rows[(q.limit ?? 50) - 1]!.seq : null };
  }

  /** A10-3 导出（只读副本，JSON 下载；导出不改库） */
  async auditExport(q: { projectId?: string }) {
    const params: unknown[] = [];
    let where = 'true';
    if (q.projectId) { params.push(q.projectId); where += ` AND project_id=$${params.length}`; }
    const r = await query(`SELECT * FROM audit_log WHERE ${where} ORDER BY seq`, params);
    return { exportedAt: new Date().toISOString(), count: r.rowCount, items: r.rows };
  }

  /** A10-5 用户最简（本地默认身份；REQ-707 分期，多用户后续扩展） */
  users() {
    return { items: [{ id: 'local', name: '本地工程师', role: 'engineer', source: 'local' }] };
  }
}

/** 审计行的输入指纹：payload 规范化 sha256（BR-01；与链上 hash 同算法不同输入） */
function fingerprintOf(payload: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex')}`;
}

/** 键序稳定序列化（jsonb 读回键序会变，快照比对用） */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
