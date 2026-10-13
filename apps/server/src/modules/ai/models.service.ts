import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { decryptText, encryptText } from '../platform/crypto.service.js';

/**
 * 模型注册与路由（DSG-D08-5；A08-9；REQ-611/710/803）：
 * - api_key AES-256-GCM 落 api_key_enc（bytea），只写不读；list 仅回掩码 api_key_hint
 * - 用途→模型路由：routes 为模型行上的用途数组，每用途至多一个生效模型（route.set 先全摘后挂）
 * - 连通自检 conn_status：网络探测在事务外执行，结果经 ai.model.test 命令落库（审计留痕）
 */

/** 用途集合：D08-5 四类 + chat（助手 dock 对话用途，差异登记待 M6 验收） + parsing（资料解析 AI 整理，差异登记） + reflection（Agent 反思迭代，设计 §2 末段） */
export const PURPOSES = ['planning', 'generation', 'review', 'translation', 'chat', 'parsing', 'reflection'] as const;
export type Purpose = (typeof PURPOSES)[number];

const PROVIDERS = ['anthropic', 'openai', 'gateway'] as const;

export interface ModelRow {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  model_code: string;
  api_key_enc: Buffer | null;
  api_key_hint: string | null;
  enabled: boolean;
  conn_status: 'ok' | 'fail' | 'untested';
  /** W2-004：上次手动连通测试时间（conn_status 是该次测试的结果快照，非实时探测） */
  conn_checked_at: string | null;
  supports_thinking: boolean;
  context_window: number;
  routes: string[];
  price_table: { in?: number; out?: number };
}

/** list 出参（绝不含 api_key_enc） */
export type ModelPublic = Omit<ModelRow, 'api_key_enc'>;

export interface ModelUpsertPayload {
  id?: string;
  name?: string;
  provider?: string;
  baseUrl?: string;
  modelCode?: string;
  /** 只写不读：提供则替换密文与掩码；不提供则保留 */
  apiKey?: string;
  enabled?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  priceTable?: { in?: number; out?: number };
}

const PUBLIC_COLS =
  'id, name, provider, base_url, model_code, api_key_hint, enabled, conn_status, conn_checked_at, ' +
  'supports_thinking, context_window, routes, price_table';

const maskKey = (k: string): string =>
  k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-4)}`;

function validateUpsert(p: ModelUpsertPayload, isCreate: boolean): void {
  if (isCreate) {
    if (!p.name?.trim()) throw new DomainError('VALIDATION_FAILED', 'name 必填', 'name');
    if (!p.modelCode?.trim()) throw new DomainError('VALIDATION_FAILED', 'modelCode 必填', 'modelCode');
  }
  if (p.provider !== undefined && !(PROVIDERS as readonly string[]).includes(p.provider)) {
    throw new DomainError('VALIDATION_FAILED', `provider 枚举 ${PROVIDERS.join('|')}`, 'provider');
  }
  if (p.baseUrl !== undefined && !/^https?:\/\/.+/.test(p.baseUrl)) {
    throw new DomainError('VALIDATION_FAILED', 'baseUrl 须为 http(s) 地址', 'baseUrl');
  }
  if (p.contextWindow !== undefined && (!Number.isInteger(p.contextWindow) || p.contextWindow <= 0)) {
    throw new DomainError('VALIDATION_FAILED', 'contextWindow 须为正整数', 'contextWindow');
  }
  if (p.priceTable !== undefined) {
    for (const k of ['in', 'out'] as const) {
      const v = p.priceTable[k];
      if (v !== undefined && (typeof v !== 'number' || v < 0)) {
        throw new DomainError('VALIDATION_FAILED', `priceTable.${k} 须为非负数（每 1k token 单价）`, `priceTable.${k}`);
      }
    }
  }
}

@Injectable()
export class AiModelsService implements OnModuleInit {
  onModuleInit(): void {
    registerCommand('ai.model.upsert', async (client, payload) => {
      const p = payload as ModelUpsertPayload;
      if (p.id) return this.updateModel(client, p as ModelUpsertPayload & { id: string });
      return this.createModel(client, p);
    });
    registerCommand('ai.model.route.set', async (client, payload, ctx) => {
      const p = payload as { purpose?: string; modelId?: string | null };
      if (!p.purpose || !(PURPOSES as readonly string[]).includes(p.purpose)) {
        throw new DomainError('VALIDATION_FAILED', `purpose 枚举 ${PURPOSES.join('|')}`, 'purpose');
      }
      if (p.modelId) {
        const m = await client.query<{ enabled: boolean }>('SELECT enabled FROM ai_models WHERE id=$1', [p.modelId]);
        if (!m.rows[0]) throw new DomainError('NOT_FOUND', '模型不存在', p.modelId);
        if (!m.rows[0].enabled) throw new DomainError('MODEL_UNAVAILABLE', '目标模型已停用', p.modelId);
      }
      // 每用途至多一个生效模型：先全摘，后挂（modelId null = 仅摘除）
      await client.query('UPDATE ai_models SET routes = routes - $1, updated_at = now() WHERE routes ? $1', [p.purpose]);
      if (p.modelId) {
        await client.query(
          "UPDATE ai_models SET routes = routes || to_jsonb($2::text), updated_at = now(), updated_by = $3 WHERE id = $1",
          [p.modelId, p.purpose, ctx.actorId]);
      }
      return { purpose: p.purpose, modelId: p.modelId ?? null };
    });
    registerCommand('ai.model.test', async (client, payload, ctx) => {
      const p = payload as { id: string; ok: boolean; detail?: string };
      const r = await client.query(
        'UPDATE ai_models SET conn_status=$2, conn_checked_at=now(), updated_at=now(), updated_by=$3 WHERE id=$1 RETURNING id',
        [p.id, p.ok ? 'ok' : 'fail', ctx.actorId]);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND', '模型不存在', p.id);
      return { id: p.id, connStatus: p.ok ? 'ok' : 'fail', detail: p.detail ?? null };
    });
  }

  private async createModel(client: PoolClient, p: ModelUpsertPayload): Promise<{ id: string }> {
    validateUpsert(p, true);
    if (!p.provider) throw new DomainError('VALIDATION_FAILED', 'provider 必填', 'provider');
    if (!p.baseUrl) throw new DomainError('VALIDATION_FAILED', 'baseUrl 必填（代理/网关接入，注⑤）', 'baseUrl');
    // W2-032：同名静默并存会让用途路由下拉无法区分——名称项目内唯一（改名同样查重，见 updateModel）
    const dup = await client.query<{ id: string }>('SELECT id FROM ai_models WHERE name=$1', [p.name!.trim()]);
    if (dup.rows[0]) throw new DomainError('VALIDATION_FAILED', `模型名称「${p.name!.trim()}」已存在，请换用可区分的名称`, 'name');
    const r = await client.query<{ id: string }>(
      `INSERT INTO ai_models (name, provider, base_url, model_code, api_key_enc, api_key_hint,
         enabled, supports_thinking, context_window, price_table, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        p.name!.trim(), p.provider, p.baseUrl.replace(/\/+$/, ''), p.modelCode!.trim(),
        p.apiKey ? encryptText(p.apiKey) : null, p.apiKey ? maskKey(p.apiKey) : null,
        p.enabled ?? true, p.supportsThinking ?? false, p.contextWindow ?? 128000,
        JSON.stringify(p.priceTable ?? {}), 'system',
      ]);
    return { id: r.rows[0]!.id };
  }

  private async updateModel(client: PoolClient, p: ModelUpsertPayload & { id: string }): Promise<{ id: string }> {
    validateUpsert(p, false);
    const exist = await client.query<{ id: string }>('SELECT id FROM ai_models WHERE id=$1 FOR UPDATE', [p.id]);
    if (!exist.rows[0]) throw new DomainError('NOT_FOUND', '模型不存在', p.id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
    if (p.name !== undefined) {
      const dup = await client.query<{ id: string }>('SELECT id FROM ai_models WHERE name=$1 AND id<>$2', [p.name.trim(), p.id]);
      if (dup.rows[0]) throw new DomainError('VALIDATION_FAILED', `模型名称「${p.name.trim()}」已存在，请换用可区分的名称`, 'name');
      push('name', p.name.trim());
    }
    if (p.provider !== undefined) push('provider', p.provider);
    if (p.baseUrl !== undefined) push('base_url', p.baseUrl.replace(/\/+$/, ''));
    if (p.modelCode !== undefined) push('model_code', p.modelCode.trim());
    if (p.apiKey !== undefined) {
      push('api_key_enc', encryptText(p.apiKey));
      push('api_key_hint', maskKey(p.apiKey));
      // 换密钥后连通状态失效
      push('conn_status', 'untested');
      push('conn_checked_at', null);
    }
    if (p.enabled !== undefined) push('enabled', p.enabled);
    if (p.supportsThinking !== undefined) push('supports_thinking', p.supportsThinking);
    if (p.contextWindow !== undefined) push('context_window', p.contextWindow);
    if (p.priceTable !== undefined) push('price_table', JSON.stringify(p.priceTable));
    if (sets.length === 0) return { id: p.id };
    sets.push('updated_at=now()');
    params.push(p.id);
    await client.query(`UPDATE ai_models SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    return { id: p.id };
  }

  /** 列表（掩码回显；api_key_enc 不出库） */
  async list(): Promise<ModelPublic[]> {
    const r = await query<ModelPublic>(`SELECT ${PUBLIC_COLS} FROM ai_models ORDER BY created_at`, []);
    return r.rows;
  }

  async upsert(p: ModelUpsertPayload, ctx: CommandContext): Promise<{ id: string }> {
    return executeCommand('ai.model.upsert', p, ctx) as Promise<{ id: string }>;
  }

  async setRoute(purpose: string, modelId: string | null, ctx: CommandContext): Promise<unknown> {
    return executeCommand('ai.model.route.set', { purpose, modelId }, ctx);
  }

  /** 用途→模型路由总览 */
  async routes(): Promise<Record<string, { modelId: string; modelName: string } | null>> {
    const r = await query<{ id: string; name: string; routes: string[] }>(
      'SELECT id, name, routes FROM ai_models WHERE enabled', []);
    const out: Record<string, { modelId: string; modelName: string } | null> = {};
    for (const purpose of PURPOSES) out[purpose] = null;
    for (const row of r.rows) {
      for (const purpose of row.routes ?? []) {
        if (purpose in out) out[purpose] = { modelId: row.id, modelName: row.name };
      }
    }
    return out;
  }

  /** 连通自检：探测在事务外，结果经命令落库 */
  async test(id: string, ctx: CommandContext): Promise<{ id: string; connStatus: string; detail: string }> {
    const row = await this.getRow(id);
    const apiKey = row.api_key_enc ? decryptText(row.api_key_enc) : null;
    const probe = await this.probe(row, apiKey);
    await executeCommand('ai.model.test', { id, ok: probe.ok, detail: probe.detail }, ctx);
    return { id, connStatus: probe.ok ? 'ok' : 'fail', detail: probe.detail };
  }

  /** 路由解析（内部用；返回含解密 key，绝不向 HTTP 序列化） */
  async resolve(purpose: Purpose): Promise<{ row: ModelRow; apiKey: string | null }> {
    const r = await query<ModelRow>(
      'SELECT * FROM ai_models WHERE enabled AND routes ? $1 ORDER BY updated_at DESC LIMIT 1', [purpose]);
    let row = r.rows[0];
    // reflection 动态兜底（设计 §2 末段）：无显式路由=enabled 中 context_window 最大者，
    // 不做迁移种子、永远跟随模型池现状（运行时聊天可用小模型，后台反思用大模型互不绑架）
    if (!row && purpose === 'reflection') {
      row = (await query<ModelRow>(
        'SELECT * FROM ai_models WHERE enabled ORDER BY context_window DESC, updated_at DESC LIMIT 1', [])).rows[0];
    }
    if (!row) {
      throw new DomainError('MODEL_UNAVAILABLE', `用途 ${purpose} 无路由模型（请先注册模型并配置路由）`, purpose);
    }
    return { row, apiKey: row.api_key_enc ? decryptText(row.api_key_enc) : null };
  }

  private async getRow(id: string): Promise<ModelRow> {
    const r = await query<ModelRow>('SELECT * FROM ai_models WHERE id=$1', [id]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '模型不存在', id);
    return r.rows[0];
  }

  /** 连通探测：GET {base_url}/models；网络/5xx/鉴权失败为 fail，其余可达即 ok */
  private async probe(row: ModelRow, apiKey: string | null): Promise<{ ok: boolean; detail: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${row.base_url}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `HTTP ${res.status} 鉴权失败` };
      }
      if (res.status >= 500) return { ok: false, detail: `HTTP ${res.status} 网关错误` };
      return { ok: true, detail: `HTTP ${res.status} 可达` };
    } catch (e) {
      return { ok: false, detail: `网络不可达：${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
