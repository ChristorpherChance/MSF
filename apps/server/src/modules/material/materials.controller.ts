import { Body, Controller, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { UploadsService, type CreateUploadInput } from './uploads.service.js';

/** 资料域端点（LLD-5 §3 DSG-A03；本控制器随 T1-03~T1-16 逐任务扩面） */
@Controller('api/v1/projects/:projectId/materials')
export class MaterialsController {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据，隐式 DI 在测试环境失效
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  /** A03-1 创建上传会话（分片/ZIP 通用入口） */
  @Post('uploads')
  @HttpCode(201)
  createUpload(
    @Param('projectId') projectId: string,
    @Body() body: CreateUploadInput,
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.uploads.create(projectId, body, {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  /** A03-2 上传分片（(uploadId, partNumber) 天然键幂等，豁免 Idempotency-Key） */
  @Put('uploads/:uploadId/parts/:partNumber')
  async uploadPart(
    @Param('projectId') projectId: string,
    @Param('uploadId') uploadId: string,
    @Param('partNumber') partNumber: string,
    @Req() req: Request,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    return this.uploads.uploadPart(projectId, uploadId, Number(partNumber), Buffer.concat(chunks));
  }

  /** A03-3 完成上传（合并 + 整体 SHA-256 + ZIP 整包十五步校验，通过才一次提交） */
  @Post('uploads/:uploadId\\:complete')
  @HttpCode(200)
  complete(
    @Param('projectId') projectId: string,
    @Param('uploadId') uploadId: string,
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.uploads.complete(projectId, uploadId, {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  /** A03-18 中止上传会话（uploading→aborted + 回收暂存分片） */
  @Post('uploads/:uploadId\\:abort')
  @HttpCode(200)
  abort(
    @Param('projectId') projectId: string,
    @Param('uploadId') uploadId: string,
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.uploads.abort(projectId, uploadId, {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }
}
