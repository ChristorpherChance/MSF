import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { AiDelegationsService } from './delegations.service.js';
import { AiSessionsService } from './sessions.service.js';
import { AiToolsService } from './tools.service.js';
import { AiUsageService } from './usage.service.js';

/** AI 会话端点（LLD-5 DSG-A08-1/2/3/4/8；REQ-601/602/603/608/610） */
@Controller('api/v1/projects/:projectId/ai')
export class AiSessionsController {
  constructor(
    @Inject(AiSessionsService) private readonly sessions: AiSessionsService,
    @Inject(AiToolsService) private readonly tools: AiToolsService,
    @Inject(AiUsageService) private readonly usage: AiUsageService,
    @Inject(AiDelegationsService) private readonly delegations: AiDelegationsService,
  ) {}

  private actor(req: Request, projectId: string) {
    const a = getActor(req);
    return { projectId, actorKind: a.kind, actorId: a.id };
  }

  /** A08-1 会话创建/列表（2026-10-08：docKind 工件绑定——req=crd|prd、design=八册；列表 docKind 缺省=不过滤、空串=NULL 组） */
  @Post('sessions')
  @HttpCode(200)
  create(
    @Param('projectId') projectId: string,
    @Body() body: { ctx: string; name?: string; thinkLevel?: string; docKind?: string | null },
    @Req() req: Request,
  ) {
    return this.sessions.create(projectId, body, this.actor(req, projectId));
  }

  @Get('sessions')
  list(
    @Param('projectId') projectId: string,
    @Query('ctx') ctx?: string,
    @Query('docKind') docKind?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const dk = docKind === undefined ? undefined : docKind === '' ? null : docKind;
    return this.sessions.list(projectId, ctx, cursor, limit ? Number(limit) : 20, dk);
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

  /** dock ⋯ 菜单：会话重命名/删除（DSG-U02-4 会话操作；删除随消息，用量留账） */
  @Post('sessions/:sessionId\\:rename')
  @HttpCode(200)
  renameSession(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { name: string },
    @Req() req: Request,
  ) {
    return this.sessions.renameSession(projectId, sessionId, body.name, this.actor(req, projectId));
  }

  @Post('sessions/:sessionId\\:delete')
  @HttpCode(200)
  deleteSession(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    return this.sessions.deleteSession(projectId, sessionId, this.actor(req, projectId));
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

  /** 会话级模型切换（DSG-U02-4 #model-sel；null 回落 chat 路由默认） */
  @Post('sessions/:sessionId\\:set-model')
  @HttpCode(200)
  setModel(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { modelId: string | null },
    @Req() req: Request,
  ) {
    return this.sessions.setModel(projectId, sessionId, body.modelId ?? null, this.actor(req, projectId));
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
    res.setHeader('X-Accel-Buffering', 'no'); // 前置 nginx 默认 proxy_buffering=on 会整包缓冲 SSE（2026-10-09 公网实测）；此头令其直通
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

  /** 自定义模板类别 AI 起草（2026-10-07）：出草案不落库，人工审改后存套件（用量落账 purpose=chat） */
  @Post('template-draft')
  @HttpCode(200)
  draftTemplate(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; hint?: string },
  ) {
    return this.sessions.draftTemplate(projectId, body.name ?? '', body.hint ?? '');
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
    res.setHeader('X-Accel-Buffering', 'no'); // 前置 nginx 默认 proxy_buffering=on 会整包缓冲 SSE（2026-10-09 公网实测）；此头令其直通
    res.setHeader('Connection', 'keep-alive');
    const emit = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    await this.sessions.attach(projectId, messageId, lastEventId ? Number(lastEventId) : 0, emit);
    res.end();
  }

  // ---- 工具桥（A08-5/6） ----

  @Get('tools')
  toolList() {
    return this.tools.list();
  }

  @Post('tools\\:invoke')
  @HttpCode(200)
  invokeTool(
    @Param('projectId') projectId: string,
    @Body() body: { sessionId?: string; messageId?: string; toolName: string; args?: Record<string, unknown> },
    @Req() req: Request,
  ) {
    return this.tools.invoke(projectId, body, this.actor(req, projectId));
  }

  @Get('sessions/:sessionId/tool-calls')
  toolCalls(@Param('projectId') projectId: string, @Param('sessionId') sessionId: string) {
    return this.tools.callsOfSession(projectId, sessionId);
  }

  // ---- 项目用量（A08-10） ----

  @Get('usage')
  async projectUsage(
    @Param('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('purpose') purpose?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    await this.usage.assertProject(projectId);
    return this.usage.ofProject(projectId, {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  @Get('usage/breakdown')
  async usageBreakdown(@Param('projectId') projectId: string) {
    await this.usage.assertProject(projectId);
    return this.usage.breakdown(projectId);
  }

  // ---- 委派（A08-8） ----

  @Get('delegations')
  delegationList(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.delegations.list(projectId, status);
  }

  @Post('delegations')
  @HttpCode(200)
  delegationCreate(
    @Param('projectId') projectId: string,
    @Body() body: {
      target: string; taskDesc: string; taskId?: string;
      workspaceScope?: unknown[]; budgetLimit?: number;
    },
    @Req() req: Request,
  ) {
    return this.delegations.create(projectId, body, this.actor(req, projectId));
  }

  @Get('delegations/:delegationId')
  delegationDetail(@Param('projectId') projectId: string, @Param('delegationId') delegationId: string) {
    return this.delegations.detail(projectId, delegationId);
  }

  @Post('delegations/:delegationId\\:cancel')
  @HttpCode(200)
  delegationCancel(
    @Param('projectId') projectId: string,
    @Param('delegationId') delegationId: string,
    @Req() req: Request,
  ) {
    return this.delegations.cancel(projectId, delegationId, this.actor(req, projectId));
  }

  @Get('delegation-targets')
  delegationTargets() {
    return this.delegations.targets();
  }
}
