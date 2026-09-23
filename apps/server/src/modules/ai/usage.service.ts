import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { registerCommand } from '../evidence/command-bus.js';

/**
 * UsageCollector 用量统计（DSG-D08-6；A08-10；REQ-612）：
 * - ai_usage 行由 ai.message.finish / 委派终结写入（price_table 兜底成本在写入侧完成）
 * - 本服务只读：项目用量查询 + 跨项目汇总（设置页用量面板）
 * - ai.usage.record：无消息载体的调用（文档生成等）经此命令落账（调用方在事务外完成流式后写入）
 */
@Injectable()
export class AiUsageService {
  onModuleInit(): void {
    registerCommand('ai.usage.record', async (client, payload) => {
      const p = payload as {
        projectId: string; modelId: string | null; purpose: string;
        tokensIn: number; tokensOut: number; durationMs: number; cost: number;
      };
      await client.query(
        `INSERT INTO ai_usage (project_id, session_id, message_id, model_id, purpose,
           tokens_in, tokens_out, duration_ms, cost)
         VALUES ($1,NULL,NULL,$2,$3,$4,$5,$6,$7)`,
        [p.projectId, p.modelId, p.purpose, p.tokensIn, p.tokensOut, p.durationMs, p.cost]);
      return { recorded: true };
    });
  }

  /** 项目用量明细（时间窗 + 用途过滤，游标分页） */
  async ofProject(projectId: string, q: { from?: string; to?: string; purpose?: string; cursor?: string; limit?: number }) {
    const params: unknown[] = [projectId];
    let where = 'u.project_id=$1';
    if (q.from) { params.push(q.from); where += ` AND u.created_at >= $${params.length}`; }
    if (q.to) { params.push(q.to); where += ` AND u.created_at < $${params.length}`; }
    if (q.purpose) { params.push(q.purpose); where += ` AND u.purpose = $${params.length}`; }
    if (q.cursor) { params.push(q.cursor); where += ` AND u.created_at < $${params.length}`; }
    const limit = q.limit ?? 50;
    params.push(limit + 1);
    const r = await query(
      `SELECT u.id, u.purpose, u.tokens_in, u.tokens_out, u.duration_ms, u.cost, u.created_at,
              m.name AS model_name, u.session_id, u.delegation_id
       FROM ai_usage u JOIN ai_models m ON m.id = u.model_id
       WHERE ${where} ORDER BY u.created_at DESC LIMIT $${params.length}`, params);
    const rows = r.rows.slice(0, limit) as Array<{ created_at: string }>;
    const sum = await query(
      `SELECT coalesce(sum(u.tokens_in),0) AS tokens_in, coalesce(sum(u.tokens_out),0) AS tokens_out,
              coalesce(sum(u.cost),0) AS cost, count(*) AS calls
       FROM ai_usage u WHERE u.project_id=$1`, [projectId]);
    return {
      items: rows,
      nextCursor: r.rows.length > limit ? rows[rows.length - 1]!.created_at : null,
      totals: sum.rows[0],
    };
  }

  /** 跨项目汇总（A08-10：按项目×模型分组）；month=current 仅当月（顶栏「本月成本」口径） */
  async summary(month?: 'current') {
    const where = month === 'current'
      ? "WHERE date_trunc('month', u.created_at) = date_trunc('month', now())"
      : '';
    const r = await query<{
      project_id: string | null; project_name: string | null; model_name: string; purpose: string;
      calls: string; tokens_in: string; tokens_out: string; cost: string;
    }>(
      `SELECT u.project_id, p.name AS project_name, m.name AS model_name, u.purpose,
              count(*) AS calls, sum(u.tokens_in) AS tokens_in, sum(u.tokens_out) AS tokens_out,
              sum(u.cost) AS cost
       FROM ai_usage u
       LEFT JOIN projects p ON p.id = u.project_id
       JOIN ai_models m ON m.id = u.model_id
       ${where}
       GROUP BY u.project_id, p.name, m.name, u.purpose
       ORDER BY cost DESC`, []);
    const totals = await query<{
      calls: string; tokens_in: string; tokens_out: string; cost: string;
    }>(
      `SELECT count(*) AS calls, coalesce(sum(tokens_in),0) AS tokens_in,
              coalesce(sum(tokens_out),0) AS tokens_out, coalesce(sum(cost),0) AS cost
       FROM ai_usage u ${where}`, []);
    return { items: r.rows, totals: totals.rows[0] };
  }

  /** 项目不存在时明确 404（避免空结果冒充零用量） */
  async assertProject(projectId: string): Promise<void> {
    const r = await query('SELECT 1 FROM projects WHERE id=$1', [projectId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '项目不存在', projectId);
  }
}
