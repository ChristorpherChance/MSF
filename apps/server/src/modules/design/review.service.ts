import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';

/**
 * 设计评审项（A05-3；REQ-303）。
 * 首访种子三条 DR（mock 评审规则，M6 真接后由自检评审产出）；conclude 留痕结论。
 */

const SEED: Array<{ code: string; severity: '高' | '中' | '低'; docKind: string; text: string }> = [
  { code: 'DR-01', severity: '高', docKind: 'api', text: '接口册覆盖全部外部交互（端点清单与页面操作一一对应）' },
  { code: 'DR-02', severity: '中', docKind: 'db', text: '数据库册 append-only 清单与 LLD-4 §4 总则一致' },
  { code: 'DR-03', severity: '中', docKind: 'ui', text: 'UI 册页面清单与原型目录一致（无孤儿页面）' },
];

@Injectable()
export class ReviewService {
  onModuleInit(): void {
    registerCommand('design.review.seed', async (client, payload, ctx) => {
      const { projectId } = payload as { projectId: string };
      const existing = await client.query('SELECT 1 FROM dsg_reviews WHERE project_id=$1 LIMIT 1', [projectId]);
      if (existing.rows[0]) return { seeded: false };
      for (const s of SEED) {
        await client.query(
          'INSERT INTO dsg_reviews (project_id, code, severity, doc_kind, text, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
          [projectId, s.code, s.severity, s.docKind, s.text, ctx.actorId],
        );
      }
      return { seeded: true, count: SEED.length };
    });

    registerCommand('design.review.conclude', async (client, payload, ctx) => {
      const { projectId, drId, conclusion, note } = payload as {
        projectId: string; drId: string; conclusion: 'pass' | 'fail' | 'na'; note?: string;
      };
      if (!['pass', 'fail', 'na'].includes(conclusion)) {
        throw new DomainError('VALIDATION_FAILED', '结论枚举 pass|fail|na', 'conclusion');
      }
      const r = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM dsg_reviews WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, drId]);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND', '评审项不存在', drId);
      await client.query(
        "UPDATE dsg_reviews SET status='done', resolution=$3, updated_by=$4, updated_at=now() WHERE id=$1 AND project_id=$2",
        [r.rows[0].id, projectId, `${conclusion}${note ? `：${note}` : ''}`, ctx.actorId],
      );
      return { id: drId, conclusion };
    });
  }

  /** A05-3 列表（首访种子） */
  async list(projectId: string, ctx: CommandContext): Promise<unknown> {
    const seeded = await query('SELECT 1 FROM dsg_reviews WHERE project_id=$1 LIMIT 1', [projectId]);
    if (!seeded.rows[0]) {
      await executeCommand('design.review.seed', { projectId }, { ...ctx, projectId });
    }
    const r = await query<{
      code: string; severity: string; doc_kind: string; text: string;
      status: string; resolution: string | null; updated_at: string | null;
    }>('SELECT * FROM dsg_reviews WHERE project_id=$1 ORDER BY code', [projectId]);
    return {
      items: r.rows.map((x) => ({
        id: x.code, severity: x.severity, docKind: x.doc_kind, item: x.text,
        status: x.status, conclusion: x.resolution, at: x.updated_at,
      })),
    };
  }

  async conclude(projectId: string, drId: string, conclusion: 'pass' | 'fail' | 'na', note: string | undefined, ctx: CommandContext) {
    return executeCommand('design.review.conclude', { projectId, drId, conclusion, note }, { ...ctx, projectId });
  }
}
