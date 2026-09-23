import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { UploadsService, type CreateUploadInput } from './uploads.service.js';
import { BatchService } from './batch.service.js';
import { FilesService } from './files.service.js';
import { ParseService } from './parse.service.js';
import { ZipExtractService } from './zip-extract.service.js';

/** 资料域端点（LLD-5 §3 DSG-A03；本控制器随 T1-03~T1-16 逐任务扩面） */
@Controller('api/v1/projects/:projectId/materials')
export class MaterialsController {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据，隐式 DI 在测试环境失效
  constructor(
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(ZipExtractService) private readonly zipExtract: ZipExtractService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ParseService) private readonly parse: ParseService,
    @Inject(BatchService) private readonly batch: BatchService,
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

  /** 原件下载（⬇ 工具栏；签名 URL，MinIO 承载） */
  @Get('files/:fileId/download')
  download(@Param('projectId') projectId: string, @Param('fileId') fileId: string) {
    return this.files.download(projectId, fileId);
  }

  /** 文件双向同步删除（LLD-6 §3.2 delFile；原文件+解析稿+ZIP 子件；引用守卫；理由必填） */
  @Delete('files/:fileId')
  deleteFile(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Body() body: { reason?: string },
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.parse.deleteFile(projectId, fileId, body?.reason ?? '', {
      projectId, actorKind: actor.kind, actorId: actor.id,
    });
  }

  /** A03-4 ZIP 行内解压（同名冲突默认拒绝，rename 自动追加序号；REQ-104） */
  @Post('files/:fileId\\:extract')
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

  /** A03-8 单个解析（202 + operationId，异步完成） */
  @Post('files/:fileId\\:parse')
  @HttpCode(202)
  parseFile(@Param('projectId') projectId: string, @Param('fileId') fileId: string, @Req() req: Request) {
    const actor = getActor(req);
    return this.parse.parse(projectId, fileId, { projectId, actorKind: actor.kind, actorId: actor.id });
  }

  /** A03-10 解析重试（仅 failed；流转全量留痕） */
  @Post('files/:fileId\\:retry-parse')
  @HttpCode(202)
  retryParse(@Param('projectId') projectId: string, @Param('fileId') fileId: string, @Req() req: Request) {
    const actor = getActor(req);
    return this.parse.parse(projectId, fileId, { projectId, actorKind: actor.kind, actorId: actor.id }, true);
  }

  /** A03-11 文件定稿 / 解锁定稿 */
  @Post('files/:fileId\\:finalize-file')
  @HttpCode(200)
  finalizeFile(@Param('projectId') projectId: string, @Param('fileId') fileId: string, @Req() req: Request) {
    const actor = getActor(req);
    return this.parse.finalizeFile(projectId, fileId, { projectId, actorKind: actor.kind, actorId: actor.id });
  }

  @Post('files/:fileId\\:unfinalize-file')
  @HttpCode(200)
  unfinalizeFile(@Param('projectId') projectId: string, @Param('fileId') fileId: string, @Req() req: Request) {
    const actor = getActor(req);
    return this.parse.unfinalizeFile(projectId, fileId, { projectId, actorKind: actor.kind, actorId: actor.id });
  }

  /** A03-12 内容定稿（单件；批量随 T1-15） */
  @Post('files/:fileId\\:finalize-content')
  @HttpCode(200)
  finalizeContent(@Param('projectId') projectId: string, @Param('fileId') fileId: string, @Req() req: Request) {
    const actor = getActor(req);
    return this.parse.finalizeContent(projectId, fileId, { projectId, actorKind: actor.kind, actorId: actor.id });
  }

  /** A03-13 内容稿编辑保存（baseFingerprint 乐观锁，VERSION_CONFLICT 兜底） */
  @Put('files/:fileId/content-draft')
  saveDraft(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Body() body: { contentMd: string; baseFingerprint: string | null },
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.parse.saveDraft(projectId, fileId, body.contentMd, body.baseFingerprint ?? null, {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  /** A03-14 解析行删除（守卫 DEPENDENCY_EXISTS；理由必填；原件不动） */
  @Delete('content-rows/:rowId')
  @HttpCode(200)
  deleteRow(
    @Param('projectId') projectId: string,
    @Param('rowId') rowId: string,
    @Body() body: { reason?: string },
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.parse.deleteRow(projectId, rowId, body?.reason ?? '', {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  /** A03-9 批量解析（默认仅待解析；逐条成功/失败） */
  @Post('files\\:batch-parse')
  @HttpCode(202)
  batchParse(
    @Param('projectId') projectId: string,
    @Body() body: { fileIds: string[]; onlyPending?: boolean },
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.batch.batchParse(projectId, body.fileIds ?? [], body.onlyPending ?? true, {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  /** A03-12 批量内容定稿（INV-BULK-1：confirm:true 强制） */
  @Post('files\\:batch-finalize-content')
  @HttpCode(200)
  batchFinalizeContent(
    @Param('projectId') projectId: string,
    @Body() body: { fileIds: string[]; confirm?: boolean },
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.batch.batchFinalizeContent(projectId, body.fileIds ?? [], body.confirm ?? false, {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  /** A03-17 需求参考输入清单（仅 content_final） */
  @Get('references')
  references(@Param('projectId') projectId: string) {
    return this.files.references(projectId);
  }

  /** A03-15 创建批量加工作业（弹窗登记 idle） */
  @Post('jobs')
  @HttpCode(202)
  createJob(
    @Param('projectId') projectId: string,
    @Body() body: { kind: 'translate' | 'mask' | 'index'; fileIds: string[]; params?: Record<string, unknown> },
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.batch.createJob(projectId, body.kind, body.fileIds ?? [], body.params, {
      projectId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  /** A03-15 确认提交（整批复核 → running；不一致 STALE_EVIDENCE 整批拒绝） */
  @Post('jobs/:jobId\\:confirm')
  @HttpCode(202)
  confirmJob(@Param('projectId') projectId: string, @Param('jobId') jobId: string, @Req() req: Request) {
    const actor = getActor(req);
    return this.batch.confirmJob(projectId, jobId, { projectId, actorKind: actor.kind, actorId: actor.id });
  }

  /** A03-16 作业查询 */
  @Get('jobs/:jobId')
  getJob(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return this.batch.getJob(projectId, jobId);
  }

  /** A03-16 停止（running → stopped，后续行 skipped） */
  @Post('jobs/:jobId\\:stop')
  @HttpCode(200)
  stopJob(@Param('projectId') projectId: string, @Param('jobId') jobId: string, @Req() req: Request) {
    const actor = getActor(req);
    return this.batch.stopJob(projectId, jobId, { projectId, actorKind: actor.kind, actorId: actor.id });
  }

  /** A03-16 单条重试（行仍 file_final 前置） */
  @Post('jobs/:jobId/items/:fileId\\:retry')
  @HttpCode(202)
  retryItem(
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
  ) {
    const actor = getActor(req);
    return this.batch.retryItem(projectId, jobId, fileId, { projectId, actorKind: actor.kind, actorId: actor.id });
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
