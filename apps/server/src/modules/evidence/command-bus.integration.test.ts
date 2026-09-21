/**
 * M11 冒烟集成测试（T0-08）：需要本地 postgres（docker compose up -d postgres && pnpm migrate）。
 * DB 不可达时整组跳过（CI 在起服务的 job 中运行）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { executeCommand, registerCommand, resetCommands } from './command-bus.js';

async function dbUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM audit_log LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('审计哈希链（集成，需 DB）', async () => {
  const up = await dbUp();
  if (!up) {
    it.skip('postgres 未就绪（docker compose up -d postgres && pnpm migrate）', () => {});
    return;
  }

  beforeAll(async () => {
    await query('TRUNCATE audit_log');
    resetCommands();
    registerCommand('health.ping', async () => ({ pong: true }));
  });
  afterAll(async () => {
    resetCommands();
    await pool.end();
  });

  it('命令执行 → 审计追加 1 行且链式正确', async () => {
    await executeCommand('health.ping', {}, { projectId: null, actorKind: 'human', actorId: 't' });
    await executeCommand('health.ping', {}, { projectId: null, actorKind: 'human', actorId: 't' });
    const r = await query<{ prev_hash: string | null; hash: string }>(
      'SELECT prev_hash, hash FROM audit_log ORDER BY seq',
    );
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]!.prev_hash).toBeNull();
    expect(r.rows[1]!.prev_hash).toBe(r.rows[0]!.hash);
  });

  it('处理器抛错 → 整体回滚零写（审计失败零写对称面）', async () => {
    registerCommand('platform.project.create', async () => {
      throw new Error('boom');
    });
    await expect(
      executeCommand('platform.project.create', { name: 'x' }, { projectId: null, actorKind: 'human', actorId: 't' }),
    ).rejects.toThrowError('boom');
    const r = await query('SELECT count(*)::int AS n FROM audit_log');
    expect(r.rows[0]!.n).toBe(2); // 仍是前两条，无部分写
  });
});
