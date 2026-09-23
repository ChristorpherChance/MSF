import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';

/** 项目管理端点（A02-x 最小集；完整面见 LLD-5 §A02） */
@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.projects.get(id);
  }

  @Post()
  create(@Body() body: { name: string; isDemo?: boolean; description?: string }) {
    return this.projects.create(body.name, body.isDemo ?? false, body.description ?? '');
  }

  /** 项目编辑（名称/描述；W4 项目卡编辑入口） */
  @Put(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; description?: string }) {
    return this.projects.update(id, body);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.projects.archive(id);
  }
}
