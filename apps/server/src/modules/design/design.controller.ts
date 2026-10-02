import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '@msf/shared';
import { getActor } from '../api/identity.middleware.js';
import { DesignDocsService, DESIGN_BOOKS, type DesignKind } from './docs.service.js';
import { DesignGenerateService } from './generate.service.js';
import { CatalogService } from './catalog.service.js';
import { PrototypeService } from './prototype.service.js';
import { ReviewService } from './review.service.js';
import { DesignExportService } from './export.service.js';
import type { ExportFormat } from '../platform/doc-export.js';

/**
 * 设计域端点（LLD-5 DSG-A05-1~13；REQ-301~312）。
 * 文档生命周期端点形态复用需求域 A04（A05-1 注）：/design/docs/:kind/...，kind ∈ hld|mod|alg|cls|db|api|ui|nfr。
 */
@Controller('api/v1/projects/:projectId/design')
export class DesignController {
  constructor(
    @Inject(DesignDocsService) private readonly docs: DesignDocsService,
    @Inject(DesignGenerateService) private readonly gen: DesignGenerateService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PrototypeService) private readonly proto: PrototypeService,
    @Inject(ReviewService) private readonly reviews: ReviewService,
    @Inject(DesignExportService) private readonly exp: DesignExportService,
  ) {}

  private actor(req: Request, projectId: string) {
    const a = getActor(req);
    return { projectId, actorKind: a.kind, actorId: a.id };
  }

  private assertKind(kind: string): DesignKind {
    // #2：类型非法（400）与文档不存在（404）必须可区分，否则用户无从自查
    if (!DESIGN_BOOKS.some((b) => b.kind === kind)) {
      throw new DomainError('VALIDATION_FAILED', `设计册类型非法（支持：${DESIGN_BOOKS.map((b) => b.kind).join('/')}）`, 'kind');
    }
    return kind as DesignKind;
  }

  /** A05-1 八册列表（首访自举） */
  @Get('docs')
  list(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.docs.listDocs(projectId, this.actor(req, projectId));
  }

  @Get('docs/:kind')
  detail(@Param('projectId') projectId: string, @Param('kind') kind: string, @Query('v') v?: string) {
    return this.docs.getDoc(projectId, this.assertKind(kind), v === undefined ? undefined : Number(v));
  }

  @Post('docs/:kind/draft')
  @HttpCode(200)
  saveDraft(
    @Param('projectId') projectId: string, @Param('kind') kind: string,
    @Body() body: { secId: string; md: string; baseVersion: number; baseFingerprint: string },
    @Req() req: Request,
  ) {
    return this.docs.saveDraft(projectId, this.assertKind(kind), body, this.actor(req, projectId));
  }

  /** A05-2 文档生成（POST-SSE，口径同 A04-4） */
  @Post('docs/:kind\\:generate')
  async generate(
    @Param('projectId') projectId: string, @Param('kind') kind: string,
    @Body() body: { referenceFileIds?: string[]; referenceFingerprints?: Record<string, string>; instruction?: string },
    @Req() req: Request, @Res() res: Response,
  ) {
    const ctx = this.actor(req, projectId);
    const { operationId, source } = await this.gen.start(
      projectId, this.assertKind(kind),
      {
        referenceFileIds: body.referenceFileIds ?? [],
        referenceFingerprints: body.referenceFingerprints ?? {},
        ...(body.instruction !== undefined ? { instruction: body.instruction } : {}),
      },
      ctx,
    );
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'stream.start', operationId, source }); // source=#5 生成来源可辨识
    const result = await this.gen.drive(operationId, ctx, (text) => send({ type: 'stream.delta', text }));
    if (result.status === 'done') {
      send({ type: 'stream.done', operationId, proposedPatchIds: result.patchIds });
    } else if (result.status === 'stopped') {
      send({ type: 'stream.done', operationId, status: 'stopped' });
    } else {
      // W2-002：error 帧带脱敏 message（原只带 code）
      send({ type: 'stream.error', operationId, code: result.error ?? 'INTERNAL', ...(result.errorMessage ? { message: result.errorMessage } : {}) });
    }
    res.end();
  }

  @Post('docs/:kind/generations/:operationId\\:pause')
  @HttpCode(200)
  pause(@Param('projectId') projectId: string, @Param('operationId') operationId: string, @Req() req: Request) {
    return this.gen.control(projectId, operationId, 'pause', this.actor(req, projectId));
  }

  @Post('docs/:kind/generations/:operationId\\:resume')
  @HttpCode(200)
  resume(@Param('projectId') projectId: string, @Param('operationId') operationId: string, @Req() req: Request) {
    return this.gen.control(projectId, operationId, 'resume', this.actor(req, projectId));
  }

  @Post('docs/:kind/generations/:operationId\\:stop')
  @HttpCode(200)
  stop(@Param('projectId') projectId: string, @Param('operationId') operationId: string, @Req() req: Request) {
    return this.gen.control(projectId, operationId, 'stop', this.actor(req, projectId));
  }

  @Post('docs/:kind/versions\\:commit')
  @HttpCode(201)
  commit(
    @Param('projectId') projectId: string, @Param('kind') kind: string,
    @Body() body: { note?: string; baseVersion: number }, @Req() req: Request,
  ) {
    return this.docs.commit(projectId, this.assertKind(kind), body.note ?? '', body.baseVersion, this.actor(req, projectId));
  }

  /** 设计册定稿：人工 confirm；未决评审项须 allowOpenReviews 二次确认（LLD-6 §3.4） */
  @Post('docs/:kind/versions/:v\\:finalize')
  @HttpCode(200)
  finalize(
    @Param('projectId') projectId: string, @Param('kind') kind: string, @Param('v') v: string,
    @Body() body: { baseVersion: number; confirm?: boolean; allowOpenReviews?: boolean },
    @Req() req: Request,
  ) {
    return this.docs.finalize(projectId, this.assertKind(kind), Number(v), body.baseVersion,
      body.confirm ?? false, body.allowOpenReviews ?? false, this.actor(req, projectId));
  }

  @Post('docs/:kind\\:unlock')
  @HttpCode(200)
  unlock(@Param('projectId') projectId: string, @Param('kind') kind: string, @Req() req: Request) {
    return this.docs.unlock(projectId, this.assertKind(kind), this.actor(req, projectId));
  }

  @Post('docs/:kind\\:undo')
  @HttpCode(200)
  undo(@Param('projectId') projectId: string, @Param('kind') kind: string, @Req() req: Request) {
    return this.docs.undo(projectId, this.assertKind(kind), this.actor(req, projectId));
  }

  @Post('docs/:kind\\:redo')
  @HttpCode(200)
  redo(@Param('projectId') projectId: string, @Param('kind') kind: string, @Req() req: Request) {
    return this.docs.redo(projectId, this.assertKind(kind), this.actor(req, projectId));
  }

  @Get('docs/:kind/versions')
  versions(@Param('projectId') projectId: string, @Param('kind') kind: string) {
    return this.docs.listVersions(projectId, this.assertKind(kind));
  }

  /** 设计册导出（L1：md/html/docx/pdf 落 MinIO + 签名 URL + 审计留痕，与 req A04-13 同构） */
  @Post('docs/:kind/versions/:v\\:export')
  @HttpCode(202)
  export(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Param('v') v: string,
    @Body() body: { format?: string },
    @Req() req: Request,
  ) {
    return this.exp.export(projectId, this.assertKind(kind), Number(v), (body.format ?? 'md') as ExportFormat, this.actor(req, projectId));
  }

  @Post('docs/:kind/versions/:v\\:switch')
  @HttpCode(200)
  switchVersion(@Param('projectId') projectId: string, @Param('kind') kind: string, @Param('v') v: string, @Req() req: Request) {
    return this.docs.switchVersion(projectId, this.assertKind(kind), Number(v), this.actor(req, projectId));
  }

  @Get('docs/:kind/patches')
  patches(@Param('projectId') projectId: string, @Param('kind') kind: string) {
    return this.docs.listPatches(projectId, this.assertKind(kind));
  }

  @Post('docs/:kind/patches/:patchId\\:accept')
  @HttpCode(200)
  acceptPatch(@Param('projectId') projectId: string, @Param('kind') kind: string, @Param('patchId') patchId: string, @Req() req: Request) {
    return this.docs.acceptPatch(projectId, this.assertKind(kind), patchId, this.actor(req, projectId));
  }

  @Post('docs/:kind/patches/:patchId\\:reject')
  @HttpCode(200)
  rejectPatch(@Param('projectId') projectId: string, @Param('kind') kind: string, @Param('patchId') patchId: string, @Req() req: Request) {
    return this.docs.rejectPatch(projectId, this.assertKind(kind), patchId, this.actor(req, projectId));
  }

  /** A05-3 评审项 */
  @Get('reviews')
  listReviews(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.reviews.list(projectId, this.actor(req, projectId));
  }

  @Post('reviews/:drId\\:conclude')
  @HttpCode(200)
  conclude(
    @Param('projectId') projectId: string, @Param('drId') drId: string,
    @Body() body: { conclusion: 'pass' | 'fail' | 'na'; note?: string }, @Req() req: Request,
  ) {
    return this.reviews.conclude(projectId, drId, body.conclusion, body.note, this.actor(req, projectId));
  }

  /** S8 重新自检评审（幂等补齐种子条目） */
  @Post('reviews\\:reseed')
  @HttpCode(200)
  reseedReviews(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.reviews.reseed(projectId, this.actor(req, projectId));
  }

  /** S8 已解决项重新打开 */
  @Post('reviews/:drId\\:reopen')
  @HttpCode(200)
  reopenReview(@Param('projectId') projectId: string, @Param('drId') drId: string, @Req() req: Request) {
    return this.reviews.reopen(projectId, drId, this.actor(req, projectId));
  }

  /** A05-4 目录查询 */
  @Get('catalog')
  getCatalog(@Param('projectId') projectId: string) {
    return this.catalog.getCatalog(projectId);
  }

  /** A05-13 目录人工增删 */
  @Post('catalog/items')
  @HttpCode(201)
  addCatalogItem(
    @Param('projectId') projectId: string,
    @Body() body: { itemType: string; code: string; title: string; note?: string },
    @Req() req: Request,
  ) {
    return this.catalog.addItem(projectId, body, this.actor(req, projectId));
  }

  @Delete('catalog/items/:itemId')
  async removeCatalogItem(@Param('projectId') projectId: string, @Param('itemId') itemId: string, @Req() req: Request) {
    await this.catalog.removeItem(projectId, itemId, this.actor(req, projectId));
    return { removed: itemId };
  }

  /** A05-5 原型规划 */
  @Post('prototype\\:plan')
  @HttpCode(201)
  plan(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.catalog.plan(projectId, this.actor(req, projectId));
  }

  /** A05-6 原型生成（同步完成——mock 体量为小HTML；202 语义保留 operationId 形态从简） */
  @Post('prototype\\:generate')
  @HttpCode(201)
  generatePrototype(
    @Param('projectId') projectId: string,
    @Body() body: { planId: string; planFingerprint: string },
    @Req() req: Request,
  ) {
    return this.proto.generate(projectId, body.planId, body.planFingerprint, this.actor(req, projectId));
  }

  /** A05-7 原型检查（同步出报告；SSE 进度随 M6 接） */
  @Post('prototype\\:check')
  @HttpCode(201)
  checkPrototype(
    @Param('projectId') projectId: string,
    @Body() body: { prototypeVersionId: string },
    @Req() req: Request,
  ) {
    return this.proto.check(projectId, body.prototypeVersionId, this.actor(req, projectId));
  }

  /** 原型工作台状态（F02-2 派生） */
  @Get('prototype')
  prototypeStatus(@Param('projectId') projectId: string) {
    return this.proto.status(projectId);
  }

  /** A05-8 预览地址 */
  @Get('prototype/pages/:pageId/preview')
  preview(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Query('v') v?: string,
  ) {
    return this.proto.preview(projectId, pageId, v !== undefined ? Number(v) : undefined);
  }

  /** S6 人工上传 HTML 初稿入库（V1.3 上传通道；同一套对应性检查） */
  @Post('prototype\\:upload')
  @HttpCode(201)
  uploadPrototype(
    @Param('projectId') projectId: string,
    @Body() body: { html: string; note?: string },
    @Req() req: Request,
  ) {
    return this.proto.upload(projectId, body.html, body.note, this.actor(req, projectId));
  }

  /** S7 原型版本列表（旧版预览弹窗数据源） */
  @Get('prototype/versions')
  prototypeVersions(@Param('projectId') projectId: string) {
    return this.proto.versions(projectId);
  }

  /** A05-9 共同定稿（策略确认点 design.prototype.finalize） */
  @Post('prototype\\:finalize')
  @HttpCode(201)
  finalizePrototype(
    @Param('projectId') projectId: string,
    @Body() body: { prototypeVersionId: string; checkReportId: string; confirm?: boolean },
    @Req() req: Request,
  ) {
    return this.proto.finalize(projectId, body.prototypeVersionId, body.checkReportId, body.confirm ?? false, this.actor(req, projectId));
  }

  /** W7-003 原型解除定稿（spec ⋯ 菜单「解锁定稿」；解锁后基线实时失效，可重新生成） */
  @Post('prototype\\:unlock')
  @HttpCode(200)
  unlockPrototype(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.proto.unlock(projectId, this.actor(req, projectId));
  }

  /** A05-10 门禁求值（实时） */
  @Get('gates/:action')
  gates(@Param('projectId') projectId: string, @Param('action') action: string) {
    if (!['generate', 'check', 'finalize', 'develop'].includes(action)) {
      throw new DomainError('NOT_FOUND', '门禁动作不存在', action);
    }
    return this.proto.gates(projectId, action as 'generate' | 'check' | 'finalize' | 'develop');
  }

  /** A05-11 基线查询 */
  @Get('baselines')
  baselines(@Param('projectId') projectId: string) {
    return this.proto.baselines(projectId);
  }

  /** A05-12 来源审计 */
  @Get('source-audit')
  sourceAudit(@Param('projectId') projectId: string) {
    return this.catalog.sourceAudit(projectId);
  }
}
