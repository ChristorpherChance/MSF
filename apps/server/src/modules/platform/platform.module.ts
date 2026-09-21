import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

/** M13 平台管理（M0 最小集：项目；通知/任务中心/设置/备份随里程碑补齐） */
@Module({ controllers: [ProjectsController], providers: [ProjectsService] })
export class PlatformModule {}
