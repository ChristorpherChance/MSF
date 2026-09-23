import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AiModule } from '../ai/ai.module.js';
import { BatchService } from './batch.service.js';
import { FilesService } from './files.service.js';
import { ParseService } from './parse.service.js';
import { AiParseEngine } from './parse-engine.js';
import { UploadsService } from './uploads.service.js';
import { ZipExtractService } from './zip-extract.service.js';

/** M03 资料域（解析引擎实接：AiParseEngine 本地抽取 + 「解析」用途模型整理，AI_PROVIDER 经 AiModule 注入） */
@Module({
  controllers: [MaterialsController],
  imports: [PlatformModule, AiModule],
  providers: [BatchService, FilesService, ParseService, AiParseEngine, UploadsService, ZipExtractService],
})
export class MaterialModule {}
