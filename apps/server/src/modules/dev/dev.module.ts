import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { DevTasksService } from './tasks.service.js';
import { DevPlansService } from './plans.service.js';
import { DevBoardService } from './board.service.js';
import { DevAutopilotService } from './autopilot.service.js';
import { DevBuildService } from './build.service.js';
import { DevSelftestService } from './selftest.service.js';
import { DevTransferService } from './transfer.service.js';
import { DevImpactService } from './impact.service.js';
import { DevCiService } from './ci.service.js';
import { DevController } from './dev.controller.js';

/** M06 开发域（M4：任务池/计划/看板/autopilot/构建/自测四门/转测试/变更/CI 回传） */
@Module({
  imports: [PolicyModule, PlatformModule],
  controllers: [DevController],
  providers: [
    DevTasksService, DevPlansService, DevBoardService, DevAutopilotService,
    DevBuildService, DevSelftestService, DevTransferService, DevImpactService, DevCiService,
  ],
})
export class DevModule {}
