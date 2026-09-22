import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';

/**
 * PromptRegistry 提示词版本（DSG-D08-4；A08-7；REQ-609）：
 * - 发布：version_no 递增，is_current 单点（部分唯一索引兜底，命令内先摘后挂）
 * - 回滚：切回历史版本留痕（ai.prompt.rollback 命令审计）
 * - skill_pack 字段预留（pi skills 能力包版本化）
 */
export interface PromptVersionRow {
  id: string; agent_key: string; agent_group: string; version_no: number;
  base_prompt: string; overlay_text: string; is_current: boolean; kind: string;
  skill_pack: Record<string, unknown> | null; created_by: string; created_at: string;
}

@Injectable()
export class AiPromptsService implements OnModuleInit {
  onModuleInit(): void {
    registerCommand('ai.prompt.publish', async (client, payload, ctx) => {
      const p = payload as {
        agentKey?: string; agentGroup?: string; basePrompt?: string;
        overlayText?: string; kind?: string; skillPack?: Record<string, unknown>;
      };
      if (!p.agentKey?.trim()) throw new DomainError('PROMPT_VERSION_INVALID', 'agentKey 必填', 'agentKey');
      if (!p.basePrompt?.trim()) throw new DomainError('PROMPT_VERSION_INVALID', 'basePrompt 不能为空', 'basePrompt');
      const kind = p.kind ?? 'prompt';
      if (kind !== 'prompt' && kind !== 'std') {
        throw new DomainError('PROMPT_VERSION_INVALID', 'kind 枚举 prompt|std', 'kind');
      }
      const prev = await client.query<{ id: string; version_no: number; agent_group: string }>(
        'SELECT id, version_no, agent_group FROM ai_prompt_versions WHERE agent_key=$1 ORDER BY version_no DESC LIMIT 1 FOR UPDATE',
        [p.agentKey]);
      const versionNo = (prev.rows[0]?.version_no ?? 0) + 1;
      await client.query('UPDATE ai_prompt_versions SET is_current=false WHERE agent_key=$1 AND is_current', [p.agentKey]);
      const r = await client.query<{ id: string; version_no: number }>(
        `INSERT INTO ai_prompt_versions (agent_key, agent_group, version_no, base_prompt, overlay_text, is_current, kind, skill_pack, created_by)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8) RETURNING id, version_no`,
        [p.agentKey, p.agentGroup ?? prev.rows[0]?.agent_group ?? 'assistant',
         versionNo, p.basePrompt, p.overlayText ?? '', kind,
         p.skillPack ? JSON.stringify(p.skillPack) : null, ctx.actorId]);
      return r.rows[0];
    });

    registerCommand('ai.prompt.rollback', async (client, payload) => {
      const p = payload as { agentKey?: string; versionNo?: number };
      if (!p.agentKey || !Number.isInteger(p.versionNo)) {
        throw new DomainError('PROMPT_VERSION_INVALID', 'agentKey + versionNo（整数）必填', 'versionNo');
      }
      const target = await client.query<{ id: string; is_current: boolean }>(
        'SELECT id, is_current FROM ai_prompt_versions WHERE agent_key=$1 AND version_no=$2 FOR UPDATE',
        [p.agentKey, p.versionNo]);
      if (!target.rows[0]) {
        throw new DomainError('PROMPT_VERSION_INVALID', `版本不存在: ${p.agentKey}@${p.versionNo}`, p.agentKey);
      }
      if (target.rows[0].is_current) return { id: target.rows[0].id, alreadyCurrent: true };
      await client.query('UPDATE ai_prompt_versions SET is_current=false WHERE agent_key=$1 AND is_current', [p.agentKey]);
      await client.query('UPDATE ai_prompt_versions SET is_current=true WHERE id=$1', [target.rows[0].id]);
      return { id: target.rows[0].id, rolledBackTo: p.versionNo };
    });
  }

  /** agents 列表（当前版本） */
  async agents() {
    const r = await query<PromptVersionRow & { versions: string }>(
      `SELECT v.*, (SELECT count(*) FROM ai_prompt_versions WHERE agent_key=v.agent_key) AS versions
       FROM ai_prompt_versions v WHERE v.is_current ORDER BY v.agent_key`, []);
    return { items: r.rows };
  }

  async versions(agentKey: string) {
    const r = await query<PromptVersionRow>(
      'SELECT * FROM ai_prompt_versions WHERE agent_key=$1 ORDER BY version_no DESC', [agentKey]);
    return { items: r.rows };
  }

  publish(p: Record<string, unknown>, ctx: CommandContext) {
    return executeCommand('ai.prompt.publish', p, ctx);
  }

  rollback(agentKey: string, versionNo: number, ctx: CommandContext) {
    return executeCommand('ai.prompt.rollback', { agentKey, versionNo }, ctx);
  }
}
