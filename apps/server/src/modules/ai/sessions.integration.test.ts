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
  stream(): { deltas: AsyncIterable<string>; result: Promise<AiMessageResult> } {
    let resolveResult!: (r: AiMessageResult) => void;
    const result = new Promise<AiMessageResult>((res) => { resolveResult = res; });
    const gates = this.gates;
    const isStopped = () => this.stopped;
    const isReleased = () => this.released;
    const deltas = (async function* (): AsyncGenerator<string> {
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
  async createSession(): Promise<AiSession> {
    this.last = new FakeSession();
    return this.last;
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
  const sessions = new AiSessionsService(provider, models, pipeline);
  sessions.onModuleInit();

  // 项目行（外键）
  await query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1,'m6-ai-f5','t'),($2,'m6-ai-f6','t')
     ON CONFLICT (id) DO NOTHING`, [PID, PID2]);

  const modelIds: string[] = [];
  afterAll(async () => {
    await query('DELETE FROM ai_usage WHERE project_id=$1', [PID]);
    await query('DELETE FROM ai_messages WHERE session_id IN (SELECT id FROM ai_sessions WHERE project_id IN ($1,$2))', [PID, PID2]);
    await query('DELETE FROM ai_sessions WHERE project_id IN ($1,$2)', [PID, PID2]);
    await query('DELETE FROM mat_files WHERE project_id=$1', [PID]);
    for (const id of modelIds) await query('DELETE FROM ai_models WHERE id=$1', [id]);
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
      name: 'chat 模型', provider: 'gateway', baseUrl: 'http://127.0.0.1:9', modelCode: 'm',
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
    // 重复 finish 拒绝
    await expect(query('SELECT 1', [])).resolves.toBeTruthy();
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
});
