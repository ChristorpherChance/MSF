import { Inject, Injectable, Optional, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { encryptText } from '../platform/crypto.service.js';
import { SandboxService } from '../executor/sandbox.service.js';

/**
 * 委派执行（DSG-D08-7/8；A08-8；REQ-610）：
 * - DLG-NNNN 项目内编号；五态+failed_timeout；并发上限默认 2（全局 running 计数，超限 RATE_LIMITED）
 * - ai.delegate.transition 承载运行态迁移（执行器内部命令）：前态不符即晚到回调——零写返回 stale
 * - 终态落 evidence（evd_records seq 链入 evidence_ids）；取消运行中委派经执行器 abort
 * - pi_native 先导：pi RPC（stdin/stdout JSONL）在沙箱容器承载（镜像取目标 config.image，须在沙箱清单）
 * - 不静默降级：目标 unavailable/镜像未配置即失败终态，重跑需人工再次发起（REQ-610）
 */

const DEFAULT_MAX_RUNNING = 2; // 可用 sys_settings「delegation.concurrencyMax」覆盖（LLD-6 §3.8 可配置）
const TERMINAL = ['succeeded', 'failed', 'failed_timeout', 'cancelled'] as const;
const DELEGATION_TIMEOUT_MS = Number(process.env.MSF_DELEGATION_TIMEOUT_MS ?? 600_000);

/** 并发上限：sys_settings 优先，环境变量次之，默认 2（E6 可配置入口） */
async function maxRunning(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ value: unknown }> }> },
): Promise<number> {
  const r = await client.query(
    "SELECT value FROM sys_settings WHERE key='delegation.concurrencyMax'", []);
  const v = Number((r.rows[0]?.value as number | undefined) ?? process.env.MSF_DELEGATION_CONCURRENCY);
  return Number.isInteger(v) && v >= 1 ? v : DEFAULT_MAX_RUNNING;
}

export interface DelegationRow {
  id: string; project_id: string; code: string; target: string; task_desc: string;
  task_id: string | null; workspace_scope: unknown; budget_limit: string | null;
  status: string; sandbox_ref: string | null; result: Record<string, unknown> | null;
  evidence_ids: number[]; cost: string | null;
  started_at: string | null; finished_at: string | null; created_by: string; created_at: string;
}

/** 执行器接口（pi_native 生产实现 / 测试可注入） */
export interface DelegationExecutor {
  /** 启动执行；经 hooks.transition 回报状态（执行器异步，不得阻塞返回） */
  start(d: DelegationRow, hooks: {
    transition: (to: string, patch?: { result?: Record<string, unknown>; cost?: number; error?: string }) => Promise<unknown>;
  }): Promise<void>;
  cancel(delegationId: string): void;
}

/** pi_native 先导执行器：沙箱容器承载 pi RPC 运行时（镜像经目标 config.image 指定并锚定清单） */
export class PiNativeExecutor implements DelegationExecutor {
  constructor(private readonly sandbox: SandboxService) {}

  async start(
    d: DelegationRow,
    hooks: { transition: (to: string, patch?: { result?: Record<string, unknown>; cost?: number; error?: string }) => Promise<unknown> },
  ): Promise<void> {
    await hooks.transition('running');
    const target = await query<{ config: Record<string, unknown> }>(
      'SELECT config FROM ai_delegation_targets WHERE key=$1', [d.target]);
    const image = target.rows[0]?.config?.['image'] as string | undefined;
    if (!image) {
      await hooks.transition('failed', { error: 'pi_native 目标未配置沙箱镜像（config.image），不静默降级' });
      return;
    }
    try {
      const r = await this.sandbox.runOnce({
        image,
        cmd: ['pi', '--mode', 'rpc', '--task', d.task_desc],
        limits: { timeoutMs: DELEGATION_TIMEOUT_MS },
      });
      await hooks.transition(r.exitCode === 0 ? 'succeeded' : 'failed', {
        result: { exitCode: r.exitCode, logs: r.logs.slice(-4000), envFingerprint: r.envFingerprint },
      });
    } catch (e) {
      if (e instanceof DomainError && e.code === 'EXECUTION_TIMEOUT') {
        await hooks.transition('failed_timeout', { error: e.message });
      } else {
        await hooks.transition('failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  cancel(): void {
    // 沙箱一次性容器由超时兜底回收；主动 kill 随沙箱句柄注册表后置（差异登记）
  }
}

@Injectable()
export class AiDelegationsService implements OnModuleInit {
  constructor(
    @Inject(SandboxService) private readonly sandbox: SandboxService,
    @Optional() @Inject('AI_DELEGATION_EXECUTOR') private readonly executor?: DelegationExecutor,
  ) {}

  private exec(): DelegationExecutor {
    return this.executor ?? new PiNativeExecutor(this.sandbox);
  }

  onModuleInit(): void {
    registerCommand('ai.target.upsert', async (client, payload, ctx) => {
      const p = payload as {
        key?: string; name?: string; description?: string; adapterKind?: string;
        endpoint?: string; credentialRef?: string;
        capabilities?: string[]; config?: Record<string, unknown>; status?: string;
      };
      if (!p.key?.trim()) throw new DomainError('VALIDATION_FAILED', 'key 必填', 'key');
      if (p.adapterKind && !['local-cli', 'remote-agent', 'builtin'].includes(p.adapterKind)) {
        throw new DomainError('VALIDATION_FAILED', 'adapterKind 枚举 local-cli|remote-agent|builtin', 'adapterKind');
      }
      // 凭据引用（DSG-U06-18）：引用设置页已存模型凭据（按名称），不内嵌明文
      if (p.credentialRef !== undefined && p.credentialRef !== null && p.credentialRef !== '') {
        const m = await client.query('SELECT id FROM ai_models WHERE name=$1', [p.credentialRef]);
        if (!m.rows[0]) {
          throw new DomainError('VALIDATION_FAILED', `凭据引用不存在（设置页模型注册表）：${p.credentialRef}`, 'credentialRef');
        }
      }
      // 密钥类字段加密存储（key/secret/token 命名的 config 值 → v1. 密文串）
      const config = p.config
        ? Object.fromEntries(Object.entries(p.config).map(([k, v]) =>
            /key|secret|token/i.test(k) && typeof v === 'string' && !v.startsWith('v1.')
              ? [k, encryptText(v).toString()]
              : [k, v]))
        : undefined;
      const exist = await client.query<{ id: string }>(
        'SELECT id FROM ai_delegation_targets WHERE key=$1 FOR UPDATE', [p.key]);
      if (exist.rows[0]) {
        await client.query(
          `UPDATE ai_delegation_targets SET
             name = coalesce($2, name), description = coalesce($3, description),
             endpoint = coalesce($8, endpoint), credential_ref = coalesce($9, credential_ref),
             capabilities = coalesce($4, capabilities), config = coalesce($5, config),
             status = coalesce($6, status), updated_by = $7, updated_at = now()
           WHERE key = $1`,
          [p.key, p.name ?? null, p.description ?? null,
           p.capabilities ? JSON.stringify(p.capabilities) : null,
           config ? JSON.stringify(config) : null, p.status ?? null, ctx.actorId,
           p.endpoint ?? null, p.credentialRef ?? null]);
        return { key: p.key, updated: true };
      }
      if (!p.name || !p.adapterKind) {
        throw new DomainError('VALIDATION_FAILED', '新建目标 name/adapterKind 必填', 'name');
      }
      await client.query(
        `INSERT INTO ai_delegation_targets (key, name, description, adapter_kind, endpoint, credential_ref, capabilities, status, config, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [p.key, p.name, p.description ?? null, p.adapterKind,
         p.endpoint ?? null, p.credentialRef ?? null,
         JSON.stringify(p.capabilities ?? []), p.status ?? 'unconfigured',
         JSON.stringify(config ?? {}), ctx.actorId]);
      return { key: p.key, created: true };
    });

    registerCommand('ai.target.test', async (client, payload) => {
      const p = payload as { key: string; ok: boolean; detail?: string; latencyMs?: number };
      const r = await client.query(
        'UPDATE ai_delegation_targets SET status=$2, last_latency_ms=$3, updated_at=now() WHERE key=$1 RETURNING key',
        [p.key, p.ok ? 'available' : 'unconfigured', p.latencyMs ?? null]);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND', '委派目标不存在', p.key);
      return { key: p.key, status: p.ok ? 'available' : 'unconfigured', detail: p.detail ?? null, latencyMs: p.latencyMs ?? null };
    });

    registerCommand('ai.delegate.create', async (client, payload, ctx) => {
      const p = payload as {
        target?: string; taskDesc?: string; taskId?: string;
        workspaceScope?: unknown[]; budgetLimit?: number;
      };
      if (!p.target) throw new DomainError('VALIDATION_FAILED', 'target 必填', 'target');
      if (!p.taskDesc?.trim()) throw new DomainError('VALIDATION_FAILED', 'taskDesc 必填', 'taskDesc');
      const t = await client.query<{ status: string }>(
        'SELECT status FROM ai_delegation_targets WHERE key=$1', [p.target]);
      if (!t.rows[0]) throw new DomainError('NOT_FOUND', '委派目标不存在', p.target);
      if (t.rows[0].status !== 'available') {
        throw new DomainError('DELEGATION_TARGET_UNAVAILABLE', `目标 ${p.target} 不可用（${t.rows[0].status}）`, p.target);
      }
      const cap = await maxRunning(client);
      // W2-052：上限检查+编号+插入是同一临界区（上限按全局 running 计数）——咨询锁串行化，防并行撞 UNIQUE 500 / 击穿上限
      await lockCodeGen(client, 'msf:code:delegation');
      const running = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM ai_delegations WHERE status IN ('queued','running')", []);
      if (Number(running.rows[0]!.n) >= cap) {
        throw new DomainError('RATE_LIMITED', `委派并发上限 ${cap} 已满，稍后重试（设置 → 系统设置可调）`, 'concurrency');
      }
      const n = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM ai_delegations WHERE project_id=$1', [ctx.projectId]);
      const code = `DLG-${String(Number(n.rows[0]!.n) + 1).padStart(4, '0')}`;
      const r = await client.query<{ id: string; code: string }>(
        `INSERT INTO ai_delegations (project_id, code, target, task_desc, task_id, workspace_scope, budget_limit, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8) RETURNING id, code`,
        [ctx.projectId, code, p.target, p.taskDesc, p.taskId ?? null,
         JSON.stringify(p.workspaceScope ?? []), p.budgetLimit ?? null, ctx.actorId]);
      return { id: r.rows[0]!.id, code };
    });

    registerCommand('ai.delegate.cancel', async (client, payload, ctx) => {
      const p = payload as { delegationId: string };
      const d = await this.lock(client, ctx.projectId!, p.delegationId);
      if ((TERMINAL as readonly string[]).includes(d.status)) {
        throw new DomainError('INVALID_STATE', `委派已终结（${d.status}）`, d.code);
      }
      await client.query(
        "UPDATE ai_delegations SET status='cancelled', finished_at=now() WHERE id=$1", [d.id]);
      this.exec().cancel(d.id);
      return { id: d.id, code: d.code, status: 'cancelled' };
    });

    registerCommand('ai.delegate.transition', async (client, payload) => {
      const p = payload as {
        delegationId: string; from: string[]; to: string;
        result?: Record<string, unknown>; cost?: number; error?: string;
      };
      const d = await client.query<DelegationRow>(
        'SELECT * FROM ai_delegations WHERE id=$1 FOR UPDATE', [p.delegationId]);
      if (!d.rows[0]) throw new DomainError('NOT_FOUND', '委派不存在', p.delegationId);
      const row = d.rows[0];
      // #16：body 缺字段 → 400 而非 500（晚到回调零写语义只覆盖前态不符，不覆盖畸形载荷）
      if (!Array.isArray(p.from) || p.from.length === 0) {
        throw new DomainError('VALIDATION_FAILED', 'from 前态列表必填（数组）', 'from');
      }
      // 晚到回调零写：前态不符（已终结/已迁移）不抛错不落库
      if (!p.from.includes(row.status)) {
        return { applied: false, stale: true, current: row.status };
      }
      const isTerminal = (TERMINAL as readonly string[]).includes(p.to);
      const patch: string[] = ['status=$2'];
      const params: unknown[] = [row.id, p.to];
      if (p.to === 'running') patch.push('started_at=now()');
      if (isTerminal) patch.push('finished_at=now()');
      if (p.result !== undefined) { params.push(JSON.stringify(p.result)); patch.push(`result=$${params.length}`); }
      if (p.cost !== undefined) { params.push(p.cost); patch.push(`cost=$${params.length}`); }
      if (p.error !== undefined) {
        params.push(JSON.stringify({ ...(row.result ?? {}), error: p.error }));
        patch.push(`result=$${params.length}`);
      }
      await client.query(`UPDATE ai_delegations SET ${patch.join(', ')} WHERE id=$1`, params);
      // 终态落证据行，seq 链入 evidence_ids
      if (isTerminal) {
        const seq = await appendEvidence(client, {
          projectId: row.project_id,
          kind: 'delegation',
          payload: {
            code: row.code, target: row.target, status: p.to,
            result: p.result ?? null, error: p.error ?? null, cost: p.cost ?? null,
          },
        });
        await client.query(
          'UPDATE ai_delegations SET evidence_ids = evidence_ids || to_jsonb($2::bigint) WHERE id=$1',
          [row.id, seq]);
      }
      return { applied: true, status: p.to };
    });
  }

  private async lock(client: PoolClient, projectId: string, id: string): Promise<DelegationRow> {
    const r = await client.query<DelegationRow>(
      'SELECT * FROM ai_delegations WHERE id=$1 FOR UPDATE', [id]);
    const d = r.rows[0];
    if (!d) throw new DomainError('NOT_FOUND', '委派不存在', id);
    if (d.project_id !== projectId) throw new DomainError('FORBIDDEN', '委派不属本项目', id);
    return d;
  }

  // ---- 门面 ----

  async create(
    projectId: string,
    p: { target: string; taskDesc: string; taskId?: string; workspaceScope?: unknown[]; budgetLimit?: number },
    ctx: CommandContext,
  ): Promise<{ id: string; code: string }> {
    const r = await executeCommand('ai.delegate.create', p, { ...ctx, projectId }) as { id: string; code: string };
    // 提交后异步派发（执行器经 transition 回报；派发失败即 failed 终态）
    const row = await query<DelegationRow>('SELECT * FROM ai_delegations WHERE id=$1', [r.id]);
    const d = row.rows[0]!;
    const hooks = {
      transition: (to: string, patch?: { result?: Record<string, unknown>; cost?: number; error?: string }) =>
        executeCommand('ai.delegate.transition', {
          delegationId: d.id,
          from: to === 'running' ? ['queued'] : ['queued', 'running'],
          to, ...(patch ?? {}),
        }, { projectId, actorKind: 'system' as const, actorId: 'delegation-runner' }),
    };
    void Promise.resolve()
      .then(() => this.exec().start(d, hooks))
      .catch(async (e) => {
        await hooks.transition('failed', { error: e instanceof Error ? e.message : String(e) })
          .catch(() => undefined);
      });
    return r;
  }

  cancel(projectId: string, delegationId: string, ctx: CommandContext) {
    return executeCommand('ai.delegate.cancel', { delegationId }, { ...ctx, projectId });
  }

  async list(projectId: string, status?: string) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (status) { params.push(status); where += ` AND status=$${params.length}`; }
    const r = await query<DelegationRow>(
      `SELECT * FROM ai_delegations WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
    return { items: r.rows, concurrency: { max: await maxRunning({ query }) } };
  }

  async detail(projectId: string, delegationId: string) {
    const r = await query<DelegationRow>('SELECT * FROM ai_delegations WHERE id=$1', [delegationId]);
    const d = r.rows[0];
    if (!d) throw new DomainError('NOT_FOUND', '委派不存在', delegationId);
    if (d.project_id !== projectId) throw new DomainError('FORBIDDEN', '委派不属本项目', delegationId);
    return d;
  }

  async targets() {
    const r = await query<{
      key: string; name: string; description: string | null; adapter_kind: string;
      endpoint: string | null; credential_ref: string | null; last_latency_ms: number | null;
      capabilities: string[]; status: string; created_at: string; updated_at: string | null;
    }>(
      `SELECT key, name, description, adapter_kind, endpoint, credential_ref, last_latency_ms,
              capabilities, status, created_at, updated_at
       FROM ai_delegation_targets ORDER BY key`, []);
    return { items: r.rows };
  }

  upsertTarget(p: Record<string, unknown>, ctx: CommandContext) {
    return executeCommand('ai.target.upsert', p, ctx);
  }

  async testTarget(key: string, ctx: CommandContext) {
    // 连通探测在事务外：local-cli 查 PATH；remote-agent 本期 HTTP 探测后置；
    // W2-047：builtin(pi_native) 不再恒可——以执行同环境（沙箱镜像内 pi --version）探测，
    // 「可用」承诺与执行力一致（原口径探测通过但执行 882ms 即败：镜像内无 pi 可执行体）
    const t = await query<{ adapter_kind: string }>(
      'SELECT adapter_kind FROM ai_delegation_targets WHERE key=$1', [key]);
    if (!t.rows[0]) throw new DomainError('NOT_FOUND', '委派目标不存在', key);
    const probe = t.rows[0].adapter_kind === 'builtin'
      ? await this.probeBuiltin(key)
      : await probeTarget(t.rows[0].adapter_kind, key);
    return executeCommand('ai.target.test', { key, ...probe }, ctx);
  }

  /** builtin 目标探测：沙箱镜像内真实执行 pi --version（与委派执行同口径） */
  private async probeBuiltin(key: string): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const t0 = Date.now();
    const t = await query<{ config: Record<string, unknown> }>(
      'SELECT config FROM ai_delegation_targets WHERE key=$1', [key]);
    const image = t.rows[0]?.config?.['image'] as string | undefined;
    if (!image) {
      return { ok: false, detail: '内建运行时未配置沙箱镜像（config.image）', latencyMs: Date.now() - t0 };
    }
    try {
      const r = await this.sandbox.runOnce({ image, cmd: ['pi', '--version'], limits: { timeoutMs: 15000 } });
      return {
        ok: r.exitCode === 0,
        detail: r.exitCode === 0
          ? `沙箱镜像 ${image} 内 pi 可执行（与委派执行同环境）`
          : `镜像 ${image} 内无 pi 可执行体（exit ${r.exitCode}）——须换含 pi 运行时的镜像`,
        latencyMs: Date.now() - t0,
      };
    } catch (e) {
      return { ok: false, detail: `沙箱探测失败：${e instanceof Error ? e.message : String(e)}`, latencyMs: Date.now() - t0 };
    }
  }

  /** 注册向导 dry-run：不入册的连通探测（保存前测试，失败即阻止注册） */
  async testDraft(p: { adapterKind?: string; endpoint?: string }) {
    if (!p.adapterKind || !['local-cli', 'remote-agent', 'builtin'].includes(p.adapterKind)) {
      throw new DomainError('VALIDATION_FAILED', 'adapterKind 枚举 local-cli|remote-agent|builtin', 'adapterKind');
    }
    // dry-run 以 endpoint 作为 local-cli 的 bin 名（向导未分配 key）
    return probeTarget(p.adapterKind, p.endpoint?.trim() || '');
  }
}

/** 连通探测（事务外纯函数）：返回 ok/detail/latencyMs */
async function probeTarget(
  adapterKind: string, keyOrBin: string,
): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const t0 = Date.now();
  let ok = adapterKind === 'builtin';
  let detail = ok ? '内建运行时可用' : '';
  if (adapterKind === 'local-cli') {
    const bin = keyOrBin === 'claude_code_local' ? 'claude' : keyOrBin === 'codex_cli' ? 'codex' : keyOrBin;
    if (!bin) return { ok: false, detail: 'local-cli 需填写端点（可执行名，如 claude）', latencyMs: 0 };
    const { execFile } = await import('node:child_process');
    ok = await new Promise<boolean>((res) =>
      execFile(bin, ['--version'], { timeout: 5000 }, (e) => res(!e)));
    detail = ok ? `${bin} CLI 可用` : `${bin} CLI 不在 PATH`;
  } else if (adapterKind === 'remote-agent') {
    if (!keyOrBin) return { ok: false, detail: 'remote-agent 需填写端点 URL', latencyMs: 0 };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      await fetch(keyOrBin, { method: 'HEAD', signal: ctl.signal }).finally(() => clearTimeout(timer));
      ok = true; detail = '端点可达';
    } catch (e) {
      detail = `端点不可达：${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok, detail, latencyMs: Date.now() - t0 };
}
