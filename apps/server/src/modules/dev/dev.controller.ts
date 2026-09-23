import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { getActor } from '../api/identity.middleware.js';
import { DevTasksService } from './tasks.service.js';
import { DevPlansService } from './plans.service.js';
import { DevBoardService } from './board.service.js';
import { DevAutopilotService } from './autopilot.service.js';
import { DevBuildService } from './build.service.js';
import { DevSelftestService } from './selftest.service.js';
import { DevTransferService } from './transfer.service.js';
import { DevImpactService } from './impact.service.js';
import { DevCiService } from './ci.service.js';
import { DevRepoService } from './repo.service.js';

/** 开发域端点（LLD-5 DSG-A06-1~22；REQ-401~420） */
@Controller('api/v1/projects/:projectId/dev')
export class DevController {
  constructor(
    @Inject(DevTasksService) private readonly tasks: DevTasksService,
    @Inject(DevPlansService) private readonly plans: DevPlansService,
    @Inject(DevBoardService) private readonly board: DevBoardService,
    @Inject(DevAutopilotService) private readonly autopilot: DevAutopilotService,
    @Inject(DevBuildService) private readonly build: DevBuildService,
    @Inject(DevSelftestService) private readonly selftest: DevSelftestService,
    @Inject(DevTransferService) private readonly transfer: DevTransferService,
    @Inject(DevImpactService) private readonly impact: DevImpactService,
    @Inject(DevCiService) private readonly ci: DevCiService,
    @Inject(DevRepoService) private readonly repo: DevRepoService,
  ) {}

  private actor(req: Request, projectId: string) {
    const a = getActor(req);
    return { projectId, actorKind: a.kind, actorId: a.id };
  }

  // ---- 任务与计划（A06-1~8） ----

  @Post('tasks\\:identify')
  identify(@Param('projectId') pid: string, @Body() body: { baselineId: string; baselineFingerprint: string }, @Req() req: Request) {
    return this.tasks.identify(pid, body.baselineId, body.baselineFingerprint, this.actor(req, pid));
  }

  @Get('tasks')
  listTasks(@Param('projectId') pid: string, @Query('col') col?: string) {
    return this.tasks.list(pid, col);
  }

  @Post('tasks')
  createTask(@Param('projectId') pid: string, @Body() body: { title: string; kind: string }, @Req() req: Request) {
    return this.tasks.createTask(pid, body.title, body.kind, this.actor(req, pid));
  }

  @Post('tasks\\:improve')
  @HttpCode(200)
  improveTasks(@Param('projectId') pid: string, @Req() req: Request) {
    return this.tasks.improveTasks(pid, this.actor(req, pid));
  }

  @Post('plan\\:schedule')
  @HttpCode(200)
  schedulePlan(@Param('projectId') pid: string, @Req() req: Request) {
    return this.tasks.schedule(pid, this.actor(req, pid));
  }

  @Get('tasks/conflicts')
  conflicts(@Param('projectId') pid: string) {
    return this.tasks.conflicts(pid);
  }

  @Get('tasks/:taskId')
  taskDetail(@Param('projectId') pid: string, @Param('taskId') taskId: string) {
    return this.tasks.detail(pid, taskId);
  }

  @Post('tasks/:taskId')
  @HttpCode(200)
  saveTask(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.tasks.saveTask(pid, taskId, body, this.actor(req, pid));
  }

  @Post('tasks/:taskId\\:transition')
  @HttpCode(200)
  transition(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Body() body: { to: string; note?: string }, @Req() req: Request) {
    return this.board.transition(pid, taskId, body.to, body.note, this.actor(req, pid));
  }

  @Post('tasks/:taskId\\:run')
  @HttpCode(200)
  runTask(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Req() req: Request) {
    return this.board.run(pid, taskId, this.actor(req, pid));
  }

  @Post('tasks/:taskId\\:progress')
  @HttpCode(200)
  progress(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Body() body: { prog: number }, @Req() req: Request) {
    return this.board.progress(pid, taskId, body.prog, this.actor(req, pid));
  }

  @Get('tasks/:taskId/start-gate')
  startGate(@Param('projectId') pid: string, @Param('taskId') taskId: string) {
    return this.board.startGate(pid, taskId);
  }

  @Post('tasks/:taskId/pr/checks')
  @HttpCode(200)
  toggleCheck(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Body() body: { key: string; checked: boolean }, @Req() req: Request) {
    return this.board.toggleCheck(pid, taskId, body.key, body.checked, this.actor(req, pid));
  }

  @Post('tasks/:taskId/pr\\:skip')
  @HttpCode(200)
  prSkip(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Body() body: { reason: string }, @Req() req: Request) {
    return this.board.skip(pid, taskId, body.reason, this.actor(req, pid));
  }

  @Post('tasks/:taskId\\:quality')
  @HttpCode(200)
  quality(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Req() req: Request) {
    return this.board.quality(pid, taskId, this.actor(req, pid));
  }

  @Post('tasks/:taskId\\:ai-review')
  @HttpCode(200)
  aiReview(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Req() req: Request) {
    return this.board.aiReview(pid, taskId, this.actor(req, pid));
  }

  @Post('tasks/:taskId/pr\\:merge')
  @HttpCode(200)
  merge(@Param('projectId') pid: string, @Param('taskId') taskId: string, @Body() body: { basisType: string; skipReason?: string }, @Req() req: Request) {
    return this.board.merge(pid, taskId, body.basisType, body.skipReason, undefined, this.actor(req, pid));
  }

  @Post('coverage\\:confirm')
  @HttpCode(200)
  confirmCoverage(@Param('projectId') pid: string, @Body() body: { taskId: string; itemId?: string }, @Req() req: Request) {
    return this.tasks.confirmCoverage(pid, body.taskId, body.itemId ?? null, this.actor(req, pid));
  }

  @Get('plan/coverage')
  coverage(@Param('projectId') pid: string) {
    return this.tasks.coverage(pid);
  }

  @Get('plan')
  planList(@Param('projectId') pid: string) {
    return this.plans.current(pid);
  }

  @Post('plan\\:submit')
  submitPlan(@Param('projectId') pid: string, @Body() body: { taskIds: string[]; note?: string }, @Req() req: Request) {
    return this.plans.submit(pid, body.taskIds, body.note, this.actor(req, pid));
  }

  @Post('plan\\:approve')
  @HttpCode(200)
  approvePlan(@Param('projectId') pid: string, @Body() body: { revision: string; fingerprint: string; confirm: boolean }, @Req() req: Request) {
    return this.plans.approve(pid, body.revision, body.fingerprint, body.confirm, this.actor(req, pid));
  }

  // ---- 代码仓（A06-9；REQ-406） ----

  @Get('repo/tree')
  repoTree(@Param('projectId') pid: string, @Query('path') path?: string) {
    return this.repo.tree(pid, path);
  }

  @Get('repo/changes')
  repoChanges(@Param('projectId') pid: string, @Query('taskId') taskId?: string) {
    return this.repo.changes(pid, taskId);
  }

  // ---- autopilot（A06-10~12） ----

  @Post('autopilot\\:start')
  @HttpCode(202)
  autopilotStart(@Param('projectId') pid: string, @Body() body: { displayedRevisionId: string; displayedFingerprint: string }, @Req() req: Request) {
    return this.autopilot.approveStart(pid, body.displayedRevisionId, body.displayedFingerprint, this.actor(req, pid));
  }

  @Post('autopilot\\:pause')
  @HttpCode(200)
  autopilotPause(@Param('projectId') pid: string, @Req() req: Request) {
    return this.autopilot.control(pid, 'pause', this.actor(req, pid));
  }

  @Post('autopilot\\:stop')
  @HttpCode(200)
  autopilotStop(@Param('projectId') pid: string, @Req() req: Request) {
    return this.autopilot.control(pid, 'stop', this.actor(req, pid));
  }

  @Post('autopilot\\:takeover')
  @HttpCode(200)
  autopilotTakeover(@Param('projectId') pid: string, @Req() req: Request) {
    return this.autopilot.control(pid, 'takeover', this.actor(req, pid));
  }

  @Post('autopilot\\:resume')
  @HttpCode(200)
  autopilotResume(@Param('projectId') pid: string, @Req() req: Request) {
    return this.autopilot.control(pid, 'resume', this.actor(req, pid));
  }

  @Get('autopilot')
  autopilotStatus(@Param('projectId') pid: string) {
    return this.autopilot.status(pid);
  }

  // ---- 构建 / 自测 / 报告 / 对照（A06-13~17） ----

  @Post('build\\:run')
  @HttpCode(202)
  buildRun(@Param('projectId') pid: string, @Req() req: Request) {
    return this.build.run(pid, this.actor(req, pid));
  }

  @Get('build')
  buildCurrent(@Param('projectId') pid: string) {
    return this.build.current(pid);
  }

  @Post('selftest\\:start')
  @HttpCode(202)
  selftestStart(@Param('projectId') pid: string, @Req() req: Request) {
    return this.selftest.start(pid, this.actor(req, pid));
  }

  @Post('selftest\\:retest')
  @HttpCode(202)
  selftestRetest(@Param('projectId') pid: string, @Body() body: { reason: string }, @Req() req: Request) {
    return this.selftest.retest(pid, body.reason, this.actor(req, pid));
  }

  @Get('selftest/gate')
  selftestGate(@Param('projectId') pid: string) {
    return this.selftest.gate(pid);
  }

  @Get('selftest/reports')
  reports(@Param('projectId') pid: string) {
    return this.selftest.reports(pid);
  }

  @Get('selftest/reports/:reportId')
  reportDetail(@Param('projectId') pid: string, @Param('reportId') reportId: string) {
    return this.selftest.reportDetail(pid, reportId);
  }

  @Post('selftest/reports/:reportId\\:export')
  @HttpCode(202)
  reportExport(@Param('projectId') pid: string, @Param('reportId') reportId: string, @Body() body: { format?: 'md' | 'html' }, @Req() req: Request) {
    return this.selftest.export(pid, reportId, body.format ?? 'md', this.actor(req, pid));
  }

  @Get('selftest/comparison')
  comparison(@Param('projectId') pid: string, @Query('pageId') pageId: string) {
    return this.selftest.comparison(pid, pageId ?? '');
  }

  // ---- 转测试（A06-18/19） ----

  @Get('transfer/gate')
  transferGate(@Param('projectId') pid: string) {
    return this.transfer.gate(pid);
  }

  @Post('transfer')
  transferDo(@Param('projectId') pid: string, @Body() body: { reportId: string; reportFingerprint: string; confirm: boolean }, @Req() req: Request) {
    return this.transfer.transfer(pid, body.reportId, body.reportFingerprint, body.confirm, this.actor(req, pid));
  }

  // ---- 变更管理（A06-20） ----

  @Get('impacts')
  impacts(@Param('projectId') pid: string, @Query('status') status?: string) {
    return this.impact.list(pid, status);
  }

  @Post('impacts\\:observe')
  @HttpCode(200)
  observe(@Param('projectId') pid: string, @Req() req: Request) {
    return this.impact.observe(pid, this.actor(req, pid));
  }

  @Post('baseline\\:confirm')
  @HttpCode(200)
  baselineConfirm(@Param('projectId') pid: string, @Body() body: { impactIds?: string[]; resolution?: 'rework' | 'accept'; note?: string }, @Req() req: Request) {
    if (body.impactIds?.length) {
      return this.impact.apply(pid, body.impactIds, body.resolution ?? 'accept', body.note, this.actor(req, pid));
    }
    return this.impact.confirmBaseline(pid, body.note, this.actor(req, pid));
  }

  // ---- CI 回传（A06-21/22） ----

  @Put('ci/webhook-secret')
  setSecret(@Param('projectId') pid: string, @Body() body: { secret: string }, @Req() req: Request) {
    return this.ci.setSecret(pid, body.secret, this.actor(req, pid));
  }

  @Get('ci/webhook-secret')
  secretStatus(@Param('projectId') pid: string) {
    return this.ci.secretStatus(pid);
  }

  @Post('ci/callbacks')
  @HttpCode(202)
  ciCallback(@Param('projectId') pid: string, @Req() req: Request) {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    return this.ci.callback(pid, raw, {
      timestamp: req.headers['x-msf-timestamp'] as string | undefined,
      signature: req.headers['x-msf-signature'] as string | undefined,
      delivery: req.headers['x-msf-delivery'] as string | undefined,
    }, this.actor(req, pid));
  }
}
