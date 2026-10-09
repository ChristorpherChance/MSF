import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '@msf/shared';
import { getActor } from '../api/identity.middleware.js';
import { ReqDocsService } from './docs.service.js';
import { GenerateService } from './generate.service.js';
import { RtmService } from './rtm.service.js';
import { ReqExportService, type ExportFormat } from './export.service.js';

/**
 * 需求域端点（LLD-5 DSG-A04-1~13 + A04-14 deferred 补充；REQ-201~210）。
 * :kind 路径参数取 crd|prd；docId 即 (projectId, kind) 唯一行（D04-1）。
 */
@Controller('api/v1/projects/:projectId/requirements')
export class ReqController {
  constructor(
    @Inject(ReqDocsService) private readonly docs: ReqDocsService,
    @Inject(GenerateService) private readonly gen: GenerateService,
    @Inject(RtmService) private readonly rtm: RtmService,
    @Inject(ReqExportService) private readonly exp: ReqExportService,
  ) {}

  private actor(req: Request, projectId: string) {
    const a = getActor(req);
    return { projectId, actorKind: a.kind, actorId: a.id };
  }

  private assertKind(kind: string): 'crd' | 'prd' {
    // #2：类型非法（400）与文档不存在（404）必须可区分，否则用户无从自查
    if (kind !== 'crd' && kind !== 'prd') throw new DomainError('VALIDATION_FAILED', '文档类型非法（仅支持 crd|prd）', 'kind');
    return kind;
  }

  /** A04-1 文档列表 */
  @Get('docs')
  list(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.docs.listDocs(projectId, this.actor(req, projectId));
  }

  /** A04-2 文档详情（?v=n 历史版本只读视图） */
  @Get('docs/:kind')
  detail(@Param('projectId') projectId: string, @Param('kind') kind: string, @Query('v') v?: string) {
    return this.docs.getDoc(projectId, this.assertKind(kind), v === undefined ? undefined : Number(v));
  }

  /** A04-3 草稿编辑（命令型） */
  @Post('docs/:kind/draft')
  @HttpCode(200)
  saveDraft(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Body() body: { secId: string; md: string; baseVersion: number; baseFingerprint: string },
    @Req() req: Request,
  ) {
    return this.docs.saveDraft(projectId, this.assertKind(kind), body, this.actor(req, projectId));
  }

  /** 编辑态增节：在 secId 节下方插入新章节（命令型，写草稿自带 undo） */
  @Post('docs/:kind/sections')
  @HttpCode(200)
  addSection(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Body() body: { secId: string; title: string; md?: string; baseVersion: number; baseFingerprint: string },
    @Req() req: Request,
  ) {
    return this.docs.addSection(projectId, this.assertKind(kind), body, this.actor(req, projectId));
  }

  /** 编辑态删节：整节移除（命令型；s0 文首不可删，至少保留一节） */
  @Post('docs/:kind/sections/:secId\\:delete')
  @HttpCode(200)
  delSection(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Param('secId') secId: string,
    @Body() body: { baseVersion: number; baseFingerprint: string },
    @Req() req: Request,
  ) {
    return this.docs.delSection(projectId, this.assertKind(kind), { secId, ...body }, this.actor(req, projectId));
  }

  /** A04-4 文档 AI 生成（POST-SSE，fetch+ReadableStream 消费，A01-6） */
  @Post('docs/:kind\\:generate')
  async generate(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Body() body: { referenceFileIds?: string[]; referenceFingerprints?: Record<string, string>; instruction?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ctx = this.actor(req, projectId);
    const { operationId, source } = await this.gen.start(
      projectId,
      this.assertKind(kind),
      { referenceFileIds: body.referenceFileIds ?? [], referenceFingerprints: body.referenceFingerprints ?? {}, ...(body.instruction !== undefined ? { instruction: body.instruction } : {}) },
      ctx,
    );
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // 前置 nginx 默认 proxy_buffering=on 会整包缓冲 SSE（2026-10-09 公网实测）；此头令其直通
    res.setHeader('Connection', 'keep-alive');
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    // 首帧携带 operationId：pause/resume/stop（A04-5）需在流式进行中寻址本次生成；source=#5 生成来源可辨识
    send({ type: 'stream.start', operationId, source });
    const result = await this.gen.drive(operationId, ctx, (text) => send({ type: 'stream.delta', text }), (message) => send({ type: 'stream.notice', message }));
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

  /** A04-5 生成过程控制（pause/resume=缓冲层；stop=中止作废） */
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

  /** A04-6 版本提交 */
  @Post('docs/:kind/versions\\:commit')
  @HttpCode(201)
  commit(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Body() body: { note?: string; baseVersion: number },
    @Req() req: Request,
  ) {
    return this.docs.commit(projectId, this.assertKind(kind), body.note ?? '', body.baseVersion, this.actor(req, projectId));
  }

  /** A04-7 版本定稿（经策略确认点 req.doc.finalize；PRD 挂 RTM 健康度门禁） */
  @Post('docs/:kind/versions/:v\\:finalize')
  @HttpCode(200)
  finalize(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Param('v') v: string,
    @Body() body: { baseVersion: number; confirm?: boolean },
    @Req() req: Request,
  ) {
    return this.docs.finalize(projectId, this.assertKind(kind), Number(v), body.baseVersion, body.confirm ?? false, this.actor(req, projectId));
  }

  /** 定稿解锁（F02-1 unlock；下游失效传播 M3 接入） */
  @Post('docs/:kind\\:unlock')
  @HttpCode(200)
  unlock(@Param('projectId') projectId: string, @Param('kind') kind: string, @Req() req: Request) {
    return this.docs.unlock(projectId, this.assertKind(kind), this.actor(req, projectId));
  }

  /** A04-8 撤销/重做 */
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

  /** A04-9 版本列表 / 切换查看 */
  @Get('docs/:kind/versions')
  versions(@Param('projectId') projectId: string, @Param('kind') kind: string) {
    return this.docs.listVersions(projectId, this.assertKind(kind));
  }

  @Post('docs/:kind/versions/:v\\:switch')
  @HttpCode(200)
  switchVersion(@Param('projectId') projectId: string, @Param('kind') kind: string, @Param('v') v: string, @Req() req: Request) {
    return this.docs.switchVersion(projectId, this.assertKind(kind), Number(v), this.actor(req, projectId));
  }

  /** A04-10 待确认补丁 */
  @Get('docs/:kind/patches')
  patches(@Param('projectId') projectId: string, @Param('kind') kind: string) {
    return this.docs.listPatches(projectId, this.assertKind(kind));
  }

  @Post('docs/:kind/patches/:patchId\\:accept')
  @HttpCode(200)
  acceptPatch(@Param('projectId') projectId: string, @Param('kind') kind: string, @Param('patchId') patchId: string, @Body() body: { reason?: string; newText?: string }, @Req() req: Request) {
    return this.docs.acceptPatch(projectId, this.assertKind(kind), patchId, this.actor(req, projectId), body?.reason, body?.newText);
  }

  @Post('docs/:kind/patches/:patchId\\:reject')
  @HttpCode(200)
  rejectPatch(@Param('projectId') projectId: string, @Param('kind') kind: string, @Param('patchId') patchId: string, @Body() body: { reason?: string }, @Req() req: Request) {
    return this.docs.rejectPatch(projectId, this.assertKind(kind), patchId, this.actor(req, projectId), body?.reason);
  }

  /** 参考关联（REQ-114；参考资料 popover 挂接/移除） */
  @Post('docs/:kind/references')
  @HttpCode(200)
  addRef(@Param('projectId') projectId: string, @Param('kind') kind: string, @Body() body: { fileId: string }, @Req() req: Request) {
    return this.docs.addReference(projectId, this.assertKind(kind), body.fileId, this.actor(req, projectId));
  }

  @Post('docs/:kind/references\\:remove')
  @HttpCode(200)
  removeRef(@Param('projectId') projectId: string, @Param('kind') kind: string, @Body() body: { fileId: string }, @Req() req: Request) {
    return this.docs.removeReference(projectId, this.assertKind(kind), body.fileId, this.actor(req, projectId));
  }

  /** A04-11 RTM 查询 */
  @Get('rtm')
  rtmQuery(@Param('projectId') projectId: string) {
    return this.rtm.rtm(projectId);
  }

  /** A04-12 RTM 健康度门禁（实时重算） */
  @Get('rtm/health')
  rtmHealth(@Param('projectId') projectId: string) {
    return this.rtm.health(projectId);
  }

  /** RTM 覆盖闭环：人工一键「重建映射并检查覆盖」（定稿后按新文档手动重建+即时结论） */
  @Post('rtm\:rebuild-check')
  @HttpCode(200)
  rebuildCheck(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.rtm.rebuildAndCheck(projectId, this.actor(req, projectId));
  }

  /** RTM 覆盖闭环：按缺口清单向 CRD/PRD 提案定向补齐（高亮补丁，人工确认后生效） */
  @Post('rtm\:coverage-fix')
  @HttpCode(200)
  coverageFix(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.gen.coverageFixFromGaps(projectId, this.actor(req, projectId));
  }

  /** A04-14（补充）：deferred 标记/撤销（LLD-3 C10-2 rtm.deferred.*；LLD-6 §3.3 行内操作钮） */
  @Post('rtm/:kind/:code\\:defer')
  @HttpCode(200)
  defer(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Param('code') code: string,
    @Body() body: { reason?: string },
    @Req() req: Request,
  ) {
    if (kind !== 'cr' && kind !== 'req') throw new DomainError('VALIDATION_FAILED', 'deferred 仅支持 CR/REQ 节点', 'kind');
    return this.rtm.markDeferred(projectId, kind, code, body.reason ?? '', this.actor(req, projectId));
  }

  @Post('rtm/:kind/:code\\:undefer')
  @HttpCode(200)
  undefer(@Param('projectId') projectId: string, @Param('kind') kind: string, @Param('code') code: string, @Req() req: Request) {
    if (kind !== 'cr' && kind !== 'req') throw new DomainError('VALIDATION_FAILED', 'deferred 仅支持 CR/REQ 节点', 'kind');
    return this.rtm.unmarkDeferred(projectId, kind, code, this.actor(req, projectId));
  }

  /** A04-13 文档导出（md/html/docx/pdf 落 MinIO + 签名 URL；L1 扩展） */
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
}
