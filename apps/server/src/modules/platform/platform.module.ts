import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { StorageService } from './storage.service.js';
import { NotificationsService } from './notifications.service.js';
import { PlatformReadService } from './platform-read.service.js';
import { SettingsService } from './settings.service.js';
import { BackupsService } from './backups.service.js';
import { TemplateSetsService } from './template-sets.service.js';
import { SystemController } from './system.controller.js';
import { ProjectPlatformController } from './project-platform.controller.js';
import { AuthController } from './auth.controller.js';

/** M13 平台管理（M7 补齐：阶段准入/通知/任务中心/事件流/设置/放行策略/审计查询/备份导出） */
@Module({
  controllers: [ProjectsController, SystemController, ProjectPlatformController, AuthController],
  providers: [ProjectsService, StorageService, NotificationsService, PlatformReadService, SettingsService, BackupsService, TemplateSetsService],
  exports: [StorageService, NotificationsService],
})
export class PlatformModule {}
