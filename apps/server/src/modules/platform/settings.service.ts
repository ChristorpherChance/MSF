import { Injectable } from '@nestjs/common';
import { DomainError, POLICY_GATE_KEYS, type PolicyGateKey } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';

/**
 * 系统设置与放行策略配置（A10-1、REQ-705/711；D10-4/D10-6/D10-7、F10-2）：
 * - sys_settings：非密配置（密钥类走 ai_models.api_key_enc，不落本表）
 * - 设置变更经 system.settings.set 命令（审计留痕）
 * - 放行策略：七确认点 manual↔auto 切换授权，留痕 policy_gate_events（理由必填）；
 *   求值仍在 PolicyService（本期求值点行为不变，配置面补齐 U06-17）
 */
@Injectable()
export class SettingsService {
  onModuleInit(): void {
    registerCommand('system.settings.set', async (client, payload, ctx) => {
      const p = payload as { key: string; value: unknown };
      await client.query(
        `INSERT INTO sys_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`,
        [p.key, JSON.stringify(p.value), ctx.actorId]);
      return { key: p.key };
    });
    registerCommand('policy.gate.set_mode', async (client, payload, ctx) => {
      const p = payload as { gateKey: PolicyGateKey; mode: 'manual' | 'auto'; reason: string };
      const cur = await client.query<{ mode: string }>(
        'SELECT mode FROM policy_gates WHERE project_id=$1 AND gate_key=$2', [ctx.projectId, p.gateKey]);
      const from = cur.rows[0]?.mode ?? 'manual';
      if (from === p.mode) return { gateKey: p.gateKey, mode: p.mode, unchanged: true };
      await client.query(
        `INSERT INTO policy_gates (project_id, gate_key, mode, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (project_id, gate_key) DO UPDATE SET mode=$3, updated_at=now()`,
        [ctx.projectId, p.gateKey, p.mode]);
      await client.query(
        `INSERT INTO policy_gate_events (project_id, gate_key, from_mode, to_mode, reason, actor_kind, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.projectId, p.gateKey, from, p.mode, p.reason, ctx.actorKind, ctx.actorId]);
      // §3.9：切换本身通知项目成员（user_id NULL=全员）
      await client.query(
        `INSERT INTO sys_notifications (project_id, user_id, type, text, link)
         VALUES ($1,NULL,'policy.gate.switched',$2,'/settings')`,
        [ctx.projectId,
         `放行策略切换：${p.gateKey} ${from === 'manual' ? '人工确认' : '自动放行'} → ${p.mode === 'auto' ? '自动放行' : '人工确认'}（${ctx.actorId}；理由：${p.reason}）`]);
      return { gateKey: p.gateKey, mode: p.mode };
    });

    /** §3.9 放行策略卡：前置条件编辑（auto 放行的前置声明，逐条文本；求值消费后置，本期为配置面） */
    registerCommand('policy.gate.set_preconditions', async (client, payload, ctx) => {
      const p = payload as { gateKey: PolicyGateKey; preconditions: string[] };
      await client.query(
        `INSERT INTO policy_gates (project_id, gate_key, mode, preconditions, updated_at)
         VALUES ($1,$2,'manual',$3,now())
         ON CONFLICT (project_id, gate_key) DO UPDATE SET preconditions=$3, updated_at=now()`,
        [ctx.projectId, p.gateKey, JSON.stringify(p.preconditions)]);
      return { gateKey: p.gateKey, preconditions: p.preconditions };
    });
  }

  /** A10-1 查询：全量设置（key→value 平铺） */
  async getAll(): Promise<Record<string, unknown>> {
    const r = await query<{ key: string; value: unknown }>('SELECT key, value FROM sys_settings ORDER BY key');
    return Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
  }

  /** A10-1 更新：点分层级键；value 任意 jsonb；baseVersion 本期不适用（单写者本地） */
  async set(key: string, value: unknown, ctx: CommandContext): Promise<{ key: string }> {
    if (!/^[a-z][a-z0-9]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(key)) {
      throw new DomainError('VALIDATION_FAILED', 'key 须为点分层级（如 zip.limits.maxEntries）', 'key');
    }
    if (/key|secret|token|password/i.test(key)) {
      throw new DomainError('VALIDATION_FAILED', '密钥类不落 sys_settings（走 ai_models.api_key_enc）', 'key');
    }
    return (await executeCommand('system.settings.set', { key, value }, ctx)) as { key: string };
  }

  /** 放行策略：七确认点清单（未配置=manual）+ 前置条件 + 最近切换事件 */
  async listGates(projectId: string) {
    const r = await query<{ gate_key: string; mode: string; preconditions: string[]; updated_at: string }>(
      'SELECT gate_key, mode, preconditions, updated_at FROM policy_gates WHERE project_id=$1', [projectId]);
    const byKey = new Map(r.rows.map((row) => [row.gate_key, row]));
    const ev = await query(
      'SELECT gate_key, from_mode, to_mode, reason, actor_id, created_at FROM policy_gate_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20',
      [projectId]);
    return {
      gates: POLICY_GATE_KEYS.map((k) => ({
        gateKey: k, mode: byKey.get(k)?.mode ?? 'manual',
        preconditions: byKey.get(k)?.preconditions ?? [],
        updatedAt: byKey.get(k)?.updated_at ?? null,
      })),
      events: ev.rows,
    };
  }

  /** 切换授权（F10-2：理由必填留痕；auto 后立即回到阻断态由 BR-07 既有求值保证） */
  async setGateMode(projectId: string, gateKey: string, mode: string, reason: string, ctx: CommandContext) {
    if (!(POLICY_GATE_KEYS as readonly string[]).includes(gateKey)) {
      throw new DomainError('VALIDATION_FAILED', `gateKey 枚举 ${POLICY_GATE_KEYS.join('|')}`, 'gateKey');
    }
    if (mode !== 'manual' && mode !== 'auto') {
      throw new DomainError('VALIDATION_FAILED', 'mode 枚举 manual|auto', 'mode');
    }
    if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '切换授权理由必填', 'reason');
    return executeCommand('policy.gate.set_mode', { gateKey, mode, reason }, { ...ctx, projectId });
  }

  /** 前置条件编辑（逐条文本，空串剔除） */
  async setPreconditions(projectId: string, gateKey: string, preconditions: string[], ctx: CommandContext) {
    if (!(POLICY_GATE_KEYS as readonly string[]).includes(gateKey)) {
      throw new DomainError('VALIDATION_FAILED', `gateKey 枚举 ${POLICY_GATE_KEYS.join('|')}`, 'gateKey');
    }
    if (!Array.isArray(preconditions) || preconditions.some((x) => typeof x !== 'string')) {
      throw new DomainError('VALIDATION_FAILED', 'preconditions 须为字符串数组', 'preconditions');
    }
    return executeCommand('policy.gate.set_preconditions',
      { gateKey, preconditions: preconditions.map((x) => x.trim()).filter(Boolean) }, { ...ctx, projectId });
  }
}
