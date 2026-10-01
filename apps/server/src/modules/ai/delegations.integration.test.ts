/** 委派执行集成测试（T6-12，需 DB；A08-8、D08-7/8、REQ-610） */
import { afterAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { executeCommand, resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { SandboxService } from '../executor/sandbox.service.js';
import {
  AiDelegationsService,
  type DelegationExecutor,
  type DelegationRow,
} from './delegations.service.js';

const PID = '00000000-0000-0000-0000-0000000000f8';
const PID2 = '00000000-0000-0000-0000-0000000000f9';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

type Hooks = { transition: (to: string, patch?: { result?: Record<string, unknown>; error?: string }) => Promise<unknown> };

/** 可控假执行器：running 后挂起，release 决定成败 */
class FakeExecutor implements DelegationExecutor {
  gates: Array<{ id: string; release: (outcome: 'succeeded' | 'failed' | 'hold') => void; hooks: Hooks }> = [];
  cancelled: string[] = [];
  async start(d: DelegationRow, hooks: Hooks): Promise<void> {
    await hooks.transition('running');
    await new Promise<void>((done) => {
      this.gates.push({
        id: d.id, hooks,
        release: (outcome) => {
          if (outcome === 'hold') return;
          void hooks.transition(outcome, outcome === 'succeeded'
            ? { result: { summary: '完成' } }
            : { error: '执行失败' }).then(() => done());
          if (outcome === 'failed') return;
        },
      });
    });
  }
  cancel(id: string): void {
    this.cancelled.push(id);
  }
}

const waitFor = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('waitFor 超时');
};

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM ai_delegations LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('委派执行（集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  resetCommands();
  const executor = new FakeExecutor();
  const svc = new AiDelegationsService(new SandboxService(), executor);
  svc.onModuleInit();

  await query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1,'m6-dlg-f8','t'),($2,'m6-dlg-f9','t')
     ON CONFLICT (id) DO NOTHING`, [PID, PID2]);
  const statusOf = async (id: string) =>
    (await query<{ status: string }>('SELECT status FROM ai_delegations WHERE id=$1', [id])).rows[0]!.status;

  afterAll(async () => {
    // 释放所有挂起执行，避免悬挂
    for (const g of executor.gates.splice(0)) g.release('failed');
    await new Promise((r) => setTimeout(r, 300));
    await query('DELETE FROM ai_delegations WHERE project_id IN ($1,$2)', [PID, PID2]);
    await query("DELETE FROM ai_delegation_targets WHERE key LIKE 't6_%'");
    await query("DELETE FROM ai_models WHERE name='t6_w7_cred'");
    await query("DELETE FROM sys_settings WHERE key='delegation.concurrencyMax'");
    await pool.end();
  });

  it('目标种子可查；upsert 密钥类 config 加密存储；test 连通更新状态', async () => {
    const list = await svc.targets();
    expect(list.items.map((t: { key: string }) => t.key)).toContain('pi_native');
    await svc.upsertTarget({
      key: 't6_remote', name: '远程代理', adapterKind: 'remote-agent',
      config: { endpoint: 'http://x', apiToken: 'secret-token-1' },
    }, CTX);
    const enc = await query<{ config: Record<string, string> }>(
      "SELECT config FROM ai_delegation_targets WHERE key='t6_remote'", []);
    expect(enc.rows[0]!.config['apiToken']).toMatch(/^v1\./);
    expect(enc.rows[0]!.config['endpoint']).toBe('http://x');
    // W2-047：builtin 探测=执行同环境（无 config.image → 不再恒 available）
    const t = await svc.testTarget('pi_native', CTX) as { status: string };
    expect(t.status).toBe('unconfigured');
    await query("UPDATE ai_delegation_targets SET status='available' WHERE key='pi_native'", []); // 恢复供后续执行链用例
    await expect(svc.testTarget('no_such', CTX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('委派全程：queued→running→succeeded，证据行链入 evidence_ids', async () => {
    const d = await svc.create(PID, { target: 'pi_native', taskDesc: '整理章节' }, CTX);
    expect(d.code).toBe('DLG-0001');
    await waitFor(async () => (await statusOf(d.id)) === 'running');
    executor.gates.find((g) => g.id === d.id)!.release('succeeded');
    await waitFor(async () => (await statusOf(d.id)) === 'succeeded');
    const row = await svc.detail(PID, d.id);
    expect(row.result).toMatchObject({ summary: '完成' });
    expect(row.evidence_ids.length).toBe(1);
    const evd = await query('SELECT kind FROM evd_records WHERE seq=$1', [row.evidence_ids[0]]);
    expect(evd.rows[0]).toMatchObject({ kind: 'delegation' });
  });

  it('不可用目标 DELEGATION_TARGET_UNAVAILABLE；越域 FORBIDDEN', async () => {
    await expect(svc.create(PID, { target: 'codex_cli', taskDesc: 'x' }, CTX))
      .rejects.toMatchObject({ code: 'DELEGATION_TARGET_UNAVAILABLE' });
    const d = await svc.create(PID, { target: 'pi_native', taskDesc: 'y' }, CTX);
    await waitFor(async () => (await statusOf(d.id)) === 'running');
    await expect(svc.cancel(PID2, d.id, { ...CTX, projectId: PID2 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    executor.gates.find((g) => g.id === d.id)!.release('failed');
    await waitFor(async () => (await statusOf(d.id)) === 'failed');
  });

  it('并发上限 2：第三个 RATE_LIMITED；取消释放配额', async () => {
    const a = await svc.create(PID, { target: 'pi_native', taskDesc: 'a' }, CTX);
    const b = await svc.create(PID, { target: 'pi_native', taskDesc: 'b' }, CTX);
    await waitFor(async () => (await statusOf(a.id)) === 'running' && (await statusOf(b.id)) === 'running');
    await expect(svc.create(PID, { target: 'pi_native', taskDesc: 'c' }, CTX))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const c = await svc.cancel(PID, a.id, CTX) as { status: string };
    expect(c.status).toBe('cancelled');
    const c2 = await svc.create(PID, { target: 'pi_native', taskDesc: 'c2' }, CTX);
    await waitFor(async () => (await statusOf(c2.id)) === 'running');
    for (const id of [b.id, c2.id]) executor.gates.find((g) => g.id === id)!.release('failed');
    await waitFor(async () =>
      (await statusOf(b.id)) === 'failed' && (await statusOf(c2.id)) === 'failed');
  });

  it('终态取消 INVALID_STATE；晚到回调零写（stale 不抛错不落库）', async () => {
    const d = await svc.create(PID, { target: 'pi_native', taskDesc: 'z' }, CTX);
    await waitFor(async () => (await statusOf(d.id)) === 'running');
    executor.gates.find((g) => g.id === d.id)!.release('succeeded');
    await waitFor(async () => (await statusOf(d.id)) === 'succeeded');
    await expect(svc.cancel(PID, d.id, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const late = await executeCommand('ai.delegate.transition', {
      delegationId: d.id, from: ['running'], to: 'failed', error: '迟到的失败回调',
    }, CTX) as { applied: boolean; stale: boolean };
    expect(late).toMatchObject({ applied: false, stale: true });
    const row = await svc.detail(PID, d.id);
    expect(row.status).toBe('succeeded'); // 零写：终态未被覆盖
  });

  // ---- W7：注册向导（端点/凭据引用/保存前 dry-run 测试）+ 并发上限可配置 ----

  it('W7 注册向导：端点持久化；凭据引用必须指向已存模型；test-draft 不入册', async () => {
    // 凭据引用不存在 → 拒绝（DSG-U06-18：引用设置中已存凭据）
    await expect(svc.upsertTarget({
      key: 't6_w7a', name: 'W7 目标A', adapterKind: 'remote-agent', credentialRef: '不存在的模型',
    }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 登记一个模型作为凭据源
    await query(
      `INSERT INTO ai_models (name, provider, base_url, model_code, created_by)
       VALUES ('t6_w7_cred','gateway','http://127.0.0.1:9','mw7','t') ON CONFLICT DO NOTHING`, []);
    await svc.upsertTarget({
      key: 't6_w7a', name: 'W7 目标A', adapterKind: 'remote-agent',
      endpoint: 'http://127.0.0.1:9/agent', credentialRef: 't6_w7_cred',
      capabilities: ['code'], description: 'W7 冒烟',
    }, CTX);
    const t = await svc.targets();
    const row = t.items.find((x) => x.key === 't6_w7a')!;
    expect(row.endpoint).toBe('http://127.0.0.1:9/agent');
    expect(row.credential_ref).toBe('t6_w7_cred');
    // dry-run：builtin 恒可；local-cli 无端点拒绝提示；探测不写入目标表
    const d1 = await svc.testDraft({ adapterKind: 'builtin' });
    expect(d1.ok).toBe(true);
    expect(d1.latencyMs).toBeGreaterThanOrEqual(0);
    const d2 = await svc.testDraft({ adapterKind: 'local-cli', endpoint: '' });
    expect(d2.ok).toBe(false);
    expect(d2.detail).toContain('端点');
    await expect(svc.testDraft({ adapterKind: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // test 记延迟（W2-047：builtin 探测走沙箱口径，无镜像 → unconfigured；延迟仍记）
    const tr = await svc.testTarget('pi_native', CTX) as { latencyMs: number | null };
    expect(tr.latencyMs).not.toBeNull();
    const lat = await query<{ last_latency_ms: number | null }>(
      "SELECT last_latency_ms FROM ai_delegation_targets WHERE key='pi_native'", []);
    expect(lat.rows[0]!.last_latency_ms).not.toBeNull();
    await query("UPDATE ai_delegation_targets SET status='available' WHERE key='pi_native'", []); // 恢复供后续执行链用例
  });

  it('W7 并发上限可配置：sys_settings delegation.concurrencyMax=1 → 第二个 RATE_LIMITED', async () => {
    await query(
      `INSERT INTO sys_settings (key, value, updated_by, updated_at)
       VALUES ('delegation.concurrencyMax','1','t',now())
       ON CONFLICT (key) DO UPDATE SET value='1', updated_at=now()`, []);
    try {
      const a = await svc.create(PID, { target: 'pi_native', taskDesc: 'cap-a' }, CTX);
      await waitFor(async () => (await statusOf(a.id)) === 'running');
      await expect(svc.create(PID, { target: 'pi_native', taskDesc: 'cap-b' }, CTX))
        .rejects.toMatchObject({ code: 'RATE_LIMITED' });
      const lst = await svc.list(PID);
      expect(lst.concurrency.max).toBe(1);
      executor.gates.find((g) => g.id === a.id)!.release('failed');
      await waitFor(async () => (await statusOf(a.id)) === 'failed');
    } finally {
      await query("DELETE FROM sys_settings WHERE key='delegation.concurrencyMax'", []);
    }
  });
});
