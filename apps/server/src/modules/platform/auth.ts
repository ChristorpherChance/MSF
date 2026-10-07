/** 部署态简易登录（2026-10-08 公网部署加装；差异登记待 13 册回补）：
 *  env MSF_AUTH_USER + MSF_AUTH_PASS 同时设置即启用；未设置=本地开发零鉴权，行为完全不变。
 *  口令只经 env 注入（systemd env 文件 600 权限），不落库、不落文档、不进 git。
 *  会话 = HMAC-SHA256 签名 cookie（无状态，7 天），密钥派生自 MSF_SECRET_KEY（与 crypto.service 同根不同域）。
 *  防护面：SameSite=Lax + 未开 CORS（跨站 fetch 被浏览器拦）+ 登录失败限流（见 auth.controller）。 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE = 'msf_auth';
const TTL_MS = 7 * 24 * 3600 * 1000;

export const authEnabled = (): boolean =>
  Boolean(process.env.MSF_AUTH_USER && process.env.MSF_AUTH_PASS);

const secret = (): Buffer =>
  createHash('sha256')
    .update(`msf-auth:${process.env.MSF_SECRET_KEY ?? 'msf-dev-secret-local-only'}`)
    .digest();

const sign = (payload: string): string =>
  createHmac('sha256', secret()).update(payload).digest('base64url');

export function issueToken(user: string): string {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(`${user}.${exp}`)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token || !authEnabled()) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = Buffer.from(sign(`${process.env.MSF_AUTH_USER}.${exp}`));
  const got = Buffer.from(token.slice(dot + 1));
  return expect.length === got.length && timingSafeEqual(expect, got);
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export const authCookieHeader = (token: string): string =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`;
export const clearCookieHeader = (): string =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** 全局中间件（main.ts 挂于 identity 之前）：启用时 /api/** 无有效 cookie → 401 UNAUTHENTICATED；
 *  豁免 /api/auth/login、/api/auth/whoami（前端启动探测）、/health（运维探活）；
 *  静态构建产物不拦（bundle 无敏感信息，数据全走 API）——SPA 登录页由前端 AuthGate 守门。
 *  注意：中间件抛错不经 Nest 过滤器，401 响应体在此直接手写（形状与 DomainErrorFilter 一致）。 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (
    !authEnabled() ||
    !req.path.startsWith('/api') ||
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/whoami'
  ) {
    next();
    return;
  }
  if (verifyToken(readCookie(req, COOKIE))) {
    next();
    return;
  }
  res
    .status(401)
    .json({ error: { code: 'UNAUTHENTICATED', message: '未登录或登录已过期，请重新登录' } });
}
