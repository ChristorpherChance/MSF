/** Agent 三层链装配集成测试（Task 2，需 DB；设计 §1）：
 *  is_current 用户版本（base_prompt+overlay_text 拼接）→ 代码基底（stage-guides DEFAULT_AGENTS）；
 *  盖戳 prompt_version_id=注入链首层用户版本 id（assistant→主→子取首个有用户版本者，全无=NULL）；
 *  input_fingerprint=sha256(三层版本 id 组合|参考指纹组合)，版本翻转即变化 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { executeCommand, resetCommands, type CommandContext } from '../evidence/command-bus.js';
import type { AiMessageResult, AiProvider, AiSession } from './ai-provider.interface.js';
import { assembleAgentBlocks, resolveAgentPrompt } from './agent-prompts.js';
import { DEFAULT_AGENTS, DEFAULT_AGENT_MAP } from './stage-guides.js';
import { AiModelsService } from './models.service.js';
import { AiPromptsService } from './prompts.service.js';
import { AiSessionsService } from './sessions.service.js';
import { AiToolsService } from './tools.service.js';
import { StreamPipeline } from './stream-pipeline.js';

const PID = '00000000-0000-0000-0000-0000000000a7';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 即时完成的假 provider：记录每轮 stream 收到的 prompt（装配内容观测口，同 sessions.integration 先例） */
class FakeProvider implements AiProvider {
  readonly kind = 'mock' as const;
  capturedPrompts: string[] = [];
  async createSession(): Promise<AiSession> {
    const captured = this.capturedPrompts;
    return {
      sessionId: randomUUID(),
      stream: (prompt: string) => {
        captured.push(prompt);
        return {
          deltas: (async function* (): AsyncGenerator<string> { yield '好。'; })(),
          result: Promise.resolve({ text: '好。', usage: { inputTokens: 1, outputTokens: 1 } } satisfies AiMessageResult),
        };
      },
      steer: () => {},
      stop: () => {},
    };
  }
}

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM ai_prompt_versions LIMIT 1');
    await query('SELECT 1 FROM ai_sessions LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('Agent 三层链装配（集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  resetCommands();
  const provider = new FakeProvider();
  const models = new AiModelsService();
  models.onModuleInit();
  const pipeline = new StreamPipeline();
  await pipeline.onModuleInit(); // Redis 可达则镜像，否则降级
  const tools = new AiToolsService();
  tools.onModuleInit();
  const sessions = new AiSessionsService(provider, models, pipeline, tools);
  sessions.onModuleInit();
  new AiPromptsService().onModuleInit(); // ai.prompt.publish 命令注册

  // 项目行（外键）
  await query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1,'agent-prompts-t','t')
     ON CONFLICT (id) DO NOTHING`, [PID]);

  // 共享库护栏：本套件会翻动名册 20 key 的 is_current——快照既有生效行、套件起点全部摘下，
  // 跑完按 id 恢复；套件内发布的版本行登记 id，afterAll 逐条删除
  // （ai_messages.prompt_version_id 有 FK，版本行删除必须在消息清理之后）
  const AGENT_KEYS = DEFAULT_AGENTS.map((a) => a.key);
  const snapshot = (await query<{ id: string }>(
    'SELECT id FROM ai_prompt_versions WHERE agent_key = ANY($1) AND is_current', [AGENT_KEYS]))
    .rows.map((r) => r.id);
  const createdVersionIds: string[] = [];
  // 护栏韧性（Task 3 收口）：afterAll 注册先于 is_current 全摘——摘行抛错也能恢复现场；
  // 恢复步骤包 try/finally（删已建版本失败不跳过快照恢复）
  afterAll(async () => {
    await query('DELETE FROM ai_usage WHERE project_id=$1', [PID]);
    await query('DELETE FROM ai_tool_calls WHERE session_id IN (SELECT id FROM ai_sessions WHERE project_id=$1)', [PID]);
    await query('DELETE FROM ai_messages WHERE session_id IN (SELECT id FROM ai_sessions WHERE project_id=$1)', [PID]);
    await query('DELETE FROM ai_sessions WHERE project_id=$1', [PID]);
    try {
      if (createdVersionIds.length > 0) {
        await query('DELETE FROM ai_prompt_versions WHERE id = ANY($1::uuid[])', [createdVersionIds]);
      }
    } finally {
      if (snapshot.length > 0) {
        await query('UPDATE ai_prompt_versions SET is_current=true WHERE id = ANY($1::uuid[])', [snapshot]);
      }
    }
    await pipeline.onModuleDestroy();
    await pool.end();
  });
  await query('UPDATE ai_prompt_versions SET is_current=false WHERE agent_key = ANY($1)', [AGENT_KEYS]);
  const publish = async (agentKey: string, basePrompt: string, overlayText?: string) => {
    const r = await executeCommand('ai.prompt.publish', {
      agentKey, agentGroup: '测试', basePrompt, ...(overlayText ? { overlayText } : {}),
    }, CTX) as { id: string; version_no: number };
    createdVersionIds.push(r.id);
    return r;
  };
  /** 发送一轮并取回 ai 消息行（盖戳）+ 首轮 prompt（装配观测） */
  const sendOnce = async (sessionId: string, content: string) => {
    const { messageId } = await sessions.send(PID, sessionId, { content }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    const m = await query<{ prompt_version_id: string | null; input_fingerprint: string | null }>(
      'SELECT prompt_version_id, input_fingerprint FROM ai_messages WHERE id=$1', [messageId]);
    return { prompt: provider.capturedPrompts[provider.capturedPrompts.length - 1]!, msg: m.rows[0]! };
  };

  it('纯基底：无用户版本时三层全量注入代码基底，盖戳 NULL', async () => {
    // 解析层：无用户版本 → 代码基底原文、versionId NULL
    const r = await resolveAgentPrompt('req');
    expect(r.versionId).toBeNull();
    expect(r.text).toBe(DEFAULT_AGENT_MAP['req']!.prompt);
    // 发送链：req/crd 会话三层块全在场（assistant 全局基底 + req 主各抽查一句 + req.crd 子块）
    const s = await sessions.create(PID, { ctx: 'req', docKind: 'crd' }, CTX) as { id: string };
    const { prompt, msg } = await sendOnce(s.id, '你好');
    expect(prompt).toContain('【全局基底】');
    expect(prompt).toContain('软件工厂的全局 AI 助手'); // assistant 基底抽查
    expect(prompt).toContain('【角色与方法】');
    expect(prompt).toContain('需求分析师'); // req 主基底抽查
    expect(prompt).toContain('映射表');
    expect(prompt).toContain('【工件专项】');
    expect(prompt).toContain('从参考资料提炼客户需求'); // req.crd 子块抽查
    // 装配序列：Agent 三块整体提前至【当前上下文】之前，其余块序列不动
    expect(prompt.indexOf('【全局基底】')).toBeLessThan(prompt.indexOf('【当前上下文】'));
    expect(prompt.indexOf('【角色与方法】')).toBeLessThan(prompt.indexOf('【当前上下文】'));
    expect(prompt.indexOf('【当前上下文】')).toBeLessThan(prompt.indexOf('【能力边界'));
    // 旧块名已退役
    expect(prompt).not.toContain('【阶段职责与方法】');
    // 盖戳：全无用户版本 → NULL；指纹 = sha256('' + '|' + 空参考指纹)
    expect(msg.prompt_version_id).toBeNull();
    expect(msg.input_fingerprint).toBe(sha256hex('|'));
  });

  it('子叠加规则：doc_kind NULL 无子块；dev 会话恒叠加 dev.coding-std', async () => {
    // 装配层：req 阶段级会话（doc_kind NULL）只有全局+主两块
    const a1 = await assembleAgentBlocks('req', null);
    expect(a1.blocks).toHaveLength(2);
    expect(a1.stampId).toBeNull();
    expect(a1.versionIds).toEqual([]);
    // design/hld 命中 design.hld 子块
    const a2 = await assembleAgentBlocks('design', 'hld');
    expect(a2.blocks).toHaveLength(3);
    expect(a2.blocks[2]).toContain('【工件专项】');
    expect(a2.blocks[2]).toContain('概要设计（HLD）专项');
    // dev：doc_kind 恒 NULL，但按名册规则恒叠加 coding-std
    const a3 = await assembleAgentBlocks('dev', null);
    expect(a3.blocks).toHaveLength(3);
    expect(a3.blocks[2]).toContain('编码规范叠加基底');
    // 发送链接线复核：dev 会话 prompt 含叠加块、不含任何 doc_kind 子块
    const s = await sessions.create(PID, { ctx: 'dev' }, CTX) as { id: string };
    const { prompt } = await sendOnce(s.id, '进度如何');
    expect(prompt).toContain('编码规范叠加基底');
    expect(prompt).not.toContain('从参考资料提炼客户需求'); // req.crd 子块不在场
    expect(prompt).not.toContain('概要设计（HLD）专项'); // design.hld 子块不在场
    // 未知名册 key：回空串、versionId NULL（容错不炸）
    const none = await resolveAgentPrompt('no.such.agent');
    expect(none.text).toBe('');
    expect(none.versionId).toBeNull();
  });

  it('用户版本接管：发布后注入用户版不含基底句；overlay 拼接；盖戳=首层用户版本 id；版本翻转指纹变化', async () => {
    const s = await sessions.create(PID, { ctx: 'req', docKind: 'crd' }, CTX) as { id: string };
    const before = await sendOnce(s.id, '发版前');
    expect(before.msg.prompt_version_id).toBeNull();

    // 发布 req 主用户版本（activate 缺省=true；首版强制生效）
    const rv = await publish('req', 'REQ-USER-BASE-V1 主版本全文标记', 'REQ-USER-OVERLAY-V1 叠加标记');
    const afterReq = await sendOnce(s.id, '发版后');
    // 装配含用户版（base+overlay 同现——overlay_text 拼接生效）、不含基底句
    expect(afterReq.prompt).toContain('REQ-USER-BASE-V1 主版本全文标记');
    expect(afterReq.prompt).toContain('REQ-USER-OVERLAY-V1 叠加标记');
    expect(afterReq.prompt).not.toContain('需求分析师');
    // 未发版的层仍是代码基底：assistant 全局基底 + req.crd 子块在场
    expect(afterReq.prompt).toContain('软件工厂的全局 AI 助手');
    expect(afterReq.prompt).toContain('从参考资料提炼客户需求');
    // 盖戳=注入链首层用户版本 id（assistant 无用户版本 → req 版本）；指纹=版本 id 组合
    expect(afterReq.msg.prompt_version_id).toBe(rv.id);
    expect(afterReq.msg.input_fingerprint).toBe(sha256hex(`${rv.id}|`));
    expect(afterReq.msg.input_fingerprint).not.toBe(before.msg.input_fingerprint);

    // 发布 assistant 用户版本 → 首层上移，盖戳跟到 assistant；req 层版本仍并入指纹
    const av = await publish('assistant', 'ASSISTANT-USER-BASE-V1 全局基底标记');
    const afterA = await sendOnce(s.id, '全局发版后');
    expect(afterA.prompt).toContain('ASSISTANT-USER-BASE-V1 全局基底标记');
    expect(afterA.prompt).not.toContain('软件工厂的全局 AI 助手'); // 用户版接管全局基底
    expect(afterA.prompt).toContain('REQ-USER-BASE-V1 主版本全文标记');
    expect(afterA.msg.prompt_version_id).toBe(av.id);
    expect(afterA.msg.input_fingerprint).toBe(sha256hex(`${av.id}|${rv.id}|`));

    // 版本翻转（req 发 v2 摘旧挂新）：盖戳仍是首层 assistant 不变，指纹随版本组合变化
    const rv2 = await publish('req', 'REQ-USER-BASE-V2 主版本全文标记');
    const afterV2 = await sendOnce(s.id, 'req 二版后');
    expect(afterV2.prompt).toContain('REQ-USER-BASE-V2');
    expect(afterV2.prompt).not.toContain('REQ-USER-BASE-V1');
    expect(afterV2.msg.prompt_version_id).toBe(av.id);
    expect(afterV2.msg.input_fingerprint).toBe(sha256hex(`${av.id}|${rv2.id}|`));
    expect(afterV2.msg.input_fingerprint).not.toBe(afterA.msg.input_fingerprint);
  });
});
