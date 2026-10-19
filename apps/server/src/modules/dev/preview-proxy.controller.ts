import { All, Controller, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DevPreviewService } from './preview.service.js';

/**
 * 预览反代（2026-10-18 二期）：/dev-preview/:projectId/* → 长驻沙箱容器。
 * 刻意不在 /api/v1 下：① 前端 SPA 回退/幂等键中间件只管 /api 系；
 * ② Referer 隔离带（main.ts）按 /dev-preview/ 来源挡平台 API 直调。
 * 鉴权=全局 authMiddleware（部署态登录同 /api 一致）。
 */
@Controller('dev-preview')
export class DevPreviewProxyController {
  constructor(@Inject(DevPreviewService) private readonly preview: DevPreviewService) {}

  @All([':projectId', ':projectId/*'])
  async proxy(
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // 尾路径（含查询串）：从 originalUrl 精确切，保住 ?a=b 与多级路径
    const prefix = `/dev-preview/${projectId}`;
    const idx = req.originalUrl.indexOf(prefix);
    let tail = idx >= 0 ? req.originalUrl.slice(idx + prefix.length) : '/';
    if (!tail.startsWith('/')) tail = `/${tail}`;
    // 无前缀尾斜杠的裸访问 302 补斜杠——否则页内相对路径引用（约定纪律）解析到 :pid 上一级全错位
    const pathOnly = req.originalUrl.split('?')[0]!;
    if (tail === '/' && !pathOnly.endsWith('/')) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      res.redirect(302, `${prefix}/${qs}`);
      return;
    }
    const r = await this.preview.proxy(projectId, tail, req);
    res.status(r.status);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    res.send(r.body);
  }
}
