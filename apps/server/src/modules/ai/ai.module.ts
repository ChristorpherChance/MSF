import { Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface.js';
import { MockAiProvider } from './mock-ai.provider.js';

/** M08 AI 编排层：M0~M5 提供 mock；M6 以 Pi SDK 真实现替换（接口不变，REQ-615） */
@Module({
  providers: [{ provide: AI_PROVIDER, useClass: MockAiProvider }],
  exports: [AI_PROVIDER],
})
export class AiModule {}
