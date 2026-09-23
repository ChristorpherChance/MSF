import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
  create(@Body() body: { name: string; isDemo?: boolean }) {
    return this.projects.create(body.name, body.isDemo ?? false);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.projects.archive(id);
  }
}
