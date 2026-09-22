import { Module } from '@nestjs/common';
import { SandboxService } from './sandbox.service.js';

/** M09 沙箱执行器（M6：dockerode 直连，一次性容器最小权限，sandbox 网无出向） */
@Module({
  providers: [SandboxService],
  exports: [SandboxService],
})
export class ExecutorModule {}
