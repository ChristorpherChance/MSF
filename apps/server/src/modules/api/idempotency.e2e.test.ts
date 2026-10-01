/**
 * 幂等收据缓存 HTTP 级验证（W2-005；LLD-5 DSG-A01-3，需 DB+Redis）：
 * 同 (actor,method,path,key) 同体重放 → 返回首个响应（同 id 同状态码）且不重复执行（DB 仅一行）；
 * 同键异体 → 409 IDEMPOTENCY_CONFLICT；换键正常执行。
 * 靶端点选 ai.sessions:create（控制器显式 @Inject，vitest/esbuild 无 emitDecoratorMetadata 环境下可 DI；
 * ss_N 发号让「是否重复执行」可观测）。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { AppModule } from '../../app.module.js';
import { config } from '../../config.js';
import { pool, query } from '../../db/pool.js';
import { DomainErrorFilter } from './domain-error.filter.js';
import { identityMiddleware } from './identity.middleware.js';
import { idempotencyMiddleware } from './idempotency.middleware.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

const PID = '00000000-0000-0000-0000-0000000000e6';
const BASE = `http://127.0.0.1:18101/api/v1/projects/${PID}/ai/sessions`;

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM projects LIMIT 1');
    const r = new Redis(config.redisUrl, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 0 });
    await r.connect();
    await r.quit();
    return true;
  } catch {
    return false;
  }
}

describe('幂等收据缓存（W2-005，需 DB+Redis）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres/redis 未就绪', () => {});
    return;
  }
  let app: NestExpressApplication;

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'w2005-idem') ON CONFLICT (id) DO NOTHING", [PID]);
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
    app.use(identityMiddleware);
    app.use(idempotencyMiddleware);
    app.useGlobalInterceptors(new IdempotencyInterceptor());
    app.useGlobalFilters(new DomainErrorFilter());
    await app.listen(18101, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await query('DELETE FROM ai_sessions WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  const post = (key: string, body: Record<string, unknown>) =>
    fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });

  it('同键同体重放：返回首个响应（同 id），不重复建行', async () => {
    const name = `w2005-${Date.now()}`;
    const key = crypto.randomUUID();
    const r1 = await post(key, { ctx: 'req', name });
    const j1 = (await r1.json()) as { id: string; code: string };
    expect(r1.status, `首个响应 ${r1.status} ${JSON.stringify(j1)}`).toBe(200);
    const r2 = await post(key, { ctx: 'req', name });
    const j2 = (await r2.json()) as { id: string; code: string };
    expect(r2.status).toBe(200); // 收据含原状态码（会话创建 @HttpCode 200）
    expect(j2.id).toBe(j1.id); // 同 id=未重复执行
    const cnt = await query<{ n: string }>(
      'SELECT count(*) AS n FROM ai_sessions WHERE project_id=$1 AND name=$2', [PID, name]);
    expect(Number(cnt.rows[0]!.n)).toBe(1);
  });

  it('同键异体 → 409 IDEMPOTENCY_CONFLICT（人话指引换键）', async () => {
    const key = crypto.randomUUID();
    const r1 = await post(key, { ctx: 'req', name: `w2005-a-${Date.now()}` });
    expect(r1.status).toBe(200);
    const r2 = await post(key, { ctx: 'req', name: `w2005-b-${Date.now()}` });
    expect(r2.status).toBe(409);
    const j = (await r2.json()) as { error: { code: string; message: string } };
    expect(j.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(j.error.message).toContain('Idempotency-Key');
  });

  it('换键同体：视为新请求正常执行（ss_N 递增）', async () => {
    const name = `w2005-c-${Date.now()}`;
    const r1 = await post(crypto.randomUUID(), { ctx: 'dev', name });
    const r2 = await post(crypto.randomUUID(), { ctx: 'dev', name });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = (await r1.json()) as { id: string; code: string };
    const j2 = (await r2.json()) as { id: string; code: string };
    expect(j2.id).not.toBe(j1.id);
    expect(j2.code).not.toBe(j1.code);
  });
});
