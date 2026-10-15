/**
 * RTM deferred 端点级回归（设计覆盖检测与可交互原型 §1，需 DB）：
 * 控制器层 kind 枚举闸同步扩 'dsg'——不扩则豁免按钮经 HTTP 400，实机才暴露。
 * 覆盖：dsg 标记/取消豁免全链（端点→命令→rtm_links 自指行→health.overdesign.exempted）、
 * 非法 kind 400、理由必填闸。
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

// e2e PID 注册表（共享库并行跑，撞 PID=FK 级联整组炸，新增套件先查再占）：
// e1~e6/e9+f1~f9+fa~ff 已占用（各套件文件顶部常量自查，如 req.integration f1/fa/fc~fe、
// template-refresh-preflight fa~fe、prototype-pages fb、design/coverage-fix.integration e7/e8）；
// d 段：d1/d4=req.integration、d2/d3=design.integration、d5=design/review-selfcheck.integration、
// d6=design/prototype-refs.integration；
// 本套件占 f0。
const PID = '00000000-0000-0000-0000-0000000000f0';
const BASE = `http://127.0.0.1:18102/api/v1/projects/${PID}/requirements`;

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM rtm_links LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

/** 死锁（40P01）退避重试：并发 e2e 套件共享同一 DB，清理/写入偶发被选为死锁牺牲者 */
async function withDeadlockRetry(fn: () => Promise<unknown>, attempts = 5): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      if ((e as { code?: string })?.code !== '40P01' || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
}

describe('rtm deferred 端点枚举闸（dsg 扩展，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  let app: NestExpressApplication;

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'od-deferred-e2e') ON CONFLICT (id) DO NOTHING", [PID]);
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
    app.use(identityMiddleware);
    app.use(idempotencyMiddleware);
    app.useGlobalFilters(new DomainErrorFilter());
    await app.listen(18102, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    // 并发套件同跑时 projects 行删除与邻套件事务偶发死锁（40P01）——退避重试，勿让清理失败炸掉整组
    await withDeadlockRetry(() => query('DELETE FROM rtm_links WHERE project_id=$1', [PID]));
    await withDeadlockRetry(() => query('DELETE FROM projects WHERE id=$1', [PID]));
    await pool.end();
  });

  const post = (path: string, body: Record<string, unknown>, key: string) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });

  it('dsg 豁免标记经端点落 rtm_links 自指行，并进入 health.overdesign.exempted；取消豁免后剔除', async () => {
    // 标记（理由必填）
    const r1 = await post('/rtm/dsg/h-1:defer', { reason: '合理的性能缓存设计，无独立需求' }, 'od-defer-1');
    expect(r1.status, `defer 响应 ${r1.status}`).toBe(200);
    const row = await query<{ from_kind: string; relation: string }>(
      "SELECT from_kind, relation FROM rtm_links WHERE project_id=$1 AND from_code='h-1'", [PID]);
    expect(row.rows[0]).toMatchObject({ from_kind: 'dsg', relation: 'deferred' });

    // health.overdesign.exempted 含 h-1（豁免码集组装）
    const h = await (await fetch(`${BASE}/rtm/health`)).json() as { overdesign: { candidates: unknown[]; exempted: string[] } };
    expect(h.overdesign.exempted).toContain('h-1');

    // 重复标记 → INVALID_STATE
    const r2 = await post('/rtm/dsg/h-1:defer', { reason: '重复' }, 'od-defer-2');
    expect(r2.status).not.toBe(200);

    // 取消豁免 → 行删除、exempted 剔除
    const r3 = await post('/rtm/dsg/h-1:undefer', {}, 'od-undefer-1');
    expect(r3.status).toBe(200);
    const h2 = await (await fetch(`${BASE}/rtm/health`)).json() as { overdesign: { exempted: string[] } };
    expect(h2.overdesign.exempted).not.toContain('h-1');
  });

  it('非法 kind 被控制器枚举闸拦 400（文案含 CR/REQ/DSG）；理由空被服务端拦', async () => {
    const bad = await post('/rtm/r/R-001:defer', { reason: 'x' }, 'od-defer-bad');
    expect(bad.status).toBe(400);
    const j = (await bad.json()) as { error: { code: string; message: string } };
    expect(j.error.code).toBe('VALIDATION_FAILED');
    expect(j.error.message).toContain('CR/REQ/DSG');

    const noReason = await post('/rtm/dsg/h-2:defer', { reason: '' }, 'od-defer-nr');
    expect(noReason.status).toBe(400);
  });
});
