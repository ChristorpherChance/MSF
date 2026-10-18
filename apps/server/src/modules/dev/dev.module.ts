import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ExecutorModule } from '../executor/executor.module.js';
import { DevTasksService } from './tasks.service.js';
import { DevPlansService } from './plans.service.js';
import { DevBoardService } from './board.service.js';
import { DevAutopilotService } from './autopilot.service.js';
import { DevBuildService } from './build.service.js';
import { DevSelftestService } from './selftest.service.js';
import { DevTransferService } from './transfer.service.js';
import { DevImpactService } from './impact.service.js';
import { DevCiService } from './ci.service.js';
import { DevRepoService } from './repo.service.js';
import { DevWorkspaceService } from './workspace.service.js';
import { DevCodegenService } from './codegen.service.js';
import { DevPreviewService } from './preview.service.js';
import { DevController } from './dev.controller.js';
import { DevPreviewProxyController } from './preview-proxy.controller.js';

/** M06 开发域（M4：任务池/计划/看板/autopilot/构建/自测四门/转测试/变更/CI 回传；
 *  2026-10-18 真化：工作区/AI 写码/沙箱构建测试/长驻预览——AiModule+ExecutorModule 引入） */
@Module({
  imports: [PolicyModule, PlatformModule, AiModule, ExecutorModule],
  controllers: [DevController, DevPreviewProxyController],
  providers: [
    DevTasksService, DevPlansService, DevBoardService, DevAutopilotService,
    DevBuildService, DevSelftestService, DevTransferService, DevImpactService, DevCiService, DevRepoService,
    DevWorkspaceService, DevCodegenService, DevPreviewService,
  ],
  exports: [DevWorkspaceService],
})
export class DevModule {}
