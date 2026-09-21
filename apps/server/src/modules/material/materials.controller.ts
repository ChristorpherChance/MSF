import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { UploadsService, type CreateUploadInput } from './uploads.service.js';
import { FilesService } from './files.service.js';
import { ZipExtractService } from './zip-extract.service.js';

/** 资料域端点（LLD-5 §3 DSG-A03；本控制器随 T1-03~T1-16 逐任务扩面） */
@Controller('api/v1/projects/:projectId/materials')
export class MaterialsController {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据，隐式 DI 在测试环境失效
  constructor(
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(ZipExtractService) private readonly zipExtract: ZipExtractService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

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

  /** A03-5 双目录树查询（REQ-105/106） */
  @Get('tree')
  tree(@Param('projectId') projectId: string) {
    return this.files.tree(projectId);
  }

  /** A03-6 文件列表（状态多值过滤 + 分页默认 20） */
  @Get('files')
  list(
    @Param('projectId') projectId: string,
    @Query('status') status?: string,
    @Query('folderId') folderId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.files.list(projectId, {
      status,
      folderId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** A03-7 文件详情（parsed/content/source 三视图） */
  @Get('files/:fileId')
  detail(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Query('view') view?: 'parsed' | 'content' | 'source',
  ) {
    return this.files.detail(projectId, fileId, view ?? 'parsed');
  }

  /** A03-4 ZIP 行内解压（同名冲突默认拒绝，rename 自动追加序号；REQ-104） */
  @Post('files/:fileId\:extract')
  @HttpCode(200)
  extractZip(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Body() body: { onConflict?: 'reject' | 'rename' },
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.zipExtract.extract(projectId, fileId, body?.onConflict ?? 'reject', {
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
