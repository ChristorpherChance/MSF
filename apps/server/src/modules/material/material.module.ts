import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller.js';
import { PlatformModule } from '../platform/platform.module.js';
import { BatchService } from './batch.service.js';
import { FilesService } from './files.service.js';
import { ParseService } from './parse.service.js';
import { UploadsService } from './uploads.service.js';
import { ZipExtractService } from './zip-extract.service.js';

/** M03 资料域（M1 逐域推进：解析/定稿/批量作业随 T1-09~T1-16 补齐） */
@Module({
  controllers: [MaterialsController],
  imports: [PlatformModule],
  providers: [BatchService, FilesService, ParseService, UploadsService, ZipExtractService],
})
export class MaterialModule {}
