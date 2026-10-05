import { query } from '../../db/pool.js';

/**
 * 上游变更联动·滞后派生（2026-10-05 用户拍板：CRD 改了下游与 RTM 要跟着变）：
 * 纯只读派生、零 schema 变更——下游文档「上游已变·待复核」徽标与 dock 阶段 agent 联动提醒同源。
 *
 * 派生口径：下游有已提交版本，且上游当前版本 submitted_at 晚于下游当前版本 submitted_at → stale。
 * 下游从未提交版本=「未生成」而非「滞后」（不标）；上游无已提交版本不标。
 * RTM 锚点链本身已在 doc.commit-version / design 提交时自动重建（rebuildRtmLinks/rtm.rebuild），
 * 本模块只负责「内容可能滞后」的人因提醒层。
 * 链路：CRD→PRD→设计八册（CRD 变更经 PRD 滞后传导到设计侧，不跨级直标）。
 */

export interface UpstreamStaleInfo {
  stale: boolean;
  /** 上游当前版本号（stale 时用于文案：「CRD 已提交 v7」） */
  upstreamVersionNo?: number;
  upstreamAt?: string;
  /** 下游当前版本号 */
  downstreamVersionNo?: number;
}

/** CRD→PRD 滞后（同域表直读）；PRD 无版本行时 stale=false */
export async function reqPrdStale(projectId: string): Promise<UpstreamStaleInfo> {
  const r = await query<{
    up_v: number; up_at: string; down_v: number | null; down_at: string | null;
  }>(
    `SELECT uv.version_no AS up_v, uv.submitted_at AS up_at,
            dv.version_no AS down_v, dv.submitted_at AS down_at
     FROM req_documents up
     JOIN req_versions uv ON uv.id = up.current_version_id
     JOIN req_documents down ON down.project_id = up.project_id AND down.doc_kind = 'prd'
     LEFT JOIN req_versions dv ON dv.id = down.current_version_id
     WHERE up.project_id = $1 AND up.doc_kind = 'crd'`,
    [projectId]);
  const row = r.rows[0];
  if (!row || row.down_v === null) return { stale: false };
  return {
    stale: new Date(row.up_at) > new Date(row.down_at!),
    upstreamVersionNo: row.up_v,
    upstreamAt: row.up_at,
    downstreamVersionNo: row.down_v,
  };
}

/** PRD→设计八册滞后（跨域只读 req_*：设计册定稿以 PRD 为直接上游；prototype 有其 DIRTY 机制不在此列） */
export async function designBooksStale(projectId: string): Promise<Record<string, UpstreamStaleInfo>> {
  const prd = await query<{ v: number; at: string }>(
    `SELECT uv.version_no AS v, uv.submitted_at AS at
     FROM req_documents d JOIN req_versions uv ON uv.id = d.current_version_id
     WHERE d.project_id = $1 AND d.doc_kind = 'prd'`,
    [projectId]);
  const up = prd.rows[0];
  if (!up) return {};
  const books = await query<{ kind: string; v: number; at: string }>(
    `SELECT d.doc_kind AS kind, dv.version_no AS v, dv.submitted_at AS at
     FROM dsg_documents d JOIN dsg_versions dv ON dv.id = d.current_version_id
     WHERE d.project_id = $1 AND d.doc_kind != 'prototype'`,
    [projectId]);
  const out: Record<string, UpstreamStaleInfo> = {};
  for (const b of books.rows) {
    out[b.kind] = {
      stale: new Date(up.at) > new Date(b.at),
      upstreamVersionNo: up.v,
      upstreamAt: up.at,
      downstreamVersionNo: b.v,
    };
  }
  return out;
}
