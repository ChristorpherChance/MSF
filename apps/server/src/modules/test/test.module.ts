import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { DevModule } from '../dev/dev.module.js';
import { ExecutorModule } from '../executor/executor.module.js';
import { TstBatchesService } from './batches.service.js';
import { TstPlansService } from './plans.service.js';
import { TstRunsService } from './runs.service.js';
import { TstDefectsService } from './defects.service.js';
import { TstReportsService } from './reports.service.js';
import { TestController } from './test.controller.js';

/** M07 测试验收域（M5：批次接收/快照/阻断恢复、计划起草批准、两级执行、缺陷五态、报告定稿、条件放行；
 *  2026-10-18 真化：自动用例沙箱真跑——DevWorkspaceService 从 DevModule 导入（单实例单注册，防命令重复）） */
@Module({
  // ExecutorModule 必须显式进 imports：DevModule 引了但未转口 SandboxService，
  // 缺省后 TstRunsService 的 @Optional sandbox 恒 undefined→真化模式 runs:execute 503（2026-10-22 全链实测实抓）
  imports: [PolicyModule, PlatformModule, DevModule, ExecutorModule],
  controllers: [TestController],
  providers: [TstBatchesService, TstPlansService, TstRunsService, TstDefectsService, TstReportsService],
})
export class TestModule {}
