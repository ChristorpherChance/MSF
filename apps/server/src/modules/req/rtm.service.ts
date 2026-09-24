import { Injectable, Inject } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { ReqDocsService } from './docs.service.js';
import { deriveLinks } from '../platform/rtm-health.js';
import { designContents } from '../platform/doc-contents.js';

/**
 * RTM 查询与健康度门禁（A04-11/12，REQ-207/208/310）+ deferred 人工标记。
 * deferred 端点 LLD-5 未列（LLD-3 C10-2 有命令、LLD-6 §3.3 有按钮）——按 A04-14 补充实现，
 * 文档同步登记在 doc/dev-plan/M2-验收.md（T2-10）。
 */
@Injectable()
export class RtmService {
  constructor(@Inject(ReqDocsService) private readonly docs: ReqDocsService) {}

  onModuleInit(): void {
    // rtm.deferred.mark/unmark：自指标记行（from==to），记审计（经命令事务天然留痕）
    registerCommand('rtm.deferred.mark', async (client, payload, ctx) => {
      const { projectId, nodeKind, nodeCode, reason } = payload as {
        projectId: string; nodeKind: 'cr' | 'req'; nodeCode: string; reason: string;
      };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '标记 deferred 必须给理由', 'reason');
      const dup = await client.query(
        "SELECT 1 FROM rtm_links WHERE project_id=$1 AND from_kind=$2 AND from_code=$3 AND relation IN ('deferred','dropped')",
        [projectId, nodeKind, nodeCode],
      );
      if (dup.rows[0]) throw new DomainError('INVALID_STATE', '该节点已标记', nodeCode);
      await client.query(
        `INSERT INTO rtm_links (project_id, from_kind, from_code, to_kind, to_code, relation, created_by)
         VALUES ($1,$2,$3,$2,$3,'deferred',$4)`,
        [projectId, nodeKind, nodeCode, ctx.actorId],
      );
      return { nodeId: nodeCode, deferred: true };
    });

    registerCommand('rtm.deferred.unmark', async (client, payload) => {
      const { projectId, nodeKind, nodeCode } = payload as {
        projectId: string; nodeKind: 'cr' | 'req'; nodeCode: string;
      };
      const r = await client.query(
        "DELETE FROM rtm_links WHERE project_id=$1 AND from_kind=$2 AND from_code=$3 AND relation IN ('deferred','dropped')",
        [projectId, nodeKind, nodeCode],
      );
      if (r.rowCount === 0) throw new DomainError('INVALID_STATE', '该节点未标记', nodeCode);
      return { nodeId: nodeCode, deferred: false };
    });
  }

  /** A04-11 RTM 查询：rows（R 维度聚合链，含未覆盖孤立节点）+ deferred 清单 */
  async rtm(projectId: string): Promise<unknown> {
    const links = await query<{ from_kind: string; from_code: string; to_kind: string; to_code: string; relation: string }>(
      'SELECT from_kind, from_code, to_kind, to_code, relation FROM rtm_links WHERE project_id=$1', [projectId]);
    const { crd, prd } = await this.docs.currentContents(null, projectId);
    const { nodes } = deriveLinks(crd, prd, await designContents(null, projectId));
    const deferredSet = new Set(
      links.rows.filter((l) => l.relation === 'deferred' || l.relation === 'dropped').map((l) => l.from_code),
    );
    // R 维度行：R → 承接它的 CR → 承接 CR 的 REQ → REQ 的 DSG 锚点
    const rows = nodes.r.map((r) => {
      const crs = links.rows.filter((l) => l.relation === 'refines' && l.from_kind === 'r' && l.from_code === r).map((l) => l.to_code);
      const reqs = links.rows.filter((l) => l.relation === 'refines' && l.from_kind === 'cr' && crs.includes(l.from_code)).map((l) => l.to_code);
      const dsgs = links.rows.filter((l) => l.relation === 'implements' && reqs.includes(l.from_code)).map((l) => l.to_code);
      const state = deferredSet.has(r)
        ? 'deferred'
        : crs.length === 0
          ? 'uncovered'
          : reqs.length === 0
            ? 'partial'
            : 'covered';
      return { r, cr: crs, req: reqs, dsg: dsgs, state };
    });
    return { rows, deferred: [...deferredSet].sort() };
  }

  /** A04-12 健康度门禁：实时重算（F06-7 不用缓存值放行） */
  async health(projectId: string): Promise<unknown> {
    const h = await this.docs.computeLiveHealth(null, projectId);
    return {
      ok: h.ok,
      l0a: h.l0a,
      l0b: h.l0b,
      l0c: h.l0c,
      l0d: h.l0d,
      thresholds: { l0a: 0.95, l0b: 1.0, l0c: 1.0 },
      warnings: h.warnings,
      gaps: h.gaps,
      deferredItems: h.deferredItems,
      basisFingerprint: `sha256:${h.basisFingerprint}`,
    };
  }

  async markDeferred(projectId: string, nodeKind: 'cr' | 'req', nodeCode: string, reason: string, ctx: CommandContext) {
    return executeCommand('rtm.deferred.mark', { projectId, nodeKind, nodeCode, reason }, { ...ctx, projectId });
  }
  async unmarkDeferred(projectId: string, nodeKind: 'cr' | 'req', nodeCode: string, ctx: CommandContext) {
    return executeCommand('rtm.deferred.unmark', { projectId, nodeKind, nodeCode }, { ...ctx, projectId });
  }
}
