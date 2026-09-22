/**
 * 资料上传 e2e（需 DB+MinIO）：真实 HTTP 面验证——
 * ① 幂等键中间件收窄（分片 PUT 豁免、create/:complete/:abort 强制）；② `:complete`/`:abort` 字面冒号路由；
 * ③ octet-stream 原始字节分片；④ 统一错误壳 details.violations 透出。
 */
import { createHash } from 'node:crypto';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { pool, query } from '../../db/pool.js';
import { DomainErrorFilter } from '../api/domain-error.filter.js';
import { identityMiddleware } from '../api/identity.middleware.js';
import { idempotencyMiddleware } from '../api/idempotency.middleware.js';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PID = '00000000-0000-0000-0000-0000000000e1';
const BASE = `http://127.0.0.1:18099/api/v1/projects/${PID}/materials`;

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM mat_uploads LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('资料上传 e2e（需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  let app: NestExpressApplication;

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'm1-e2e') ON CONFLICT (id) DO NOTHING", [PID]);
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error','warn'] });
    app.use(identityMiddleware);
    app.use(idempotencyMiddleware);
    app.useGlobalFilters(new DomainErrorFilter());
    await app.listen(18099, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await query('DELETE FROM mat_uploads WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  it('写端点缺 Idempotency-Key → 400 VALIDATION_FAILED；分片 PUT 豁免', async () => {
    const noKey = await fetch(`${BASE}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'a.md', size: 3, sha256: sha256(Buffer.from('abc')) }),
    });
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).error.code).toBe('VALIDATION_FAILED');

    // 分片 PUT 天然键豁免：不带 key 应直达业务（会话不存在 → 404 而非 400）
    const put = await fetch(`${BASE}/uploads/upl_none/parts/1`, {
      method: 'PUT',
      body: Buffer.from('abc'),
    });
    expect(put.status).toBe(404);
  });

  it('全链路 HTTP：create(201) → part(200) → :complete(200) → 重复 :complete(409 INVALID_STATE)', async () => {
    const content = Buffer.from('# e2e 冒烟\n');
    const create = await fetch(`${BASE}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e-1' },
      body: JSON.stringify({ fileName: 'e2e.md', size: content.length, sha256: sha256(content) }),
    });
    expect(create.status).toBe(201);
    const { uploadId } = (await create.json()) as { uploadId: string };

    const put = await fetch(`${BASE}/uploads/${uploadId}/parts/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(put.status).toBe(200);

    const complete = await fetch(`${BASE}/uploads/${uploadId}:complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e-2' },
      body: '{}',
    });
    expect(complete.status).toBe(200);
    const done = (await complete.json()) as { file: { id: string; code: string; parse_status: string } };
    expect(done.file.parse_status).toBe('pending');

    const again = await fetch(`${BASE}/uploads/${uploadId}:complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e-3' },
      body: '{}',
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('INVALID_STATE');

    const abort = await fetch(`${BASE}/uploads/${uploadId}:abort`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'e2e-4' },
    });
    expect(abort.status).toBe(409); // 已完成会话中止 → INVALID_STATE

    // 字面冒号动作路由回归（单反斜杠 `\:` 会被吞成参数分隔符，fileId 只剩首字符）：
    // :parse 必须完整捕获 uuid（未修复时 500 invalid uuid "e"）
    const fileId = done.file.id;
    const parse = await fetch(`${BASE}/files/${fileId}:parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e-5' },
      body: '{}',
    });
    expect(parse.status).toBe(202);
    expect((await parse.json()).operationId).toMatch(/^op_parse_/);
  });
});
