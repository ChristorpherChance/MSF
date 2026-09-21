import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller.js';
import { StorageService } from './storage.service.js';
import { FilesService } from './files.service.js';
import { ParseService } from './parse.service.js';
import { UploadsService } from './uploads.service.js';
import { ZipExtractService } from './zip-extract.service.js';

/** M03 资料域（M1 逐域推进：解析/定稿/批量作业随 T1-09~T1-16 补齐） */
@Module({
  controllers: [MaterialsController],
  providers: [FilesService, ParseService, StorageService, UploadsService, ZipExtractService],
  exports: [StorageService],
})
export class MaterialModule {}
