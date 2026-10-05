/** 对话改文档 + 增量修订归一化（集成，需 DB）：GenerateService 旁路与既有流归一化双链断言 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import type { AiMessageResult, AiProvider, AiSession } from '../ai/ai-provider.interface.js';
import { PolicyService } from '../policy/policy.service.js';
import { ReqDocsService } from './docs.service.js';
import { GenerateService, genTiming } from './generate.service.js';

const PID = '00000000-0000-0000-0000-0000000000e1';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

/** 假 pi provider：createSession 返回预置全文（kind='pi' 才走 driveReal） */
class FakePiProvider implements AiProvider {
  readonly kind = 'pi' as const;
  text = '';
  async createSession(): Promise<AiSession> {
    const text = this.text;
    return {
      sessionId: 'fake-pi',
      stream: () => ({
        deltas: (async function* () { yield text; })(),
        result: Promise.resolve({ text, usage: { inputTokens: 1, outputTokens: 1 } } satisfies AiMessageResult),
      }),
      steer: () => {},
      stop: () => {},
    };
  }
}

async function infraUp(): Promise<boolean> {
  try { await query('SELECT 1 FROM req_documents LIMIT 1'); return true; } catch { return false; }
}

describe('对话改文档/归一化（集成，需 DB）', async () => {
  if (!(await infraUp())) { it.skip('postgres 未就绪', () => {}); return; }
  genTiming.chunkDelayMs = 0;
  const docs = new ReqDocsService(new PolicyService());
  const gen = new GenerateService();
  const fakePi = new FakePiProvider();
  const genPi = new GenerateService(fakePi);
  resetCommands();
  docs.onModuleInit();
  gen.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'pe-e1') ON CONFLICT (id) DO NOTHING", [PID]);
    await docs.listDocs(PID, CTX); // provisioning 模板 v1
  });
  afterAll(async () => {
    await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_links WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_health WHERE project_id=$1', [PID]);
    await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_events WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  interface DocView { cur: number; contentFingerprint: string; modified: boolean; secs: Array<{ id: string; title: string; md: string }> }
  const view = async (kind: 'crd' | 'prd') => (await docs.getDoc(PID, kind)) as unknown as DocView;
  /** 写入两节 CR 内容并提交为新版本（清 modified，让指纹/补丁流可预期） */
  async function seedSections(): Promise<void> {
    const d = await view('crd');
    await docs.saveDraft(PID, 'crd', {
      secId: d.secs[0]!.id,
      md: '引言\n\n## CR-001 门户首页\n\n承接：R-001\n\n旧正文。\n\n## CR-002 检索\n\n承接：R-002',
      baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX);
    const d2 = await view('crd');
    await docs.commit(PID, 'crd', 'seed', d2.cur, CTX);
  }

  it('既有增量修订流挂归一化：命中 CR-001 的 AI 产出转 modify，不再重复追加', async () => {
    await seedSections();
    fakePi.text = '## CR-001 门户首页\n\n承接：R-001\n\n新正文（支持手柄）。';
    const started = await genPi.start(PID, 'crd', { referenceFileIds: [], referenceFingerprints: {}, instruction: '把 CR-001 改为支持手柄' }, CTX);
    const r = await genPi.drive(started.operationId, CTX, () => {});
    expect(r.status).toBe('done');
    const patches = (await docs.listPatches(PID, 'crd')) as {
      items: Array<{ patchId: string; type: string; secId: string; status: string }>;
    };
    const pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend).toHaveLength(1);
    expect(pend[0]!.type).toBe('modify'); // 归一化生效：非 add 重复追加
    expect(pend[0]!.secId).toBe('s1'); // T5 Minor 1：落到 CR-001 既有节（seed 口径 s0=引言/s1=CR-001/s2=CR-002）
    await docs.rejectPatch(PID, 'crd', pend[0]!.patchId, CTX, '归一化验证完毕');
  });

  it('对话改文档守卫链：未生成 → 未清补丁 → 定稿锁 全走 ok:false 人话（不落码）', async () => {
    // 未生成：用未打开过文档的新项目
    const PID2 = '00000000-0000-0000-0000-0000000000e2';
    await query("INSERT INTO projects (id, name) VALUES ($1, 'pe-e2') ON CONFLICT (id) DO NOTHING", [PID2]);
    const none = await gen.proposeEditsFromChat(PID2, 'crd', '改点什么', { ...CTX, projectId: PID2 });
    expect(none.ok).toBe(false);
    expect(none.reason).toContain('还没有内容');
    // 正常提案（mock：命中既有节=modify + 全新节=add 两形态）
    const ok = await gen.proposeEditsFromChat(PID, 'crd', '把 CR-001 改为支持手柄，并补一条验收', CTX);
    expect(ok).toEqual({ ok: true, patchCount: 2, route: '/req', kind: 'crd' }); // kind 供 dock 工具卡「前往审阅」定位页签（7572c2f 增补）
    const patches = (await docs.listPatches(PID, 'crd')) as {
      items: Array<{ patchId: string; type: string; secId: string; status: string; source: string }>;
    };
    const pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend.map((p) => p.type).sort()).toEqual(['add', 'modify']);
    expect(pend[0]!.source).toBe('ai'); // proposedBy='assistant' 同源
    // T5 Minor 1：两形态各落期望节 id（modify→CR-001=s1；全新节 add 保持 s0 锚）
    expect(pend.find((p) => p.type === 'modify')!.secId).toBe('s1');
    expect(pend.find((p) => p.type === 'add')!.secId).toBe('s0');
    // 未清补丁闸：第二批被拒（人话含数量）
    const busy = await gen.proposeEditsFromChat(PID, 'crd', '再来一条', CTX);
    expect(busy.ok).toBe(false);
    expect(busy.reason).toContain('待确认补丁');
    // 处置干净后定稿 → VERSION_LOCKED 人话
    for (const p of pend) await docs.rejectPatch(PID, 'crd', p.patchId, CTX, '守卫链验证');
    const d = await view('crd');
    await docs.finalize(PID, 'crd', d.cur, d.cur, true, CTX);
    const locked = await gen.proposeEditsFromChat(PID, 'crd', '定稿后改', CTX);
    expect(locked.ok).toBe(false);
    expect(locked.reason).toContain('已定稿');
    await docs.unlock(PID, 'crd', CTX);
    // 双链留痕：模拟编排层旁路——getExternalTool handler + recordDirect；audit_log 有 doc.propose-pending 行
    const { getExternalTool } = await import('../platform/external-tools.js');
    const { AiToolsService } = await import('../ai/tools.service.js');
    const tools = new AiToolsService();
    await query("DELETE FROM ai_sessions WHERE project_id=$1 AND code='ss_pe'", [PID]); // 预删防残留（幂等口径同 24bd2c7）
    const sid = (await query<{ id: string }>(
      `INSERT INTO ai_sessions (project_id, code, ctx, name, created_by)
       VALUES ($1,'ss_pe','req','旁路留痕','t') RETURNING id`, [PID])).rows[0]!.id;
    const auditBefore = Number((await query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE project_id=$1 AND command='doc.propose-pending'", [PID])).rows[0]!.n);
    const handler = getExternalTool('req.doc.propose_edits')!;
    const result = await handler(PID, { sessionId: sid, args: { kind: 'crd', instruction: '留痕探针' } }, CTX);
    await tools.recordDirect({ sessionId: sid, toolName: 'req.doc.propose_edits', args: { kind: 'crd' } },
      result['ok'] === false ? 'failed' : 'ok', result);
    const calls = await query<{ status: string }>(
      "SELECT status FROM ai_tool_calls WHERE session_id=$1 AND tool_name='req.doc.propose_edits'", [sid]);
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0]!.status).toBe('ok');
    const audit = await query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE project_id=$1 AND command='doc.propose-pending'", [PID]);
    expect(Number(audit.rows[0]!.n) - auditBefore).toBe(1); // 本次 handler 恰落一行（不被前序用例审计行混淆）
    // 清理本用例补丁与探针会话
    const rest = (await docs.listPatches(PID, 'crd')) as { items: Array<{ patchId: string; status: string }> };
    for (const p of rest.items.filter((x) => x.status === 'pending')) await docs.rejectPatch(PID, 'crd', p.patchId, CTX, '清理');
    await query('DELETE FROM ai_tool_calls WHERE session_id=$1', [sid]);
    await query('DELETE FROM ai_sessions WHERE id=$1', [sid]);
    await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID2]);
    await query('DELETE FROM evd_events WHERE project_id=$1', [PID2]);
    await query('DELETE FROM projects WHERE id=$1', [PID2]);
  });

  it('rewrite 模式：整篇重写产单条 replace 补丁，接受后整篇替换（删除章节的表达通道）', async () => {
    // mock 通道：整篇重写注记 + 保留全文骨架
    const ok = await gen.proposeEditsFromChat(PID, 'crd', '彻底重写', CTX, 'rewrite');
    expect(ok).toEqual({ ok: true, patchCount: 1, route: '/req', kind: 'crd' });
    let patches = (await docs.listPatches(PID, 'crd')) as {
      items: Array<{ patchId: string; type: string; secId: string; status: string; new?: string }>;
    };
    let pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend).toHaveLength(1);
    expect(pend[0]!.type).toBe('replace');
    expect(pend[0]!.secId).toBe('s0');
    expect(pend[0]!.new).toContain('mock 整篇重写');
    // 接受：整篇替换落草稿（undo 栈自带）
    await docs.acceptPatch(PID, 'crd', pend[0]!.patchId, CTX);
    let d = await view('crd');
    expect(d.secs[0]!.md).toContain('mock 整篇重写：彻底重写');
    expect(d.secs.some((s) => s.title === 'CR-001 门户首页')).toBe(true); // 骨架保留
    // undo 回基点（草稿消亡回 clean）——W2-024：草稿期接受的补丁回转 pending，须处置干净
    await docs.undo(PID, 'crd', CTX);
    d = await view('crd');
    expect(d.modified).toBe(false);
    expect(d.secs[0]!.md).not.toContain('mock 整篇重写');
    const revived = (await docs.listPatches(PID, 'crd')) as { items: Array<{ patchId: string; status: string }> };
    for (const p of revived.items.filter((x) => x.status === 'pending')) {
      await docs.rejectPatch(PID, 'crd', p.patchId, CTX, 'undo 回转处置');
    }
    // fakePi 通道：模型整篇输出 → 单条 replace（第五章消失类诉求——输出不含的节被整替删除）
    fakePi.text = '# CRD\n\n## 一、背景\n\n重写后背景。\n\n## CR-001 门户首页\n\n承接：R-001（重写）。';
    const ok2 = await genPi.proposeEditsFromChat(PID, 'crd', '重写并只保留第一章', CTX, 'rewrite');
    expect(ok2).toMatchObject({ ok: true, patchCount: 1 });
    patches = (await docs.listPatches(PID, 'crd')) as {
      items: Array<{ patchId: string; type: string; secId: string; status: string; new?: string }>;
    };
    pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend).toHaveLength(1);
    expect(pend[0]!.type).toBe('replace');
    expect(pend[0]!.new).toContain('重写后背景');
    expect(pend[0]!.new).not.toContain('CR-002'); // 模型未输出的节=删除语义
    await docs.rejectPatch(PID, 'crd', pend[0]!.patchId, CTX, 'rewrite 验证完毕');
    // mode 枚举校验（旁路 handler 层人话不落码）
    const { getExternalTool } = await import('../platform/external-tools.js');
    const handler = getExternalTool('req.doc.propose_edits')!;
    expect((await handler(PID, { args: { kind: 'crd', instruction: 'x', mode: 'bogus' } }, CTX))['ok']).toBe(false);
  });

  it('旁路 handler 参数校验：kind 枚举/instruction 必填（人话不落码）', async () => {
    const { getExternalTool } = await import('../platform/external-tools.js');
    const handler = getExternalTool('req.doc.propose_edits')!;
    expect((await handler(PID, { args: { kind: 'hld', instruction: 'x' } }, CTX))['ok']).toBe(false);
    expect((await handler(PID, { args: { kind: 'crd' } }, CTX))['ok']).toBe(false);
  });
});
