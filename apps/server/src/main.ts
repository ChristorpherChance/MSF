import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { DomainErrorFilter } from './modules/api/domain-error.filter.js';
import { identityMiddleware } from './modules/api/identity.middleware.js';
import { idempotencyMiddleware } from './modules/api/idempotency.middleware.js';
import { IdempotencyInterceptor } from './modules/api/idempotency.interceptor.js';
import { authEnabled, authMiddleware, verifyToken } from './modules/platform/auth.js';
import { DevPreviewService } from './modules/dev/preview.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // X-05/W2-056：文档逐节保存 10 万字级正文 ≈300KB（UTF-8），默认 100KB 会 413；显式 2MB 上限（超限由过滤器映射人话）
  app.useBodyParser('json', { limit: '2mb' });
  // 部署态简易登录（env 门控，未设置=本地开发零鉴权）：须在业务路由前
  app.use(authMiddleware);
  // 预览同源隔离带（2026-10-18 运行预览二期）：预览 iframe 与平台同源，AI 生成页内脚本
  // 可能携带平台会话直调 /api——凡 Referer 含 /dev-preview/ 的 /api 请求一律 403。
  // 生成应用约定只调相对路径（经 /dev-preview/:pid/* 反代进出沙箱容器，头中 Cookie 已剥离）。
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ref = String(req.headers.referer ?? '');
    if (req.path.startsWith('/api/') && ref.includes('/dev-preview/')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '预览沙箱内页面不可直调平台 API' } });
      return;
    }
    next();
  });
  app.use(identityMiddleware);
  app.use(idempotencyMiddleware);
  // W2-005：A01-3 收据缓存（同键同体重放返首个响应；同键异体 409）——须在 body-parser 之后（payload 哈希依赖解析后 body）
  app.useGlobalInterceptors(new IdempotencyInterceptor());
  app.useGlobalFilters(new DomainErrorFilter());
  // 公网部署同进程托管前端构建产物（MSF_WEB_DIST 指向 apps/web/dist；本地 vite 开发不设置）：
  // 静态文件直出 + SPA 路由回退 index.html（/api 与 /health 除外）；SameSite=Lax + 双提交 Token 等安全头在静态层/反代落地（R-02-3；LLD-5 §1.2）
  const webDist = process.env.MSF_WEB_DIST;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    const root = resolve(webDist);
    app.useStaticAssets(root, { index: false });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/dev-preview') || req.path === '/health' || extname(req.path)) {
        next();
        return;
      }
      res.sendFile(join(root, 'index.html'));
    });
  }
  // 预览 WS 反代（2026-10-21 游戏可玩根修）：/dev-preview/:pid/* 的 upgrade 管道透传到沙箱容器。
  // 鉴权口径同 HTTP 罩（部署态须登录）；Nest/Express 不处理 upgrade，不挂这个实时应用（游戏/协作）全断。
  const httpServer = app.getHttpServer() as import('node:http').Server;
  httpServer.on('upgrade', (req, socket, head) => {
    void (async () => {
      const m = /^\/dev-preview\/([0-9a-f-]{36})(\/[^?\s]*)?(\?\S*)?$/.exec(req.url ?? '');
      if (!m) { socket.destroy(); return; }
      if (authEnabled()) {
        const token = String(req.headers.cookie ?? '').match(/(?:^|;\s*)msf_auth=([^;]+)/)?.[1];
        if (!verifyToken(token)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      const preview = app.get(DevPreviewService, { strict: false }) as DevPreviewService;
      const tail = `${m[2] ?? '/'}${m[3] ?? ''}`;
      const ok = await preview.proxyUpgrade(m[1]!, tail, req, socket, head);
      if (!ok) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    })().catch(() => socket.destroy());
  });
  await app.listen(config.port);
  console.warn(`[msf] server listening on :${config.port}`);
}

void bootstrap();
