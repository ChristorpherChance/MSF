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
import { TemplateSetsService } from './template-sets.service.js';
import { bindingOf, codeDefaultTemplate, refreshTemplateOverrides, resolveTemplate, setItemTemplate, type DocTemplate } from './doc-templates.js';

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
    @Inject(TemplateSetsService) private readonly templateSets: TemplateSetsService,
  ) {}

  /** A02-4 阶段导航准入查询 */
  @Get('stages')
  stages(@Param('projectId') projectId: string, @Req() req: Request) {
    const a = getActor(req);
    return this.read.stages(projectId, { projectId, actorKind: a.kind, actorId: a.id });
  }

  /** 默认文档模板查看（2026-10-06/07：📄 模板钮数据源；绑定感知——当前项目生效=绑定套件条目 ?? 代码默认）。
   *  读前刷新覆盖缓存：设置页编辑器保存的套件条目即时生效 */
  @Get('doc-templates')
  async docTemplates(@Param('projectId') projectId: string) {
    await refreshTemplateOverrides();
    const setId = bindingOf(projectId);
    const builtin = ['crd', 'prd', 'hld', 'mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr'];
    return {
      items: builtin.map((kind) => {
        const t = resolveTemplate(kind === 'crd' || kind === 'prd' ? 'req' : 'design', kind, projectId)!;
        return {
          kind,
          domain: kind === 'crd' || kind === 'prd' ? 'req' : 'design',
          standard: t.standard,
          quality: t.quality,
          writingRules: t.writingRules,
          chapters: t.chapters,
          customized: setId ? setItemTemplate(setId, kind) !== undefined : false,
        };
      }),
      activeSetId: setId ?? null,
      note: '未绑定模板套件时按系统默认模板（国际标准）生成；套件在设置页「📄 文档模板」管理；参考资料中若有用户模板/格式规范，以用户模板为准。',
    };
  }

  /** 代码默认模板（设置页编辑器「载入默认」参照；不含套件覆盖） */
  @Get('doc-templates/:kind\\:default')
  docTemplateDefault(@Param('kind') kind: string) {
    const t = codeDefaultTemplate(kind);
    if (!t) throw new DomainError('VALIDATION_FAILED', 'kind 枚举 crd|prd|hld|mod|alg|cls|db|api|ui|nfr（自定义类别 x- 前缀无默认）', 'kind');
    return t;
  }

  /** 模板套件：清单+当前项目绑定 */
  @Get('template-sets')
  async templateSetsList(@Param('projectId') projectId: string) {
    const r = await this.templateSets.listSets();
    return { ...r, activeSetId: bindingOf(projectId) ?? null };
  }

  /** 模板套件：新建（cloneFrom='default' 或省略=空套件逐项编辑；=setId 克隆既有套件条目） */
  @Post('template-sets')
  createTemplateSet(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; description?: string; cloneFrom?: string },
    @Req() req: Request,
  ) {
    const a = getActor(req);
    return this.templateSets.createSet(body.name, body.description ?? '', body.cloneFrom, { projectId, actorKind: a.kind, actorId: a.id });
  }

  @Post('template-sets/:setId\\:rename')
  renameTemplateSet(
    @Param('projectId') projectId: string, @Param('setId') setId: string,
    @Body() body: { name: string; description?: string }, @Req() req: Request,
  ) {
    const a = getActor(req);
    return this.templateSets.renameSet(setId, body.name, body.description ?? '', { projectId, actorKind: a.kind, actorId: a.id });
  }

  @Post('template-sets/:setId\\:delete')
  deleteTemplateSet(@Param('projectId') projectId: string, @Param('setId') setId: string, @Req() req: Request) {
    const a = getActor(req);
    return this.templateSets.deleteSet(setId, { projectId, actorKind: a.kind, actorId: a.id });
  }

  /** 套件条目编辑初值：套件条目 ?? 代码默认（自定义类别返回 null 待 AI 起草/人工填） */
  @Get('template-sets/:setId/items/:kind')
  templateSetItem(@Param('setId') setId: string, @Param('kind') kind: string) {
    return { item: this.templateSets.editSeed(setId, kind) ?? null };
  }

  /** 套件条目：保存（validateTemplate 专业度闸，命令记审计） */
  @Put('template-sets/:setId/items/:kind')
  saveTemplateSetItem(
    @Param('projectId') projectId: string, @Param('setId') setId: string, @Param('kind') kind: string,
    @Body() body: DocTemplate, @Req() req: Request,
  ) {
    const a = getActor(req);
    return this.templateSets.saveItem(setId, kind, body, { projectId, actorKind: a.kind, actorId: a.id });
  }

  /** 套件条目：删除（该 kind 在套件内回退代码默认） */
  @Delete('template-sets/:setId/items/:kind')
  deleteTemplateSetItem(
    @Param('projectId') projectId: string, @Param('setId') setId: string, @Param('kind') kind: string,
    @Req() req: Request,
  ) {
    const a = getActor(req);
    return this.templateSets.deleteItem(setId, kind, { projectId, actorKind: a.kind, actorId: a.id });
  }

  /** 项目绑定/解绑活动套件（setId=null 解绑回默认） */
  @Put('template-binding')
  bindTemplateSet(
    @Param('projectId') projectId: string, @Body() body: { setId: string | null }, @Req() req: Request,
  ) {
    const a = getActor(req);
    return this.templateSets.bind(projectId, body.setId, { projectId, actorKind: a.kind, actorId: a.id });
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
