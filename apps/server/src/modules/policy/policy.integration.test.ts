/** M12 集成测试（需 DB，见 command-bus.integration.test.ts 头注） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { PolicyService } from './policy.service.js';

async function dbUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM policy_gates LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('PolicyService（集成，需 DB）', async () => {
  const up = await dbUp();
  if (!up) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  const svc = new PolicyService();
  const pid = '00000000-0000-0000-0000-0000000000aa';

  beforeAll(async () => {
    await query(
      "INSERT INTO projects (id, name) VALUES ($1, 'policy-test') ON CONFLICT (id) DO NOTHING",
      [pid],
    );
    await query('DELETE FROM policy_gates WHERE project_id=$1', [pid]);
  });
  afterAll(async () => {
    await query('DELETE FROM policy_gates WHERE project_id=$1', [pid]);
    await query('DELETE FROM projects WHERE id=$1', [pid]);
    await pool.end();
  });

  it('未配置确认点默认人工（REQ-711）', async () => {
    const d = await svc.evaluate(pid, 'req.doc.finalize');
    expect(d.mode).toBe('manual');
  });

  it('配置后按配置求值；listGates 覆盖全部 7 点', async () => {
    await query(
      "INSERT INTO policy_gates (project_id, gate_key, mode) VALUES ($1, 'dev.transfer', 'auto')",
      [pid],
    );
    expect((await svc.evaluate(pid, 'dev.transfer')).mode).toBe('auto');
    const gates = await svc.listGates(pid);
    expect(gates.length).toBe(7);
    expect(gates.find((g) => g.gateKey === 'dev.transfer')?.mode).toBe('auto');
    expect(gates.find((g) => g.gateKey === 'test.release')?.mode).toBe('manual');
  });
});
