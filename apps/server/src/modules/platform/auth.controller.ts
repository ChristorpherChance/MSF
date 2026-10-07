import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { DomainError } from '@msf/shared';
import {
  authCookieHeader,
  authEnabled,
  clearCookieHeader,
  issueToken,
  readCookie,
  verifyToken,
} from './auth.js';

/** 登录失败限流：同 IP（frp 反代取 XFF 首跳）10 分钟内错 5 次 → 锁 10 分钟（内存态，重启清零；429 RATE_LIMITED 走闭集既有码）。
 *  另有全局限额：XFF 可伪造，单靠 per-IP 会被轮换绕过——任意来源合计错 30 次/10 分钟即全局限流。 */
const fails = new Map<string, { n: number; resetAt: number }>();
let globalFails = { n: 0, resetAt: 0 };
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const MAX_GLOBAL_FAILS = 30;

const clientIp = (req: Request): string => {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0];
  return first?.trim() || req.ip || 'unknown';
};

const hit = (map: Map<string, { n: number; resetAt: number }>, key: string): void => {
  const rec = map.get(key);
  const cur = rec && rec.resetAt > Date.now() ? rec : { n: 0, resetAt: Date.now() + WINDOW_MS };
  cur.n += 1;
  map.set(key, cur);
};

const locked = (req: Request): boolean => {
  const rec = fails.get(clientIp(req));
  return Boolean(
    (rec && rec.resetAt > Date.now() && rec.n >= MAX_FAILS) ||
      (globalFails.resetAt > Date.now() && globalFails.n >= MAX_GLOBAL_FAILS),
  );
};

const eq = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

/** 简易登录（env 门控，见 auth.ts 头注）；whoami 无 cookie 也返回 200（enabled/user 两态），供前端启动探测 */
@Controller('api/auth')
export class AuthController {
  @Get('whoami')
  whoami(@Req() req: Request): { enabled: boolean; user: string | null } {
    if (!authEnabled()) return { enabled: false, user: 'local' };
    const ok = verifyToken(readCookie(req, 'msf_auth'));
    return { enabled: true, user: ok ? (process.env.MSF_AUTH_USER ?? null) : null };
  }

  @Post('login')
  @HttpCode(200)
  login(
    @Body() body: { username?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): { ok: boolean; user: string } {
    if (!authEnabled()) return { ok: true, user: 'local' };
    if (locked(req)) {
      throw new DomainError('RATE_LIMITED', '尝试太频繁，请 10 分钟后再试');
    }
    const u = String(body?.username ?? '');
    const p = String(body?.password ?? '');
    const eu = process.env.MSF_AUTH_USER ?? '';
    const ep = process.env.MSF_AUTH_PASS ?? '';
    if (!eq(u, eu) || !eq(p, ep)) {
      hit(fails, clientIp(req));
      globalFails =
        globalFails.resetAt > Date.now()
          ? { ...globalFails, n: globalFails.n + 1 }
          : { n: 1, resetAt: Date.now() + WINDOW_MS };
      throw new DomainError('UNAUTHENTICATED', '用户名或密码不对');
    }
    fails.delete(clientIp(req));
    res.setHeader('Set-Cookie', authCookieHeader(issueToken(eu)));
    return { ok: true, user: eu };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response): { ok: boolean } {
    res.setHeader('Set-Cookie', clearCookieHeader());
    return { ok: true };
  }
}
