import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { TstBatchesService } from './batches.service.js';
import { TstPlansService } from './plans.service.js';
import { TstRunsService } from './runs.service.js';
import { TstDefectsService } from './defects.service.js';
import { TstReportsService } from './reports.service.js';

/** 测试验收域端点（LLD-5 DSG-A07-1~14；REQ-501~511） */
@Controller('api/v1/projects/:projectId/acceptance')
export class TestController {
  constructor(
    @Inject(TstBatchesService) private readonly batches: TstBatchesService,
    @Inject(TstPlansService) private readonly plans: TstPlansService,
    @Inject(TstRunsService) private readonly runs: TstRunsService,
    @Inject(TstDefectsService) private readonly defects: TstDefectsService,
    @Inject(TstReportsService) private readonly reports: TstReportsService,
  ) {}

  private actor(req: Request, projectId: string) {
    const a = getActor(req);
    return { projectId, actorKind: a.kind, actorId: a.id };
  }

  // ---- 批次（A07-1/2/13/14） ----

  @Post('batches\\:receive')
  receive(
    @Param('projectId') pid: string,
    @Body() body: {
      handoffId: string; buildFingerprint: string; selftestReportFingerprint: string;
      designBaselineFingerprint: string; environment: Record<string, unknown>;
    },
    @Req() req: Request,
  ) {
    return this.batches.receive(pid, body, this.actor(req, pid));
  }

  @Get('batches')
  listBatches(@Param('projectId') pid: string) {
    return this.batches.list(pid);
  }

  @Get('batches/:batchId')
  batchDetail(@Param('projectId') pid: string, @Param('batchId') batchId: string) {
    return this.batches.detail(pid, batchId);
  }

  @Post('batches/:batchId\\:export-snapshot')
  exportSnapshot(@Param('projectId') pid: string, @Param('batchId') batchId: string, @Req() req: Request) {
    return this.batches.export(pid, batchId, this.actor(req, pid));
  }

  @Post('batches/:batchId\\:block')
  @HttpCode(200)
  block(@Param('projectId') pid: string, @Param('batchId') batchId: string, @Body() body: { reason: string }, @Req() req: Request) {
    return this.batches.block(pid, batchId, body.reason, this.actor(req, pid));
  }

  @Post('batches/:batchId\\:unblock')
  @HttpCode(200)
  unblock(@Param('projectId') pid: string, @Param('batchId') batchId: string, @Body() body: { reason: string }, @Req() req: Request) {
    return this.batches.unblock(pid, batchId, body.reason, this.actor(req, pid));
  }

  // ---- 计划（A07-3） ----

  @Post('batches/:batchId/plans\\:draft')
  draftPlan(@Param('projectId') pid: string, @Param('batchId') batchId: string, @Req() req: Request) {
    return this.plans.draft(pid, batchId, this.actor(req, pid));
  }

  @Post('batches/:batchId/plans/:planId\\:approve')
  @HttpCode(200)
  approvePlan(
    @Param('projectId') pid: string, @Param('batchId') batchId: string, @Param('planId') planId: string,
    @Body() body: { confirm: boolean }, @Req() req: Request,
  ) {
    return this.plans.approve(pid, batchId, planId, body.confirm, this.actor(req, pid));
  }

  @Get('batches/:batchId/plan')
  currentPlan(@Param('projectId') pid: string, @Param('batchId') batchId: string) {
    return this.plans.current(pid, batchId);
  }

  // ---- 执行（A07-4/5） ----

  @Post('batches/:batchId/runs\\:execute')
  executeRun(
    @Param('projectId') pid: string, @Param('batchId') batchId: string,
    @Body() body: { planId: string }, @Req() req: Request,
  ) {
    return this.runs.execute(pid, batchId, body.planId, this.actor(req, pid));
  }

  @Put('runs/:runId/results/:caseId')
  @HttpCode(200)
  manualRecord(
    @Param('projectId') pid: string, @Param('runId') runId: string, @Param('caseId') caseId: string,
    @Body() body: { status: string; evidence: string; simulation?: boolean }, @Req() req: Request,
  ) {
    return this.runs.manualRecord(pid, runId, caseId, body, this.actor(req, pid));
  }

  @Get('batches/:batchId/runs')
  runsOfBatch(@Param('projectId') pid: string, @Param('batchId') batchId: string) {
    return this.runs.runsOfBatch(pid, batchId);
  }

  // ---- 缺陷（A07-6~9） ----

  @Post('defects')
  createDefect(
    @Param('projectId') pid: string,
    @Body() body: { batchId: string; runId: string; caseId: string; title: string; evidence: string },
    @Req() req: Request,
  ) {
    return this.defects.create(pid, body, this.actor(req, pid));
  }

  @Get('defects')
  listDefects(@Param('projectId') pid: string, @Query('status') status?: string, @Query('batchId') batchId?: string) {
    return this.defects.list(pid, { status, batchId });
  }

  @Post('defects/:defectId\\:confirm')
  @HttpCode(200)
  confirmDefect(
    @Param('projectId') pid: string, @Param('defectId') defectId: string,
    @Body() body: { severity: string; reason: string }, @Req() req: Request,
  ) {
    return this.defects.confirm(pid, defectId, body, this.actor(req, pid));
  }

  @Post('defects/:defectId\\:fix-start')
  @HttpCode(200)
  fixStart(
    @Param('projectId') pid: string, @Param('defectId') defectId: string,
    @Body() body: { assignee?: string; reworkTaskIds?: string[] }, @Req() req: Request,
  ) {
    return this.defects.fixStart(pid, defectId, body ?? {}, this.actor(req, pid));
  }

  @Post('defects/:defectId\\:mark-fixed')
  @HttpCode(200)
  markFixed(
    @Param('projectId') pid: string, @Param('defectId') defectId: string,
    @Body() body: { reworkTaskIds?: string[]; newBuildFingerprint: string; note?: string }, @Req() req: Request,
  ) {
    return this.defects.markFixed(pid, defectId, body, this.actor(req, pid));
  }

  @Post('defects/:defectId\\:link-regression')
  @HttpCode(200)
  linkRegression(
    @Param('projectId') pid: string, @Param('defectId') defectId: string,
    @Body() body: { batchId: string; runId: string; caseId: string }, @Req() req: Request,
  ) {
    return this.defects.linkRegression(pid, defectId, body, this.actor(req, pid));
  }

  @Post('defects/:defectId\\:close')
  @HttpCode(200)
  closeDefect(@Param('projectId') pid: string, @Param('defectId') defectId: string, @Req() req: Request) {
    return this.defects.close(pid, defectId, this.actor(req, pid));
  }

  @Post('defects/:defectId\\:reopen')
  @HttpCode(200)
  reopenDefect(
    @Param('projectId') pid: string, @Param('defectId') defectId: string,
    @Body() body: { reason: string }, @Req() req: Request,
  ) {
    return this.defects.reopen(pid, defectId, body.reason, this.actor(req, pid));
  }

  // ---- 报告与交付（A07-10/11/12） ----

  @Post('batches/:batchId/report\\:generate')
  generateReport(@Param('projectId') pid: string, @Param('batchId') batchId: string, @Req() req: Request) {
    return this.reports.generate(pid, batchId, this.actor(req, pid));
  }

  @Get('batches/:batchId/reports')
  reportsOfBatch(@Param('projectId') pid: string, @Param('batchId') batchId: string) {
    return this.reports.reportsOfBatch(pid, batchId);
  }

  @Post('reports/:reportId\\:finalize')
  @HttpCode(200)
  finalizeReport(
    @Param('projectId') pid: string, @Param('reportId') reportId: string,
    @Body() body: { confirm: boolean }, @Req() req: Request,
  ) {
    return this.reports.finalize(pid, reportId, body.confirm, this.actor(req, pid));
  }

  @Post('reports/:reportId\\:release')
  authorize(
    @Param('projectId') pid: string, @Param('reportId') reportId: string,
    @Body() body: { type: string; waivers?: Array<{ defectId: string; justification: string }>; confirm: boolean },
    @Req() req: Request,
  ) {
    return this.reports.authorize(pid, reportId, body, this.actor(req, pid));
  }

  @Post('reports/:reportId\\:export')
  exportReport(@Param('projectId') pid: string, @Param('reportId') reportId: string, @Req() req: Request) {
    return this.reports.export(pid, reportId, this.actor(req, pid));
  }

  @Get('decisions')
  decisions(@Param('projectId') pid: string, @Query('batchId') batchId?: string) {
    return this.reports.decisions(pid, batchId);
  }
}
