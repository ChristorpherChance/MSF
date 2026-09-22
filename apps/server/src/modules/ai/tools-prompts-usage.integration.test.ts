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

  it('工具注册表：三件套可调用，结果落 ai_tool_calls(ok)', async () => {
    const list = tools.list();
    expect(list.tools.map((t) => t.name)).toEqual(['nav.goto', 'read_context', 'propose_next_step']);
    const nav = await tools.invoke(PID, { sessionId, toolName: 'nav.goto', args: { tab: 'dev' } }, CTX);
    expect(nav.result['route']).toBe('/dev');
    const ctx2 = await tools.invoke(PID, { sessionId, toolName: 'read_context' }, CTX);
    expect(ctx2.result).toHaveProperty('materials');
    const next = await tools.invoke(PID, { sessionId, toolName: 'propose_next_step' }, CTX);
    expect((next.result['suggestions'] as string[]).length).toBeGreaterThan(0);
    const calls = await tools.callsOfSession(PID, sessionId);
    expect(calls.items.filter((c) => c.status === 'ok').length).toBe(3);
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
    const calls = await tools.callsOfSession(PID, sessionId);
    expect(calls.items.filter((c) => c.status === 'denied').length).toBe(2);
    expect(calls.items.filter((c) => c.status === 'failed').length).toBe(2);
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
  });
});
