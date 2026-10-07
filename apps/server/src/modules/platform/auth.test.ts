/** 简易登录单元测试（env 门控；不依赖 DB/MinIO） */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DomainError } from '@msf/shared';
import {
  authCookieHeader,
  authEnabled,
  authMiddleware,
  clearCookieHeader,
  issueToken,
  readCookie,
  verifyToken,
} from './auth.js';
import { AuthController } from './auth.controller.js';

const ENV = { MSF_AUTH_USER: 'superopen', MSF_AUTH_PASS: 'Bb1234~!', MSF_SECRET_KEY: 'test-secret' };

const mockReq = (path: string, cookie?: string): Request =>
  ({ path, headers: cookie ? { cookie } : {}, ip: '127.0.0.1' }) as unknown as Request;

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(n: number): MockRes;
  json(b: unknown): MockRes;
  setHeader(k: string, v: string): void;
}
const mockRes = (): MockRes => {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(n) {
      r.statusCode = n;
      return r;
    },
    json(b) {
      r.body = b;
      return r;
    },
    setHeader(k, v) {
      r.headers[k.toLowerCase()] = v;
    },
  };
  return r;
};

describe('简易登录（env 门控）', () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });
  afterEach(() => {
    delete process.env.MSF_AUTH_USER;
    delete process.env.MSF_AUTH_PASS;
    delete process.env.MSF_SECRET_KEY;
  });

  it('未设置 env 时门控关闭：middleware 全放行，whoami 报 enabled=false', () => {
    delete process.env.MSF_AUTH_USER;
    delete process.env.MSF_AUTH_PASS;
    expect(authEnabled()).toBe(false);
    let called = false;
    authMiddleware(mockReq('/api/projects'), mockRes() as unknown as Response, () => {
      called = true;
    });
    expect(called).toBe(true);
    const c = new AuthController();
    expect(c.whoami(mockReq('/api/auth/whoami'))).toEqual({ enabled: false, user: 'local' });
  });

  it('签发/校验 token：有效通过、篡改拒、过期拒', () => {
    const t = issueToken('superopen');
    expect(verifyToken(t)).toBe(true);
    expect(verifyToken(`${t}x`)).toBe(false);
    expect(verifyToken(t.replace(/^(\d+)\./, (m) => `${Number(m) - 8 * 24 * 3600 * 1000}.`))).toBe(
      false,
    );
    expect(verifyToken(undefined)).toBe(false);
    expect(verifyToken('garbage')).toBe(false);
  });

  it('middleware：无 cookie 的 /api 请求 401 人话；豁免 login/whoami/health；带有效 cookie 放行', () => {
    const res = mockRes();
    let called = false;
    authMiddleware(mockReq('/api/projects'), res as unknown as Response, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');

    for (const p of ['/api/auth/login', '/api/auth/whoami', '/health', '/assets/index.js']) {
      called = false;
      authMiddleware(mockReq(p), mockRes() as unknown as Response, () => {
        called = true;
      });
      expect(called, p).toBe(true);
    }

    const cookie = `msf_auth=${issueToken('superopen')}`;
    expect(readCookie(mockReq('/api/projects', cookie), 'msf_auth')).toBeTruthy();
    called = false;
    authMiddleware(mockReq('/api/projects', cookie), mockRes() as unknown as Response, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('login：错口令 401 且计数，连续 5 次后 429 限流；对口令签发 cookie', () => {
    const c = new AuthController();
    const bad = (): void => {
      c.login({ username: 'superopen', password: 'wrong' }, mockReq('/api/auth/login'), mockRes() as unknown as Response);
    };
    for (let i = 0; i < 5; i++) {
      try {
        bad();
        expect.unreachable('错口令应抛 UNAUTHENTICATED');
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        expect((e as DomainError).code).toBe('UNAUTHENTICATED');
      }
    }
    try {
      c.login({ username: 'superopen', password: 'Bb1234~!' }, mockReq('/api/auth/login'), mockRes() as unknown as Response);
      expect.unreachable('限流后应抛 RATE_LIMITED');
    } catch (e) {
      expect((e as DomainError).code).toBe('RATE_LIMITED');
    }
    // 换一个 IP：限流按 IP 隔离，正常登录成功并签发 HttpOnly cookie
    const res = mockRes();
    const out = c.login(
      { username: 'superopen', password: 'Bb1234~!' },
      { ...mockReq('/api/auth/login'), ip: '10.0.0.2' } as Request,
      res as unknown as Response,
    );
    expect(out).toEqual({ ok: true, user: 'superopen' });
    expect(res.headers['set-cookie']).toContain('HttpOnly');
    expect(res.headers['set-cookie']).toContain('SameSite=Lax');
    const token = res.headers['set-cookie']!.match(/^msf_auth=([^;]+)/)![1]!;
    expect(verifyToken(token)).toBe(true);
    // logout 清 cookie
    const res2 = mockRes();
    c.logout(res2 as unknown as Response);
    expect(res2.headers['set-cookie']).toContain('Max-Age=0');
    expect(authCookieHeader('x')).toContain('Path=/');
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });
});
