import { createHash } from 'node:crypto';
import { fingerprint } from '@msf/shared';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { deriveLinks, computeHealth } from '../platform/rtm-health.js';
import { designContents } from '../platform/doc-contents.js';

/** 开发域门禁公共件（跨域禁令：不 import design/req 服务，经 SQL 直读他域表 + platform 纯函数） */

export interface GateIssue { code: string; message: string; target?: string | undefined }

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

type Q = <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
export const qof = (client: PoolClient | null): Q =>
  (client ? client.query.bind(client) : query) as unknown as Q;

/** 最新设计基线行 */
export async function latestBaseline(client: PoolClient | null, projectId: string) {
  const q = qof(client);
  const r = await q<{
    id: string; code: string; items: Array<{ artifact: string; version_id: string | null; fingerprint: string | null }>;
    baseline_fingerprint: string; valid: boolean; confirmed_at: string;
  }>('SELECT * FROM dsg_baselines WHERE project_id=$1 ORDER BY confirmed_at DESC LIMIT 1', [projectId]);
  return r.rows[0] ?? null;
}

/** 实时重算基线工件组合（与 design 域 baselineItems 同口径，SQL 直读；W2-043 提取供重确认重登复用） */
export async function liveBaselineItems(client: PoolClient | null, projectId: string) {
  const q = qof(client);
  const items: Array<{ artifact: string; version_id: string | null; fingerprint: string | null; required: boolean }> = [];
  // W3-005：HLD finalOnly=true（解锁即失效）；required 为既有指纹口径（HLD=false），与 finalOnly 解耦
  const sources = [
    { artifact: 'PRD', table: 'req_documents', vtable: 'req_versions', kind: 'prd', finalOnly: true, required: true },
    { artifact: 'HLD', table: 'dsg_documents', vtable: 'dsg_versions', kind: 'hld', finalOnly: true, required: false },
  ];
  for (const s of sources) {
    const r = await q<{ id: string; fp: string }>(
      `SELECT v.id, v.content_fingerprint AS fp FROM ${s.table} d
       JOIN ${s.vtable} v ON v.id = ${s.finalOnly ? 'd.final_version_id' : 'COALESCE(d.final_version_id, d.current_version_id)'}
       WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, s.kind]);
    items.push({ artifact: s.artifact, version_id: r.rows[0]?.id ?? null, fingerprint: r.rows[0]?.fp ?? null, required: s.required });
  }
  const proto = await q<{ id: string; fp: string }>(
    `SELECT v.id, v.content_fingerprint AS fp FROM dsg_documents d JOIN dsg_versions v ON v.id=d.final_version_id
     WHERE d.project_id=$1 AND d.doc_kind='prototype'`, [projectId]);
  items.push({ artifact: 'PROTOTYPE', version_id: proto.rows[0]?.id ?? null, fingerprint: proto.rows[0]?.fp ?? null, required: true });
  return items;
}

/** 实时基线指纹（liveBaselineItems 的指纹投影） */
export async function liveBaselineFingerprint(client: PoolClient | null, projectId: string): Promise<string | null> {
  return fingerprint({ items: await liveBaselineItems(client, projectId) });
}

/** develop 门禁（REQ-310：基线有效 ∧ L0c=100%；§15(a)/(e) 子码） */
export async function developGateIssues(client: PoolClient | null, projectId: string): Promise<GateIssue[]> {
  const q = qof(client);
  const issues: GateIssue[] = [];
  const bl = await latestBaseline(client, projectId);
  if (!bl) {
    issues.push({ code: 'BASELINE_REQUIRED', message: '尚无设计基线' });
  } else {
    const live = await liveBaselineFingerprint(client, projectId);
    if (!bl.valid || live !== bl.baseline_fingerprint) {
      issues.push({ code: 'BASELINE_STALE', message: '共同设计基线已过期', target: bl.code });
    }
  }
  const docs = await q<{ doc_kind: string; content: string | null }>(
    `SELECT d.doc_kind, v.content FROM req_documents d
     LEFT JOIN req_versions v ON v.id=d.current_version_id WHERE d.project_id=$1`, [projectId]);
  const crd = docs.rows.find((x) => x.doc_kind === 'crd')?.content ?? '';
  const prd = docs.rows.find((x) => x.doc_kind === 'prd')?.content ?? '';
  const { nodes } = deriveLinks(crd, prd, await designContents(client, projectId));
  const links = await q<{ from_kind: string; from_code: string; to_kind: string; to_code: string; relation: string }>(
    'SELECT from_kind, from_code, to_kind, to_code, relation FROM rtm_links WHERE project_id=$1', [projectId]);
  const h = computeHealth(nodes, links.rows);
  if (h.l0c < 1) {
    for (const g of h.gaps.filter((x) => x.code === 'L0C_BELOW')) {
      issues.push({ code: 'L0C_BELOW', message: g.message, target: g.target });
    }
    if (h.gaps.every((x) => x.code !== 'L0C_BELOW')) {
      issues.push({ code: 'RTM_HEALTH', message: `L0c=${(h.l0c * 100).toFixed(1)}% < 100%` });
    }
  }
  return issues;
}
