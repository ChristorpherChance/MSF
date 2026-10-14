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
import { assembleAgentBlocks, type AssembledAgents, type ContextBand } from './agent-prompts.js';
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
  /** agentic 接力：记录每轮 stream 收到的 prompt（断言工具结果回喂） */
  onStream: ((prompt: string) => void) | null = null;
  /** 接力轮失败注入：deltas 首迭代即抛、result 拒绝（模拟网关 503 瞬断——不可重试口径） */
  fail = false;
  /** 断流注入（可重试口径：stream closed before ……命中 isRetryableStreamCut，A3 零流出安全重试用） */
  failCut = false;
  stream(prompt?: string): { deltas: AsyncIterable<string>; result: Promise<AiMessageResult> } {
    if (prompt !== undefined) this.onStream?.(prompt);
    if (this.fail || this.failCut) {
      const msg = this.failCut ? 'stream closed before response.completed' : 'boom-503 upstream auth_unavailable';
      const result = Promise.reject<AiMessageResult>(new Error(msg));
      result.catch(() => undefined);
      const deltas = (async function* (): AsyncGenerator<string> {
        throw new Error(msg);
      })();
      return { deltas, result };
    }
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
  /** agentic 接力轮次队列：首轮后每次 createSession 依序出队（空=默认两段——注意默认路径有闸会挂起，接力轮务必入队） */
  roundQueue: string[][] = [];
  /** 每轮 stream 收到的 prompt（接力轮回喂断言用） */
  capturedPrompts: string[] = [];
  /** 按 createSession 调用序的失败注入队列（首轮→接力轮依次出队） */
  failQueue: boolean[] = [];
  /** 断流注入队列（可重试口径；与 failQueue 同序出队） */
  failCutQueue: boolean[] = [];
  async createSession(): Promise<AiSession> {
    const s = new FakeSession();
    s.chunks = this.nextChunks ?? this.roundQueue.shift() ?? null;
    s.fail = this.failQueue.shift() ?? false;
    s.failCut = this.failCutQueue.shift() ?? false;
    s.onStream = (p) => this.capturedPrompts.push(p);
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
  // A6 usage 归因测试用：注册 ai.usage.record 命令（生产由模块 onModuleInit 注册）
  const { AiUsageService } = await import('./usage.service.js');
  new AiUsageService().onModuleInit();
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

  it('工件绑定（0029）：docKind 校验+按 (ctx,doc_kind) 精确分组+默认名带文档标签', async () => {
    // 合法绑定：design/hld 与 design/mod 各一组，互不相见
    const h = await sessions.create(PID, { ctx: 'design', docKind: 'hld' }, CTX) as { id: string; code: string };
    const m = await sessions.create(PID, { ctx: 'design', docKind: 'mod' }, CTX) as { id: string };
    const stageLevel = await sessions.create(PID, { ctx: 'design', name: '评审闲聊' }, CTX) as { id: string };
    const hldList = await sessions.list(PID, 'design', undefined, 20, 'hld');
    expect(hldList.items.map((x) => x.id)).toEqual([h.id]);
    expect(hldList.items[0]!.doc_kind).toBe('hld');
    expect(hldList.items[0]!.name).toContain('概要设计说明书'); // 默认名带文档标签
    const modList = await sessions.list(PID, 'design', undefined, 20, 'mod');
    expect(modList.items.map((x) => x.id)).toEqual([m.id]);
    const nullList = await sessions.list(PID, 'design', undefined, 20, null);
    expect(nullList.items.map((x) => x.id)).toEqual([stageLevel.id]); // NULL 组=阶段级会话
    // 老口径（不传 docKind）不过滤：三组全见
    const all = await sessions.list(PID, 'design');
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    // 非法：design 不接受 crd；material 不接受任何 docKind
    await expect(sessions.create(PID, { ctx: 'design', docKind: 'crd' }, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(sessions.create(PID, { ctx: 'material', docKind: 'hld' }, CTX))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // req 域同口径
    const p = await sessions.create(PID, { ctx: 'req', docKind: 'prd' }, CTX) as { id: string };
    const prdList = await sessions.list(PID, 'req', undefined, 20, 'prd');
    expect(prdList.items.some((x) => x.id === p.id)).toBe(true);
    expect(prdList.items.every((x) => x.doc_kind === 'prd')).toBe(true);
    // prompt 注入【当前工件】：绑定 hld 的会话提示词带文档名与 kind 默认值指引
    provider.capturedPrompts = [];
    provider.nextChunks = ['好的。'];
    const { messageId } = await sessions.send(PID, h.id, { content: '改一下第三章' }, CTX);
    await sessions.drive(messageId, () => {}, { ctx: CTX });
    const prompt = provider.capturedPrompts[0]!;
    expect(prompt).toContain('【当前工件】');
    expect(prompt).toContain('概要设计说明书');
    expect(prompt).toContain('kind=hld');
  });

  it('消息排序：同事务同刻的 user+ai 对，DESC 返回 ai 在前（前端 reverse 后 user 在上）', async () => {
    // ai.message.send 同事务插入 user+ai 两行，created_at 同为事务时间戳——
    // 无 tiebreaker 时 DESC 次序不确定，曾致「AI 回复压到我的问题上方」
    const s = await sessions.create(PID, { ctx: 'req', name: '排序' }, CTX) as { id: string };
    await query(
      `INSERT INTO ai_messages (session_id, role, content, status)
       VALUES ($1,'user','问题本体','done'),($1,'ai','回复本体','done')`, [s.id]);
    const msgs = await sessions.messages(PID, s.id);
    expect(msgs.items.map((m) => m.role)).toEqual(['ai', 'user']);
    expect(msgs.items[0]!.content).toBe('回复本体');
    // 与真实发送链同口径复核：send 完成后首条仍是 ai 在 DESC 首位
    await sessions.send(PID, s.id, { content: '再发一轮' }, CTX);
    await new Promise((r) => setTimeout(r, 1200)); // mock 流终结
    const after = await sessions.messages(PID, s.id);
    expect(after.items.map((m) => m.role).slice(0, 2)).toEqual(['ai', 'user']);
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

  it('W2-053 工具自主调用链 + agentic 接力：围栏块流末解析执行→结果回喂模型→同一条消息续答', async () => {
    provider.capturedPrompts = []; // 跨用例累积清零（本用例断言恰两轮：首轮+接力轮）
    provider.nextChunks = ['好的，为你打开需求页。', '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```'];
    provider.roundQueue.push(['已为你打开需求页，可直接查看。']); // 接力轮续答（无围栏→接力终止）
    const { messageId } = await sessions.send(PID, sessionId, { content: '帮我打开需求页' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as {
      content: string;
      toolCalls: Array<{ toolName: string; status: string; resultSummary: unknown }>;
    };
    // 正文剔除围栏块 + 接力轮续答并入同一条消息；工具调用挂到该消息（前端 AiContent 按 message.toolCalls 渲染工具卡）
    expect(aiMsg.content).not.toContain('msf-tool');
    expect(aiMsg.content).toContain('为你打开需求页');
    expect(aiMsg.content).toContain('已为你打开需求页，可直接查看'); // 接力轮：结果回喂后的续答
    expect(aiMsg.toolCalls.length).toBe(1);
    expect(aiMsg.toolCalls[0]!.toolName).toBe('nav.goto');
    expect(aiMsg.toolCalls[0]!.status).toBe('ok');
    expect((aiMsg.toolCalls[0]!.resultSummary as { route: string }).route).toBe('/req');
    // 接力 prompt 携带工具执行结果（模型据此回答，不再"拿到结果后我会……"）
    expect(provider.capturedPrompts.length).toBe(2);
    expect(provider.capturedPrompts[1]).toContain('nav.goto');
    expect(provider.capturedPrompts[1]).toContain('"route":"/req"');
    // 非法块/未注册工具不阻断落稿：正文保留剔除后内容，失败调用留痕 failed（失败结果同样回喂接力轮）
    provider.nextChunks = ['```msf-tool\nnot-json\n```', '尾部正文。', '```msf-tool\n{"name":"no.such"}\n```'];
    provider.roundQueue.push(['该工具不存在，已知悉。']);
    const s2 = await sessions.send(PID, sessionId, { content: '再来一次' }, CTX);
    const c2 = await sessions.drive(s2.messageId, () => {}, { ctx: CTX });
    expect(c2.status).toBe('done');
    const msgs2 = await sessions.messages(PID, sessionId);
    const aiMsg2 = msgs2.items.find((m) => m.id === s2.messageId)! as unknown as {
      content: string; toolCalls: Array<{ toolName: string; status: string }>;
    };
    expect(aiMsg2.content).toBe('尾部正文。\n\n该工具不存在，已知悉。');
    expect(aiMsg2.toolCalls.some((t) => t.toolName === 'no.such' && t.status === 'denied')).toBe(true);
  });

  it('接力轮网关失败不静默：消息内补可见提示、首轮成果与工具卡保留、接力终止不再连败', async () => {
    provider.capturedPrompts = [];
    provider.nextChunks = ['我先读取需求页内容。', '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```'];
    provider.failQueue = [false, true]; // 首轮正常、接力轮网关 503 瞬断
    const { messageId } = await sessions.send(PID, sessionId, { content: '读一下' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done'); // 首轮成功即 done（接力失败不拖垮整消息）
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as {
      content: string; toolCalls: Array<{ toolName: string; status: string }>;
    };
    // 首轮成果与工具卡保留 + 续答失败提示用户可见（2026-10-05 实机教训：失败零痕迹→用户对着开场白干等）
    expect(aiMsg.content).toContain('我先读取需求页内容');
    expect(aiMsg.content).toContain('⚠️ 续答生成失败');
    expect(aiMsg.content).toContain('请重发你的问题');
    expect(aiMsg.content).not.toContain('msf-tool');
    expect(aiMsg.toolCalls.length).toBe(1);
    expect(aiMsg.toolCalls[0]!.status).toBe('ok');
    // 恰两轮（首轮+失败的接力轮）：失败即终止，不再向故障网关连败至 3 轮上限
    expect(provider.capturedPrompts.length).toBe(2);
    provider.failQueue = [];
  });

  it('A3 接力轮零流出断流安全重试：stream cut 自动重建会话重试 1 次+notice 帧；A4 进度帧全程可见', async () => {
    provider.capturedPrompts = [];
    provider.nextChunks = ['我先读取需求页。', '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```'];
    // 首轮正常 → 接力轮断流（可重试口径，零 delta 流出）→ 重试会话正常续答
    provider.failCutQueue = [false, true, false];
    provider.roundQueue.push(['x']); // 占位给断流轮（failCut 优先于 chunks，不出队不挂闸——此条实际被断流会话持有）
    provider.roundQueue.push(['断流重试后续答完成。']); // 重试会话
    const frames: Array<{ type: string; text?: string }> = [];
    const { messageId } = await sessions.send(PID, sessionId, { content: '读一下' }, CTX);
    const c = await sessions.drive(messageId, (f) => frames.push(f as { type: string; text?: string }), { ctx: CTX });
    expect(c.status).toBe('done');
    // 三轮会话：首轮+断流接力轮+重试轮（恰 1 次重试，不连败）
    expect(provider.capturedPrompts.length).toBe(3);
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as { content: string };
    expect(aiMsg.content).toContain('断流重试后续答完成');
    expect(aiMsg.content).not.toContain('续答生成失败'); // 重试成功不留失败提示
    // A4 notice 帧：工具执行+接力轮次+断流重试三类进度用户可见
    const notices = frames.filter((f) => f.type === 'stream.notice').map((f) => f.text ?? '');
    expect(notices.some((t) => t.includes('正在执行 nav.goto'))).toBe(true);
    expect(notices.some((t) => t.includes('接力第 1 轮'))).toBe(true);
    expect(notices.some((t) => t.includes('自动重试'))).toBe(true);
    provider.failCutQueue = [];
  });

  it('A5 单轮工具块上限 6：一轮 5 块全执行不残留（原 3 块上限残留块白烧接力轮）', async () => {
    provider.capturedPrompts = [];
    const blocks = ['req', 'design', 'proto', 'dev', 'test']
      .map((t) => '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"' + t + '"}}\n```\n');
    provider.nextChunks = ['五页都看一下。', ...blocks];
    provider.roundQueue.push(['五页结果都在，给结论。']); // 接力轮收束
    const { messageId } = await sessions.send(PID, sessionId, { content: '五页巡检' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    expect(provider.capturedPrompts.length).toBe(2); // 恰一轮接力（5 块全执行，无残留触发第二轮）
    const relay = provider.capturedPrompts[1]!;
    for (const t of ['req', 'design', 'proto', 'dev', 'test']) {
      expect(relay).toContain(`"route":"/${t}"`); // 五个结果同轮回喂
    }
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as {
      content: string; toolCalls: Array<{ toolName: string; status: string }>;
    };
    expect(aiMsg.toolCalls.length).toBe(5);
    expect(aiMsg.content).toContain('五页结果都在');
  });

  it('A6 usage 归因：ai.usage.record 带 sessionId/messageId 落账，按会话可归因', async () => {
    const { executeCommand } = await import('../evidence/command-bus.js');
    const model = await query<{ id: string }>('SELECT id FROM ai_models LIMIT 1', []);
    const msg = await query<{ id: string }>(
      'SELECT id FROM ai_messages WHERE session_id=$1 LIMIT 1', [sessionId]);
    await executeCommand('ai.usage.record', {
      projectId: PID, modelId: model.rows[0]!.id, purpose: 'generation',
      tokensIn: 100, tokensOut: 50, durationMs: 10, cost: 0,
      sessionId, messageId: msg.rows[0]!.id,
    }, CTX);
    const row = await query<{ session_id: string | null; message_id: string | null }>(
      `SELECT session_id, message_id FROM ai_usage
       WHERE project_id=$1 AND purpose='generation' ORDER BY created_at DESC LIMIT 1`, [PID]);
    expect(row.rows[0]!.session_id).toBe(sessionId);
    expect(row.rows[0]!.message_id).toBe(msg.rows[0]!.id);
    // 不带归因的旧调用方（页面直发生成/委派）不受影响：NULL 落账口径不变
    await executeCommand('ai.usage.record', {
      projectId: PID, modelId: model.rows[0]!.id, purpose: 'generation',
      tokensIn: 1, tokensOut: 1, durationMs: 1, cost: 0,
    }, CTX);
    const row2 = await query<{ session_id: string | null }>(
      `SELECT session_id FROM ai_usage
       WHERE project_id=$1 AND purpose='generation' ORDER BY created_at DESC LIMIT 1`, [PID]);
    expect(row2.rows[0]!.session_id).toBeNull();
  });

  it('未闭合尾围栏容错：模型漏写收尾 ``` 时体部合法照样执行并剥离；半截 JSON 绝不执行', async () => {
    provider.capturedPrompts = [];
    // 2026-10-06 实机形态：长 JSON 后模型省略闭合 ```——闭合 RE 零命中，提案曾静默未执行
    provider.nextChunks = ['好的，为你打开需求页。', '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}']; // 无收尾 ```
    provider.roundQueue.push(['已为你打开需求页。']); // 接力轮续答
    const { messageId } = await sessions.send(PID, sessionId, { content: '打开需求页' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as {
      content: string; toolCalls: Array<{ toolName: string; status: string }>;
    };
    expect(aiMsg.content).not.toContain('msf-tool'); // 未闭合尾块同样剥离无残留
    expect(aiMsg.content).toContain('已为你打开需求页'); // 执行→回喂→接力续答全链照常
    expect(aiMsg.toolCalls.length).toBe(1);
    expect(aiMsg.toolCalls[0]!.toolName).toBe('nav.goto');
    expect(aiMsg.toolCalls[0]!.status).toBe('ok');
    // 半截 JSON（流被截断形态）：绝不执行（防半参数调用）、不崩溃、现场保留
    provider.nextChunks = ['读取中。', '\n```msf-tool\n{"name":"nav.goto","args":{"ta'];
    const s2 = await sessions.send(PID, sessionId, { content: '再来' }, CTX);
    const c2 = await sessions.drive(s2.messageId, () => {}, { ctx: CTX });
    expect(c2.status).toBe('done');
    const msgs2 = await sessions.messages(PID, sessionId);
    const aiMsg2 = msgs2.items.find((m) => m.id === s2.messageId)! as unknown as {
      content: string; toolCalls: Array<{ toolName: string }>;
    };
    expect(aiMsg2.toolCalls.length).toBe(0);
    expect(aiMsg2.content).toContain('读取中。');
  });

  it('接力工具结果跨轮累积：第 N 轮 prompt 携带此前全部轮次结果（116 实机「重写五册」根修——只回喂当轮致重复读烧轮次）', async () => {
    provider.capturedPrompts = [];
    provider.nextChunks = ['先读需求页。', '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```'];
    provider.roundQueue.push(['再读设计页。', '\n```msf-tool\n{"name":"nav.goto","args":{"tab":"design"}}\n```']); // 接力轮 1
    provider.roundQueue.push(['两页内容都在，直接给结论。']); // 接力轮 2（无围栏→终止）
    const { messageId } = await sessions.send(PID, sessionId, { content: '三轮接力' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    expect(provider.capturedPrompts.length).toBe(3); // 首轮+两轮接力
    // 接力轮 1 只见首轮结果；接力轮 2 须同时见到首轮与接力轮 1 的结果（累积在场，无需重读）
    expect(provider.capturedPrompts[1]).toContain('"route":"/req"');
    expect(provider.capturedPrompts[1]).not.toContain('"route":"/design"');
    expect(provider.capturedPrompts[2]).toContain('"route":"/req"');
    expect(provider.capturedPrompts[2]).toContain('"route":"/design"');
    expect(provider.capturedPrompts[2]).toContain('严禁重复读取同一文档');
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as { content: string; toolCalls: Array<{ toolName: string }> };
    expect(aiMsg.toolCalls.length).toBe(2);
    expect(aiMsg.content).toContain('直接给结论');
    expect(aiMsg.content).not.toContain('msf-tool');
  });

  it('接力工具结果总预算：跨轮累积超 80000 字淘汰最旧条目并明示省略（防爆窗）', async () => {
    const { registerExternalTool, resetExternalTools } = await import('../platform/external-tools.js');
    resetExternalTools();
    // Task 3 分档口径：本用例钉 wide 档（toolLog 预算 80000）——前序用例把 chat 路由换到
    // 默认 128000 窗口测试模型会落 standard（40000）；宽窗模型（≥512k）显式占路由恢复 wide。
    // 共享库护栏现成：modelIds 收尾删行 + chatHolders 快照恢复
    const wide = (await models.upsert({
      name: `wide 模型 ${randomUUID().slice(0, 8)}`, provider: 'gateway', baseUrl: 'http://127.0.0.1:9',
      modelCode: 'm', contextWindow: 1000000,
    }, CTX)).id;
    modelIds.push(wide);
    await models.setRoute('chat', wide, CTX);
    try {
      registerExternalTool('test.big', async () => ({ ok: true, payload: 'x'.repeat(30000) }));
      provider.capturedPrompts = [];
      // findToolSpans 每轮最多解析 3 块：两轮各 3 块（单结果截 16000）→ 累积 96000 字超总预算 80000，
      // 第三轮（接力轮 2）prompt 须淘汰最旧条目并带省略说明
      const three = () => Array.from({ length: 3 }, (_, i) => `${i ? '\n\n' : ''}\`\`\`msf-tool\n{"name":"test.big","args":{}}\n\`\`\``);
      provider.nextChunks = three();
      provider.roundQueue.push(three()); // 接力轮 1：再产 3 块
      provider.roundQueue.push(['收束。']); // 接力轮 2：无围栏收束
      const { messageId } = await sessions.send(PID, sessionId, { content: '大结果' }, CTX);
      const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
      expect(c.status).toBe('done');
      expect(provider.capturedPrompts.length).toBe(3);
      const relay1 = provider.capturedPrompts[1]!;
      expect(relay1).not.toContain('因上下文预算已省略'); // 首轮 3×16000 未超预算
      const relay2 = provider.capturedPrompts[2]!;
      expect(relay2).toContain('因上下文预算已省略');
      expect(relay2).toContain('test.big');
      expect(relay2.length).toBeLessThan(200000); // 预算闸生效（basePrompt+5×16000 量级，绝不 6 块全量）
    } finally {
      resetExternalTools();
    }
  });

  it('窄档 toolLog 预算 16000 生效（Task 9 补钉）：跨轮累积第二条即淘汰最旧并明示省略', async () => {
    const { registerExternalTool, resetExternalTools } = await import('../platform/external-tools.js');
    resetExternalTools();
    // 窄窗模型绑定会话（64000 < 128000 → narrow，toolLog 总预算 16000；绑定模型优先于 chat 路由）
    // 对照上一用例 wide 档 80000：同样两条 ~16000 结果 wide 不淘汰（32120<80000），narrow 必淘汰——
    // 淘汰说明出现即证明窄档预算生效
    const narrowM = (await models.upsert({
      name: `narrow-toolLog 模型 ${randomUUID().slice(0, 8)}`, provider: 'gateway', baseUrl: 'http://127.0.0.1:9',
      modelCode: 'm', contextWindow: 64000,
    }, CTX)).id;
    modelIds.push(narrowM);
    try {
      registerExternalTool('test.bign', async () => ({ ok: true, payload: 'x'.repeat(30000) }));
      const s = await sessions.create(PID, { ctx: 'req', modelId: narrowM }, CTX) as { id: string };
      provider.capturedPrompts = [];
      const one = ['```msf-tool\n{"name":"test.bign","args":{}}\n```'];
      provider.nextChunks = one; // 首轮 1 块
      provider.roundQueue.push(one); // 接力轮 1：再产 1 块 → 累积两条 ~16000
      provider.roundQueue.push(['收束。']); // 接力轮 2：无围栏收束
      const { messageId } = await sessions.send(PID, s.id, { content: '窄档大结果' }, CTX);
      const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
      expect(c.status).toBe('done');
      expect(provider.capturedPrompts.length).toBe(3);
      const relay1 = provider.capturedPrompts[1]!;
      expect(relay1).toContain('test.bign 执行结果');
      expect(relay1).toContain('结果过长已截断'); // 单结果截 16000（与预算同值，兜底保留防一条不剩）
      expect(relay1).not.toContain('因上下文预算已省略');
      const relay2 = provider.capturedPrompts[2]!;
      expect(relay2).toContain('（更早的 1 条工具结果因上下文预算已省略'); // 第二条（最旧）被 16000 预算淘汰
      expect(relay2.match(/工具 test\.bign 执行结果：/g)?.length).toBe(1); // 只留最新一条
      expect(relay2.length).toBeLessThan(60000); // 预算闸生效（basePrompt 数千字+单块 ~16000 量级）
    } finally {
      resetExternalTools();
    }
  });

  it('上下文分档透传（Task 3）：窄档会话注入精简工具块+子 Agent 精简段；doc.read 阈值按 band 取预算', async () => {
    // 窄窗模型绑定会话（64000 < 128000 → narrow；绑定模型优先于 chat 路由，设计 §2）
    const narrowM = (await models.upsert({
      name: `narrow 模型 ${randomUUID().slice(0, 8)}`, provider: 'gateway', baseUrl: 'http://127.0.0.1:9',
      modelCode: 'm', contextWindow: 64000,
    }, CTX)).id;
    modelIds.push(narrowM);
    const s = await sessions.create(PID, { ctx: 'req', docKind: 'crd', modelId: narrowM }, CTX) as { id: string };
    provider.capturedPrompts = [];
    provider.nextChunks = ['好的。'];
    const { messageId } = await sessions.send(PID, s.id, { content: '窄档探测' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    const prompt = provider.capturedPrompts[0]!;
    // 窄档工具声明=精简版（签名与纪律句保留，示例/展开段落砍掉）
    expect(prompt).toContain('【可用工具（可自主调用）】');
    expect(prompt).toContain('doc.read：读取文档正文');
    expect(prompt).not.toContain('当用户问"文档里某条怎么写的'); // FULL 版独有展开句
    // 子 Agent（req.crd）窄档只留【职责】【反模式】段；主 Agent/全局基底窄档不降全量在场
    expect(prompt).toContain('从参考资料提炼客户需求'); // 职责段
    expect(prompt).toContain('实机事故正发生在 CRD 重编号'); // 反模式段
    expect(prompt).not.toContain('先出目录大纲再逐章生成'); // 方法论段已裁
    expect(prompt).not.toContain('来源 R-* 标注齐全'); // 质量闸段已裁
    expect(prompt).toContain('需求分析师'); // req 主全量
    expect(prompt).toContain('软件工厂的全局 AI 助手'); // assistant 全量
    // doc.read 截断阈值按 band 取预算（payload 显式 band 逐跳透传，不走 args 走私）：
    // 7006 字文档——narrow cap 6000 截断给 nextOffset；wide cap 12000 不截
    const d = await query<{ id: string }>(
      'INSERT INTO req_documents (project_id, doc_kind, created_by) VALUES ($1,$2,$3) RETURNING id', [PID, 'crd', 't']);
    const ver = await query<{ id: string }>(
      `INSERT INTO req_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, submitted_by, submitted_at)
       VALUES ($1,1,$2,'fp-band','gf-band','t',now()) RETURNING id`,
      [d.rows[0]!.id, `# 长文\n\n${'长'.repeat(7000)}`]);
    await query('UPDATE req_documents SET current_version_id=$2 WHERE id=$1', [d.rows[0]!.id, ver.rows[0]!.id]);
    try {
      const rNarrow = await tools.invoke(PID, { sessionId: s.id, toolName: 'doc.read', args: { kind: 'crd' }, band: 'narrow' }, CTX);
      expect(rNarrow.result['truncated']).toBe(true);
      expect(rNarrow.result['nextOffset']).toBe(6000);
      const rWide = await tools.invoke(PID, { sessionId: s.id, toolName: 'doc.read', args: { kind: 'crd' }, band: 'wide' }, CTX);
      expect(rWide.result['truncated']).toBe(false);
    } finally {
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE id=$1', [d.rows[0]!.id]);
      await query('DELETE FROM req_versions WHERE document_id=$1', [d.rows[0]!.id]);
      await query('DELETE FROM req_documents WHERE id=$1', [d.rows[0]!.id]);
    }
  });

  it('阶段化预设+联动提醒：req 会话注入阶段职责块；CRD 新版时注入 PRD 滞后提醒', async () => {
    provider.capturedPrompts = [];
    // 联动夹具：PRD v2 早于 CRD v3（直插行，测后清理）
    const mk = async (kind: string, v: number, at: string) => {
      const d = await query<{ id: string }>(
        'INSERT INTO req_documents (project_id, doc_kind, created_by) VALUES ($1,$2,$3) RETURNING id', [PID, kind, 't']);
      const ver = await query<{ id: string }>(
        `INSERT INTO req_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, submitted_by, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [d.rows[0]!.id, v, '# x', `fp-${kind}-${v}`, `gf-${kind}-${v}`, 't', at]);
      await query('UPDATE req_documents SET current_version_id=$2 WHERE id=$1', [d.rows[0]!.id, ver.rows[0]!.id]);
    };
    try {
      await mk('prd', 2, '2026-10-01T00:00:00Z');
      await mk('crd', 3, '2026-10-02T00:00:00Z');
      const s = await sessions.create(PID, { ctx: 'req', name: '阶段预设' }, CTX) as { id: string };
      provider.nextChunks = ['好的。'];
      const { messageId } = await sessions.send(PID, s.id, { content: '你好' }, CTX);
      await sessions.drive(messageId, () => {}, { ctx: CTX });
      const prompt = provider.capturedPrompts[0]!;
      expect(prompt).toContain('【角色与方法】'); // Task 2 三层链：替代旧【阶段职责与方法】块名
      expect(prompt).toContain('需求分析师');
      expect(prompt).toContain('映射表'); // req 指南的覆盖核对方法论钉死
      expect(prompt).toContain('【联动提醒】');
      expect(prompt).toContain('CRD 已提交更新的 v3');
      expect(prompt).toContain('PRD 仍停留在 v2');
      // W4-003 口径：工具改动同步全部声明点——设计册提案通道须在工具清单与能力边界双声明
      expect(prompt).toContain('design.doc.propose_edits');
      expect(prompt).toContain('对设计八册的修改请求用 design.doc.propose_edits');
      // req 指南钉死「查出缺口主动补齐成提案」闭环
      expect(prompt).toContain('有缺口就主动补齐');
    } finally {
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    }
  });

  it('外部工具旁路：命中注册表走 handler（无事务）+ recordDirect 成功/失败两路留痕；未命中走 invoke 不变', async () => {
    const { registerExternalTool, resetExternalTools } = await import('../platform/external-tools.js');
    resetExternalTools();
    // try/finally：中途断言失败也不残留注册态（外部工具 Map 为模块级，残留会污染本进程其它用例）
    try {
      let called = 0;
      registerExternalTool('test.echo', async (_p, call) => { called += 1; return { ok: true, echo: call.args['x'] }; });
      registerExternalTool('test.boom', async () => { throw new Error('boom'); });
      provider.nextChunks = [
        '```msf-tool\n{"name":"test.echo","args":{"x":1}}\n```',
        '```msf-tool\n{"name":"test.boom","args":{}}\n```',
        '```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```',
      ];
      provider.roundQueue.push(['旁路结果已收到。']); // 接力轮（三个块均有结果回喂）
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
    } finally {
      resetExternalTools();
    }
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
      // Task 3 消重收口：buildPrompt 改收 send() 同源装配的 asm+band（私有方法直调须自装配）
      buildPrompt: (p: string, s: string, c: string, r: string[], asm: AssembledAgents, band: ContextBand) => Promise<string>;
    }).buildPrompt(PID, m.id, '本次问题', [], await assembleAgentBlocks('material', null, 'wide'), 'wide');
    expect(prompt).toContain('【他阶段会话');
    expect(prompt).toContain('[需求] ss_1');
    // 摘要注入在会话历史之前
    expect(prompt.indexOf('【他阶段会话')).toBeLessThan(prompt.indexOf('【会话历史】'));
  });
});
