import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { StorageService } from './storage.service.js';
import { DomainError } from '@msf/shared';

/**
 * 对象存储代理（差异登记条目 35 增补，2026-10-08）。
 * 存在意义：部署态 MinIO 只绑 127.0.0.1，presignedGet 签出的直链公网浏览器不可达；
 * env MSF_FILES_PROXY=1 时 presignedGet 改发本路由的相对 URL，由本进程流式转发。
 * 鉴权：/api/** 已被 authMiddleware cookie 门覆盖；GET 无 CSRF 面。
 */
@Controller('api/v1/files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  async get(
    @Query('key') key: string,
    @Query('dl') dl: string | undefined,
    @Query('ct') ct: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (process.env.MSF_FILES_PROXY !== '1') {
      throw new DomainError('NOT_FOUND', '文件代理未启用');
    }
    if (!key || key.length > 512 || key.includes('..')) {
      throw new DomainError('VALIDATION_FAILED', '非法对象键');
    }
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    if (dl) {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(dl)}`);
    }
    try {
      const stream = await this.storage.getObjectStream(key);
      stream.on('error', () => {
        if (!res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: '对象不存在' } });
        else res.destroy();
      });
      (stream as NodeJS.ReadableStream).pipe(res);
    } catch {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: '对象不存在' } });
    }
  }
}
