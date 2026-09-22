import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { AiModelsService, type ModelUpsertPayload } from './models.service.js';

/** AI 域端点（LLD-5 DSG-A08；本阶段先落 A08-9 模型注册/路由，会话/委派随 T6-05+ 追加） */
@Controller('api/v1/ai')
export class AiController {
  constructor(@Inject(AiModelsService) private readonly models: AiModelsService) {}

  private actor(req: Request) {
    const a = getActor(req);
    return { projectId: null, actorKind: a.kind, actorId: a.id };
  }

  // ---- 模型注册与路由（A08-9） ----

  @Get('models')
  listModels() {
    return this.models.list();
  }

  @Post('models')
  @HttpCode(200)
  upsertModel(@Body() body: ModelUpsertPayload, @Req() req: Request) {
    return this.models.upsert(body, this.actor(req));
  }

  @Post('models/:id\\:test')
  @HttpCode(200)
  testModel(@Param('id') id: string, @Req() req: Request) {
    return this.models.test(id, this.actor(req));
  }

  @Get('routes')
  routes() {
    return this.models.routes();
  }

  @Put('routes/:purpose')
  setRoute(
    @Param('purpose') purpose: string,
    @Body() body: { modelId?: string | null },
    @Req() req: Request,
  ) {
    return this.models.setRoute(purpose, body.modelId ?? null, this.actor(req));
  }
}
