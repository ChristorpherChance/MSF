import {
  Body, Controller, Get, HttpCode, Inject, Post, Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '@msf/shared';
import { getActor } from '../api/identity.middleware.js';
import { ReflectionService } from './reflection.service.js';
import { DEFAULT_AGENT_MAP, DEFAULT_AGENTS } from './stage-guides.js';

/**
 * Agent 反思端点（设计 §4；挂 api/v1/system 区镜像 system 端点形态）。
 * 注：controller 落在 AiModule 而非 platform/system.controller——PlatformModule 不反向依赖 ai（无环），
 * ReflectionService 由 AiModule 提供并导出；路由前缀与 system 区一致仅是端点归属口径。
 */
@Controller('api/v1/system')
export class ReflectionsController {
  constructor(@Inject(ReflectionService) private readonly reflections: ReflectionService) {}

  /** 反思全局跨项目：projectId=null，actor 经 getActor */
  private actor(req: Request) {
    const a = getActor(req);
    return { projectId: null, actorKind: a.kind, actorId: a.id };
  }

  /** 手动触发一场反思（并发闸：在飞再触发抛 INVALID_STATE「已有反思任务进行中」） */
  @Post('reflections\\:run')
  @HttpCode(200)
  run(@Req() req: Request) {
    return this.reflections.run('manual', this.actor(req));
  }

  /** 历史列表（近 50 场：id/trigger/窗口/提案状态计数/created_at）；?id= 单取含 report 全文 + proposals 明细 */
  @Get('reflections')
  list(@Query('id') id?: string) {
    return this.reflections.list(id);
  }

  /** 提案处置：adopt=is_current 翻转（先摘后挂）+状态回写；reject=仅状态回写（版本行保留可追溯） */
  @Post('reflections\\:resolve')
  @HttpCode(200)
  resolve(
    @Body() body: { reflectionId?: string; agentKey?: string; versionNo?: number; action?: string },
    @Req() req: Request,
  ) {
    const versionNo = body?.versionNo;
    if (!body?.reflectionId || !body.agentKey || typeof versionNo !== 'number' || !Number.isInteger(versionNo)
      || (body.action !== 'adopt' && body.action !== 'reject')) {
      throw new DomainError('VALIDATION_FAILED', 'reflectionId + agentKey + versionNo（整数）+ action（adopt|reject）必填', 'action');
    }
    return this.reflections.resolveProposal(
      { reflectionId: body.reflectionId, agentKey: body.agentKey, versionNo, decision: body.action },
      this.actor(req));
  }

  /**
   * Agent 代码默认基底名册（设置页 Agent 区名册树数据源；Task 7 顺带加入口）。
   * 只读直出 stage-guides DEFAULT_AGENTS——运行时真身同源，前端不再内置 AGENTS 常量。
   * 无参=全量二十套（{items}）；?key= 单取 {key,name,group,role,prompt}，未知 key 404。
   */
  @Get('agent-baseline')
  baseline(@Query('key') key?: string) {
    if (key) {
      const def = DEFAULT_AGENT_MAP[key];
      if (!def) throw new DomainError('NOT_FOUND', `未知 agentKey「${key}」（名册外）`, key);
      return def;
    }
    return { items: DEFAULT_AGENTS };
  }
}
