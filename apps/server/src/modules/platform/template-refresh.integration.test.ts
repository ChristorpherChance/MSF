/** ⇄ 模板重排·批量编排器（集成，需 DB）：顺序执行/失败隔离/全跳过汇总/并发闸/停止 五例（fake handler；SSE 帧序与真链路端到端见 Task 4） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import {
  TemplateRefreshService, registerRefreshHandler, resetRefreshHandlers,
} from './template-refresh.service.js';

const PID = '00000000-0000-0000-0000-0000000000f1';
const PID2 = '00000000-0000-0000-0000-0000000000f2';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };
const CTX2: CommandContext = { projectId: PID2, actorKind: 'human', actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try { await query('SELECT 1 FROM req_documents LIMIT 1'); return true; } catch { return false; }
}

/** 最小夹具：文档行+当前版本行（无草稿/未定稿/无补丁 → 守卫预检放行；镜像 sessions.integration.test.ts 直插口径） */
async function seedDoc(pid: string, domain: 'req' | 'design', kind: string): Promise<void> {
  const docT = domain === 'req' ? 'req_documents' : 'dsg_documents';
  const d = domain === 'req'
    ? await query<{ id: string }>(
        'INSERT INTO req_documents (project_id, doc_kind, created_by) VALUES ($1,$2,\'t\') RETURNING id', [pid, kind])
    : await query<{ id: string }>( // dsg_documents name/chapter_prefix 非空（镜像 design docs.service ensureDoc）
        `INSERT INTO dsg_documents (project_id, doc_kind, name, chapter_prefix, created_by)
         VALUES ($1,$2,$3,$4,'t') RETURNING id`, [pid, kind, kind, 'z']);
  const v = domain === 'req'
    ? await query<{ id: string }>(
        `INSERT INTO req_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, submitted_by, submitted_at)
         VALUES ($1,1,'# x','fp','gf','t',now()) RETURNING id`, [d.rows[0]!.id])
    : await query<{ id: string }>(
        `INSERT INTO dsg_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, refs, submitted_by)
         VALUES ($1,1,'# x','fp','gf','[]','t') RETURNING id`, [d.rows[0]!.id]);
  await query(`UPDATE ${docT} SET current_version_id=$2 WHERE id=$1`, [d.rows[0]!.id, v.rows[0]!.id]);
}

/** 可控闸门：fake handler 挂起用（stop/并发闸两例的确定性来源） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('模板重排·批量编排器（集成，需 DB）', async () => {
  if (!(await infraUp())) { it.skip('postgres 未就绪', () => {}); return; }
  resetCommands();
  const svc = new TemplateRefreshService();
  svc.onModuleInit(); // 注册 template_refresh.start/.stop 两命令（测试勿直调 executeCommand——不触发 drive，waitDone 永挂）

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1,'tr-f1') ON CONFLICT (id) DO NOTHING", [PID]);
    await query("INSERT INTO projects (id, name) VALUES ($1,'tr-f2') ON CONFLICT (id) DO NOTHING", [PID2]);
  });
  afterAll(async () => {
    resetRefreshHandlers(); // 处理器注册表模块级全局，勿污染后续套件（Task 4 真处理器）
    for (const pid of [PID, PID2]) {
      for (const dom of ['req', 'dsg'] as const) {
        await query(`DELETE FROM ${dom}_pendings WHERE document_id IN (SELECT id FROM ${dom}_documents WHERE project_id=$1)`, [pid]);
        await query(`DELETE FROM ${dom}_drafts WHERE document_id IN (SELECT id FROM ${dom}_documents WHERE project_id=$1)`, [pid]);
        await query(`UPDATE ${dom}_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1`, [pid]);
        await query(`DELETE FROM ${dom}_versions WHERE document_id IN (SELECT id FROM ${dom}_documents WHERE project_id=$1)`, [pid]);
        await query(`DELETE FROM ${dom}_documents WHERE project_id=$1`, [pid]);
      }
      await query('DELETE FROM sys_notifications WHERE project_id=$1', [pid]);
      await query('DELETE FROM evd_events WHERE project_id=$1', [pid]);
      await query('DELETE FROM projects WHERE id=$1', [pid]);
    }
    await pool.end();
  });

  it('顺序执行+失败隔离：done/failed/failed 矩阵跑满三册，帧序 refresh.kind.* 起 refresh.done 收、seq 连续', async () => {
    await seedDoc(PID, 'req', 'crd');
    await seedDoc(PID, 'design', 'hld');
    await seedDoc(PID, 'design', 'db');
    resetRefreshHandlers();
    const calls: string[] = [];
    registerRefreshHandler('crd', async () => { calls.push('crd'); return { ok: true, patchCount: 1 }; });
    registerRefreshHandler('hld', async () => { calls.push('hld'); throw new Error('boom'); });
    registerRefreshHandler('db', async () => { calls.push('db'); return { ok: false, reason: 'x' }; });
    const { operationId } = await svc.start(PID, ['crd', 'hld', 'db'], CTX);
    await svc.waitDone(operationId);
    expect(calls).toEqual(['crd', 'hld', 'db']); // 失败隔离：throw 与 ok:false 均不阻断后续册
    const op = svc.get(operationId)!;
    expect(op.states.get('crd')).toMatchObject({ status: 'done' });
    expect(op.states.get('hld')).toMatchObject({ status: 'failed', reason: 'boom' });
    expect(op.states.get('db')).toMatchObject({ status: 'failed', reason: 'x' });
    expect(op.summary).toEqual({ done: 1, failed: 2, skipped: 0 });
    const types = op.events.map((e) => e.type);
    expect(types[0]).toMatch(/^refresh\.kind\./);
    expect(types[types.length - 1]).toBe('refresh.done');
    expect(op.events.map((e) => e.seq)).toEqual(types.map((_, i) => i + 1)); // seq 自 1 连续递增
  });

  it('同项目并发闸：上批未终态再发起 → INVALID_STATE；终态后放行', async () => {
    const gate = deferred<{ ok: boolean }>();
    resetRefreshHandlers();
    registerRefreshHandler('crd', () => gate.promise);
    const first = await svc.start(PID, ['crd'], CTX);
    await expect(svc.start(PID, ['crd'], CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    gate.resolve({ ok: true });
    await svc.waitDone(first.operationId);
    const second = await svc.start(PID, ['crd'], CTX); // 终态后可再发起
    await svc.waitDone(second.operationId);
    expect(svc.get(second.operationId)!.states.get('crd')!.status).toBe('done');
  });

  it('kinds 校验：空数组/越界 kind → VALIDATION_FAILED；重复 kind 去重', async () => {
    await expect(svc.start(PID, [], CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(svc.start(PID, ['xyz'], CTX)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    resetRefreshHandlers();
    registerRefreshHandler('crd', async () => ({ ok: true }));
    const { operationId } = await svc.start(PID, ['crd', 'crd'], CTX);
    await svc.waitDone(operationId);
    expect(svc.get(operationId)!.kinds).toEqual(['crd']); // 去重后单册
  });

  it('全跳过汇总：新项目全册无内容 → 预检全 skipped「未生成」，summary.done=0，终帧照发', async () => {
    resetRefreshHandlers();
    let called = 0;
    registerRefreshHandler('crd', async () => { called++; return { ok: true }; });
    const { operationId } = await svc.start(PID2, ['crd', 'hld'], CTX2);
    await svc.waitDone(operationId);
    expect(called).toBe(0); // 预检拦截，handler 不触达
    const op = svc.get(operationId)!;
    expect(op.states.get('crd')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('未生成') });
    expect(op.states.get('hld')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('未生成') });
    expect(op.summary).toEqual({ done: 0, failed: 0, skipped: 2 });
    expect(op.events.map((e) => e.type)).toEqual([
      'refresh.kind.skipped', 'refresh.kind.skipped', 'refresh.done',
    ]);
  });

  it('停止：stop 在飞册跑完前置标志，剩余册 skipped「人工停止」', async () => {
    await seedDoc(PID, 'design', 'api'); // 第二册亦备内容——验证跳过来自 stop 而非预检
    const gate = deferred<{ ok: boolean }>();
    resetRefreshHandlers();
    registerRefreshHandler('crd', () => gate.promise); // 在飞册挂起，保证 stop 先落
    const { operationId } = await svc.start(PID, ['crd', 'api'], CTX);
    await svc.stop(PID, operationId, CTX); // 经 executeCommand 落审计
    gate.resolve({ ok: true });
    await svc.waitDone(operationId);
    const op = svc.get(operationId)!;
    expect(op.states.get('crd')!.status).toBe('done'); // 当前册跑完（不中断在飞册=已知限制）
    expect(op.states.get('api')).toMatchObject({ status: 'skipped', reason: '人工停止' });
    expect(op.summary).toEqual({ done: 1, failed: 0, skipped: 1 });
  });
});
