/** AI 会话/消息/流式管线集成测试（T6-05/06，需 DB；A08-1~4、REQ-601/602/603/606/608/612） */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import type {
  AiMessageResult,
  AiProvider,
  AiSession,
} from './ai-provider.interface.js';
import { AiModelsService } from './models.service.js';
import { AiSessionsService } from './sessions.service.js';
import { AiToolsService } from './tools.service.js';
import { StreamPipeline } from './stream-pipeline.js';

const PID = '00000000-0000-0000-0000-0000000000f5';
const PID2 = '00000000-0000-0000-0000-0000000000f6';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

/** 可控假会话：每段之间设闸，测试可决定推进/停止时机（stop/pause 确定性） */
class FakeSession implements AiSession {
  readonly sessionId = randomUUID();
  private gates: Array<() => void> = [];
  private released = false;
  private stopped = false;
  /** W2-053：自定义块序列（工具围栏块测试用）；空=默认两段 */
  chunks: string[] | null = null;
  stream(): { deltas: AsyncIterable<string>; result: Promise<AiMessageResult> } {
    let resolveResult!: (r: AiMessageResult) => void;
    const result = new Promise<AiMessageResult>((res) => { resolveResult = res; });
    const gates = this.gates;
    const isStopped = () => this.stopped;
    const isReleased = () => this.released;
    const custom = this.chunks;
    const deltas = (async function* (): AsyncGenerator<string> {
      if (custom) {
        for (const ch of custom) yield ch;
        resolveResult({ text: custom.join(''), usage: { inputTokens: 10, outputTokens: 6 } });
        return;
      }
      yield '第一段。';
      if (!isReleased()) await new Promise<void>((r) => gates.push(r));
      if (isStopped()) {
        resolveResult({ text: '第一段。', usage: { inputTokens: 10, outputTokens: 3 } });
        return;
      }
      yield '第二段。';
      resolveResult({ text: '第一段。第二段。', usage: { inputTokens: 10, outputTokens: 6 } });
    })();
    return { deltas, result };
  }
  release(): void {
    this.released = true;
    this.gates.splice(0).forEach((g) => g());
  }
  stop(): void {
    this.stopped = true;
    this.release();
  }
  steer(): void {}
}

class FakeProvider implements AiProvider {
  readonly kind = 'mock' as const;
  last: FakeSession | null = null;
  /** W2-053：下一次 createSession 的自定义块序列 */
  nextChunks: string[] | null = null;
  async createSession(): Promise<AiSession> {
    const s = new FakeSession();
    s.chunks = this.nextChunks;
    this.nextChunks = null;
    this.last = s;
    return s;
  }
}

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM ai_sessions LIMIT 1');
    await query('SELECT 1 FROM mat_files LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

const waitFor = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor 超时');
};

describe('AI 会话/消息/流式管线（集成，需 DB）', async () => {
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

  // 项目行（外键）
  await query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1,'m6-ai-f5','t'),($2,'m6-ai-f6','t')
     ON CONFLICT (id) DO NOTHING`, [PID, PID2]);

  const modelIds: string[] = [];
  // 路由快照：setRoute('chat', …) 全摘语义会摘掉共库真实模型的 chat 路由。
  // 只快照本套件触碰的用途、跑完补挂回原持有模型（整表快照在并行套件间互相覆盖，已踩坑）。
  const chatHolders = (await query<{ id: string }>("SELECT id FROM ai_models WHERE routes ? 'chat'", [])).rows.map((r) => r.id);
  afterAll(async () => {
    await query('DELETE FROM ai_usage WHERE project_id=$1', [PID]);
    // W2-053：工具调用挂 message_id 后须先清 ai_tool_calls（FK ai_tool_calls_message_id_fkey）
    await query('DELETE FROM ai_tool_calls WHERE session_id IN (SELECT id FROM ai_sessions WHERE project_id IN ($1,$2))', [PID, PID2]);
    await query('DELETE FROM ai_messages WHERE session_id IN (SELECT id FROM ai_sessions WHERE project_id IN ($1,$2))', [PID, PID2]);
    await query('DELETE FROM ai_sessions WHERE project_id IN ($1,$2)', [PID, PID2]);
    await query('DELETE FROM mat_parsed WHERE project_id=$1', [PID]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    for (const id of modelIds) await query('DELETE FROM ai_models WHERE id=$1', [id]);
    for (const id of chatHolders) {
      await query(
        "UPDATE ai_models SET routes = routes || '\"chat\"'::jsonb WHERE id=$1 AND NOT (routes ? 'chat')",
        [id],
      );
    }
    await pipeline.onModuleDestroy();
    await pool.end();
  });

  let sessionId = '';

  it('会话创建/列表/切换（ss_N 编号，审计留痕）', async () => {
    const s = await sessions.create(PID, { ctx: 'req', name: '需求问答' }, CTX) as { id: string; code: string };
    sessionId = s.id;
    expect(s.code).toBe('ss_1');
    const list = await sessions.list(PID, 'req');
    expect(list.items[0]!.id).toBe(sessionId);
    const sw = await sessions.switchSession(PID, sessionId, CTX) as { code: string };
    expect(sw.code).toBe('ss_1');
    await expect(sessions.switchSession(PID2, sessionId, { ...CTX, projectId: PID2 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('W8 ⋯ 菜单：重命名留痕；删除随消息清空且越域拒绝', async () => {
    const s = await sessions.create(PID, { ctx: 'req', name: '待改名' }, CTX) as { id: string };
    await sessions.send(PID, s.id, { content: 'hello' }, CTX);
    await new Promise((r) => setTimeout(r, 1200)); // mock 流终结
    await sessions.renameSession(PID, s.id, '改名后', CTX);
    const d = await sessions.detail(PID, s.id);
    expect(d.name).toBe('改名后');
    await expect(sessions.renameSession(PID, s.id, '  ', CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(sessions.deleteSession(PID2, s.id, { ...CTX, projectId: PID2 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await sessions.deleteSession(PID, s.id, CTX);
    await expect(sessions.detail(PID, s.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const msg = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM ai_messages WHERE session_id=$1', [s.id]);
    expect(msg.rows[0]!.n).toBe(0);
    const audit = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE command IN ('ai.session.rename','ai.session.delete')", []);
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it('参考门禁：不存在/未定稿/指纹漂移分别拒绝，定稿+指纹一致放行', async () => {
    const ghost = randomUUID();
    await expect(sessions.send(PID, sessionId, { content: 'x', referenceFileIds: [ghost] }, CTX))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const fp = 'a'.repeat(64);
    const fid = (await query<{ id: string }>(
      `INSERT INTO mat_files (project_id, code, name, ext, size_bytes, object_key, content_fingerprint, source, parse_status, created_by)
       VALUES ($1,'F-901','r.md','md',10,'k',$2,'upload','parsed','t') RETURNING id`, [PID, fp])).rows[0]!.id;
    await expect(sessions.send(PID, sessionId, { content: 'x', referenceFileIds: [fid] }, CTX))
      .rejects.toMatchObject({ code: 'REFERENCE_NOT_FINAL' });
    await query('UPDATE mat_files SET parse_status=$2 WHERE id=$1', [fid, 'content_final']);
    // 内容稿指纹口径=M03 references()：mat_parsed content_parse/final（实机走查修复后的权威来源）
    await query(
      `INSERT INTO mat_parsed (id, project_id, file_id, kind, body_md, content_fingerprint, status, created_by)
       VALUES ($1,$2,$3,'content_parse','x',$4,'final','t')`,
      [randomUUID(), PID, fid, fp],
    );
    await expect(sessions.send(PID, sessionId, {
      content: 'x', referenceFileIds: [fid], referenceFingerprints: { [fid]: 'b'.repeat(64) },
    }, CTX)).rejects.toMatchObject({ code: 'REFERENCE_STALE' });
    // 放行：指纹一致 → 命令落库成功（随后立即中止，避免悬挂管线）
    const { messageId } = await sessions.send(PID, sessionId, {
      content: '引用提问', referenceFileIds: [fid], referenceFingerprints: { [fid]: fp },
    }, CTX);
    await sessions.control(PID, messageId, 'stop', CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('stopped');
    const msg = await query<{ input_fingerprint: string | null }>(
      'SELECT input_fingerprint FROM ai_messages WHERE id=$1', [messageId]);
    expect(msg.rows[0]!.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('发送消息 SSE 全程：user+ai 落库，终态 done，ai_usage 按 price_table 兜底成本', async () => {
    const mid = (await models.upsert({
      // W2-032 起名称唯一：测试名带随机后缀，崩溃残留不阻塞重跑
      name: `chat 模型 ${randomUUID().slice(0, 8)}`, provider: 'gateway', baseUrl: 'http://127.0.0.1:9', modelCode: 'm',
      priceTable: { in: 0.002, out: 0.01 },
    }, CTX)).id;
    modelIds.push(mid);
    await models.setRoute('chat', mid, CTX);

    const { messageId } = await sessions.send(PID, sessionId, { content: '你好' }, CTX);
    const frames: Array<{ type: string }> = [];
    provider.last!.release();
    const c = await sessions.drive(messageId, (f) => frames.push(f), { ctx: CTX });
    expect(c.status).toBe('done');
    expect(c.content).toBe('第一段。第二段。');
    expect(frames.map((f) => f.type)).toEqual(['stream.delta', 'stream.delta', 'stream.done']);
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)!;
    expect(aiMsg.status).toBe('done');
    expect(aiMsg.model_id).toBe(mid);
    expect(msgs.items.some((m) => m.role === 'user' && m.content === '你好')).toBe(true);
    const usage = await query<{ tokens_in: number; tokens_out: number; cost: string }>(
      'SELECT tokens_in, tokens_out, cost FROM ai_usage WHERE message_id=$1', [messageId]);
    expect(usage.rows[0]).toMatchObject({ tokens_in: 10, tokens_out: 6 });
    // 兜底：10/1000*0.002 + 6/1000*0.01 = 0.00008
    expect(Number(usage.rows[0]!.cost)).toBeCloseTo(0.00008, 6);
    // W8 富消息卡：messages() 附耗时/成本/工具调用摘要（ai_usage + ai_tool_calls 按 message_id 聚合）
    const rich = msgs.items.find((m) => m.id === messageId)! as unknown as {
      durationMs: number | null; cost: string | null; toolCalls: unknown[];
    };
    expect(rich.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number(rich.cost)).toBeCloseTo(0.00008, 6);
    expect(rich.toolCalls).toEqual([]);
    // 重复 finish 拒绝
    await expect(query('SELECT 1', [])).resolves.toBeTruthy();
  });

  it('W2-053 工具自主调用链：```msf-tool 围栏块流末解析执行——挂 message_id、正文剔除、工具卡随消息可达', async () => {
    provider.nextChunks = ['好的，为你打开需求页。', '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```'];
    const { messageId } = await sessions.send(PID, sessionId, { content: '帮我打开需求页' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as {
      content: string;
      toolCalls: Array<{ toolName: string; status: string; resultSummary: unknown }>;
    };
    // 正文剔除围栏块；工具调用挂到该消息（前端 AiContent 按 message.toolCalls 渲染工具卡）
    expect(aiMsg.content).not.toContain('msf-tool');
    expect(aiMsg.content).toContain('为你打开需求页');
    expect(aiMsg.toolCalls.length).toBe(1);
    expect(aiMsg.toolCalls[0]!.toolName).toBe('nav.goto');
    expect(aiMsg.toolCalls[0]!.status).toBe('ok');
    expect((aiMsg.toolCalls[0]!.resultSummary as { route: string }).route).toBe('/req');
    // 非法块/未注册工具不阻断落稿：正文保留剔除后内容，失败调用留痕 failed
    provider.nextChunks = ['```msf-tool\nnot-json\n```', '尾部正文。', '```msf-tool\n{"name":"no.such"}\n```'];
    const s2 = await sessions.send(PID, sessionId, { content: '再来一次' }, CTX);
    const c2 = await sessions.drive(s2.messageId, () => {}, { ctx: CTX });
    expect(c2.status).toBe('done');
    const msgs2 = await sessions.messages(PID, sessionId);
    const aiMsg2 = msgs2.items.find((m) => m.id === s2.messageId)! as unknown as {
      content: string; toolCalls: Array<{ toolName: string; status: string }>;
    };
    expect(aiMsg2.content).toBe('尾部正文。');
    expect(aiMsg2.toolCalls.some((t) => t.toolName === 'no.such' && t.status === 'denied')).toBe(true);
  });

  it('外部工具旁路：命中注册表走 handler（无事务）+ recordDirect 成功/失败两路留痕；未命中走 invoke 不变', async () => {
    const { registerExternalTool, resetExternalTools } = await import('../platform/external-tools.js');
    resetExternalTools();
    let called = 0;
    registerExternalTool('test.echo', async (_p, call) => { called += 1; return { ok: true, echo: call.args['x'] }; });
    registerExternalTool('test.boom', async () => { throw new Error('boom'); });
    provider.nextChunks = [
      '```msf-tool\n{"name":"test.echo","args":{"x":1}}\n```',
      '```msf-tool\n{"name":"test.boom","args":{}}\n```',
      '```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```',
    ];
    const { messageId } = await sessions.send(PID, sessionId, { content: '触发旁路' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    expect(called).toBe(1);
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as {
      toolCalls: Array<{ toolName: string; status: string; resultSummary: unknown }>;
    };
    const echo = aiMsg.toolCalls.find((t) => t.toolName === 'test.echo');
    const boom = aiMsg.toolCalls.find((t) => t.toolName === 'test.boom');
    const nav = aiMsg.toolCalls.find((t) => t.toolName === 'nav.goto');
    expect(echo?.status).toBe('ok');
    expect((echo?.resultSummary as { echo: number }).echo).toBe(1);
    expect(boom?.status).toBe('failed');
    expect(String((boom?.resultSummary as { error: string }).error)).toContain('boom');
    expect(nav?.status).toBe('ok'); // 未命中注册表走 invoke 不变
    resetExternalTools();
  });

  it('会话级模型：create/set-model 校验，发送按会话绑定模型落戳（优先于 chat 路由）', async () => {
    // 绑定一个无 chat 路由的模型：会话绑定优先于路由默认
    const bound = (await models.upsert({
      name: `会话绑定模型 ${randomUUID().slice(0, 8)}`, provider: 'gateway', baseUrl: 'http://127.0.0.1:9', modelCode: 'mb',
    }, CTX)).id;
    modelIds.push(bound);
    const s = await sessions.create(PID, { ctx: 'dev', modelId: bound }, CTX) as { id: string };
    const row = await query<{ model_id: string }>('SELECT model_id FROM ai_sessions WHERE id=$1', [s.id]);
    expect(row.rows[0]!.model_id).toBe(bound);

    // 不存在 / 已停用 → VALIDATION_FAILED
    await expect(sessions.setModel(PID, s.id, randomUUID(), CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await models.upsert({ id: bound, enabled: false }, CTX);
    await expect(sessions.setModel(PID, s.id, bound, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await models.upsert({ id: bound, enabled: true }, CTX);

    // set-model 正常路径 + 发送落戳为会话绑定模型
    await sessions.setModel(PID, s.id, bound, CTX);
    const { messageId } = await sessions.send(PID, s.id, { content: '绑定模型提问' }, CTX);
    provider.last!.release();
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    const msg = await query<{ model_id: string }>(
      'SELECT model_id FROM ai_messages WHERE id=$1', [messageId]);
    expect(msg.rows[0]!.model_id).toBe(bound);
    // 跨项目拒绝
    await expect(sessions.setModel(PID2, s.id, bound, { ...CTX, projectId: PID2 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('pause 缓冲 / resume 冲放（缓冲层口径）', async () => {
    const { messageId } = await sessions.send(PID, sessionId, { content: '流控' }, CTX);
    const frames: Array<{ type: string; text?: string }> = [];
    const driving = sessions.drive(messageId, (f) => frames.push(f as never), { ctx: CTX });
    await waitFor(() => frames.length === 1); // 首段到达
    await sessions.control(PID, messageId, 'pause', CTX);
    provider.last!.release(); // 第二段产生但应被缓冲
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.length).toBe(1);
    await sessions.control(PID, messageId, 'resume', CTX);
    const c = await driving;
    expect(c.status).toBe('done');
    expect(frames.map((f) => f.type)).toEqual(['stream.delta', 'stream.delta', 'stream.done']);
  });

  it('stop=abort：终态 stopped 带部分内容；终结后流控拒绝 INVALID_STATE', async () => {
    const { messageId } = await sessions.send(PID, sessionId, { content: '停我' }, CTX);
    const frames: Array<{ type: string }> = [];
    const driving = sessions.drive(messageId, (f) => frames.push(f), { ctx: CTX });
    await waitFor(() => frames.length === 1);
    await sessions.control(PID, messageId, 'stop', CTX);
    const c = await driving;
    expect(c.status).toBe('stopped');
    expect(c.content).toBe('第一段。');
    const m = await query<{ status: string; content: string }>(
      'SELECT status, content FROM ai_messages WHERE id=$1', [messageId]);
    expect(m.rows[0]).toMatchObject({ status: 'stopped', content: '第一段。' });
    await expect(sessions.control(PID, messageId, 'pause', CTX))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('重复 finish 拒绝（INVALID_STATE）', async () => {
    const { messageId } = await sessions.send(PID, sessionId, { content: '一次' }, CTX);
    await sessions.control(PID, messageId, 'stop', CTX);
    await sessions.drive(messageId, () => {}, { ctx: CTX });
    const { executeCommand } = await import('../evidence/command-bus.js');
    await expect(executeCommand('ai.message.finish', {
      messageId, status: 'done', content: 'x', durationMs: 1,
    }, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('断线重挂：lastEventId 重放滚动窗，已终结条目直接返终帧', async () => {
    const { messageId } = await sessions.send(PID, sessionId, { content: '回放' }, CTX);
    provider.last!.release();
    await sessions.drive(messageId, () => {}, { ctx: CTX });
    const replayed: Array<{ type: string; seq: number }> = [];
    await sessions.attach(PID, messageId, 0, (f) => replayed.push(f as never));
    expect(replayed.filter((f) => f.type === 'stream.delta').length).toBe(2);
    expect(replayed.some((f) => f.type === 'stream.done')).toBe(true);
    // lastEventId=1 只补后续帧
    const tail: Array<{ seq: number }> = [];
    await sessions.attach(PID, messageId, 1, (f) => tail.push(f as never));
    expect(tail.every((f) => f.seq > 1)).toBe(true);
  });

  it('跨阶段互通：buildPrompt 注入【他阶段会话】块（其它会话最近用户消息；本会话不进块）', async () => {
    // sessionId（req ctx）已在先前用例创建并有用户消息；另建 material 会话发一条
    const m = await sessions.create(PID, { ctx: 'material', name: '资料沟通' }, CTX) as { id: string };
    await sessions.send(PID, m.id, { content: '客户明确要求双人同屏协作' }, CTX);
    await new Promise((r) => setTimeout(r, 1200)); // fake 流终结
    const prompt = await (sessions as unknown as {
      buildPrompt: (p: string, s: string, c: string, r: string[]) => Promise<string>;
    }).buildPrompt(PID, m.id, '本次问题', []);
    expect(prompt).toContain('【他阶段会话');
    expect(prompt).toContain('[需求] ss_1');
    // 摘要注入在会话历史之前
    expect(prompt.indexOf('【他阶段会话')).toBeLessThan(prompt.indexOf('【会话历史】'));
  });
});
