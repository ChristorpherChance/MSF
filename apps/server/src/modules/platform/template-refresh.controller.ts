import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { TemplateRefreshService } from './template-refresh.service.js';

/** ⇄ 模板重排端点（设计 §1：start/preflight/stream/stop 四个） */
@Controller('api/v1/projects/:projectId/template-refresh')
export class TemplateRefreshController {
  constructor(@Inject(TemplateRefreshService) private readonly svc: TemplateRefreshService) {}

  private actor(req: Request, projectId: string) {
    const a = getActor(req);
    return { projectId, actorKind: a.kind, actorId: a.id };
  }

  /** 弹窗数据：十册清单+启发式徽标+跳过预判（只读直查不经命令） */
  @Get('preflight')
  preflight(@Param('projectId') projectId: string) {
    return this.svc.preflight(projectId).then((items) => ({ items }));
  }

  /** 启动批量重排（命令落审计后后台驱动，立即回 operationId） */
  @Post('start')
  @HttpCode(200)
  start(@Param('projectId') projectId: string, @Body() body: { kinds: string[] }, @Req() req: Request) {
    return this.svc.start(projectId, body?.kinds ?? [], this.actor(req, projectId));
  }

  @Post(':opId\\:stop')
  @HttpCode(200)
  stopOp(@Param('projectId') projectId: string, @Param('opId') opId: string, @Req() req: Request) {
    return this.svc.stop(projectId, opId, this.actor(req, projectId)).then(() => ({ ok: true }));
  }

  /** SSE 进度：lastEventId 重放 + 续订至 refresh.done（A1 模式：X-Accel-Buffering + 15s 注释帧心跳） */
  @Get(':opId/stream')
  async stream(
    @Param('projectId') projectId: string,
    @Param('opId') opId: string,
    @Query('lastEventId') lastEventId: string | undefined,
    @Res() res: Response,
  ) {
    const op = this.svc.get(opId);
    if (!op || op.projectId !== projectId) { // 头未发方可走 JSON 错误（SSE 发出后全局过滤器接管不了）
      res.status(404).json({ error: { code: 'NOT_FOUND', message: '批次不存在或已终结' } });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // 前置 nginx 默认 proxy_buffering=on 会整包缓冲 SSE；此头令其直通
    res.setHeader('Connection', 'keep-alive');
    const emit = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    // A1 SSE 心跳：15s 注释帧保活（不占帧序号、不进滚动窗，前端解析循环天然跳过）
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 连接已断 */ }
    }, 15000);
    try {
      const last = lastEventId ? Number(lastEventId) : 0;
      for (const e of op.events.filter((x) => x.seq > last)) emit({ type: e.type, seq: e.seq, ...e.data });
      if (!op.done) {
        const unsub = this.svc.subscribe(opId, (e) => emit({ type: e.type, seq: e.seq, ...e.data }));
        // 等终态或客户端断开（断开即清理，勿泄漏轮询与订阅）
        await new Promise<void>((resolve) => {
          const t = setInterval(() => { if (op.done) { clearInterval(t); resolve(); } }, 500);
          res.on('close', () => { clearInterval(t); resolve(); });
        });
        unsub();
      }
    } finally {
      clearInterval(ping);
    }
    res.end();
  }
}
