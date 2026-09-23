import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '@msf/shared';
import { getActor } from '../api/identity.middleware.js';
import { NotificationsService } from './notifications.service.js';
import { PlatformReadService } from './platform-read.service.js';
import { SettingsService } from './settings.service.js';
import { BackupsService } from './backups.service.js';

/**
 * 系统面端点（LLD-5 DSG-A10-1~5；REQ-703/705/706/707/708/804）：
 * - 设置（sys_settings，非密；密钥类走 ai_models.api_key_enc）
 * - 通知中心（站内；GET 列表/:read/:read-all + :stream SSE 推送）
 * - 审计只读查询/导出（无改删端点）
 * - 备份导出（202 + operationId；完成通知含签名 URL）
 * - 用户最简（本地默认身份）
 */
@Controller('api/v1/system')
export class SystemController {
  constructor(
    @Inject(NotificationsService) private readonly notices: NotificationsService,
    @Inject(PlatformReadService) private readonly read: PlatformReadService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(BackupsService) private readonly backups: BackupsService,
  ) {}

  // ---- A10-1 设置 ----

  @Get('settings')
  getSettings() {
    return this.settings.getAll();
  }

  /** 请求体为平铺 { key: value } 设置表；baseVersion 本期不适用（单写者本地） */
  @Put('settings')
  async putSettings(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const a = getActor(req);
    const entries = Object.entries(body ?? {}).filter(([k]) => k !== 'baseVersion');
    if (entries.length === 0) throw new DomainError('VALIDATION_FAILED', '无设置项', 'body');
    for (const [key, value] of entries) {
      await this.settings.set(key, value, { projectId: null, actorKind: a.kind, actorId: a.id });
    }
    return { updated: entries.map(([k]) => k) };
  }

  // ---- A10-2 通知中心 ----

  @Get('notifications')
  listNotifications(
    @Query('unread') unread: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('projectId') projectId: string | undefined,
    @Req() req: Request,
  ) {
    return this.notices.list(
      {
        unreadOnly: unread === 'true',
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      },
      getActor(req).id,
    );
  }

  @Post('notifications/:noticeId\\:read')
  @HttpCode(200)
  readNotification(@Param('noticeId') noticeId: string, @Req() req: Request) {
    const a = getActor(req);
    return this.notices.read(noticeId, { projectId: null, actorKind: a.kind, actorId: a.id });
  }

  @Post('notifications\\:read-all')
  @HttpCode(200)
  readAllNotifications(@Req() req: Request) {
    const a = getActor(req);
    return this.notices.readAll({ projectId: null, actorKind: a.kind, actorId: a.id });
  }

  /** 通知实时推送（SSE；notice.created，断开自动退订） */
  @Get('notifications\\:stream')
  streamNotifications(@Req() req: Request, @Res() res: Response) {
    const userId = getActor(req).id;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const unsubscribe = this.notices.subscribe((n) => {
      if (n.user_id === null || n.user_id === userId) {
        res.write(`data: ${JSON.stringify({ type: 'notice.created', notice: n })}\n\n`);
      }
    });
    req.on('close', unsubscribe);
  }

  // ---- A10-3 审计查询（只读；无改删端点） ----

  @Get('audit')
  audit(
    @Query('projectId') projectId: string | undefined,
    @Query('actor') actor: string | undefined,
    @Query('command') command: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.read.audit({
      ...(projectId !== undefined ? { projectId } : {}),
      ...(actor !== undefined ? { actor } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  @Get('audit\\:export')
  auditExport(@Query('projectId') projectId: string | undefined) {
    return this.read.auditExport({ ...(projectId !== undefined ? { projectId } : {}) });
  }

  // ---- A10-4 备份导出 ----

  @Post('backups\\:export')
  @HttpCode(202)
  exportBackup(
    @Body() body: { scope?: string; projectId: string; includeEvidence?: boolean },
    @Req() req: Request,
  ) {
    if (!body?.projectId) throw new DomainError('VALIDATION_FAILED', 'projectId 必填', 'projectId');
    const a = getActor(req);
    return this.backups.export(
      body.projectId,
      { ...(body.scope !== undefined ? { scope: body.scope } : {}), ...(body.includeEvidence !== undefined ? { includeEvidence: body.includeEvidence } : {}) },
      { projectId: body.projectId, actorKind: a.kind, actorId: a.id },
    );
  }

  // ---- A10-5 用户（本期最简） ----

  @Get('users')
  users() {
    return this.read.users();
  }

  @Get('users/me')
  me(@Req() req: Request) {
    const a = getActor(req);
    return { id: a.id, name: '本地工程师', role: 'engineer', source: 'local', actorType: a.kind };
  }
}
