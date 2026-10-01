import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { config } from '../../config.js';
import type { AiSession, AiUsage } from './ai-provider.interface.js';

/**
 * 流式管线（DSG-D08-2/3；A08-4；REQ-603/606）：
 * - 进程内注册表口径（任务分解 M6 注②）：运行态条目含 AiSession 句柄、事件滚动窗、订阅者
 * - pause/resume = 平台缓冲层（不委托 Pi）；stop = abort（终态 stopped 带部分内容，无半截提交）
 * - Redis 滚动窗镜像（ai:stream:{messageId} 列表，≤200 帧，1h 过期）：断线 lastEventId 重放；
 *   Redis 不可达时降级为纯进程内窗（不阻断主流）
 */

export interface StreamFrame {
  seq: number;
  type: 'stream.delta' | 'stream.done' | 'stream.error';
  data: Record<string, unknown>;
}

export interface PipelineCompletion {
  status: 'done' | 'stopped' | 'failed';
  content: string;
  usage?: AiUsage;
  error?: string;
  /** 失败原因人话（脱敏截断；W2-002：error 帧带 message、失败行落库） */
  errorMessage?: string;
}

/** W2-002：原始供应商错误归类到闭集码（401/网络不可达→MODEL_UNAVAILABLE；429→MODEL_RATE_LIMITED） */
export function classifyAiError(raw: string): string {
  if (/429|rate.?limit/i.test(raw)) return 'MODEL_RATE_LIMITED';
  if (/401|403|unauthorized|invalid api key|forbidden/i.test(raw)) return 'MODEL_UNAVAILABLE';
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|fetch failed|network|socket|timed? ?out/i.test(raw)) return 'MODEL_UNAVAILABLE';
  return 'INTERNAL';
}

/** 脱敏：去密钥样 token + 压空白 + 截断（本地单用户部署，仍需防密钥回显到消息/帧） */
export function sanitizeAiError(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(api[-_ ]?key|token|authorization|bearer)\s*[:=]?\s*\S+/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

interface PipelineEntry {
  messageId: string;
  sessionId: string;
  projectId: string;
  ai: AiSession;
  prompt: string;
  paused: boolean;
  stopped: boolean;
  buffer: StreamFrame[];
  events: StreamFrame[];
  subscribers: Set<(f: StreamFrame) => void>;
  completion: Promise<PipelineCompletion>;
  resolveCompletion: (c: PipelineCompletion) => void;
  done: boolean;
  resumed: (() => void) | null;
  started: boolean;
}

const WINDOW = 200;

interface RedisLike {
  rpush(key: string, v: string): Promise<unknown>;
  ltrim(key: string, a: number, b: number): Promise<unknown>;
  expire(key: string, s: number): Promise<unknown>;
  lrange(key: string, a: number, b: number): Promise<string[]>;
  quit(): Promise<unknown>;
}

@Injectable()
export class StreamPipeline implements OnModuleInit, OnModuleDestroy {
  private entries = new Map<string, PipelineEntry>();
  private redis: RedisLike | null = null;

  async onModuleInit(): Promise<void> {
    try {
      const { Redis } = await import('ioredis');
      const r = new Redis(config.redisUrl, {
        lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 0,
      }) as unknown as RedisLike & { connect(): Promise<void> };
      await r.connect();
      this.redis = r;
    } catch {
      this.redis = null; // 降级进程内窗（注②）
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  /** 注册条目（send 命令落库后调用） */
  register(init: {
    messageId: string; sessionId: string; projectId: string;
    ai: AiSession; prompt: string;
  }): void {
    let resolveCompletion!: (c: PipelineCompletion) => void;
    const completion = new Promise<PipelineCompletion>((res) => { resolveCompletion = res; });
    this.entries.set(init.messageId, {
      ...init,
      paused: false, stopped: false, buffer: [], events: [], subscribers: new Set(),
      completion, resolveCompletion, done: false, resumed: null, started: false,
    });
  }

  get(messageId: string): PipelineEntry {
    const e = this.entries.get(messageId);
    if (!e) throw new DomainError('NOT_FOUND', '流式操作不存在或已终结', messageId);
    return e;
  }

  peek(messageId: string): PipelineEntry | undefined {
    return this.entries.get(messageId);
  }

  subscribe(messageId: string, fn: (f: StreamFrame) => void): () => void {
    const e = this.get(messageId);
    e.subscribers.add(fn);
    return () => e.subscribers.delete(fn);
  }

  pause(messageId: string): void {
    this.get(messageId).paused = true;
  }

  resume(messageId: string): void {
    const e = this.get(messageId);
    e.paused = false;
    for (const f of e.buffer) this.broadcast(e, f);
    e.buffer = [];
    e.resumed?.();
    e.resumed = null;
  }

  /** stop = abort：供应商流中断，驱动循环以部分内容终结（stopped） */
  stop(messageId: string): void {
    const e = this.get(messageId);
    e.stopped = true;
    e.ai.stop();
  }

  /**
   * 驱动供应商流（幂等：仅首次调用生效）。每帧入滚动窗+Redis 镜像；pause 期缓冲不广播。
   * 终结时经 onFinish 回调落库（ai.message.finish），随后广播终帧并 resolve completion。
   */
  run(
    messageId: string,
    extra: { thinkLevel?: string | undefined },
    onFinish: (c: PipelineCompletion) => Promise<void>,
  ): void {
    const e = this.get(messageId);
    if (e.started) return;
    e.started = true;
    void (async () => {
      const { deltas, result } = e.ai.stream(e.prompt, { thinkLevel: extra.thinkLevel as never });
      result.catch(() => null); // 失败经 deltas 迭代抛出，此处仅防 unhandled
      let content = '';
      let usage: AiUsage | undefined;
      try {
        for await (const d of deltas) {
          content += d;
          this.emit(e, { seq: 0, type: 'stream.delta', data: { text: d } });
          if (e.paused) await this.waitResume(e);
        }
        const r = await result.catch(() => null);
        usage = r?.usage;
        await this.finish(e, { status: e.stopped ? 'stopped' : 'done', content, ...(usage ? { usage } : {}) }, onFinish);
      } catch (err) {
        // W2-002：后端日志留痕（原静默无日志）；DomainError 保留其闭集码，原始供应商错误归类+脱敏
        const raw = err instanceof Error ? err.message : String(err);
        console.error(`[ai] stream failed messageId=${messageId}: ${raw}`);
        await this.finish(e, {
          status: 'failed', content,
          error: err instanceof DomainError ? err.code : classifyAiError(raw),
          errorMessage: sanitizeAiError(raw),
          ...(usage ? { usage } : {}),
        }, onFinish);
      }
    })();
  }

  private emit(e: PipelineEntry, frame: StreamFrame): void {
    this.record(e, frame);
    if (e.paused) e.buffer.push(frame);
    else this.broadcast(e, frame);
  }

  /** 入滚动窗 + Redis 镜像（终帧同路径，保证重放含 stream.done/error） */
  private record(e: PipelineEntry, frame: StreamFrame): void {
    frame.seq = e.events.length + 1;
    e.events.push(frame);
    if (e.events.length > WINDOW) e.events.shift();
    if (this.redis) {
      const key = `ai:stream:${e.messageId}`;
      void this.redis.rpush(key, JSON.stringify(frame))
        .then(() => this.redis!.ltrim(key, -WINDOW, -1))
        .then(() => this.redis!.expire(key, 3600))
        .catch(() => undefined);
    }
  }

  private broadcast(e: PipelineEntry, f: StreamFrame): void {
    for (const sub of e.subscribers) sub(f);
  }

  private waitResume(e: PipelineEntry): Promise<void> {
    if (!e.paused) return Promise.resolve();
    return new Promise((res) => { e.resumed = res; });
  }

  private async finish(
    e: PipelineEntry,
    c: PipelineCompletion,
    onFinish: (c: PipelineCompletion) => Promise<void>,
  ): Promise<void> {
    try {
      await onFinish(c);
    } finally {
      e.done = true;
      // W2-002：error 帧带脱敏 message（原只带 code，「401 Invalid API key」类细节被吞）
      const terminal: StreamFrame = c.status === 'failed'
        ? { seq: 0, type: 'stream.error', data: { code: c.error ?? 'INTERNAL', message: c.errorMessage ?? c.error ?? 'INTERNAL' } }
        : { seq: 0, type: 'stream.done', data: { status: c.status } };
      this.record(e, terminal);
      this.broadcast(e, terminal);
      e.resolveCompletion(c);
    }
  }

  /** lastEventId 重放：进程内窗优先（同进程最新）；条目已不在注册表时读 Redis 镜像 */
  async replay(messageId: string, lastEventId: number): Promise<StreamFrame[]> {
    const e = this.entries.get(messageId);
    if (e) return e.events.filter((f) => f.seq > lastEventId);
    if (this.redis) {
      try {
        const raw = await this.redis.lrange(`ai:stream:${messageId}`, 0, -1);
        return raw.map((s) => JSON.parse(s) as StreamFrame).filter((f) => f.seq > lastEventId);
      } catch { /* 退化为空 */ }
    }
    return [];
  }
}
