import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '@msf/shared';
import { getActor } from '../api/identity.middleware.js';
import { PlatformReadService } from './platform-read.service.js';
import { SettingsService } from './settings.service.js';
import { codeDefaultTemplate, listTemplates, refreshTemplateOverrides, templateOverrides, type DocTemplate } from './doc-templates.js';

/**
 * 项目平台扩展端点（LLD-5 DSG-A02-4/5/6 + 放行策略配置面）：
 * - stages：五阶段准入门禁实时求值（缺口明示；快照变化驱动落库）
 * - tasks：任务中心跨域汇总（sys_tasks_view）
 * - events：项目事件流（evd_events 游标分页）
 * - policy-gates：七确认点 manual↔auto 切换授权（理由必填留痕，F10-2）
 */
@Controller('api/v1/projects/:projectId')
export class ProjectPlatformController {
  constructor(
    @Inject(PlatformReadService) private readonly read: PlatformReadService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /** A02-4 阶段导航准入查询 */
  @Get('stages')
  stages(@Param('projectId') projectId: string, @Req() req: Request) {
    const a = getActor(req);
    return this.read.stages(projectId, { projectId, actorKind: a.kind, actorId: a.id });
  }

  /** 默认文档模板查看（2026-10-06：模板此前只注入生成 prompt 不可见——用户「我没看到模板呢」补呈现入口；
   *  只读直出平台模板库，不过命令不过项目态（内容与项目无关，项目路由仅为口径统一）；
   *  读前刷新覆盖缓存：设置页编辑器保存的覆盖即时生效 */
  @Get('doc-templates')
  async docTemplates() {
    await refreshTemplateOverrides();
    const all = listTemplates();
    const ov = templateOverrides();
    return {
      items: Object.entries(all).map(([kind, t]) => ({
        kind,
        domain: kind === 'crd' || kind === 'prd' ? 'req' : 'design',
        standard: t.standard,
        quality: t.quality,
        writingRules: t.writingRules,
        chapters: t.chapters,
        overridden: kind in ov,
      })),
      note: '未提供自定义模板时按默认模板生成；参考资料中若有用户模板/格式规范，以用户模板为准。设置页可编辑覆盖并恢复默认。',
    };
  }

  /** 代码默认模板（设置页编辑器「恢复默认」参照/初始填充；不含覆盖） */
  @Get('doc-templates/:kind\\:default')
  docTemplateDefault(@Param('kind') kind: string) {
    const t = codeDefaultTemplate(kind);
    if (!t) throw new DomainError('VALIDATION_FAILED', 'kind 枚举 crd|prd|hld|mod|alg|cls|db|api|ui|nfr', 'kind');
    return t;
  }

  /** 文档模板编辑器：保存覆盖（validateTemplate 专业度闸，命令记审计） */
  @Put('doc-templates/:kind')
  saveDocTemplate(@Param('projectId') projectId: string, @Param('kind') kind: string, @Body() body: DocTemplate, @Req() req: Request) {
    const a = getActor(req);
    return this.settings.saveDocTemplate(kind, body, { projectId, actorKind: a.kind, actorId: a.id });
  }

  /** 文档模板编辑器：恢复默认（删覆盖行，命令记审计） */
  @Delete('doc-templates/:kind')
  resetDocTemplate(@Param('projectId') projectId: string, @Param('kind') kind: string, @Req() req: Request) {
    const a = getActor(req);
    return this.settings.resetDocTemplate(kind, { projectId, actorKind: a.kind, actorId: a.id });
  }

  /** A02-5 任务中心汇总 */
  @Get('tasks')
  tasks(
    @Param('projectId') projectId: string,
    @Query('stage') stage: string | undefined,
    @Query('status') status: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ) {
    return this.read.tasks(projectId, {
      ...(stage !== undefined ? { stage } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(page !== undefined ? { page: Number(page) } : {}),
      ...(pageSize !== undefined ? { pageSize: Number(pageSize) } : {}),
    });
  }

  /** A02-6 项目事件流 */
  @Get('events')
  events(
    @Param('projectId') projectId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.read.events(projectId, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  /** 放行策略：七确认点清单 + 最近切换事件（设置页放行策略组） */
  @Get('policy-gates')
  policyGates(@Param('projectId') projectId: string) {
    return this.settings.listGates(projectId);
  }

  /** 切换授权（F10-2：理由必填；unchanged 幂等） */
  @Post('policy-gates/:gateKey\\:set-mode')
  setGateMode(
    @Param('projectId') projectId: string,
    @Param('gateKey') gateKey: string,
    @Body() body: { mode: string; reason: string },
    @Req() req: Request,
  ) {
    const a = getActor(req);
    return this.settings.setGateMode(projectId, gateKey, body.mode, body.reason, {
      projectId, actorKind: a.kind, actorId: a.id,
    });
  }

  /** §3.9：前置条件编辑（逐条文本） */
  @Post('policy-gates/:gateKey\\:set-preconditions')
  setPreconditions(
    @Param('projectId') projectId: string,
    @Param('gateKey') gateKey: string,
    @Body() body: { preconditions: string[] },
    @Req() req: Request,
  ) {
    const a = getActor(req);
    return this.settings.setPreconditions(projectId, gateKey, body.preconditions ?? [], {
      projectId, actorKind: a.kind, actorId: a.id,
    });
  }
}
