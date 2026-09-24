/**
 * dev 任务冒号动作路由 HTTP 级回归（#17，需 DB+MinIO）：
 * 裸 tasks/:taskId 曾吞掉 :transition/:run/:progress/:quality/:ai-review（Express :param 匹配冒号），
 * 全部落 500 22P02。修复后（taskId 限定 UUID 形态）这些请求必须落到动作处理器——
 * 对不存在的任务应得 404 NOT_FOUND「任务不存在」，而非 500。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { pool, query } from '../../db/pool.js';
import { DomainErrorFilter } from '../api/domain-error.filter.js';
import { identityMiddleware } from '../api/identity.middleware.js';
import { idempotencyMiddleware } from '../api/idempotency.middleware.js';

const PID = '00000000-0000-0000-0000-0000000000f9';
const MISSING_TASK = '00000000-0000-0000-0000-00000000ff17';
const BASE = `http://127.0.0.1:18100/api/v1/projects/${PID}/dev`;

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dev_tasks LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('dev 冒号动作路由回归（#17，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  let app: NestExpressApplication;

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'w9-dev-routes') ON CONFLICT (id) DO NOTHING", [PID]);
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
    app.use(identityMiddleware);
    app.use(idempotencyMiddleware);
    app.useGlobalFilters(new DomainErrorFilter());
    await app.listen(18100, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  // 五个曾被吞噬的动作路由：落到动作处理器后查无此任务 → 404；被吞进 saveTask 则 500（22P02）
  const ROUTES: Array<{ action: string; body?: Record<string, unknown> }> = [
    { action: 'transition', body: { to: 'ing' } },
    { action: 'run' },
    { action: 'progress', body: { prog: 10 } },
    { action: 'quality' },
    { action: 'ai-review' },
  ];

  for (const { action, body } of ROUTES) {
    it(`tasks/:id:${action} 不被 saveTask 吞掉（404 而非 500）`, async () => {
      const r = await fetch(`${BASE}/tasks/${MISSING_TASK}:${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `w9-${action}` },
        body: JSON.stringify(body ?? {}),
      });
      const j = (await r.json()) as { code?: string; message?: string };
      expect(r.status, `:${action} 响应 ${r.status} ${JSON.stringify(j)}`).not.toBe(500);
      expect([400, 404]).toContain(r.status);
      expect(j.code).not.toBe('INTERNAL');
    });
  }

  it('裸 saveTask 仍可达（UUID 形态 taskId 正常入参校验）', async () => {
    const r = await fetch(`${BASE}/tasks/${MISSING_TASK}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'w9-save' },
      body: JSON.stringify({}),
    });
    const j = (await r.json()) as { code?: string };
    expect(r.status).not.toBe(500);
    expect(j.code).not.toBe('INTERNAL');
  });
});
