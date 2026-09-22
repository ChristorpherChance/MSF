import { Module } from '@nestjs/common';
import { ExecutorModule } from '../executor/executor.module.js';
import { AI_PROVIDER } from './ai-provider.interface.js';
import { AiController } from './ai.controller.js';
import { AiSessionsController } from './ai-sessions.controller.js';
import { AiDelegationsService } from './delegations.service.js';
import { AiModelsService } from './models.service.js';
import { AiPromptsService } from './prompts.service.js';
import { AiSessionsService } from './sessions.service.js';
import { AiToolsService } from './tools.service.js';
import { AiUsageService } from './usage.service.js';
import { MockAiProvider } from './mock-ai.provider.js';
import { PiAiGateway } from './pi-gateway.js';
import { StreamPipeline } from './stream-pipeline.js';

/**
 * M08 AI 编排层：mock 与 Pi 真接并存，MSF_AI_PROVIDER=mock|pi 切换（默认 mock，REQ-615）。
 * 模型注册/路由（D08-5）独立于开关——pi 模式下经 ModelRouter 解析用途→模型。
 */
@Module({
  imports: [ExecutorModule],
  controllers: [AiController, AiSessionsController],
  providers: [
    AiModelsService,
    AiSessionsService,
    AiToolsService,
    AiPromptsService,
    AiUsageService,
    AiDelegationsService,
    StreamPipeline,
    {
      provide: AI_PROVIDER,
      inject: [AiModelsService],
      useFactory: (models: AiModelsService) =>
        process.env.MSF_AI_PROVIDER === 'pi' ? new PiAiGateway(models) : new MockAiProvider(),
    },
  ],
  exports: [AI_PROVIDER, AiModelsService, AiSessionsService, AiToolsService, AiPromptsService, AiUsageService, AiDelegationsService, StreamPipeline],
})
export class AiModule {}
