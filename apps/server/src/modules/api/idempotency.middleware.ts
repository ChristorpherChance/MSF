import type { NextFunction, Request, Response } from 'express';

/**
 * 幂等键中间件（LLD-5 A01-3）：写端点要求 Idempotency-Key 头。
 * M0 形态：校验存在性并透传；收据缓存（重放返回原收据）随 Redis 接线补全。
 * 天然键幂等端点（如分片 PUT）在路由级豁免（A03-2，R-03-10）。
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.path.startsWith('/health')) {
    if (!req.header('Idempotency-Key') && !req.path.includes('/uploads/')) {
      res.status(400).json({
        error: { code: 'VALIDATION_FAILED', message: '缺少 Idempotency-Key 头', target: 'Idempotency-Key' },
      });
      return;
    }
  }
  next();
}
