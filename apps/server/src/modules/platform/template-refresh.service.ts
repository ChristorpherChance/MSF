import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { registerCommand, executeCommand, type CommandContext } from '../evidence/command-bus.js';
import { sanitizeAiError } from '../ai/stream-pipeline.js';

/** ⇄ 模板重排·批量任务编排器（设计 §1/§2：内存任务注册表沿用 GenOp 先例；进程重启丢任务=已知限制） */

export type RefreshHandler = (
  projectId: string, kind: string, ctx: CommandContext,
) => Promise<{ ok: boolean; reason?: string; patchCount?: number }>;

/** 每册处理器注册表（external-tools.ts 先例，零模块图边）：req/design generate.service onModuleInit 注册 */
const handlers = new Map<string, RefreshHandler>();
export function registerRefreshHandler(kind: string, h: RefreshHandler): void {
  if (handlers.has(kind)) throw new Error(`重排处理器重复注册: ${kind}`);
  handlers.set(kind, h);
}
/** 测试用：清空注册表 */
export function resetRefreshHandlers(): void { handlers.clear(); }

export const REFRESH_KINDS = ['crd', 'prd', 'hld', 'mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr'] as const;

interface KindState { status: 'queued' | 'running' | 'done' | 'failed' | 'skipped'; reason?: string; patchCount?: number }
export interface RefreshEvent { seq: number; type: string; data: Record<string, unknown> }
interface RefreshOp {
  id: string; projectId: string; kinds: string[];
  states: Map<string, KindState>;
  events: RefreshEvent[];
  subscribers: Set<(e: RefreshEvent) => void>;
  done: boolean; stopRequested: boolean;
  summary?: { done: number; failed: number; skipped: number };
  startedAt: number; finishedAt?: number;
  nextSeq: number; // 帧序号单调计数（滚动窗 shift 后不复用——lastEventId 断线重放口径）
  resolveDone: (() => void) | null;
}

const REQ_KINDS = new Set(['crd', 'prd']);
const WINDOW = 200; // 进度事件滚动窗（断线重放上限；批量任务生命周期短，无 Redis 镜像）

@Injectable()
export class TemplateRefreshService {
  private ops = new Map<string, RefreshOp>();

  onModuleInit(): void {
    registerCommand('template_refresh.start', async (_client, payload) => {
      const p = payload as { projectId: string; kinds: string[] };
      const kinds = [...new Set((p.kinds ?? []).map(String))]; // 重复 kind 去重
      if (kinds.length === 0) throw new DomainError('VALIDATION_FAILED', '请至少选择一册文档', 'kinds');
      const bad = kinds.find((k) => !(REFRESH_KINDS as readonly string[]).includes(k));
      if (bad) throw new DomainError('VALIDATION_FAILED', `未知文档类别 ${bad}`, 'kinds');
      for (const op of this.ops.values()) { // 同项目并发闸：有活跃批次即拒
        if (op.projectId === p.projectId && !op.done) {
          throw new DomainError('INVALID_STATE', '已有批量重排进行中（终态后可再发起）', op.id);
        }
      }
      const op: RefreshOp = {
        id: randomUUID(), projectId: p.projectId, kinds,
        states: new Map<string, KindState>(kinds.map((k) => [k, { status: 'queued' as const }])),
        events: [], subscribers: new Set(),
        done: false, stopRequested: false, startedAt: Date.now(), nextSeq: 1, resolveDone: null,
      };
      this.ops.set(op.id, op);
      return { operationId: op.id };
    });
    registerCommand('template_refresh.stop', async (_client, payload) => {
      const p = payload as { operationId: string };
      const op = this.ops.get(p.operationId);
      if (!op) throw new DomainError('NOT_FOUND', '批次不存在或已终结', p.operationId);
      op.stopRequested = true; // 轻量停止：当前在飞册跑完，剩余标 skipped（不中断在飞册=已知限制）
      return { stopped: true };
    });
  }

  /** 启动：命令落审计后后台驱动（不挂请求） */
  async start(projectId: string, kinds: string[], ctx: CommandContext): Promise<{ operationId: string }> {
    const r = (await executeCommand('template_refresh.start', { projectId, kinds }, ctx)) as { operationId: string };
    const op = this.ops.get(r.operationId)!;
    void this.drive(op, ctx).catch((e) => {
      console.error(`[template-refresh] drive crashed op=${op.id}: ${e instanceof Error ? e.message : e}`);
      this.finish(op); // 编排循环自身崩溃也要落终态，勿让订阅方永挂
    });
    return r;
  }

  async stop(projectId: string, operationId: string, ctx: CommandContext): Promise<void> {
    const op = this.ops.get(operationId);
    if (op && op.projectId !== projectId) throw new DomainError('FORBIDDEN', '批次不属本项目', operationId);
    await executeCommand('template_refresh.stop', { operationId }, ctx);
  }

  private async drive(op: RefreshOp, ctx: CommandContext): Promise<void> {
    for (const kind of op.kinds) { // 逐册串行
      if (op.stopRequested) {
        this.setState(op, kind, { status: 'skipped', reason: '人工停止' });
        this.emit(op, 'refresh.kind.skipped', { kind, reason: '人工停止' }); // 帧型闭集：停止跳过与预检跳过同帧，前端按帧渲染不停留 queued
        continue;
      }
      const skip = await this.precheck(op.projectId, kind);
      if (skip) {
        this.setState(op, kind, { status: 'skipped', reason: skip });
        this.emit(op, 'refresh.kind.skipped', { kind, reason: skip });
        continue;
      }
      this.setState(op, kind, { status: 'running' });
      this.emit(op, 'refresh.kind.started', { kind });
      const handler = handlers.get(kind);
      try {
        const r = handler
          ? await handler(op.projectId, kind, ctx)
          : { ok: false as const, reason: '该类别未注册重排处理器' };
        if (r.ok) {
          this.setState(op, kind, { status: 'done', ...(r.patchCount !== undefined ? { patchCount: r.patchCount } : {}) });
          this.emit(op, 'refresh.kind.done', { kind, patchCount: r.patchCount ?? 1, domain: REQ_KINDS.has(kind) ? 'req' : 'design' });
        } else {
          this.setState(op, kind, { status: 'failed', ...(r.reason !== undefined ? { reason: r.reason } : {}) });
          this.emit(op, 'refresh.kind.failed', { kind, reason: r.reason ?? '未知原因' });
        }
      } catch (e) { // 失败隔离：单册异常不阻断后续册
        const reason = sanitizeAiError(e instanceof Error ? e.message : String(e));
        this.setState(op, kind, { status: 'failed', reason });
        this.emit(op, 'refresh.kind.failed', { kind, reason });
      }
    }
    this.finish(op);
  }

  private finish(op: RefreshOp): void {
    if (op.done) return;
    const states = [...op.states.values()];
    op.summary = {
      done: states.filter((s) => s.status === 'done').length,
      failed: states.filter((s) => s.status === 'failed').length,
      skipped: states.filter((s) => s.status === 'skipped').length,
    };
    op.done = true; op.finishedAt = Date.now();
    this.emit(op, 'refresh.done', { summary: op.summary });
    op.resolveDone?.();
  }

  /** 守卫预检（与 proposeEditsFromChat 同口径，区分 skipped/failed；跨域只 SQL 直读不写） */
  private async precheck(projectId: string, kind: string): Promise<string | null> {
    const req = REQ_KINDS.has(kind);
    const docs = await query<{ final_version_id: string | null; current_version_id: string | null }>(
      `SELECT final_version_id, current_version_id FROM ${req ? 'req_documents' : 'dsg_documents'}
       WHERE project_id=$1 AND doc_kind=$2`, [projectId, kind]);
    const d = docs.rows[0];
    if (!d || !d.current_version_id) return '未生成（请先在页面生成初稿）';
    if (d.final_version_id && d.final_version_id === d.current_version_id) return '已定稿（需先在页面 ⋯ 解锁）';
    const pend = await query<{ n: string }>(
      `SELECT count(*) AS n FROM ${req ? 'req_pendings' : 'dsg_pendings'} p
       JOIN ${req ? 'req_documents' : 'dsg_documents'} d2 ON d2.id=p.document_id
       WHERE d2.project_id=$1 AND d2.doc_kind=$2 AND p.status='pending'`, [projectId, kind]);
    if (Number(pend.rows[0]?.n ?? 0) > 0) return '有待确认补丁，请先在页面处置';
    return null;
  }

  /** preflight 弹窗数据（设计 §3）：每册 内容有无/定稿/待确认数/启发式徽标 */
  async preflight(projectId: string): Promise<Array<{
    kind: string; domain: 'req' | 'design';
    hasContent: boolean; finalized: boolean; pending: number; mismatch: boolean | null;
  }>> {
    const { resolveTemplate } = await import('./doc-templates.js');
    const { anchorPrefixOf, auditSkeleton } = await import('./template-refresh.js');
    const items = [];
    for (const kind of REFRESH_KINDS) {
      const req = REQ_KINDS.has(kind);
      const docT = req ? 'req_documents' : 'dsg_documents';
      const verT = req ? 'req_versions' : 'dsg_versions';
      const drfT = req ? 'req_drafts' : 'dsg_drafts';
      const pendT = req ? 'req_pendings' : 'dsg_pendings';
      const r = await query<{
        final_version_id: string | null; current_version_id: string | null;
        draft: string | null; cur: string | null; pend: string;
      }>(
        `SELECT d.final_version_id, d.current_version_id,
                (SELECT content FROM ${drfT} t WHERE t.document_id=d.id) AS draft,
                (SELECT content FROM ${verT} v WHERE v.id=d.current_version_id) AS cur,
                (SELECT count(*) FROM ${pendT} p WHERE p.document_id=d.id AND p.status='pending') AS pend
         FROM ${docT} d WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, kind]);
      const d = r.rows[0];
      const effective = d?.draft ?? d?.cur ?? ''; // 草稿优先（doc.read 同口径）
      const t = resolveTemplate(req ? 'req' : 'design', kind, projectId);
      items.push({
        kind, domain: (req ? 'req' : 'design') as 'req' | 'design',
        hasContent: !!effective.trim(),
        finalized: !!(d?.final_version_id && d.final_version_id === d.current_version_id),
        pending: Number(d?.pend ?? 0),
        // 布尔过渡：Task 2 升 report 形态（issues 明细+上游滞后第四维），mismatch 字段届时退役
        mismatch: effective.trim() && t
          ? auditSkeleton(effective, t.chapters.map((c) => c.title), anchorPrefixOf(kind)).issues.length > 0
          : null, // 无内容/无模板不评
      });
    }
    return items;
  }

  subscribe(opId: string, fn: (e: RefreshEvent) => void): () => void {
    const op = this.ops.get(opId);
    if (!op) throw new DomainError('NOT_FOUND', '批次不存在或已终结', opId);
    op.subscribers.add(fn);
    return () => op.subscribers.delete(fn);
  }
  get(opId: string): RefreshOp | undefined { return this.ops.get(opId); }

  /** 测试等待口（集成测试断言终态用；生产路径不调用） */
  waitDone(opId: string): Promise<void> {
    const op = this.ops.get(opId);
    if (!op || op.done) return Promise.resolve();
    return new Promise((res) => { op.resolveDone = res; });
  }

  private setState(op: RefreshOp, kind: string, s: KindState): void { op.states.set(kind, s); }
  private emit(op: RefreshOp, type: string, data: Record<string, unknown>): void {
    const e: RefreshEvent = { seq: op.nextSeq++, type, data };
    op.events.push(e);
    if (op.events.length > WINDOW) op.events.shift();
    for (const sub of op.subscribers) { // 订阅者异常隔离：SSE 写已断socket 不得炸掉批次/吞掉终帧
      try { sub(e); } catch (err) {
        console.error(`[template-refresh] subscriber threw op=${op.id} seq=${e.seq}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
