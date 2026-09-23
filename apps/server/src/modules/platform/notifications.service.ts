import { Injectable } from '@nestjs/common';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';

/**
 * 通知中心与领域事件流（DSG-D09-3/D10-5；A10-2/A02-6；REQ-703）：
 * - evidence.event.emit：领域事件 append（evd_events，与 audit_log 分工：事件管业务事实）
 * - system.notification.emit：通知落库（user_id NULL=全员），同事务可选携带领域事件
 * - SSE：进程内订阅总线（单进程自托管），通知提交后推 notice.created（A01-6）
 * - 读：未读过滤/游标分页/单条已读/全部已读
 */

export interface NoticeRow {
  id: string; project_id: string | null; user_id: string | null; type: string; text: string;
  unread: boolean; created_at: string;
}

type Listener = (n: NoticeRow) => void;
const listeners = new Set<Listener>();

@Injectable()
export class NotificationsService {
  onModuleInit(): void {
    registerCommand('evidence.event.emit', async (client, payload, ctx) => {
      const p = payload as { kind: string; payload?: unknown };
      await client.query(
        'INSERT INTO evd_events (project_id, kind, payload, actor_kind, actor_id) VALUES ($1,$2,$3,$4,$5)',
        [ctx.projectId, p.kind, JSON.stringify(p.payload ?? {}), ctx.actorKind, ctx.actorId]);
      return { emitted: p.kind };
    });
    registerCommand('system.notification.emit', async (client, payload, ctx) => {
      const p = payload as { type: string; text: string; userId?: string; eventKind?: string };
      const r = await client.query<NoticeRow>(
        'INSERT INTO sys_notifications (project_id, user_id, type, text) VALUES ($1,$2,$3,$4) RETURNING *',
        [ctx.projectId, p.userId ?? null, p.type, p.text]);
      if (p.eventKind) {
        await client.query(
          'INSERT INTO evd_events (project_id, kind, payload, actor_kind, actor_id) VALUES ($1,$2,$3,$4,$5)',
          [ctx.projectId, p.eventKind, JSON.stringify({ noticeId: r.rows[0]!.id, type: p.type }), ctx.actorKind, ctx.actorId]);
      }
      return { noticeId: r.rows[0]!.id };
    });
    registerCommand('system.notification.read', async (client, payload) => {
      const p = payload as { noticeId: string };
      await client.query('UPDATE sys_notifications SET unread=false WHERE id=$1', [p.noticeId]);
      return { noticeId: p.noticeId };
    });
    registerCommand('system.notification.read_all', async (client, _payload, ctx) => {
      const r = await client.query(
        'UPDATE sys_notifications SET unread=false WHERE unread AND (user_id IS NULL OR user_id=$1) RETURNING id',
        [ctx.actorId]);
      return { count: r.rowCount };
    });
  }

  /** 通知产生（命令提交后推 SSE；供各域经命令总线调用，跨域零 import） */
  async emit(ctx: CommandContext, input: { type: string; text: string; userId?: string; eventKind?: string }): Promise<string> {
    const r = (await executeCommand('system.notification.emit', input, ctx)) as { noticeId: string };
    const row = await query<NoticeRow>('SELECT * FROM sys_notifications WHERE id=$1', [r.noticeId]);
    if (row.rows[0]) for (const l of listeners) l(row.rows[0]);
    return r.noticeId;
  }

  /** 领域事件 append（轻量入口，不带通知） */
  async emitEvent(ctx: CommandContext, kind: string, payload: unknown): Promise<void> {
    await executeCommand('evidence.event.emit', { kind, payload }, ctx);
  }

  async list(q: { unreadOnly: boolean; cursor?: string; limit?: number; projectId?: string }, userId: string) {
    const params: unknown[] = [userId];
    let where = '(user_id IS NULL OR user_id=$1)';
    if (q.unreadOnly) where += ' AND unread';
    if (q.projectId) { params.push(q.projectId); where += ` AND project_id=$${params.length}`; }
    if (q.cursor) { params.push(q.cursor); where += ` AND created_at < $${params.length}`; }
    params.push((q.limit ?? 30) + 1);
    const r = await query<NoticeRow>(
      `SELECT * FROM sys_notifications WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    const items = r.rows.slice(0, q.limit ?? 30);
    const unread = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sys_notifications WHERE unread AND (user_id IS NULL OR user_id=$1)', [userId]);
    return { items, nextCursor: r.rows.length > (q.limit ?? 30) ? items[items.length - 1]!.created_at : null, unreadCount: unread.rows[0]!.n };
  }

  async read(noticeId: string, ctx: CommandContext): Promise<void> {
    await executeCommand('system.notification.read', { noticeId }, ctx);
  }

  async readAll(ctx: CommandContext): Promise<{ count: number }> {
    return (await executeCommand('system.notification.read_all', {}, ctx)) as { count: number };
  }

  /** SSE 订阅（notice.created；断开自动退订） */
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  }
}
