import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { TstBatchesService } from './batches.service.js';
import { TstPlansService } from './plans.service.js';
import { TstRunsService } from './runs.service.js';
import { TstDefectsService } from './defects.service.js';
import { TstReportsService } from './reports.service.js';
import { TestController } from './test.controller.js';

/** M07 测试验收域（M5：批次接收/快照/阻断恢复、计划起草批准、两级执行、缺陷五态、报告定稿、条件放行） */
@Module({
  imports: [PolicyModule, PlatformModule],
  controllers: [TestController],
  providers: [TstBatchesService, TstPlansService, TstRunsService, TstDefectsService, TstReportsService],
})
export class TestModule {}
