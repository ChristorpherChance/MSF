import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ReqDocsService } from './docs.service.js';
import { GenerateService } from './generate.service.js';
import { RtmService } from './rtm.service.js';
import { ReqExportService } from './export.service.js';
import { ReqController } from './req.controller.js';

/** M04 需求域（M2：CRD/PRD 生命周期 + RTM + 导出；M6 生成真接 AiModule 的 AI_PROVIDER，mock 兜底） */
@Module({
  imports: [PolicyModule, PlatformModule, AiModule],
  controllers: [ReqController],
  providers: [ReqDocsService, GenerateService, RtmService, ReqExportService],
})
export class ReqModule {}
