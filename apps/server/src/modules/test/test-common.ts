import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';

/** 测试验收域共享件（DSG-D07；编号 TB/TP/AT/TR/AR/AD/DF 统稿 M5） */

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface BatchRow {
  id: string; project_id: string; code: string; handoff_fingerprint: string;
  handoff: Record<string, unknown>;
  build_snapshot: { build_id: string; build_fingerprint: string; ui_artifact_fingerprint?: string };
  dev_report_snapshot: { report_id: string; report_fingerprint: string; status: string };
  baseline_snapshot: { baseline_id: string; baseline_fingerprint: string };
  acceptance_terms: Record<string, unknown>;
  environment: Record<string, unknown>; environment_fingerprint: string;
  status: string; previous_status: string | null; blocked_reason: string | null;
  received_by: string; received_at: string;
}

export const qof = (client: PoolClient | null) =>
  client ? client.query.bind(client) : query;

/** 按业务编号锁批次（不存在 NOT_FOUND） */
export async function lockBatch(client: PoolClient, projectId: string, code: string): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    'SELECT * FROM tst_batches WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, code]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', '批次不存在', code);
  return r.rows[0];
}

export async function getBatch(client: PoolClient | null, projectId: string, code: string): Promise<BatchRow> {
  const r = await qof(client)<BatchRow>(
    'SELECT * FROM tst_batches WHERE project_id=$1 AND code=$2', [projectId, code]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', '批次不存在', code);
  return r.rows[0];
}

/** blocked 期间一切推进命令拒绝（F02-8 异常路径） */
export function assertNotBlocked(b: BatchRow): void {
  if (b.status === 'blocked') {
    throw new DomainError('INVALID_STATE', `批次 ${b.code} 处于阻断态（${b.blocked_reason ?? ''}），须先恢复`, b.code);
  }
}

/** 域内序列号：count+1 补零（W2-052：check-then-act——咨询锁串行化「计数→发号」；
 *  锁键含 where 参数集，粒度对齐调用方唯一约束维度（项目/批次）） */
export async function nextCode(client: PoolClient, table: string, where: string, params: unknown[], prefix: string, pad = 3): Promise<string> {
  await lockCodeGen(client, `msf:code:tst:${table}:${prefix}:${params.join(':')}`);
  const r = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return `${prefix}-${String(Number(r.rows[0]?.n ?? 0) + 1).padStart(pad, '0')}`;
}

/** 运行级结论三值聚合（BR-09 口径注记④）：any fail→fail；存在 not-run/blocked/not-applicable→blocked（未完成不美化）；else pass */
export function aggregateConclusion(results: string[]): 'pass' | 'fail' | 'blocked' {
  if (results.some((r) => r === 'fail')) return 'fail';
  if (results.some((r) => r === 'blocked' || r === 'not-run' || r === 'not-applicable')) return 'blocked';
  return 'pass';
}

/** 报告 basis 指纹：最新 run 的用例结果 + 批次缺陷状态（执行/缺陷任一变化则旧报告草稿需重新生成，REQ-508） */
export async function computeBasisFingerprint(client: PoolClient | null, batchId: string): Promise<string> {
  const q = qof(client);
  const run = await q<{ id: string }>(
    'SELECT id FROM tst_runs WHERE batch_id=$1 ORDER BY created_at DESC LIMIT 1', [batchId]);
  const cases = run.rows[0]
    ? await q<{ case_id: string; result: string; is_simulated: boolean }>(
        'SELECT case_id, result, is_simulated FROM tst_case_runs WHERE run_id=$1 ORDER BY case_id', [run.rows[0].id])
    : { rows: [] as Array<{ case_id: string; result: string; is_simulated: boolean }> };
  const defects = await q<{ code: string; status: string; severity: string | null }>(
    'SELECT code, status, severity FROM tst_defects WHERE batch_id=$1 ORDER BY code', [batchId]);
  return fingerprint(JSON.parse(JSON.stringify({
    runId: run.rows[0]?.id ?? null,
    cases: cases.rows, defects: defects.rows,
  })));
}
