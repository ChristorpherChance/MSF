/** ToolBridge / PromptRegistry / UsageCollector 集成测试（T6-07/08/09，需 DB；A08-5/6/7/10） */
import { afterAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { AiModelsService } from './models.service.js';
import { AiPromptsService } from './prompts.service.js';
import { AiToolsService } from './tools.service.js';
import { AiUsageService } from './usage.service.js';

const PID = '00000000-0000-0000-0000-0000000000f7';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM ai_tool_calls LIMIT 1');
    await query('SELECT 1 FROM ai_prompt_versions LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('AI 工具桥/提示词/用量（集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  resetCommands();
  const tools = new AiToolsService();
  tools.onModuleInit();
  const prompts = new AiPromptsService();
  prompts.onModuleInit();
  const usage = new AiUsageService();
  const models = new AiModelsService();
  models.onModuleInit();

  await query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1,'m6-tools-f7','t') ON CONFLICT (id) DO NOTHING`,
    [PID]);
  const sessionId = (await query<{ id: string }>(
    `INSERT INTO ai_sessions (project_id, code, ctx, name, created_by)
     VALUES ($1,'ss_t1','req','工具测试','t') RETURNING id`, [PID])).rows[0]!.id;

  const modelIds: string[] = [];
  afterAll(async () => {
    await query('DELETE FROM ai_tool_calls WHERE session_id=$1', [sessionId]);
    await query('DELETE FROM ai_prompt_versions WHERE agent_key LIKE $1', ['t6_%']);
    await query('DELETE FROM ai_sessions WHERE id=$1', [sessionId]);
    await query('DELETE FROM ai_usage WHERE purpose=$1', ['t6_usage']);
    for (const id of modelIds) await query('DELETE FROM ai_models WHERE id=$1', [id]);
    await pool.end();
  });

  it('工具注册表：六件套可调用，结果落 ai_tool_calls(ok)', async () => {
    const list = tools.list();
    expect(list.tools.map((t) => t.name)).toEqual([
      'nav.goto', 'read_context', 'doc.read', 'chat.history.read', 'propose_next_step', 'req.doc.propose_edits',
    ]);
    const nav = await tools.invoke(PID, { sessionId, toolName: 'nav.goto', args: { tab: 'dev' } }, CTX);
    expect(nav.result['route']).toBe('/dev');
    const ctx2 = await tools.invoke(PID, { sessionId, toolName: 'read_context' }, CTX);
    expect(ctx2.result).toHaveProperty('materials');
    // W5-001：doc.read——空项目如实 found:false（不抛错，ok 留痕）
    const doc = await tools.invoke(PID, { sessionId, toolName: 'doc.read', args: { kind: 'prd' } }, CTX);
    expect(doc.result).toMatchObject({ kind: 'prd', found: false });
    const next = await tools.invoke(PID, { sessionId, toolName: 'propose_next_step' }, CTX);
    expect((next.result['suggestions'] as string[]).length).toBeGreaterThan(0);
    const calls = await tools.callsOfSession(PID, sessionId);
    expect(calls.items.filter((c) => c.status === 'ok').length).toBe(4);
  });

  it('doc.read 根修（5.1 看不到）：草稿优先+界面编号注入+anchor 定向读+sections 清单', async () => {
    // 预删防残留（UNIQUE(project_id, doc_kind)）
    await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('UPDATE req_documents SET current_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    const docId = (await query<{ id: string }>(
      `INSERT INTO req_documents (project_id, doc_kind, created_by) VALUES ($1,'crd','t') RETURNING id`, [PID])).rows[0]!.id;
    const vContent = ['# CRD', '', '## 一、背景与目标', '', '背景。', '',
      '## 二、功能需求', '', '引言。', '', '## CR-001 浏览器即开即玩', '', '承接：R-001 旧文。'].join('\n');
    const vid = (await query<{ id: string }>(
      `INSERT INTO req_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, submitted_by)
       VALUES ($1,1,$2,'fp','gfp','t') RETURNING id`, [docId, vContent])).rows[0]!.id;
    await query('UPDATE req_documents SET current_version_id=$2 WHERE id=$1', [docId, vid]);
    // 草稿含版本没有的尾部新节（模拟「截断+只读当前稿」看不到的场景）
    const draft = `${vContent}\n\n## 五、待确认事项\n\n待确认表。\n\n## CR-015 免登录双人游戏\n\n承接：R-015 细则（仅草稿）。`;
    await query(
      `INSERT INTO req_drafts (document_id, base_version_id, base_content_fingerprint, content, created_by)
       VALUES ($1,$2,'fp',$3,'t')`, [docId, vid, draft]);
    try {
      // ① 全文读：草稿优先（版本没有的 CR-015 可见）+ 界面编号注入 + modified 标记 + sections 清单
      const full = await tools.invoke(PID, { sessionId, toolName: 'doc.read', args: { kind: 'crd' } }, CTX);
      expect(full.result['found']).toBe(true);
      expect(full.result['modified']).toBe(true);
      expect(String(full.result['content'])).toContain('R-015 细则（仅草稿）'); // 草稿优先
      expect(String(full.result['content'])).toContain('## 2.1 浏览器即开即玩（CR-001）'); // 界面编号注入
      expect(full.result['sections']).toContain('3.1 免登录双人游戏（CR-015）');
      // ② anchor 定向读：编号「3.1」命中草稿尾部节（修复前 12000 截断+无编号双落空）
      const anchored = await tools.invoke(PID, { sessionId, toolName: 'doc.read', args: { kind: 'crd', anchor: '3.1' } }, CTX);
      expect(anchored.result['anchorFound']).toBe(true);
      expect(anchored.result['sectionTitle']).toBe('3.1 免登录双人游戏（CR-015）');
      expect(String(anchored.result['content'])).toContain('仅草稿');
      // 大章序 + 锚点码两形态
      const ch = await tools.invoke(PID, { sessionId, toolName: 'doc.read', args: { kind: 'crd', anchor: '第三章' } }, CTX);
      expect(ch.result['sectionTitle']).toBe('五、待确认事项');
      const code = await tools.invoke(PID, { sessionId, toolName: 'doc.read', args: { kind: 'crd', anchor: 'CR-001' } }, CTX);
      expect(code.result['sectionTitle']).toBe('2.1 浏览器即开即玩（CR-001）');
      // ③ 未命中：anchorFound:false 人话 + sections 清单自助重试（不落码）
      const miss = await tools.invoke(PID, { sessionId, toolName: 'doc.read', args: { kind: 'crd', anchor: '9.9' } }, CTX);
      expect(miss.result['anchorFound']).toBe(false);
      expect(String(miss.result['message'])).toContain('9.9');
    } finally {
      await query('DELETE FROM req_drafts WHERE document_id=$1', [docId]);
      await query('UPDATE req_documents SET current_version_id=NULL WHERE id=$1', [docId]);
      await query('DELETE FROM req_versions WHERE document_id=$1', [docId]);
      await query('DELETE FROM req_documents WHERE id=$1', [docId]);
    }
  });

  it('chat.history.read：按编号读他会话消息（项目守卫/limit 封顶/不存在人话）', async () => {
    // 造目标会话 + 两条 done 消息
    // 预删防残留：此前失败轮可能留下 ss_t9 撞唯一约束
    const stale = await query<{ id: string }>(
      'SELECT id FROM ai_sessions WHERE project_id=$1 AND code=$2', [PID, 'ss_t9']);
    for (const r of stale.rows) {
      await query('DELETE FROM ai_messages WHERE session_id=$1', [r.id]);
      await query('DELETE FROM ai_sessions WHERE id=$1', [r.id]);
    }
    const target = (await query<{ id: string }>(
      `INSERT INTO ai_sessions (project_id, code, ctx, name, created_by)
       VALUES ($1,'ss_t9','material','资料深读','t') RETURNING id`, [PID])).rows[0]!.id;
    // 两条独立事务：created_at DEFAULT now()=事务时间戳，同事务插入会同刻、次序退化为随机 id 排序（flaky）
    await query(
      `INSERT INTO ai_messages (session_id, role, content, status) VALUES ($1,'user','客户要双人同屏','done')`, [target]);
    await query(
      `INSERT INTO ai_messages (session_id, role, content, status) VALUES ($1,'ai','已记录','done')`, [target]);
    const r = await tools.invoke(PID, { sessionId, toolName: 'chat.history.read', args: { sessionCode: 'ss_t9' } }, CTX);
    expect(r.result['found']).toBe(true);
    const msgs = r.result['messages'] as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'ai']); // 时间正序
    expect(msgs[0]!.content).toBe('客户要双人同屏');
    // limit 封顶 50 不报错；不存在会话 → found:false 人话（不抛码）
    const cap = await tools.invoke(PID, { sessionId, toolName: 'chat.history.read', args: { sessionCode: 'ss_t9', limit: 999 } }, CTX);
    expect(cap.result['found']).toBe(true);
    const none = await tools.invoke(PID, { sessionId, toolName: 'chat.history.read', args: { sessionCode: 'ss_nope' } }, CTX);
    expect(none.result['found']).toBe(false);
    expect(String(none.result['message'])).toContain('ss_nope');
    await query('DELETE FROM ai_messages WHERE session_id=$1', [target]);
    await query('DELETE FROM ai_sessions WHERE id=$1', [target]);
  });

  it('越界工具 denied 留痕 + TOOL_DENIED；未注册 TOOL_UNREGISTERED；参数错 TOOL_ARGS_INVALID', async () => {
    await expect(tools.invoke(PID, { sessionId, toolName: 'req.doc.finalize' }, CTX))
      .rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await expect(tools.invoke(PID, { sessionId, toolName: 'no.such.tool' }, CTX))
      .rejects.toMatchObject({ code: 'TOOL_UNREGISTERED' });
    await expect(tools.invoke(PID, { sessionId, toolName: 'nav.goto', args: {} }, CTX))
      .rejects.toMatchObject({ code: 'TOOL_ARGS_INVALID' });
    await expect(tools.invoke(PID, { sessionId, toolName: 'nav.goto', args: { tab: 'bogus' } }, CTX))
      .rejects.toMatchObject({ code: 'TOOL_ARGS_INVALID' });
    // W5-001：doc.read kind 枚举闭集（prototype 册不开放正文直读）
    await expect(tools.invoke(PID, { sessionId, toolName: 'doc.read', args: { kind: 'prototype' } }, CTX))
      .rejects.toMatchObject({ code: 'TOOL_ARGS_INVALID' });
    const calls = await tools.callsOfSession(PID, sessionId);
    expect(calls.items.filter((c) => c.status === 'denied').length).toBe(2);
    expect(calls.items.filter((c) => c.status === 'failed').length).toBe(3);
  });

  it('提示词发布/版本/回滚（is_current 单点）', async () => {
    const v1 = await prompts.publish({ agentKey: 't6_assistant', basePrompt: 'v1 提示词' }, CTX) as
      { id: string; version_no: number };
    expect(v1.version_no).toBe(1);
    const v2 = await prompts.publish({
      agentKey: 't6_assistant', basePrompt: 'v2 提示词', overlayText: '叠加', kind: 'std',
    }, CTX) as { version_no: number };
    expect(v2.version_no).toBe(2);
    const agents = await prompts.agents();
    const cur = agents.items.find((a) => a.agent_key === 't6_assistant')!;
    expect(cur.version_no).toBe(2);
    expect(cur.kind).toBe('std');
    await prompts.rollback('t6_assistant', 1, CTX);
    const after = await prompts.agents();
    expect(after.items.find((a) => a.agent_key === 't6_assistant')!.version_no).toBe(1);
    const versions = await prompts.versions('t6_assistant');
    expect(versions.items.length).toBe(2);
    // 审计留痕
    const audit = await query<{ command: string }>(
      'SELECT command FROM audit_log WHERE command LIKE $1 ORDER BY seq', ['ai.prompt.%']);
    expect(audit.rows.map((r) => r.command)).toContain('ai.prompt.rollback');
  });

  it('提示词校验：空 basePrompt / 不存在版本拒绝', async () => {
    await expect(prompts.publish({ agentKey: 't6_x', basePrompt: '  ' }, CTX))
      .rejects.toMatchObject({ code: 'PROMPT_VERSION_INVALID' });
    await expect(prompts.rollback('t6_assistant', 99, CTX))
      .rejects.toMatchObject({ code: 'PROMPT_VERSION_INVALID' });
  });

  it('W7 提示词版本：name 落库；重命名；当前生效版不可删、切换后可删', async () => {
    await prompts.publish({ agentKey: 't6_w7p', basePrompt: '基底', overlayText: 'A' }, CTX);
    await prompts.publish({ agentKey: 't6_w7p', basePrompt: '基底', overlayText: 'B', name: '定制版' }, CTX);
    let vers = (await prompts.versions('t6_w7p')).items;
    expect(vers.find((v) => v.version_no === 2)!.name).toBe('定制版');
    expect(vers.find((v) => v.version_no === 1)!.name).toBe('版本 1'); // 默认命名
    // 重命名
    await prompts.rename('t6_w7p', 1, '初版微调', CTX);
    vers = (await prompts.versions('t6_w7p')).items;
    expect(vers.find((v) => v.version_no === 1)!.name).toBe('初版微调');
    // 当前生效版（v2）不可删
    await expect(prompts.remove('t6_w7p', 2, CTX))
      .rejects.toMatchObject({ code: 'PROMPT_VERSION_INVALID' });
    // 切回 v1 后 v2 可删
    await prompts.rollback('t6_w7p', 1, CTX);
    await prompts.remove('t6_w7p', 2, CTX);
    vers = (await prompts.versions('t6_w7p')).items;
    expect(vers.length).toBe(1);
    const audit = await query<{ command: string }>(
      "SELECT command FROM audit_log WHERE command IN ('ai.prompt.rename','ai.prompt.delete')", []);
    expect(audit.rows.map((r) => r.command)).toEqual(
      expect.arrayContaining(['ai.prompt.rename', 'ai.prompt.delete']));
  });

  it('用量：项目明细 + 跨项目汇总（price_table 成本已在写入侧落列）', async () => {
    const mid = (await models.upsert({
      name: 't6 用量模型', provider: 'gateway', baseUrl: 'http://127.0.0.1:9', modelCode: 'mu',
    }, CTX)).id;
    modelIds.push(mid);
    await query(
      `INSERT INTO ai_usage (project_id, model_id, purpose, tokens_in, tokens_out, duration_ms, cost)
       VALUES ($1,$2,'t6_usage',100,50,800,0.001),($1,$2,'t6_usage',200,80,900,0.002)`,
      [PID, mid]);
    const page = await usage.ofProject(PID, { purpose: 't6_usage' });
    expect(page.items.length).toBe(2);
    expect(Number(page.totals!.tokens_in)).toBeGreaterThanOrEqual(300);
    const sum = await usage.summary();
    const row = sum.items.find((r) => r.purpose === 't6_usage')!;
    expect(Number(row.tokens_out)).toBe(130);
    expect(Number(row.cost)).toBeCloseTo(0.003, 6);
    await expect(usage.assertProject('00000000-0000-0000-0000-000000000099'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    // breakdown：分上下文/分会话/总量三视图（dock 统计面板数据源）
    // ss_t1 会话（ctx=req）挂 1 行会话用量 + 2 行无会话用量（t6_usage，ctx 落 null 桶）
    await query('DELETE FROM ai_usage WHERE project_id=$1 AND purpose=$2', [PID, 'chat']); // 预删防上轮残留
    await query(
      `INSERT INTO ai_usage (project_id, session_id, model_id, purpose, tokens_in, tokens_out, duration_ms, cost)
       VALUES ($1,$2,$3,'chat',10,5,100,0.0001)`, [PID, sessionId, mid]);
    const bd = await usage.breakdown(PID);
    expect(Number(bd.totals!.calls)).toBeGreaterThanOrEqual(3);
    const reqCtx = bd.byCtx.find((r) => r.ctx === 'req')!;
    expect(Number(reqCtx.tokens_in)).toBe(10);
    const nullCtx = bd.byCtx.find((r) => r.ctx === null)!; // 文档生成等直落账（session_id NULL）
    expect(Number(nullCtx.tokens_in)).toBe(300);
    const sess = bd.bySession.find((r) => r.session_id === sessionId)!;
    expect(sess.code).toBe('ss_t1');
    expect(Number(sess.tokens_out)).toBe(5);
    await query('DELETE FROM ai_usage WHERE project_id=$1 AND purpose=$2', [PID, 'chat']);
  });

  it('req.doc.propose_edits：list 可见 kind=propose；误入 invoke 路径防御性失败留痕（旁路未接线）', async () => {
    // 顺序约束：本用例必须保持在 describe 末尾——前置用例对 ai_tool_calls 按状态精确计数
    // （ok=4 / denied=2 / failed=3），本用例会再落 ok+failed 行，提前插入会污染计数
    const meta = tools.list().tools.find((t) => t.name === 'req.doc.propose_edits');
    expect(meta?.kind).toBe('propose');
    // 防御分支：正常路径经外部注册表旁路，invoke 直接命中=旁路未接线 → ok:false 人话（不落稿）
    const r = await tools.invoke(PID, { sessionId, toolName: 'req.doc.propose_edits', args: { kind: 'crd', instruction: 'x' } }, CTX);
    expect((r.result as { ok: boolean }).ok).toBe(false);
    expect(String((r.result as { reason: string }).reason)).toContain('旁路');
    // recordDirect 旁路留痕：pool 直插同 INSERT 口径
    await tools.recordDirect({ sessionId, toolName: 'req.doc.propose_edits', args: { kind: 'crd' } }, 'failed', { error: '探针' });
    const rows = await tools.callsOfSession(PID, sessionId);
    expect(rows.items.some((c) => c.tool_name === 'req.doc.propose_edits'
      && c.status === 'failed'
      && String((c.result_summary as { error?: string }).error).includes('探针'))).toBe(true);
  });
});
