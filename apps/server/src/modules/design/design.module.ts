import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AiModule } from '../ai/ai.module.js';
import { DesignDocsService } from './docs.service.js';
import { DesignGenerateService } from './generate.service.js';
import { CatalogService } from './catalog.service.js';
import { PrototypeService } from './prototype.service.js';
import { PrototypePagesService } from './prototype-pages.service.js';
import { ReviewService } from './review.service.js';
import { DesignController } from './design.controller.js';
import { DesignExportService } from './export.service.js';

/** M05 设计域（M3：八册文档生命周期 + 原型四步流水 + 目录/来源审计 + 基线 + 评审；M7 生成真接 AiModule 的 AI_PROVIDER，mock 兜底） */
@Module({
  imports: [PolicyModule, PlatformModule, AiModule],
  controllers: [DesignController],
  providers: [DesignDocsService, DesignGenerateService, CatalogService, PrototypeService, PrototypePagesService, ReviewService, DesignExportService],
})
export class DesignModule {}
