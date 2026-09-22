import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { AiSessionsService } from './sessions.service.js';

/** AI 会话端点（LLD-5 DSG-A08-1/2/3/4；REQ-601/602/603/608） */
@Controller('api/v1/projects/:projectId/ai')
export class AiSessionsController {
  constructor(@Inject(AiSessionsService) private readonly sessions: AiSessionsService) {}

  private actor(req: Request, projectId: string) {
    const a = getActor(req);
    return { projectId, actorKind: a.kind, actorId: a.id };
  }

  /** A08-1 会话创建/列表 */
  @Post('sessions')
  @HttpCode(200)
  create(
    @Param('projectId') projectId: string,
    @Body() body: { ctx: string; name?: string; thinkLevel?: string },
    @Req() req: Request,
  ) {
    return this.sessions.create(projectId, body, this.actor(req, projectId));
  }

  @Get('sessions')
  list(
    @Param('projectId') projectId: string,
    @Query('ctx') ctx?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.sessions.list(projectId, ctx, cursor, limit ? Number(limit) : 20);
  }

  /** A08-2 会话切换（留痕）与消息历史（游标分页） */
  @Post('sessions/:sessionId\\:switch')
  @HttpCode(200)
  switchSession(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    return this.sessions.switchSession(projectId, sessionId, this.actor(req, projectId));
  }

  @Get('sessions/:sessionId/messages')
  messages(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.sessions.messages(projectId, sessionId, cursor, limit ? Number(limit) : 50);
  }

  /** A08-3 发送消息（POST-SSE；首帧 stream.start 携带 operationId=messageId 供 pause/resume/stop 寻址） */
  @Post('sessions/:sessionId/messages\\:send')
  async send(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: {
      content: string;
      referenceFileIds?: string[];
      referenceFingerprints?: Record<string, string>;
      thinkLevel?: string;
    },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ctx = this.actor(req, projectId);
    const { messageId } = await this.sessions.send(projectId, sessionId, body, ctx);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const emit = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    emit({ type: 'stream.start', operationId: messageId });
    await this.sessions.drive(messageId, emit, { thinkLevel: body.thinkLevel, ctx });
    res.end();
  }

  /** A08-4 流控（pause/resume=缓冲层；stop=abort） */
  @Post('messages/:messageId\\:pause')
  @HttpCode(200)
  pause(@Param('projectId') projectId: string, @Param('messageId') messageId: string, @Req() req: Request) {
    return this.sessions.control(projectId, messageId, 'pause', this.actor(req, projectId));
  }

  @Post('messages/:messageId\\:resume')
  @HttpCode(200)
  resume(@Param('projectId') projectId: string, @Param('messageId') messageId: string, @Req() req: Request) {
    return this.sessions.control(projectId, messageId, 'resume', this.actor(req, projectId));
  }

  @Post('messages/:messageId\\:stop')
  @HttpCode(200)
  stop(@Param('projectId') projectId: string, @Param('messageId') messageId: string, @Req() req: Request) {
    return this.sessions.control(projectId, messageId, 'stop', this.actor(req, projectId));
  }

  /** A08-4 断线重挂：lastEventId 重放 + 续订 */
  @Get('messages/:messageId/stream')
  async attach(
    @Param('projectId') projectId: string,
    @Param('messageId') messageId: string,
    @Query('lastEventId') lastEventId: string | undefined,
    @Res() res: Response,
  ) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const emit = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    await this.sessions.attach(projectId, messageId, lastEventId ? Number(lastEventId) : 0, emit);
    res.end();
  }
}
