/** AI 域模型注册/路由与 Pi 网关集成测试（T6-03/04，需 DB；D08-5、A08-9、REQ-611/615/710/803） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { decryptText } from '../platform/crypto.service.js';
import { AiModelsService } from './models.service.js';
import { PiAiGateway } from './pi-gateway.js';

const CTX: CommandContext = { projectId: null, actorKind: 'human', actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM ai_models LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('AI 模型注册/路由 + Pi 网关（集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  resetCommands();
  const models = new AiModelsService();
  models.onModuleInit();
  const gateway = new PiAiGateway(models);

  const ids: string[] = [];
  // 路由快照：route.set「先全摘后挂」会摘掉共库真实模型的 generation 路由（实机网关被摘→MODEL_UNAVAILABLE）。
  // 只快照本套件触碰的用途、跑完补挂回原持有模型（整表快照在并行套件间互相覆盖，已踩坑）。
  let genHolders: string[] = [];
  beforeAll(async () => {
    genHolders = (await query<{ id: string }>("SELECT id FROM ai_models WHERE routes ? 'generation'", [])).rows.map((r) => r.id);
  });
  afterAll(async () => {
    for (const id of ids) await query('DELETE FROM ai_models WHERE id=$1', [id]);
    for (const id of genHolders) {
      await query(
        "UPDATE ai_models SET routes = routes || '\"generation\"'::jsonb WHERE id=$1 AND NOT (routes ? 'generation')",
        [id],
      );
    }
    await pool.end();
  });

  it('upsert 创建：密钥加密落库，list 仅回掩码', async () => {
    const { id } = await models.upsert({
      name: '测试网关模型', provider: 'gateway', baseUrl: 'http://127.0.0.1:9',
      modelCode: 'test-model', apiKey: 'sk-test-abcdef123456',
      priceTable: { in: 0.001, out: 0.002 },
    }, CTX);
    ids.push(id);
    const list = await models.list();
    const row = list.find((m) => m.id === id)!;
    expect(row.api_key_hint).toBe('sk-t…3456');
    expect(row).not.toHaveProperty('api_key_enc');
    // 库内密文可解密还原（CredentialVault 口径），且非明文
    const enc = await query<{ api_key_enc: Buffer }>('SELECT api_key_enc FROM ai_models WHERE id=$1', [id]);
    expect(enc.rows[0]!.api_key_enc.toString()).not.toContain('sk-test-abcdef123456');
    expect(decryptText(enc.rows[0]!.api_key_enc)).toBe('sk-test-abcdef123456');
    // 审计留痕（同事务）
    const audit = await query('SELECT 1 FROM audit_log WHERE command=$1 LIMIT 1', ['ai.model.upsert']);
    expect(audit.rows.length).toBe(1);
  });

  it('upsert 更新：未给 apiKey 保留原密文，给则替换并回 untested', async () => {
    const id = ids[0]!;
    const before = await query<{ api_key_enc: Buffer }>('SELECT api_key_enc FROM ai_models WHERE id=$1', [id]);
    await models.upsert({ id, name: '改名模型' }, CTX);
    const keep = await query<{ api_key_enc: Buffer }>('SELECT api_key_enc FROM ai_models WHERE id=$1', [id]);
    expect(keep.rows[0]!.api_key_enc.equals(before.rows[0]!.api_key_enc)).toBe(true);
    await models.upsert({ id, apiKey: 'sk-new-key-9999' }, CTX);
    const after = await query<{ api_key_enc: Buffer; conn_status: string }>(
      'SELECT api_key_enc, conn_status FROM ai_models WHERE id=$1', [id]);
    expect(decryptText(after.rows[0]!.api_key_enc)).toBe('sk-new-key-9999');
    expect(after.rows[0]!.conn_status).toBe('untested');
  });

  it('route.set：用途唯一挂载，resolve 命中；摘除后 MODEL_UNAVAILABLE', async () => {
    const a = ids[0]!;
    const b = (await models.upsert({
      name: '备用模型', provider: 'openai', baseUrl: 'http://127.0.0.1:9', modelCode: 'm2',
    }, CTX)).id;
    ids.push(b);
    await models.setRoute('generation', a, CTX);
    await models.setRoute('generation', b, CTX); // 换挂：a 自动摘除
    const routes = await models.routes();
    expect(routes['generation']!.modelId).toBe(b);
    const resolved = await models.resolve('generation');
    expect(resolved.row.id).toBe(b);
    expect(resolved.apiKey).toBeNull(); // 未配 key
    await models.setRoute('generation', null, CTX);
    await expect(models.resolve('generation')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('reflection 兜底：显式路由优先 / 无路由取 enabled 窗口最大者 / 全禁抛 MODEL_UNAVAILABLE', async () => {
    // 反思路由快照（同 generation 口径：route.set 先摘后挂会动共库路由，跑完还原原持有者）
    const reflHolders = (await query<{ id: string }>("SELECT id FROM ai_models WHERE routes ? 'reflection'", [])).rows.map((r) => r.id);
    try {
      // ① 显式路由优先：挂载小窗模型也命中挂载行（不走窗口兜底）
      const small = (await models.upsert({
        name: '反思小窗模型', provider: 'openai', baseUrl: 'http://127.0.0.1:9',
        modelCode: 'refl-small', contextWindow: 8000,
      }, CTX)).id;
      ids.push(small);
      await models.setRoute('reflection', small, CTX);
      const explicit = await models.resolve('reflection');
      expect(explicit.row.id).toBe(small);
      // ② 摘掉路由 → 动态兜底：enabled 中 context_window 最大者（与 SQL 口径逐行对齐，共库数据无关）
      await models.setRoute('reflection', null, CTX);
      const expectRow = (await query<{ id: string }>(
        'SELECT id FROM ai_models WHERE enabled ORDER BY context_window DESC, updated_at DESC LIMIT 1', [])).rows[0];
      if (expectRow) {
        const fallback = await models.resolve('reflection');
        expect(fallback.row.id).toBe(expectRow.id);
      } else {
        // 空库口径：兜底亦无米下锅 → 同样抛 MODEL_UNAVAILABLE
        await expect(models.resolve('reflection')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
      }
      // ③ 全禁 → 既有码 MODEL_UNAVAILABLE；快照 enabled 行 finally 还原（窗口收窄，单套件运行无并行干扰）
      const enabledIds = (await query<{ id: string }>('SELECT id FROM ai_models WHERE enabled', [])).rows.map((r) => r.id);
      try {
        await query('UPDATE ai_models SET enabled=false', []);
        await expect(models.resolve('reflection')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
      } finally {
        for (const id of enabledIds) await query('UPDATE ai_models SET enabled=true WHERE id=$1', [id]);
      }
    } finally {
      // 还原反思路由原持有者
      await query("UPDATE ai_models SET routes = routes - 'reflection' WHERE routes ? 'reflection'", []);
      for (const id of reflHolders) {
        await query(
          "UPDATE ai_models SET routes = routes || '\"reflection\"'::jsonb WHERE id=$1 AND NOT (routes ? 'reflection')",
          [id],
        );
      }
    }
  });

  it('model.test：不可达地址 → conn_status=fail（探测在事务外，结果经命令落库）', async () => {
    const r = await models.test(ids[0]!, CTX);
    expect(r.connStatus).toBe('fail');
    expect(r.detail).toMatch(/网络不可达|HTTP/);
  });

  it('Pi 网关：无路由用途 createSession → MODEL_UNAVAILABLE；停用模型不可路由', async () => {
    await expect(gateway.createSession({ projectId: 'p', purpose: 'generation' }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    await models.setRoute('generation', ids[1]!, CTX);
    await models.upsert({ id: ids[1]!, enabled: false }, CTX);
    await expect(gateway.createSession({ projectId: 'p', purpose: 'generation' }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    await models.upsert({ id: ids[1]!, enabled: true }, CTX);
    const s = await gateway.createSession({ projectId: 'p', purpose: 'generation' });
    expect(s.sessionId).toBeTruthy();
  });

  it('校验：非法 provider/purpose 拒绝', async () => {
    await expect(models.upsert({
      name: 'x', provider: 'bogus', baseUrl: 'http://x', modelCode: 'y',
    }, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(models.setRoute('bogus', null, CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
