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

  beforeAll(() => {
    resetCommands();
    registerCommand('health.ping', async () => ({ pong: true }));
  });
  afterAll(async () => {
    resetCommands();
    await pool.end();
  });

  it('命令执行 → 审计追加 1 行且链式正确', async () => {
    // 并发共库下只数本文件独占的 health.ping 行，避免他文件插入干扰
    const b = await query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE command='health.ping'");
    await executeCommand('health.ping', {}, { projectId: null, actorKind: 'human', actorId: 't' });
    const a = await query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE command='health.ping'");
    expect(a.rows[0]!.n - b.rows[0]!.n).toBe(1);
    // 多测试文件并发共库会交错插入，改为验证全局不变量：每行 prev_hash = 前一行 hash
    const bad = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT prev_hash, lag(hash) OVER (ORDER BY seq) AS ph FROM audit_log
       ) t WHERE prev_hash IS DISTINCT FROM ph`,
    );
    expect(bad.rows[0]!.n).toBe(0);
  });

  it('处理器抛错 → 整体回滚零写（审计失败零写对称面）', async () => {
    registerCommand('platform.project.create', async () => {
      throw new Error('boom');
    });
    const marker = `boom-${Date.now()}`;
    await expect(
      executeCommand('platform.project.create', { name: marker }, { projectId: null, actorKind: 'human', actorId: 't' }),
    ).rejects.toThrowError('boom');
    const r = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE payload->>'name' = $1",
      [marker],
    );
    expect(r.rows[0]!.n).toBe(0); // 无部分写
  });
});
