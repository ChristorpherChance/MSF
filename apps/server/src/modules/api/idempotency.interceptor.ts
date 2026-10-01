import { createHash } from 'node:crypto';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { DomainError } from '@msf/shared';
import { config } from '../../config.js';
import { getActor } from './identity.middleware.js';

/**
 * 幂等收据缓存（W2-005；LLD-5 DSG-A01-3 全口径补全）：
 * - 写端点（POST/PATCH/PUT/DELETE）带 Idempotency-Key 时：按 (actor, method, path, key) 存首个响应收据
 *   （Redis，TTL 24h），同键同体重放直接返回原收据（含原状态码），不重复执行命令；
 * - 同键异体重放 → 409 IDEMPOTENCY_CONFLICT；
 * - Redis 不可达时降级为仅存在性校验（与 stream-pipeline 同口径，不阻断主流）；
 * - 并发同键在飞：不做分布式锁——命令层咨询锁（W2-052）与唯一约束兜底，收据只解决「事后重放」；
 * - body===undefined 的响应（SSE 流式端点等直写 res 的场景）不缓存——SSE 有 lastEventId 重放路径（A08-4）。
 */

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, v: string, ...args: unknown[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface Receipt { payloadHash: string; status: number; body: unknown }

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const TTL_SECONDS = 24 * 3600;
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export class IdempotencyInterceptor implements NestInterceptor {
  private redis: RedisLike | null | undefined; // undefined=未探测

  private async getRedis(): Promise<RedisLike | null> {
    if (this.redis !== undefined) return this.redis;
    try {
      const { Redis } = await import('ioredis');
      const r = new Redis(config.redisUrl, {
        lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 0,
      }) as unknown as RedisLike & { connect(): Promise<void> };
      await r.connect();
      this.redis = r;
    } catch {
      this.redis = null; // 降级：仅中间件存在性校验
    }
    return this.redis;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  async intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    if (!WRITE_METHODS.has(req.method)) return next.handle();
    // 天然键幂等豁免：分片 PUT（A03-2，R-03-10）
    if (/\/uploads\/[^/]+\/parts\/\d+$/.test(req.path)) return next.handle();
    const idemKey = req.header('Idempotency-Key');
    if (!idemKey) return next.handle(); // 缺失拒绝在中间件（400）
    const redis = await this.getRedis();
    if (!redis) return next.handle();

    const actor = getActor(req).id;
    const payloadHash = sha256hex(JSON.stringify(req.body ?? null));
    const cacheKey = `msf:idem:${actor}:${req.method}:${req.path}:${idemKey}`;
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) {
      const receipt = JSON.parse(hit) as Receipt;
      if (receipt.payloadHash !== payloadHash) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '同 Idempotency-Key 不同载荷：首个请求已执行，重放须与原载荷完全一致（换载荷请换新键）',
          'Idempotency-Key',
        );
      }
      // 同键同体重放：返回首个响应收据（含原状态码），不重复执行
      context.switchToHttp().getResponse<Response>().status(receipt.status);
      return of(receipt.body);
    }
    return next.handle().pipe(
      tap((body: unknown) => {
        if (body === undefined) return; // SSE/空响应不缓存
        const res = context.switchToHttp().getResponse<Response>();
        void redis.set(
          cacheKey,
          JSON.stringify({ payloadHash, status: res.statusCode, body } satisfies Receipt),
          'EX', TTL_SECONDS,
        ).catch(() => undefined);
      }),
    );
  }
}
