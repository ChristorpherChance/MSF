/**
 * 跨域文档正文直读（#15 反向派生公共输入）。
 * 跨域禁令下各领域不 import 他域服务，经此 SQL 直读 + platform 纯函数派生（gate-common 同口径）。
 */
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';

/** 设计各册当前提交版本正文（prototype 为 HTML 不扫） */
export async function designContents(
  client: PoolClient | null,
  projectId: string,
): Promise<Array<{ book: string; content: string }>> {
  const q = client ? client.query.bind(client) : query;
  const r = await q<{ doc_kind: string; content: string | null }>(
    `SELECT d.doc_kind, v.content FROM dsg_documents d
     LEFT JOIN dsg_versions v ON v.id=d.current_version_id
     WHERE d.project_id=$1 AND d.doc_kind!='prototype'`, [projectId]);
  return r.rows.filter((x) => x.content).map((x) => ({ book: x.doc_kind, content: x.content! }));
}
