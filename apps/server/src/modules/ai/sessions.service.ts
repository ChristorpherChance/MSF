import { createHash } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { AI_PROVIDER, type AiProvider, type AiUsage } from './ai-provider.interface.js';
import type { ModelRow } from './models.service.js';
import { AiModelsService } from './models.service.js';
import { StreamPipeline, type PipelineCompletion } from './stream-pipeline.js';

/**
 * AI 会话与消息（DSG-D08-1/2；A08-1/2/3；REQ-601/602/603/608）：
 * - 会话归属项目：一切访问经 assertScope（越域 FORBIDDEN；PROJECT_SCOPE 为 issue 码非 DomainError，差异登记）
 * - 发送消息两段式：ai.message.send 命令落库（user+streaming ai 行，同事务审计）→ 管线驱动供应商流
 *   → 终结经 ai.message.finish 落终态与用量（ai_usage，price_table 兜底成本，REQ-612）
 * - referenceFileIds 复用 M03 门禁：非定稿 REFERENCE_NOT_FINAL、指纹漂移 REFERENCE_STALE（SQL 直读 mat_files）
 * - 输入指纹 = sha256(提示词版本 + 参考指纹组合)（REQ-115）
 */

const CTX_TABS = ['material', 'req', 'design', 'proto', 'dev', 'test'] as const;
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface SessionRow {
  id: string; project_id: string; code: string; ctx: string; name: string;
  refs: Array<{ fileId: string; fingerprint: string }>;
  think_level: string; tree_ref: string | null; created_by: string;
  model_id: string | null;
  created_at: string; updated_at: string;
}

export interface MessageRow {
  id: string; session_id: string; role: string; content: string; status: string;
  prompt_version_id: string | null; model_id: string | null;
  input_fingerprint: string | null; created_at: string;
}

interface SendPayload {
  sessionId: string;
  content: string;
  referenceFileIds: string[];
  referenceFingerprints: Record<string, string>;
}

@Injectable()
export class AiSessionsService implements OnModuleInit {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(AiModelsService) private readonly models: AiModelsService,
    @Inject(StreamPipeline) private readonly pipeline: StreamPipeline,
  ) {}

  onModuleInit(): void {
    registerCommand('ai.session.create', async (client, payload, ctx) => {
      const p = payload as { ctx: string; name?: string; thinkLevel?: string; modelId?: string };
      if (!(CTX_TABS as readonly string[]).includes(p.ctx)) {
        throw new DomainError('VALIDATION_FAILED', `ctx 枚举 ${CTX_TABS.join('|')}`, 'ctx');
      }
      if (p.modelId) await this.assertModelUsable(client, p.modelId);
      const n = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM ai_sessions WHERE project_id=$1', [ctx.projectId]);
      const code = `ss_${Number(n.rows[0]!.n) + 1}`;
      const r = await client.query<{ id: string; code: string }>(
        `INSERT INTO ai_sessions (project_id, code, ctx, name, think_level, model_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code`,
        [ctx.projectId, code, p.ctx, p.name?.trim() || `会话 ${code}`,
         ['low', 'mid', 'high'].includes(p.thinkLevel ?? '') ? p.thinkLevel! : 'mid',
         p.modelId ?? null, ctx.actorId]);
      return r.rows[0];
    });

    registerCommand('ai.session.set-model', async (client, payload, ctx) => {
      const p = payload as { sessionId: string; modelId: string | null };
      const s = await this.lockSession(client, ctx.projectId!, p.sessionId);
      if (p.modelId) await this.assertModelUsable(client, p.modelId);
      await client.query('UPDATE ai_sessions SET model_id=$2, updated_at=now() WHERE id=$1',
        [s.id, p.modelId ?? null]);
      return { sessionId: s.id, modelId: p.modelId ?? null };
    });

    registerCommand('ai.session.switch', async (client, payload, ctx) => {
      const p = payload as { sessionId: string };
      const s = await this.lockSession(client, ctx.projectId!, p.sessionId);
      await client.query('UPDATE ai_sessions SET updated_at=now() WHERE id=$1', [s.id]);
      return { sessionId: s.id, code: s.code };
    });

    /** dock ⋯ 菜单：重命名（DSG-U02-4 会话操作） */
    registerCommand('ai.session.rename', async (client, payload, ctx) => {
      const p = payload as { sessionId: string; name?: string };
      if (!p.name?.trim()) throw new DomainError('VALIDATION_FAILED', '会话名不能为空', 'name');
      const s = await this.lockSession(client, ctx.projectId!, p.sessionId);
      await client.query('UPDATE ai_sessions SET name=$2, updated_at=now() WHERE id=$1',
        [s.id, p.name.trim()]);
      return { sessionId: s.id, name: p.name.trim() };
    });

    /** dock ⋯ 菜单：删除会话（消息/工具调用随行删除；ai_usage 计量留账不删——审计口径） */
    registerCommand('ai.session.delete', async (client, payload, ctx) => {
      const p = payload as { sessionId: string };
      const s = await this.lockSession(client, ctx.projectId!, p.sessionId);
      await client.query('DELETE FROM ai_tool_calls WHERE session_id=$1', [s.id]);
      await client.query('DELETE FROM ai_messages WHERE session_id=$1', [s.id]);
      await client.query('DELETE FROM ai_sessions WHERE id=$1', [s.id]);
      return { sessionId: s.id, deleted: true };
    });

    registerCommand('ai.message.send', async (client, payload, ctx) => {
      const p = payload as SendPayload;
      if (!p.content?.trim()) throw new DomainError('VALIDATION_FAILED', '消息内容不能为空', 'content');
      const s = await this.lockSession(client, ctx.projectId!, p.sessionId);
      await this.verifyReferences(client, ctx.projectId!, p.referenceFileIds, p.referenceFingerprints);
      // 当前提示词版本（agent=assistant；无则 null——mock 期允许无注册提示词）
      const pv = await client.query<{ id: string }>(
        'SELECT id FROM ai_prompt_versions WHERE agent_key=$1 AND is_current', ['assistant']);
      // 模型戳：会话绑定模型（仍启用）优先，否则 chat 用途路由默认，无路由（mock 期）记 null
      let modelId: string | null = null;
      if (s.model_id) {
        const bound = await client.query<{ id: string }>(
          'SELECT id FROM ai_models WHERE id=$1 AND enabled', [s.model_id]);
        modelId = bound.rows[0]?.id ?? null;
      }
      if (!modelId) {
        const routed = await client.query<{ id: string }>(
          'SELECT id FROM ai_models WHERE enabled AND routes ? $1 ORDER BY updated_at DESC LIMIT 1', ['chat']);
        modelId = routed.rows[0]?.id ?? null;
      }
      const refsFp = p.referenceFileIds.map((id) => p.referenceFingerprints[id] ?? '').join(',');
      const inputFingerprint = sha256hex(`${pv.rows[0]?.id ?? '-'}|${refsFp}`);
      await client.query(
        'INSERT INTO ai_messages (session_id, role, content, status) VALUES ($1,$2,$3,$4)',
        [s.id, 'user', p.content, 'done']);
      const m = await client.query<{ id: string }>(
        `INSERT INTO ai_messages (session_id, role, content, status, prompt_version_id, model_id, input_fingerprint)
         VALUES ($1,'ai','', 'streaming', $2, $3, $4) RETURNING id`,
        [s.id, pv.rows[0]?.id ?? null, modelId, inputFingerprint]);
      await client.query('UPDATE ai_sessions SET updated_at=now() WHERE id=$1', [s.id]);
      return { messageId: m.rows[0]!.id, sessionId: s.id };
    });

    registerCommand('ai.message.finish', async (client, payload) => {
      const p = payload as {
        messageId: string; status: 'done' | 'stopped' | 'failed';
        content: string; usage?: AiUsage; durationMs: number; error?: string;
      };
      const m = await client.query<MessageRow & { session_id: string }>(
        'UPDATE ai_messages SET status=$2, content=$3 WHERE id=$1 AND status=$4 RETURNING *',
        [p.messageId, p.status, p.content, 'streaming']);
      if (!m.rows[0]) throw new DomainError('INVALID_STATE', '消息已终结（重复 finish 拒绝）', p.messageId);
      if (p.usage) {
        const row = m.rows[0];
        let cost = p.usage.cost ?? null;
        if (cost === null && row.model_id) {
          // price_table 兜底（REQ-612/D08-5）：cost = in/1000*priceIn + out/1000*priceOut
          const mr = await client.query<ModelRow>('SELECT * FROM ai_models WHERE id=$1', [row.model_id]);
          const price = mr.rows[0]?.price_table ?? {};
          cost = (p.usage.inputTokens / 1000) * (price.in ?? 0) + (p.usage.outputTokens / 1000) * (price.out ?? 0);
        }
        if (row.model_id) {
          const sess = await client.query<{ project_id: string }>(
            'SELECT project_id FROM ai_sessions WHERE id=$1', [row.session_id]);
          await client.query(
            `INSERT INTO ai_usage (project_id, session_id, message_id, model_id, purpose,
               tokens_in, tokens_out, duration_ms, cost)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [sess.rows[0]?.project_id ?? null, row.session_id, row.id, row.model_id, 'chat',
             p.usage.inputTokens, p.usage.outputTokens, p.durationMs, cost ?? 0]);
        }
      }
      return { messageId: p.messageId, status: p.status };
    });

    for (const action of ['pause', 'resume', 'stop'] as const) {
      registerCommand(`ai.message.${action}` as const, async (client, payload, ctx) => {
        const p = payload as { messageId: string };
        const m = await client.query<{ session_id: string; status: string }>(
          'SELECT session_id, status FROM ai_messages WHERE id=$1', [p.messageId]);
        if (!m.rows[0]) throw new DomainError('NOT_FOUND', '消息不存在', p.messageId);
        const s = await client.query<{ project_id: string }>(
          'SELECT project_id FROM ai_sessions WHERE id=$1', [m.rows[0].session_id]);
        if (s.rows[0]?.project_id !== ctx.projectId) {
          throw new DomainError('FORBIDDEN', '消息不属本项目', p.messageId);
        }
        if (m.rows[0].status !== 'streaming') {
          throw new DomainError('INVALID_STATE', `消息非流式进行中（${m.rows[0].status}）`, p.messageId);
        }
        // 管线副作用（进程内）：审计同事务已留痕
        if (action === 'pause') this.pipeline.pause(p.messageId);
        else if (action === 'resume') this.pipeline.resume(p.messageId);
        else this.pipeline.stop(p.messageId);
        return { messageId: p.messageId, action };
      });
    }
  }

  private async lockSession(client: { query: typeof query }, projectId: string, sessionId: string) {
    const r = await client.query<SessionRow>(
      'SELECT * FROM ai_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    const s = r.rows[0];
    if (!s) throw new DomainError('NOT_FOUND', '会话不存在', sessionId);
    if (s.project_id !== projectId) {
      throw new DomainError('FORBIDDEN', '会话不属本项目', sessionId);
    }
    return s;
  }

  /** 模型可用性门禁：存在且启用（连通态由 UI 列表过滤，服务端不强制——连通可过期） */
  private async assertModelUsable(client: { query: typeof query }, modelId: string): Promise<void> {
    const r = await client.query<{ id: string }>(
      'SELECT id FROM ai_models WHERE id=$1 AND enabled', [modelId]);
    if (!r.rows[0]) {
      throw new DomainError('VALIDATION_FAILED', '模型不存在或已停用', modelId);
    }
  }

  /** M03 参考门禁（SQL 直读 mat_files/mat_parsed；跨域不 import） */
  private async verifyReferences(
    client: { query: typeof query },
    projectId: string,
    fileIds: string[],
    fingerprints: Record<string, string>,
  ): Promise<void> {
    if (fileIds.length === 0) return;
    const r = await client.query<{ id: string; parse_status: string }>(
      'SELECT id, parse_status FROM mat_files WHERE project_id=$1 AND id = ANY($2::uuid[])',
      [projectId, fileIds]);
    const byId = new Map(r.rows.map((x) => [x.id, x]));
    // 内容稿指纹与 M03 references() 同口径：mat_parsed kind='content_parse' status='final'
    // （此前误读 mat_files.content_fingerprint=原件 sha，与下发指纹永远不符，挂参考必 REFERENCE_STALE——实机走查修复）
    const fp = await client.query<{ file_id: string; content_fingerprint: string }>(
      `SELECT file_id, content_fingerprint FROM mat_parsed
       WHERE project_id=$1 AND file_id = ANY($2::uuid[]) AND kind='content_parse' AND status='final'`,
      [projectId, fileIds]);
    const fpById = new Map(fp.rows.map((x) => [x.file_id, x.content_fingerprint]));
    const norm = (s: string | null | undefined): string => (s ?? '').replace(/^sha256:/, '');
    for (const fid of fileIds) {
      const f = byId.get(fid);
      if (!f) throw new DomainError('NOT_FOUND', '参考文件不存在', fid);
      if (f.parse_status !== 'content_final') {
        throw new DomainError('REFERENCE_NOT_FINAL', '参考输入未定稿（须内容定稿后方可引用）', fid);
      }
      const registered = fingerprints[fid];
      const current = fpById.get(fid) ?? null;
      if (registered !== undefined && norm(registered) !== norm(current)) {
        throw new DomainError('REFERENCE_STALE', '参考输入在执行期发生变化，拒绝提交', fid, {
          registered, current,
        });
      }
    }
  }

  // ---- 查询 ----

  async list(projectId: string, ctxTab?: string, cursor?: string, limit = 20) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (ctxTab) { params.push(ctxTab); where += ` AND ctx=$${params.length}`; }
    if (cursor) { params.push(cursor); where += ` AND created_at < $${params.length}`; }
    params.push(limit + 1);
    const r = await query<SessionRow>(
      `SELECT * FROM ai_sessions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    const rows = r.rows.slice(0, limit);
    return { items: rows, nextCursor: r.rows.length > limit ? rows[rows.length - 1]!.created_at : null };
  }

  async detail(projectId: string, sessionId: string): Promise<SessionRow> {
    const r = await query<SessionRow>('SELECT * FROM ai_sessions WHERE id=$1', [sessionId]);
    const s = r.rows[0];
    if (!s) throw new DomainError('NOT_FOUND', '会话不存在', sessionId);
    if (s.project_id !== projectId) throw new DomainError('FORBIDDEN', '会话不属本项目', sessionId);
    return s;
  }

  async messages(projectId: string, sessionId: string, cursor?: string, limit = 50) {
    await this.detail(projectId, sessionId);
    const params: unknown[] = [sessionId];
    let where = 'session_id=$1';
    if (cursor) { params.push(cursor); where += ` AND created_at < $${params.length}`; }
    params.push(limit + 1);
    const r = await query<MessageRow>(
      `SELECT * FROM ai_messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    const rows = r.rows.slice(0, limit);
    // W8 富消息卡：ai 消息附耗时/成本（ai_usage）与工具调用摘要（ai_tool_calls）
    const ids = rows.filter((m) => m.role === 'ai').map((m) => m.id);
    const usageByMsg = new Map<string, { duration_ms: number; cost: string }>();
    const toolsByMsg = new Map<string, Array<Record<string, unknown>>>();
    if (ids.length) {
      const u = await query<{ message_id: string; duration_ms: number; cost: string }>(
        `SELECT DISTINCT ON (message_id) message_id, duration_ms, cost
         FROM ai_usage WHERE message_id = ANY($1::uuid[]) ORDER BY message_id, created_at DESC`, [ids]);
      for (const x of u.rows) usageByMsg.set(x.message_id, { duration_ms: x.duration_ms, cost: x.cost });
      const t = await query<{
        message_id: string; tool_name: string; args: unknown; result_summary: unknown; status: string;
      }>(
        `SELECT message_id, tool_name, args, result_summary, status
         FROM ai_tool_calls WHERE message_id = ANY($1::uuid[]) ORDER BY created_at`, [ids]);
      for (const x of t.rows) {
        const arr = toolsByMsg.get(x.message_id) ?? [];
        arr.push({ toolName: x.tool_name, args: x.args, resultSummary: x.result_summary, status: x.status });
        toolsByMsg.set(x.message_id, arr);
      }
    }
    return {
      items: rows.map((m) => ({
        ...m,
        durationMs: usageByMsg.get(m.id)?.duration_ms ?? null,
        cost: usageByMsg.get(m.id)?.cost ?? null,
        toolCalls: toolsByMsg.get(m.id) ?? [],
      })),
      nextCursor: r.rows.length > limit ? rows[rows.length - 1]!.created_at : null,
    };
  }

  // ---- 命令门面 ----

  create(projectId: string, p: { ctx: string; name?: string; thinkLevel?: string; modelId?: string }, ctx: CommandContext) {
    return executeCommand('ai.session.create', p, { ...ctx, projectId });
  }

  switchSession(projectId: string, sessionId: string, ctx: CommandContext) {
    return executeCommand('ai.session.switch', { sessionId }, { ...ctx, projectId });
  }

  renameSession(projectId: string, sessionId: string, name: string, ctx: CommandContext) {
    return executeCommand('ai.session.rename', { sessionId, name }, { ...ctx, projectId });
  }

  deleteSession(projectId: string, sessionId: string, ctx: CommandContext) {
    return executeCommand('ai.session.delete', { sessionId }, { ...ctx, projectId });
  }

  /** 会话级模型切换（DSG-U02-4 #model-sel；null=回落 chat 路由默认） */
  setModel(projectId: string, sessionId: string, modelId: string | null, ctx: CommandContext) {
    return executeCommand('ai.session.set-model', { sessionId, modelId }, { ...ctx, projectId });
  }

  /**
   * 发送消息（两段式）：命令落库 → 注册管线并创建供应商会话。
   * 调用方随后 drive(messageId, send) 驱动 SSE。
   */
  async send(
    projectId: string,
    sessionId: string,
    body: {
      content: string;
      referenceFileIds?: string[];
      referenceFingerprints?: Record<string, string>;
      thinkLevel?: string;
    },
    ctx: CommandContext,
  ): Promise<{ messageId: string }> {
    const prep = await executeCommand('ai.message.send', {
      sessionId, content: body.content,
      referenceFileIds: body.referenceFileIds ?? [],
      referenceFingerprints: body.referenceFingerprints ?? {},
    }, { ...ctx, projectId }) as { messageId: string; sessionId: string };
    const ai = await this.provider.createSession({ projectId, purpose: 'chat' });
    // 提示词组装（实机走查修复）：参考全文 + 会话历史注入——否则 AI 看不到挂载资料也说不出前文
    const prompt = await this.buildPrompt(projectId, sessionId, body.content, body.referenceFileIds ?? []);
    this.pipeline.register({
      messageId: prep.messageId, sessionId, projectId, ai, prompt,
    });
    return { messageId: prep.messageId };
  }

  /** 组装发往模型的提示词：参考全文（内容定稿稿，单份截 12000 字/总截 32000 字）+ 近 6 轮历史 + 本次请求 */
  private async buildPrompt(
    projectId: string,
    sessionId: string,
    content: string,
    referenceFileIds: string[],
  ): Promise<string> {
    const parts: string[] = [];
    if (referenceFileIds.length > 0) {
      const refs = await query<{ name: string; body_md: string }>(
        `SELECT f.name, p.body_md FROM mat_files f
         JOIN mat_parsed p ON p.file_id=f.id AND p.kind='content_parse' AND p.status='final'
         WHERE f.project_id=$1 AND f.id = ANY($2::uuid[])
         ORDER BY f.code`,
        [projectId, referenceFileIds]);
      let budget = 32000;
      const blocks: string[] = [];
      for (const r of refs.rows) {
        if (budget <= 0) break;
        const body = r.body_md.length > 12000 ? `${r.body_md.slice(0, 12000)}\n…（截断）` : r.body_md;
        const cut = body.length > budget ? `${body.slice(0, budget)}\n…（截断）` : body;
        budget -= cut.length;
        blocks.push(`《${r.name}》\n${cut}`);
      }
      if (blocks.length > 0) parts.push(`【参考资料（已内容定稿）】\n${blocks.join('\n\n---\n\n')}`);
    }
    const history = await query<{ role: string; content: string }>(
      `SELECT role, content FROM ai_messages
       WHERE session_id=$1 AND status='done' AND role IN ('user','ai')
       ORDER BY created_at DESC, id DESC LIMIT 12`,
      [sessionId]);
    const turns = history.rows.reverse();
    if (turns.length > 0) {
      const lines = turns.map((m) => {
        const text = m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content;
        return `${m.role === 'user' ? '用户' : '助手'}：${text}`;
      });
      parts.push(`【会话历史】\n${lines.join('\n')}`);
    }
    parts.push(`【本次请求】\n${content}`);
    return parts.join('\n\n');
  }

  /** 驱动 SSE：订阅管线帧并转发；返终态（终帧由管线广播） */
  async drive(
    messageId: string,
    send: (frame: { type: string; [k: string]: unknown }) => void,
    opts?: { thinkLevel?: string | undefined; ctx?: CommandContext },
  ): Promise<PipelineCompletion> {
    const e = this.pipeline.get(messageId);
    const unsub = this.pipeline.subscribe(messageId, (f) =>
      send({ type: f.type, seq: f.seq, messageId, ...f.data }));
    const startedAt = Date.now();
    this.pipeline.run(messageId, { thinkLevel: opts?.thinkLevel }, async (c) => {
      await executeCommand('ai.message.finish', {
        messageId, status: c.status, content: c.content,
        ...(c.usage ? { usage: c.usage } : {}), durationMs: Date.now() - startedAt,
        ...(c.error ? { error: c.error } : {}),
      }, opts?.ctx ?? { projectId: e.projectId, actorKind: 'system', actorId: 'stream' });
    });
    try {
      return await e.completion;
    } finally {
      unsub();
    }
  }

  /** 断线重挂（A08-4）：重放 lastEventId 之后帧；仍活跃则续订至终结 */
  async attach(
    projectId: string,
    messageId: string,
    lastEventId: number,
    send: (frame: { type: string; [k: string]: unknown }) => void,
  ): Promise<void> {
    const frames = await this.pipeline.replay(messageId, lastEventId);
    for (const f of frames) send({ type: f.type, seq: f.seq, messageId, ...f.data });
    const e = this.pipeline.peek(messageId);
    if (!e || e.done) return;
    if (e.projectId !== projectId) throw new DomainError('FORBIDDEN', '消息不属本项目', messageId);
    const unsub = this.pipeline.subscribe(messageId, (f) =>
      send({ type: f.type, seq: f.seq, messageId, ...f.data }));
    try {
      await e.completion;
    } finally {
      unsub();
    }
  }

  control(projectId: string, messageId: string, action: 'pause' | 'resume' | 'stop', ctx: CommandContext) {
    return executeCommand(`ai.message.${action}`, { messageId }, { ...ctx, projectId });
  }
}
