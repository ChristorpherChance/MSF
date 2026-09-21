import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config.js';

/** 全局 pg 连接池（M0 直驱 pg；行锁/UNIQUE(prev_hash) 等并发控制需要原生 SQL） */
export const pool = new Pool({ connectionString: config.databaseUrl });

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> => pool.query<T>(text, params);

/** 命令事务载体：全部写操作在此回调内完成（BR-01/BR-04；失败整体回滚） */
export async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
