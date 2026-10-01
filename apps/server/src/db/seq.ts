import type { PoolClient } from 'pg';

/**
 * 发号串行化（W2-052）：count/max+1 发号是 check-then-act——并行事务各读旧值同算下一号，
 * INSERT 撞唯一键 23505 裸 500（实证：并行委派 DLG-0003 撞键）。
 * 域级咨询锁（xact 范围，随事务提交释放）加在「计数→发号→插入」临界区之前：锁内计数必新鲜。
 * 锁键约定 `msf:code:<域>[:<维度>]`——同键串行、跨键并行；键粒度对齐唯一约束维度。
 */
export async function lockCodeGen(client: PoolClient, lockKey: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
}
