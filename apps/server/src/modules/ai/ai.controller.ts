import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { AiModelsService, type ModelUpsertPayload } from './models.service.js';
import { AiPromptsService } from './prompts.service.js';
import { AiUsageService } from './usage.service.js';

/** AI 域端点（LLD-5 DSG-A08；模型 A08-9 / 提示词 A08-7 / 用量汇总 A08-10） */
@Controller('api/v1/ai')
export class AiController {
  constructor(
    @Inject(AiModelsService) private readonly models: AiModelsService,
    @Inject(AiPromptsService) private readonly prompts: AiPromptsService,
    @Inject(AiUsageService) private readonly usage: AiUsageService,
  ) {}

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

  // ---- 提示词版本（A08-7） ----

  @Get('prompts')
  promptAgents() {
    return this.prompts.agents();
  }

  @Get('prompts/:agentKey/versions')
  promptVersions(@Param('agentKey') agentKey: string) {
    return this.prompts.versions(agentKey);
  }

  @Post('prompts')
  @HttpCode(200)
  publishPrompt(@Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.prompts.publish(body, this.actor(req));
  }

  @Post('prompts/:agentKey\\:rollback')
  @HttpCode(200)
  rollbackPrompt(
    @Param('agentKey') agentKey: string,
    @Body() body: { versionNo: number },
    @Req() req: Request,
  ) {
    return this.prompts.rollback(agentKey, body.versionNo, this.actor(req));
  }

  // ---- 用量跨项目汇总（A08-10） ----

  @Get('usage/summary')
  usageSummary() {
    return this.usage.summary();
  }
}
