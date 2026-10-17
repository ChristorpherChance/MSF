import { createHash } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { buildCrossSessionDigest } from '../platform/cross-session-digest.js';
import { getExternalTool } from '../platform/external-tools.js';
import { designBooksStale, reqPrdStale } from '../platform/upstream-stale.js';
import { AI_PROVIDER, type AiProvider, type AiUsage } from './ai-provider.interface.js';
import type { ModelRow } from './models.service.js';
import { AiModelsService } from './models.service.js';
import { assembleAgentBlocks, BAND_BUDGETS, contextBand, type AssembledAgents, type ContextBand } from './agent-prompts.js';
import { buildTemplateDraftPrompt, parseTemplateDraft } from './template-draft.js';
import { AiToolsService } from './tools.service.js';
import { StreamPipeline, type PipelineCompletion } from './stream-pipeline.js';

/**
 * AI 会话与消息（DSG-D08-1/2；A08-1/2/3；REQ-601/602/603/608）：
 * - 会话归属项目：一切访问经 assertScope（越域 FORBIDDEN；PROJECT_SCOPE 为 issue 码非 DomainError，差异登记）
 * - 发送消息两段式：ai.message.send 命令落库（user+streaming ai 行，同事务审计）→ 管线驱动供应商流
 *   → 终结经 ai.message.finish 落终态与用量（ai_usage，price_table 兜底成本，REQ-612）
 * - referenceFileIds 复用 M03 门禁：非定稿 REFERENCE_NOT_FINAL、指纹漂移 REFERENCE_STALE（SQL 直读 mat_files）
 * - 输入指纹 = sha256(三层注入链版本 id 组合 + 参考指纹组合)（REQ-115；2026-10-12 三层链口径升级）
 * - Agent prompt 三层链（设计 §1）：代码基底（stage-guides DEFAULT_AGENTS）→ ai_prompt_versions
 *   is_current 用户版本（base+overlay 拼接）→ 运行时装配（agent-prompts.assembleAgentBlocks）；
 *   prompt_version_id=注入链首层用户版本 id（assistant→主→子取首个有用户版本者，全无=NULL）
 * - 上下文预算分档（设计 §2；Task 3）：send() 按会话模型（绑定优先/chat 路由兜底）context_window
 *   分档（wide ≥512k / standard 128k~512k / narrow <128k；无模型/mock 期=wide 基线不变），
 *   一次装配同源消费（盖戳/指纹/注入——消「盖戳版本 X、注入版本 Y」一致性窗口），band 经
 *   PipelineEntry 透传到接力轮 toolLog 预算与 doc.read 截断阈值
 */

const CTX_TABS = ['material', 'req', 'design', 'proto', 'dev', 'test'] as const;
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * 会话工件绑定（2026-10-08，迁移 0029）：req=crd|prd、design=八册 kind，其余 ctx 恒 NULL。
 * 权威册名在 design 域 DESIGN_BOOKS；跨域禁令下 ai 不 import 他域模块，此处镜像（改 DESIGN_BOOKS 须同步）。
 */
export const SESSION_DOC_KINDS: Record<string, Record<string, string>> = {
  req: { crd: 'CRD 客户需求', prd: 'PRD 产品需求' },
  design: {
    hld: '概要设计说明书', mod: '模块设计', alg: '算法与流程', cls: '类与数据结构',
    db: '数据库设计', api: 'API 接口', ui: 'UI 设计', nfr: '非功能规则',
  },
};

/** 原型页动态工件（0032，2026-10-17）：design ctx 允许 page:<页面编号> 绑定——
 *  「选中哪个页面 dock 就聊哪个页面」（0029 枚举外的动态扩展；页面编号来自目录，非静态可枚举） */
export const PROTO_PAGE_KIND = /^page:([A-Za-z0-9][A-Za-z0-9-]{0,23})$/;

/** 会话工件显示名：枚举册名 + 原型页动态码（非法组合返回 null=校验拒绝口径） */
export function sessionDocKindLabel(ctx: string, kind: string): string | null {
  const m = PROTO_PAGE_KIND.exec(kind);
  if (m && ctx === 'design') return `原型页 ${m[1]}`;
  return SESSION_DOC_KINDS[ctx]?.[kind] ?? null;
}

export interface SessionRow {
  id: string; project_id: string; code: string; ctx: string; name: string;
  doc_kind: string | null;
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
  /** 三层链盖戳（2026-10-12）：send() 读侧装配后随 payload 传入；缺省回退命令内 assistant 单点查询保兼容 */
  promptVersionId?: string | null;
  inputFingerprint?: string;
}

@Injectable()
export class AiSessionsService implements OnModuleInit {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(AiModelsService) private readonly models: AiModelsService,
    @Inject(StreamPipeline) private readonly pipeline: StreamPipeline,
    @Inject(AiToolsService) private readonly tools: AiToolsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // W2-053 衍生：进程重启即流终结——注册表清空后 DB 里的 streaming 行永无人收尾，启动时一次性标 failed
    // （本域表启动修复，不经命令总线；10 分钟龄期守卫：测试套件不 await onModuleInit，避免误杀在途流）
    await query(
      "UPDATE ai_messages SET status='failed', error='INTERNAL' WHERE status='streaming' AND created_at < now() - interval '10 minutes'",
      [],
    ).catch(() => undefined);
    this.registerCommands();
  }

  private registerCommands(): void {
    registerCommand('ai.session.create', async (client, payload, ctx) => {
      const p = payload as { ctx: string; name?: string; thinkLevel?: string; modelId?: string; docKind?: string | null };
      if (!(CTX_TABS as readonly string[]).includes(p.ctx)) {
        throw new DomainError('VALIDATION_FAILED', `ctx 枚举 ${CTX_TABS.join('|')}`, 'ctx');
      }
      // 工件绑定校验：仅 req/design 允许 docKind，且必须是该阶段的合法文档类别（其余阶段恒 NULL）；
      // design 另放行 page:<页面编号> 动态工件（0032 原型页对话提案，PROTO_PAGE_KIND 收口）
      const docKind = p.docKind ?? null;
      if (docKind !== null && !sessionDocKindLabel(p.ctx, docKind)) {
        throw new DomainError('VALIDATION_FAILED', `该阶段无此文档类别（${p.ctx} 可选：${Object.keys(SESSION_DOC_KINDS[p.ctx] ?? {}).join('|') || '无'}${p.ctx === 'design' ? '，或 page:<页面编号>' : ''}）`, 'docKind');
      }
      if (p.modelId) await this.assertModelUsable(client, p.modelId);
      // W2-052：ss_ 发号属 check-then-act——咨询锁串行化「取号→插入」临界区；
      // 会话可删（deleteSession），count+1 在删行后与存量撞号（实测 ss_3 撞 500）→ 须 max(数字后缀)+1
      await lockCodeGen(client, `msf:code:session:${ctx.projectId}`);
      const n = await client.query<{ n: string }>(
        `SELECT COALESCE(MAX(CAST(substring(code FROM 'ss_(\\d+)') AS int)), 0) + 1 AS n
         FROM ai_sessions WHERE project_id=$1`, [ctx.projectId]);
      const code = `ss_${Number(n.rows[0]!.n)}`;
      const docLabel = docKind ? sessionDocKindLabel(p.ctx, docKind)! : '';
      const r = await client.query<{ id: string; code: string }>(
        `INSERT INTO ai_sessions (project_id, code, ctx, name, doc_kind, think_level, model_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, code`,
        [ctx.projectId, code, p.ctx, p.name?.trim() || (docKind ? `${docLabel}·${code}` : `会话 ${code}`),
         docKind,
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
      // 盖戳口径（2026-10-12 三层链）：send() 读侧装配（不经命令事务）后随 payload 传入
      // stampId/fingerprint，命令优先采用；缺省（旧调用方直发命令）回退 assistant 单点查询保兼容
      let promptVersionId: string | null;
      let inputFingerprint: string;
      if (p.promptVersionId !== undefined && p.inputFingerprint !== undefined) {
        promptVersionId = p.promptVersionId;
        inputFingerprint = p.inputFingerprint;
      } else {
        const pv = await client.query<{ id: string }>(
          'SELECT id FROM ai_prompt_versions WHERE agent_key=$1 AND is_current', ['assistant']);
        promptVersionId = pv.rows[0]?.id ?? null;
        const refsFp0 = p.referenceFileIds.map((id) => p.referenceFingerprints[id] ?? '').join(',');
        inputFingerprint = sha256hex(`${promptVersionId ?? '-'}|${refsFp0}`);
      }
      // 模型戳：会话绑定模型（仍启用）优先，否则 chat 用途路由默认，无路由（mock 期）记 null。
      // Task 9 收口：解析口径单点=models.resolveChatModelRow（与 send() 分档解析同源；命令事务内走 client）
      const chatRow = await this.models.resolveChatModelRow(s.model_id, client);
      const modelId = chatRow?.id ?? null;
      await client.query(
        'INSERT INTO ai_messages (session_id, role, content, status) VALUES ($1,$2,$3,$4)',
        [s.id, 'user', p.content, 'done']);
      const m = await client.query<{ id: string }>(
        `INSERT INTO ai_messages (session_id, role, content, status, prompt_version_id, model_id, input_fingerprint)
         VALUES ($1,'ai','', 'streaming', $2, $3, $4) RETURNING id`,
        [s.id, promptVersionId, modelId, inputFingerprint]);
      await client.query('UPDATE ai_sessions SET updated_at=now() WHERE id=$1', [s.id]);
      return { messageId: m.rows[0]!.id, sessionId: s.id };
    });

    registerCommand('ai.message.finish', async (client, payload) => {
      const p = payload as {
        messageId: string; status: 'done' | 'stopped' | 'failed';
        content: string; usage?: AiUsage; durationMs: number; error?: string; errorMessage?: string;
      };
      // W2-002：失败行落脱敏错误人话（ai_messages.error，0022 迁移）——失败原因不再只在帧里
      const m = await client.query<MessageRow & { session_id: string }>(
        'UPDATE ai_messages SET status=$2, content=$3, error=$5 WHERE id=$1 AND status=$4 RETURNING *',
        [p.messageId, p.status, p.content, 'streaming', p.errorMessage ?? p.error ?? null]);
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

  /** docKind：undefined=不按工件过滤（老调用口径）；string|null=精确匹配（IS NOT DISTINCT FROM 兼容 NULL 组） */
  async list(projectId: string, ctxTab?: string, cursor?: string, limit = 20, docKind?: string | null) {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (ctxTab) { params.push(ctxTab); where += ` AND ctx=$${params.length}`; }
    if (docKind !== undefined) { params.push(docKind); where += ` AND doc_kind IS NOT DISTINCT FROM $${params.length}`; }
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
      // 同事务插入的 user+ai 两行 created_at 同值（事务时间戳），须用 role 定序：
      // DESC 中 ai 排前 → 前端 reverse 后 user 在上（同刻对=一轮对话的固定次序）
      `SELECT * FROM ai_messages WHERE ${where} ORDER BY created_at DESC, (role='ai') DESC LIMIT $${params.length}`, params);
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

  create(projectId: string, p: { ctx: string; name?: string; thinkLevel?: string; modelId?: string; docKind?: string | null }, ctx: CommandContext) {
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
    // 三层链装配（读侧，不进命令事务）：盖戳口径=注入链首层用户版本 id（assistant→主→子取首个
    // 有用户版本者，全无=NULL）；input_fingerprint=sha256(三层版本 id 组合|参考指纹组合)（设计 §1）。
    // 会话不存在时 sessRow 为空、按 assistant 单层装配，随后命令内 lockSession 照旧抛 NOT_FOUND。
    // Task 3 消重收口：send() 装配一次，asm 同源传入 buildPrompt→buildSystemPrompt（盖戳版本
    // 即注入版本，消除双装配的冗余 SELECT 与一致性窗口）；band 同源计算一并透传。
    const sessRow = await query<{ ctx: string; doc_kind: string | null; model_id: string | null }>(
      'SELECT ctx, doc_kind, model_id FROM ai_sessions WHERE id=$1', [sessionId]);
    const sessInfo = sessRow.rows[0];
    // 上下文分档（设计 §2）：会话绑定模型（仍启用）优先，chat 用途路由兜底——解析口径单点
    // =models.resolveChatModelRow（Task 9 收口，与命令内消息模型戳同源）；
    // 解析不到=mock 期/未配置=wide（306 基线口径不变，降档只发生在绑定真实模型且窗口 <512k 时）
    const chatRow = await this.models.resolveChatModelRow(sessInfo?.model_id);
    const contextWindow = chatRow?.context_window ?? null;
    const band = contextBand(contextWindow);
    const asm = await assembleAgentBlocks(sessInfo?.ctx ?? null, sessInfo?.doc_kind ?? null, band);
    const refsFp = (body.referenceFileIds ?? [])
      .map((id) => (body.referenceFingerprints ?? {})[id] ?? '').join(',');
    const inputFingerprint = sha256hex(`${asm.versionIds.join('|')}|${refsFp}`);
    const prep = await executeCommand('ai.message.send', {
      sessionId, content: body.content,
      referenceFileIds: body.referenceFileIds ?? [],
      referenceFingerprints: body.referenceFingerprints ?? {},
      promptVersionId: asm.stampId, inputFingerprint,
    }, { ...ctx, projectId }) as { messageId: string; sessionId: string };
    const ai = await this.provider.createSession({ projectId, purpose: 'chat' });
    // 提示词组装（实机走查修复）：参考全文 + 会话历史注入——否则 AI 看不到挂载资料也说不出前文
    const prompt = await this.buildPrompt(projectId, sessionId, body.content, body.referenceFileIds ?? [], asm, band);
    this.pipeline.register({
      messageId: prep.messageId, sessionId, projectId, ai, prompt,
      // A3 零流出断流安全重试的会话工厂（断流重建同档会话重发）
      makeSession: () => this.provider.createSession({ projectId, purpose: 'chat' }),
      // 分档透传（Task 3）：接力轮 toolLog 预算与 doc.read 截断阈值按此取 BAND_BUDGETS
      band,
    });
    return { messageId: prep.messageId };
  }

  /**
   * W2-053：解析回复中的 ```msf-tool 围栏块，逐个经 ai.tool.invoke 编排执行（每轮封顶 MAX_TOOL_SPANS_PER_ROUND 个，
   * 调用挂 session_id+message_id——前端工具卡按消息聚合的前提），返回剔除围栏后的正文+执行结果。
   * 命中外部工具注册表（external-tools.ts）的工具走旁路：handler 无事务执行（含嵌套 LLM
   * 的工具绝不在命令事务内跑）+ recordDirect 留痕 ai_tool_calls；未命中经 ai.tool.invoke。
   * 单块失败不阻断：denied/args_invalid 已在命令内留痕，非法 JSON 块忽略。
   * results 供 agentic 接力轮回喂（驱动层把结果注入接力 prompt，模型同轮继续回答）。
   */
  async runToolBlocks(
    projectId: string,
    sessionId: string,
    messageId: string,
    content: string,
    ctx: CommandContext,
    /** 上下文分档（Task 3）：来源=drive() 里 PipelineEntry.band（缺省 wide）；经 ai.tool.invoke
     *  payload 逐跳透传到 doc.read 截断阈值（显式字段，不走 args 走私） */
    band: ContextBand = 'wide',
  ): Promise<{ stripped: string; results: Array<{ name: string; result: unknown }> }> {
    const spans = findToolSpans(content);
    if (spans.length === 0) return { stripped: content, results: [] };
    // 先全量解析（非法 JSON 块忽略），再按「连续只读段并行、写类串行」调度（A7，2026-10-11）：
    // 只读工具（doc.read/read_context 等无内部命令事务）Promise.all 并行缩短多文档读取墙钟；
    // 写类工具（propose_edits 旁路外部工具）保持声明顺序串行（提案间可能有先后依赖语义）。
    // results 顺序=块声明顺序（并行组按完成序留痕 ai_tool_calls，created_at 自然排序）
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const { body: raw } of spans) {
      try {
        const call = JSON.parse(raw) as { name?: string; args?: Record<string, unknown> };
        if (call.name) calls.push({ name: call.name, args: call.args ?? {} });
      } catch { /* 非法 JSON 块忽略 */ }
    }
    const results: Array<{ name: string; result: unknown }> = [];
    const execOne = async (call: { name: string; args: Record<string, unknown> }): Promise<{ name: string; result: unknown }> => {
      // A4：工具执行用户可见——propose 类是长调用（嵌套 LLM 单册/单页 3~8 分钟），单独口径防「卡住」误判
      this.pipeline.emitNotice(
        messageId,
        call.name.endsWith('.propose_edits') || call.name.endsWith('.propose_page')
          ? `正在生成修改提案（${call.name}，长调用约需数分钟）…`
          : `正在执行 ${call.name}…`,
      );
      // 外部工具旁路：含嵌套 LLM 的工具绝不在 ai.tool.invoke 命令事务内跑——
      // handler 无事务执行（内部命令独立事务），recordDirect 补落 ai_tool_calls（成功/失败两路留痕）
      const external = getExternalTool(call.name);
      if (external) {
        const p = { sessionId, messageId, toolName: call.name, args: call.args };
        try {
          const result = await external(projectId, { sessionId, messageId, args: call.args }, ctx);
          await this.tools.recordDirect(p, result['ok'] === false ? 'failed' : 'ok', result);
          return { name: call.name, result };
        } catch (e) {
          const err = { error: e instanceof Error ? e.message : String(e) };
          await this.tools.recordDirect(p, 'failed', err);
          return { name: call.name, result: err };
        }
      }
      const r = await this.tools
        .invoke(projectId, { sessionId, messageId, toolName: call.name, args: call.args, band }, ctx)
        .catch((e) => ({ result: { error: e instanceof Error ? e.message : String(e) } }));
      return { name: call.name, result: r.result };
    };
    let i = 0;
    while (i < calls.length) {
      const call = calls[i]!;
      const readonly = READONLY_TOOLS.has(call.name) && !getExternalTool(call.name);
      if (!readonly) {
        results.push(await execOne(call));
        i++;
        continue;
      }
      // 收集连续只读段并行执行
      let j = i;
      while (j < calls.length && READONLY_TOOLS.has(calls[j]!.name) && !getExternalTool(calls[j]!.name)) j++;
      const group = await Promise.all(calls.slice(i, j).map(execOne));
      results.push(...group);
      i = j;
    }
    // span 剥离（闭合/未闭合同路径，未闭合尾块一并无残留）
    const stripped = stripToolSpans(content, spans);
    return { stripped: stripped || '已按请求调用工具，结果见下方工具卡。', results };
  }

  /** 自定义模板类别 AI 起草（2026-10-07 拍板）：非 SSE 内部调用（purpose=chat）出草案，
   *  人工审改后经 template_set.update_item 保存（AI 起草、人工定稿纪律不破）；草案不落库 */
  async draftTemplate(projectId: string, name: string, hint: string) {
    if (!name?.trim()) throw new DomainError('VALIDATION_FAILED', '类别名称必填', 'name');
    const t0 = Date.now();
    const ai = await this.provider.createSession({ projectId, purpose: 'chat' });
    const { deltas, result } = ai.stream(buildTemplateDraftPrompt(name, hint));
    for await (const d of deltas) void d;
    const r = await result.catch(() => null);
    if (!r) throw new DomainError('MODEL_UNAVAILABLE', 'AI 起草调用失败，请重试或人工填写', 'template-draft');
    if (r.modelId && r.usage) {
      await executeCommand('ai.usage.record', {
        projectId, modelId: r.modelId, purpose: 'chat',
        tokensIn: r.usage.inputTokens, tokensOut: r.usage.outputTokens,
        durationMs: Date.now() - t0, cost: r.usage.cost ?? 0,
      }, { projectId, actorKind: 'assistant', actorId: 'pi' });
    }
    return parseTemplateDraft(r.text);
  }

  /**
   * 组装发往模型的提示词 = buildSystemPrompt 系统段 +【会话历史】+【本次请求】。
   * provider 接口是单字符串 prompt——历史与请求不是独立 system 槽位，
   * 拼接在系统段之后的同一字符串尾部（不「移动」，保持原位）。
   * asm/band 由 send() 一次装配/计算后同源传入（Task 3 消重收口）。
   */
  private async buildPrompt(
    projectId: string,
    sessionId: string,
    content: string,
    referenceFileIds: string[],
    asm: AssembledAgents,
    band: ContextBand,
  ): Promise<string> {
    const system = await this.buildSystemPrompt(projectId, sessionId, referenceFileIds, asm, band);
    const parts: string[] = [system];
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
    return parts.filter((p) => p).join('\n\n');
  }

  /**
   * system 段装配（设计 §1 序列；参考全文=内容定稿稿，单份截 12000 字/总截 32000 字）：
   * Agent 三层链三块（【全局基底】/【角色与方法】/【工件专项】，位置提前至【当前上下文】之前）
   * →【当前上下文】(U-035)→【当前工件】(0029)→【联动提醒】→【能力边界】→【可用工具】→【参考资料】→【他阶段会话摘要】
   * asm（send() 一次装配同源传入，Task 3 消重）+ band（窄档：工具声明用精简版、缺口文案截短）。
   */
  private async buildSystemPrompt(
    projectId: string,
    sessionId: string,
    referenceFileIds: string[],
    asm: AssembledAgents,
    band: ContextBand,
  ): Promise<string> {
    const parts: string[] = [];
    const sessCtx = await query<{ ctx: string; doc_kind: string | null }>(
      'SELECT ctx, doc_kind FROM ai_sessions WHERE id=$1', [sessionId]);
    const sess = sessCtx.rows[0];
    // Agent 三层链三块（send() 装配产物同源注入；2026-10-12 设计 §1）：assistant 全局基底 + 主（ctx）
    // + 子（doc_kind 命中；dev 恒叠加 coding-std）。每层独立三层链解析：is_current 用户版本
    // （base+overlay）优先、无则代码基底——设置页 Agent prompt 从此是运行时真身
    parts.push(...asm.blocks);
    // U-035：注入项目与五阶段准入实时口径（跨域只 SQL 直读 projects 快照列，不写）
    const STAGE_LABEL: Record<string, string> = { material: '资料', req: '需求', design: '设计', dev: '开发', test: '测试' };
    const pj = await query<{ name: string; stage_gates: Array<{ stage: string; ok: boolean; issues: Array<{ message: string }> }> | null }>(
      'SELECT name, stage_gates FROM projects WHERE id=$1', [projectId]);
    if (pj.rows[0]) {
      const gates = Array.isArray(pj.rows[0].stage_gates) ? pj.rows[0].stage_gates : [];
      // 窄档（Task 3）：门禁缺口文案截短 120→60 字
      const gapCap = band === 'narrow' ? 60 : 120;
      const gateText = gates.length === 0
        ? '（准入未求值）'
        : gates.map((g) => {
            const label = STAGE_LABEL[g.stage] ?? g.stage;
            if (g.ok) return `${label} ✓`;
            const gap = g.issues.map((i) => i.message).join('；');
            return `${label} ✗（缺口：${gap.length > gapCap ? `${gap.slice(0, gapCap)}…` : gap}）`;
          }).join(' / ');
      parts.push(`【当前上下文】\n项目：${pj.rows[0].name}\n五阶段准入：${gateText}\n（你是该软件工厂项目的内置助手，回答与操作建议应结合上述项目状态。）`);
    }
    // 会话工件绑定（0029）：req/design 会话绑定具体文档——模型与用户共享「当前在改哪篇」的坐标，
    // 根修「选中详细设计却改了概要设计」（会话池阶段级共用、模型靠猜 kind）
    const boundKind = sess?.doc_kind;
    if (boundKind) {
      const boundCtx = sess!.ctx;
      const pageM = PROTO_PAGE_KIND.exec(boundKind);
      if (boundCtx === 'design' && pageM) {
        // 原型页绑定（0032）：模型与用户共享「当前在改哪页」坐标——propose_page 的 pageCode 不再靠猜
        parts.push(`【当前工件】\n本会话绑定原型页：${pageM[1]}（设计阶段·原型工作台）。用户的页面修改请求默认针对该页——design.proto.propose_page 的 pageCode 默认用 ${pageM[1]}；仅当用户明确要求处理其它页面或文档时才换目标，并在正文说明你改的是哪个。`);
      } else {
        const label = SESSION_DOC_KINDS[boundCtx]?.[boundKind] ?? boundKind;
        const toolName = boundCtx === 'design' ? 'design.doc.propose_edits' : 'req.doc.propose_edits';
        parts.push(`【当前工件】\n本会话绑定文档：《${label}》（kind=${boundKind}）。用户的修改请求默认针对该文档——doc.read 与 ${toolName} 的 kind 默认用 ${boundKind}；仅当用户明确要求处理其他文档时才换 kind，并在正文说明你改的是哪篇。`);
      }
    }
    // 上游变更联动提醒（与 upstream-stale.ts 同源派生）：agent 看到下游滞后应主动提示用户跟随修订
    try {
      const ctxTab = sess?.ctx;
      if (ctxTab === 'req') {
        const s = await reqPrdStale(projectId);
        if (s.stale) {
          parts.push(`【联动提醒】\nCRD 已提交更新的 v${s.upstreamVersionNo}，PRD 仍停留在 v${s.downstreamVersionNo}——内容可能滞后。若用户尚未察觉，主动提醒并询问是否需要按新 CRD 跟随修订 PRD（propose_edits，rewrite 通道可整篇重出）。`);
        }
      } else if (ctxTab === 'design' || ctxTab === 'proto') {
        const m = await designBooksStale(projectId);
        const staleKinds = Object.entries(m).filter(([, v]) => v.stale).map(([k]) => k);
        if (staleKinds.length > 0) {
          parts.push(`【联动提醒】\nPRD 已提交更新的 v${Object.values(m).find((v) => v.stale)?.upstreamVersionNo ?? ''}，${staleKinds.length} 册设计文档（${staleKinds.join('/')}）内容可能滞后。若用户尚未察觉，主动提醒复核；设计册修订须走设计页生成/增量流（不在你的写通道内）。`);
        }
      }
    } catch { /* 派生失败静默降级，不阻断聊天主链（与跨阶段摘要同口径） */ }
    // U-040 能力边界声明（对话改文档落地后修订）：写操作只有 propose_edits 提案通道（人工确认后生效），
    // 缺此声明时模型会谎称"已修改/已定稿"
    parts.push(`【能力边界（必须遵守）】
你不能直接修改、定稿、放行任何文档、UI 原型、代码、计划或批次；也不能替用户点击任何"人工确认"。
唯一写通道：对 CRD/PRD 的修改请求用 req.doc.propose_edits、对设计八册的修改请求用 design.doc.propose_edits、对原型页面的修改请求用 design.proto.propose_page 提交修改建议——产出待确认产物（高亮补丁/页面提案），经用户逐条确认或「✓ 采用」后才生效；其它写诉求给出建议文本并指引落地路径（需求页/设计页 AI 生成与修订、开发页、测试页流程；定稿与放行永远是人工操作）。
严禁声称"已修改/已定稿/已放行/已完成写入"——凡未经用户确认，系统内数据均未变化。`);
    // W2-053 + 跨阶段互通/对话改文档：工具自主调用声明（REQ-605）——```msf-tool 围栏块流末解析执行；
    // 窄档用精简版（Task 3：签名与纪律句保留，砍示例段落）
    parts.push(band === 'narrow' ? TOOL_BLOCK_CONDENSED : TOOL_BLOCK_FULL);
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
    // 跨阶段互通（读侧）：本项目其它会话最近用户消息摘要（整块预算 3000，超出从最旧丢弃；
    // 会话列表/草稿仍按阶段隔离，互通仅发生在 AI 读侧；SQL 失败静默降级不阻断聊天主链）
    try {
      const cross = await query<{ ctx: string; code: string; at: string; excerpts: string[] | null }>(
        `SELECT s.ctx, s.code, to_char(s.updated_at, 'YYYY-MM-DD HH24:MI') AS at,
                (SELECT array_agg(m.content) FROM (
                   SELECT content FROM ai_messages
                   WHERE session_id=s.id AND role='user' AND status='done'
                   ORDER BY created_at DESC LIMIT 2) m) AS excerpts
         FROM ai_sessions s
         WHERE s.project_id=$1 AND s.id<>$2
         ORDER BY s.updated_at DESC LIMIT 10`,
        [projectId, sessionId]);
      const digest = buildCrossSessionDigest(cross.rows.map((r) => ({
        ctx: r.ctx, code: r.code, at: r.at,
        excerpts: (r.excerpts ?? []).reverse().map((x) => (x.length > 200 ? `${x.slice(0, 200)}…` : x)),
      })));
      if (digest) parts.push(digest);
    } catch { /* 摘要注入失败静默降级（该块省略） */ }
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
      // W2-053：流末解析 ```msf-tool 围栏块并编排执行（工具调用挂 message_id，工具卡随消息渲染）
      // 2026-10-05 agentic 接力：工具结果回喂模型继续生成（同一条消息多轮，封顶 MAX_RELAY_ROUNDS 轮接力）——
      // 此前工具结果只在工具卡呈现，模型拿不到结果，「我读取后回答你」类承诺落空须用户再推一句
      const ctx2 = opts?.ctx ?? { projectId: e.projectId, actorKind: 'system' as const, actorId: 'stream' };
      let content = c.content;
      let status = c.status;
      let usage = c.usage;
      let rounds = 0;
      // 工具结果跨轮累积日志（2026-10-10 根修：原只回喂当轮结果，接力轮看不到更早读取的内容，
      // 多文档任务被迫重读烧轮次——116 实机「重写五册」两次撞上限 8 轮全耗在重复 doc.read）
      const toolLog: Array<{ name: string; result: unknown }> = [];
      // 上下文分档（Task 3）：注册时按会话模型分档（缺省 wide）——toolLog 回喂预算与
      // doc.read 截断阈值按 BAND_BUDGETS[band] 取
      const band: ContextBand = e.band ?? 'wide';
      while (status === 'done' && content.includes('```msf-tool') && rounds < MAX_RELAY_ROUNDS) {
        rounds++;
        const { stripped, results } = await this.runToolBlocks(e.projectId, e.sessionId, messageId, content, ctx2, band);
        content = stripped;
        if (results.length === 0) break;
        toolLog.push(...results);
        const ai2 = await this.provider.createSession({ projectId: e.projectId, purpose: 'chat' });
        // A4：接力轮次用户可见（长静默期不再是黑盒）
        this.pipeline.emitNotice(messageId, `接力第 ${rounds} 轮：工具结果已回喂，正在继续生成`);
        const r2 = await this.pipeline.runContinuation(
          messageId, ai2, buildToolFollowup(e.prompt, toolLog, MAX_RELAY_ROUNDS - rounds, band),
          () => this.provider.createSession({ projectId: e.projectId, purpose: 'chat' }),
        );
        content = `${content}\n\n${r2.content}`.trim();
        if (r2.usage) {
          usage = usage
            ? { inputTokens: usage.inputTokens + r2.usage.inputTokens, outputTokens: usage.outputTokens + r2.usage.outputTokens, cost: (usage.cost ?? 0) + (r2.usage.cost ?? 0) }
            : r2.usage;
        }
        if (r2.stopped) { status = 'stopped'; break; }
        if (r2.failed) {
          // 接力轮网关失败（如 503 上游鉴权不可用瞬断）：首轮成果+工具卡保留，但绝不能让用户
          // 对着半截开场白干等——消息内补可见提示并终止接力（网关故障期继续接力只会连败）
          content = `${content}\n\n> ⚠️ 续答生成失败（${r2.failed}）：工具结果已取回，但模型续答中断。请重发你的问题，我会重新读取并直接给出结论。`;
          break;
        }
      }
      if (status === 'done' && rounds >= MAX_RELAY_ROUNDS && content.includes('```msf-tool')) {
        // 封顶退出但末轮仍带未执行围栏：剥掉不执行——raw 围栏露出会让用户以为「AI 答应了却没动静」
        // （2026-10-09 实机现场：mod 重生成 7 连读后承诺提案，围栏原文留在消息尾、propose_edits 未发）
        content = `${stripToolSpans(content, findToolSpans(content))}\n\n> ⚠️ 本轮工具接力已达上限（${MAX_RELAY_ROUNDS} 轮），最后一步操作未执行。回复「继续」我会接着完成。`;
        console.warn(`[ai] relay cap reached messageId=${messageId} rounds=${rounds}——末轮围栏未执行已剥离`);
      }
      await executeCommand('ai.message.finish', {
        messageId, status, content,
        ...(usage ? { usage } : {}), durationMs: Date.now() - startedAt,
        ...(c.error ? { error: c.error } : {}),
        ...(c.errorMessage ? { errorMessage: c.errorMessage } : {}),
      }, ctx2);
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

/** 【可用工具】声明双版本（Task 3，设计 §2 窄档口径）：FULL=现状全量（示例+长篇口径保留）；
 *  CONDENSED=窄档精简——每工具一行签名+一句用途，签名与纪律句（围栏格式/自动回喂/写走人工）保留，
 *  砍的是示例与展开段落。能力边界/工具签名永不进裁剪表（签名行即保留项）。
 *  导出供 agent-presets.test.ts 平价测试钉死（Task 9）：两块均含全部七个工具名+围栏格式+
 *  自动回喂纪律句——新增工具必须两版同步，漏同步 condensed 测试即红。 */
export const TOOL_BLOCK_FULL = `【可用工具（可自主调用）】
需要时，在回复正文之外输出独立的工具围栏块（可多个；不需要则不输出）：
\`\`\`msf-tool
{"name":"工具名","args":{...}}
\`\`\`
- nav.goto：为用户打开某个页面。args: {"tab":"material|req|design|proto|dev|test|tasks|delegate|settings|rtm"}。当用户说"打开/带我去/跳转到某页"时调用，正文同时说明已发起打开。RTM 需求矩阵有直达页签：tab 用 "rtm"。
- read_context：读取当前项目状态快照（各域条目计数）。args: {}。当需要最新项目数据回答"进展/状态"类问题时调用。
- doc.read：读取指定文档正文（与界面同口径：草稿优先、章节标题带界面编号——「5.1 节」类指代按返回的编号对应）。args: {"kind":"crd|prd|hld|mod|alg|cls|db|api|ui|nfr","anchor":"5.1","offset":0}（anchor 可选：章节编号如「5.1」「第五章」、标题或 CR 编号，定向读单节不截断，用户按编号/章节名指代时务必带 anchor；offset 可选：全文被截断时从第 N 字符续读，截断时返回里会给出 nextOffset）。当用户问"文档里某条怎么写的/某节内容/REQ 编号原话/哪一节承接某需求"时调用；返回含 finalized（是否已定稿）、modified（是否有未提交草稿）、versionNo 与 sections 章节清单，回答时如实说明依据的版本与定稿态。found:false 表示该文档尚未生成；anchorFound:false 表示章节未命中，按 sections 清单修正后重试。
- chat.history.read：读取本项目其它阶段会话的最近消息。args: {"sessionCode":"ss_3","limit":20}（limit 封顶 50）。当【他阶段会话】摘要不够、需要了解客户在其它阶段聊过的细节时调用。
- propose_next_step：按项目当前状态计算下一步建议清单。args: {}。当用户问"下一步该做什么"时调用。
- req.doc.propose_edits：提交 CRD/PRD 修改建议（高亮补丁，用户确认后才生效）。args: {"kind":"crd|prd","instruction":"要改什么","mode":"patch"}（instruction 截 2000 字；mode 默认 patch=只改涉及章节。用户要求"整篇重写/完全重新写/彻底删除某章"时 mode 用 "rewrite"：以当前全文为基线重写整篇，产一条「整篇重写」补丁，同样经用户确认后生效；rewrite 前先用 doc.read 拿齐全文）。当用户要求修改需求文档内容时调用；调用后在正文说明"已发起修改建议提交（结果见下方工具卡），提交成功时请到需求页确认"。
- design.doc.propose_edits：提交设计八册修改建议（高亮补丁，用户确认后才生效）。args: {"kind":"hld|mod|alg|cls|db|api|ui|nfr","instruction":"要改什么","mode":"patch"}（mode 语义同 req.doc.propose_edits）。当用户要求修改设计册内容、或你核对后发现某册有缺口需要补齐时调用（kind 用册名小写）；正文说明"已发起修改建议提交，提交成功时请到设计页确认"。
- design.proto.propose_page：提交原型页修改提案（按意见重新生成该页 UI 原型为待处置提案，不直接改页面——用户在原型页双排对比后「✓ 采用 / ✗ 放弃」才生效）。args: {"pageCode":"P-001","instruction":"要改什么"}（pageCode 用目录页面编号；instruction 截 1000 字）。当用户要求修改某个原型页面的布局/配色/交互/内容时调用；正文说明"已发起页面修改提案（长调用约需数分钟），生成完成后请到原型页对比确认"。
工具由系统在回复完成后执行，结果以工具卡随消息呈现、并**自动回给你继续回答**（无需用户再发话；拿到结果就直接给结论或下一步工具调用，不要说"拿到结果后我会……"）；围栏块本身不会展示给用户。除 req.doc.propose_edits / design.doc.propose_edits / design.proto.propose_page 的提案通道外，写操作仍须走人工路径。`;

export const TOOL_BLOCK_CONDENSED = `【可用工具（可自主调用）】
需要时，在回复正文之外输出独立的工具围栏块（可多个；不需要则不输出）：
\`\`\`msf-tool
{"name":"工具名","args":{...}}
\`\`\`
- nav.goto：为用户打开页面。args: {"tab":"material|req|design|proto|dev|test|tasks|delegate|settings|rtm"}（RTM 需求矩阵直达 tab="rtm"）
- read_context：读取项目状态快照（各域条目计数）。args: {}
- doc.read：读取文档正文（草稿优先、章节标题带界面编号）。args: {"kind":"crd|prd|hld|mod|alg|cls|db|api|ui|nfr","anchor":"章节编号/标题/CR 编号（可选，指代章节时务必带）","offset":0}（截断时按返回的 nextOffset 续读；found:false=文档未生成；anchorFound:false 按 sections 清单修正重试）
- chat.history.read：读取本项目其它阶段会话最近消息。args: {"sessionCode":"ss_3","limit":20}（limit 封顶 50）
- propose_next_step：按项目状态给出下一步建议清单。args: {}
- req.doc.propose_edits：提交 CRD/PRD 修改建议（高亮补丁，用户确认后才生效）。args: {"kind":"crd|prd","instruction":"要改什么","mode":"patch|rewrite"}（instruction 截 2000 字；rewrite=整篇重写，先 doc.read 拿齐全文）
- design.doc.propose_edits：提交设计八册修改建议（高亮补丁，用户确认后才生效）。args: {"kind":"hld|mod|alg|cls|db|api|ui|nfr","instruction":"要改什么","mode":"patch|rewrite"}
- design.proto.propose_page：提交原型页修改提案（重新生成该页为待处置提案，用户「✓ 采用 / ✗ 放弃」才生效）。args: {"pageCode":"P-001","instruction":"要改什么"}（instruction 截 1000 字）
工具由系统在回复完成后执行，结果以工具卡随消息呈现、并**自动回给你继续回答**（拿到结果就直接给结论或下一步工具调用，不要说"拿到结果后我会……"）；围栏块本身不会展示给用户。除三件 propose 提案通道外，写操作仍须走人工路径。`;

/** 只读工具集（A7 并行调度口径，2026-10-11）：无写副作用，连续段可 Promise.all 并行；
 *  写类（propose_edits 等旁路外部工具）不在此列，保持声明顺序串行 */
const READONLY_TOOLS = new Set(['doc.read', 'read_context', 'chat.history.read', 'propose_next_step', 'nav.goto']);

/** 每轮最多解析执行的工具块数（A5 2026-10-11：3→6——多文档任务一轮常带 4~5 个 doc.read，
 *  残留块白烧接力轮；16 轮 × 6 块仍严格有界，防失控靠「内容无围栏即停」不变） */
const MAX_TOOL_SPANS_PER_ROUND = 6;

/** 闭合围栏块定位；另收「回合末尾未闭合但体部完整合法」的围栏——2026-10-06 实机：模型在长 JSON 后
 *  漏写收尾 ```，闭合 RE 零命中 → 围栏原文露出给用户 + 提案静默未执行（本次根修现场） */
function findToolSpans(content: string): Array<{ body: string; start: number; end: number }> {
  const spans: Array<{ body: string; start: number; end: number }> = [];
  for (const mm of content.matchAll(/```msf-tool\s*\n([\s\S]*?)```/g)) {
    if (spans.length >= MAX_TOOL_SPANS_PER_ROUND) break;
    spans.push({ body: mm[1]!.trim(), start: mm.index!, end: mm.index! + mm[0].length });
  }
  if (spans.length < MAX_TOOL_SPANS_PER_ROUND) {
    const tailStart = spans.length > 0 ? spans[spans.length - 1]!.end : 0;
    const om = /```msf-tool\s*\n([\s\S]*)$/.exec(content.slice(tailStart));
    if (om) {
      const body = om[1]!.trim();
      try {
        JSON.parse(body); // 体部完整合法才收：半截 JSON（流被截断）绝不执行，防半参数调用
        spans.push({ body, start: tailStart + (om.index ?? 0), end: content.length });
      } catch { /* 半截围栏不收 */ }
    }
  }
  return spans;
}

/** 围栏 span 剥离（不执行——接力封顶善后用，runToolBlocks 同路径复用） */
function stripToolSpans(content: string, spans: Array<{ body: string; start: number; end: number }>): string {
  let stripped = '';
  let cursor = 0;
  for (const s of spans) { stripped += content.slice(cursor, s.start); cursor = s.end; }
  return (stripped + content.slice(cursor)).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 接力轮上限。2026-10-09 实机「对话重新生成模块设计」：读密集型流程（mod/prd/hld 多文档+分页
 * 补读）7 次 doc.read 耗尽原上限 3 轮，propose_edits 没来得及发——消息停在口头承诺、页面未改。
 * 2026-10-10 再上探 8→16：工具结果跨轮累积后重读消失（见 toolLog），多册任务按「读一册提案一册」
 * 约 2~3 轮/册，16 轮覆盖五册重写全链仍有余量；防失控靠「内容无围栏即停」+ 剩余轮次倒计时警告。
 */
const MAX_RELAY_ROUNDS = 16;

/** agentic 接力 prompt：工具执行结果回喂（单结果截 16000 字防爆窗），模型据此同轮继续回答。
 *  与首轮同一份 basePrompt（系统声明+会话历史在场，接力轮不丢上下文）。
 *  toolLog=跨轮累积的全部工具结果（新→旧排序渲染时旧在前，淘汰最旧保最新）；
 *  roundsLeft=含本次在内还剩几次接力机会——≤3 起倒计时警告，=1 末轮硬警告（直接结论/提案，别再读）；
 *  band（Task 3）：回喂总预算取 BAND_BUDGETS[band].toolLog（wide 80000=现状常量原位参数化）——
 *  超出时淘汰最旧条目并明示，总预算防多轮累积无限膨胀 */
function buildToolFollowup(basePrompt: string, toolLog: Array<{ name: string; result: unknown }>, roundsLeft = 1, band: ContextBand = 'wide'): string {
  const blocks: string[] = [];
  let total = 0;
  let evicted = 0;
  const budget = BAND_BUDGETS[band].toolLog;
  // 最新的结果最可能被下一步用到：从尾向头装，超预算淘汰最旧
  const kept: string[] = [];
  for (let i = toolLog.length - 1; i >= 0; i--) {
    const r = toolLog[i]!;
    const json = JSON.stringify(r.result);
    const cut = json.length > 16000
      ? `${json.slice(0, 16000)}…（结果过长已截断，可用 doc.read 的 anchor/offset 参数定向补读）`
      : json;
    const block = `工具 ${r.name} 执行结果：\n${cut}`;
    if (total + block.length > budget && kept.length > 0) { evicted = i + 1; break; }
    kept.unshift(block);
    total += block.length;
  }
  if (toolLog.length > 0 && kept.length === 0) { kept.unshift(`工具 ${toolLog[toolLog.length - 1]!.name} 执行结果：（单条结果超总预算，请用 doc.read 的 anchor/offset 参数定向重读）`); }
  if (evicted > 0) blocks.push(`（更早的 ${evicted} 条工具结果因上下文预算已省略；若后续步骤仍需其内容，请用 doc.read 的 anchor/offset 参数定向重读该篇，不要整篇重读）`);
  blocks.push(...kept);
  const warn = roundsLeft <= 1
    ? '\n\n⚠️ 这是本轮最后一次工具回喂机会：请直接给出结论；要改文档就立刻提交 propose_edits 提案，不要再发起读取类调用。'
    : roundsLeft <= 3
      ? `\n\n⚠️ 工具接力还剩 ${roundsLeft} 次机会：请优先提交已读齐文档的 propose_edits 提案，不要再重复读取已有结果的文档。`
      : '';
  return `${basePrompt}

【工具执行结果（系统已执行你至今所有的围栏块调用，含此前各轮——结果持续在场，严禁重复读取同一文档）】
${blocks.join('\n\n')}

请基于上述结果直接给出回答或下一步动作（不要再说"我已发起读取，拿到结果后我会……"——结果已经在上文；确需换参数重读时才再次调用工具）。多文档任务纪律：每篇文档读齐后立刻提交该篇提案，再读下一篇。${warn}`;
}

