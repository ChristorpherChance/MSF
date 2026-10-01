import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { DomainErrorFilter } from './modules/api/domain-error.filter.js';
import { identityMiddleware } from './modules/api/identity.middleware.js';
import { idempotencyMiddleware } from './modules/api/idempotency.middleware.js';
import { IdempotencyInterceptor } from './modules/api/idempotency.interceptor.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // X-05/W2-056：文档逐节保存 10 万字级正文 ≈300KB（UTF-8），默认 100KB 会 413；显式 2MB 上限（超限由过滤器映射人话）
  app.useBodyParser('json', { limit: '2mb' });
  app.use(identityMiddleware);
  app.use(idempotencyMiddleware);
  // W2-005：A01-3 收据缓存（同键同体重放返首个响应；同键异体 409）——须在 body-parser 之后（payload 哈希依赖解析后 body）
  app.useGlobalInterceptors(new IdempotencyInterceptor());
  app.useGlobalFilters(new DomainErrorFilter());
  // SameSite=Lax + 双提交 Token 等安全头在静态层/反代落地（R-02-3；LLD-5 §1.2）
  await app.listen(config.port);
  console.warn(`[msf] server listening on :${config.port}`);
}

void bootstrap();
