import { Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface.js';
import { AiController } from './ai.controller.js';
import { AiModelsService } from './models.service.js';
import { MockAiProvider } from './mock-ai.provider.js';
import { PiAiGateway } from './pi-gateway.js';

/**
 * M08 AI 编排层：mock 与 Pi 真接并存，MSF_AI_PROVIDER=mock|pi 切换（默认 mock，REQ-615）。
 * 模型注册/路由（D08-5）独立于开关——pi 模式下经 ModelRouter 解析用途→模型。
 */
@Module({
  controllers: [AiController],
  providers: [
    AiModelsService,
    {
      provide: AI_PROVIDER,
      inject: [AiModelsService],
      useFactory: (models: AiModelsService) =>
        process.env.MSF_AI_PROVIDER === 'pi' ? new PiAiGateway(models) : new MockAiProvider(),
    },
  ],
  exports: [AI_PROVIDER, AiModelsService],
})
export class AiModule {}
