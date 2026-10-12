import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { config } from '../../config.js';
import type { AiSession, AiUsage } from './ai-provider.interface.js';
import type { ContextBand } from './agent-prompts.js';

/**
 * 流式管线（DSG-D08-2/3；A08-4；REQ-603/606）：
 * - 进程内注册表口径（任务分解 M6 注②）：运行态条目含 AiSession 句柄、事件滚动窗、订阅者
 * - pause/resume = 平台缓冲层（不委托 Pi）；stop = abort（终态 stopped 带部分内容，无半截提交）
 * - Redis 滚动窗镜像（ai:stream:{messageId} 列表，≤200 帧，1h 过期）：断线 lastEventId 重放；
 *   Redis 不可达时降级为纯进程内窗（不阻断主流）
 */

export interface StreamFrame {
  seq: number;
  /** stream.notice（2026-10-11）：进度提示帧（工具执行/接力轮次/自动重试）——进滚动窗+Redis 镜像可重放，前端状态行滚动呈现 */
  type: 'stream.delta' | 'stream.done' | 'stream.error' | 'stream.notice';
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

/**
 * 上游偶发断流判定（2026-10-09 公网实机：CPA 长流 4411 delta 后偶发 closed before
 * response.completed，重试即过；直连压测两种 API 各 100s+ 长流均完整收尾）。
 * 命中=传输层断流，值得整轮重发；限流/鉴权/配额错误重试无意义且放大成本，明确排除。
 * 调用方纪律：有界（生成路径各 1 次自动重试），重试须发 stream.notice 不静默。
 */
export function isRetryableStreamCut(raw: string): boolean {
  if (/429|rate.?limit|quota|401|403|unauthorized|invalid api key|forbidden/i.test(raw)) return false;
  return /stream closed before|disconnected before completion|premature close|socket hang up|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|other side closed|network|timed? ?out/i.test(raw);
}

/**
 * 非 SSE 内部调用断流重试（2026-10-11 A2）：嵌套提案（propose_edits pi 通道，单册 3~8 分钟）
 * 是全链最长单次裸奔调用——命中 isRetryableStreamCut 自动整轮重发 1 次（与三处 driveReal 同口径）。
 * 有界不静默：重试 console.warn 留痕；非断流错误（限流/鉴权/配额）原样上抛。
 */
export async function withStreamCutRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (!isRetryableStreamCut(raw)) throw e;
    console.warn(`[ai] ${label} 断流，自动重试 1 次：${raw.slice(0, 200)}`);
    return await fn();
  }
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
  /** 首轮 thinkLevel——接力轮（agentic loop）沿用同一推理档位 */
  thinkLevel?: string | undefined;
  /** 断流重试用会话工厂（2026-10-11 A3）：零流出断流重建会话重发；缺省（测试直注册）则无重试 */
  makeSession?: (() => Promise<AiSession>) | undefined;
  /** 上下文预算分档（Task 3）：send() 按会话模型 context_window 分档后随注册传入；
   *  缺省（测试直注册/旧调用方）= wide——工具回喂预算与 doc.read 阈值走现状常量口径 */
  band?: ContextBand | undefined;
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
    makeSession?: (() => Promise<AiSession>) | undefined;
    band?: ContextBand | undefined;
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
    e.thinkLevel = extra.thinkLevel;
    void (async () => {
      let content = '';
      let usage: AiUsage | undefined;
      let retried = false;
      for (;;) {
        const { deltas, result } = e.ai.stream(e.prompt, { thinkLevel: extra.thinkLevel as never });
        result.catch(() => null); // 失败经 deltas 迭代抛出，此处仅防 unhandled
        try {
          for await (const d of deltas) {
            content += d;
            this.emit(e, { seq: 0, type: 'stream.delta', data: { text: d } });
            if (e.paused) await this.waitResume(e);
          }
          const r = await result.catch(() => null);
          usage = r?.usage;
          await this.finish(e, { status: e.stopped ? 'stopped' : 'done', content, ...(usage ? { usage } : {}) }, onFinish);
          return;
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          // A3 零流出安全重试（2026-10-11）：断流发生在任何 delta 流出之前 → 整轮重发无重复文本风险，
          // 重建会话自动重试 1 次（有界不静默：stream.notice + console.warn）；已有流出则维持
          // 「保留已流出+failed」纪律（已广播 delta 无法回收）
          if (!retried && content === '' && !e.stopped && e.makeSession && isRetryableStreamCut(raw)) {
            retried = true;
            console.warn(`[ai] stream cut before any delta, retrying once messageId=${messageId}: ${raw.slice(0, 200)}`);
            try {
              e.ai = await e.makeSession();
            } catch (e2) {
              const raw2 = e2 instanceof Error ? e2.message : String(e2);
              console.error(`[ai] retry session rebuild failed messageId=${messageId}: ${raw2}`);
              await this.finish(e, {
                status: 'failed', content: '',
                error: classifyAiError(raw2), errorMessage: sanitizeAiError(raw2),
              }, onFinish);
              return;
            }
            this.emitNotice(messageId, '上游连接瞬断，已自动重试 1 次');
            continue;
          }
          // W2-002：后端日志留痕（原静默无日志）；DomainError 保留其闭集码，原始供应商错误归类+脱敏
          console.error(`[ai] stream failed messageId=${messageId}: ${raw}`);
          await this.finish(e, {
            status: 'failed', content,
            error: err instanceof DomainError ? err.code : classifyAiError(raw),
            errorMessage: sanitizeAiError(raw),
            ...(usage ? { usage } : {}),
          }, onFinish);
          return;
        }
      }
    })();
  }

  /**
   * 接力轮（agentic loop）：首轮回复带工具围栏时，工具执行结果回喂模型后继续生成——
   * 同一条消息内换新供应商会话接着流式输出（delta 走同一滚动窗/暂停缓冲/订阅广播，
   * 前端无感衔接）；stop 打击切换到当前轮会话，thinkLevel 沿用首轮档位。
   * 仅在 run 的 onFinish 内、终帧广播前调用（条目未 done）。
   */
  async runContinuation(
    messageId: string,
    ai: AiSession,
    prompt: string,
    /** A3 零流出安全重试：接力轮断流时尚零 delta 流出则重建会话重发 1 次（同 run 口径） */
    makeSession?: () => Promise<AiSession>,
  ): Promise<{ content: string; usage?: AiUsage; stopped: boolean; failed?: string }> {
    const e = this.get(messageId);
    let cur = ai;
    e.ai = cur; // stop/pause 作用于当前轮会话
    let content = '';
    let failed: string | undefined;
    let retried = false;
    for (;;) {
      const roundContentStart = content.length;
      const { deltas, result } = cur.stream(prompt, { thinkLevel: e.thinkLevel as never });
      result.catch(() => null);
      try {
        for await (const d of deltas) {
          content += d;
          this.emit(e, { seq: 0, type: 'stream.delta', data: { text: d } });
          if (e.paused) await this.waitResume(e);
        }
        const r = await result.catch(() => null);
        return { content, ...(r?.usage ? { usage: r.usage } : {}), stopped: e.stopped };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // 本轮零流出断流 → 重建会话重试 1 次（无重复文本风险）；已有流出则保留+failed 提示不回收
        if (!retried && content.length === roundContentStart && !e.stopped && makeSession && isRetryableStreamCut(raw)) {
          retried = true;
          console.warn(`[ai] continuation cut before any delta, retrying once messageId=${messageId}: ${raw.slice(0, 200)}`);
          try {
            cur = await makeSession();
            e.ai = cur;
          } catch (e2) {
            failed = sanitizeAiError(e2 instanceof Error ? e2.message : String(e2));
            console.error(`[ai] continuation retry session rebuild failed messageId=${messageId}: ${failed}`);
            break;
          }
          this.emitNotice(messageId, '续答连接瞬断，已自动重试 1 次');
          continue;
        }
        // 接力轮流失败：保留已流出部分，由调用方决定以现有内容终结（不再抛——首轮成果已可用）。
        // 但绝不能静默——2026-10-05 实机曾整轮失败零痕迹（回复只剩开场白），排查无据；
        // failed 回传调用方，由其在消息内补用户可见的续答失败提示
        failed = sanitizeAiError(raw);
        console.error(`[ai] continuation stream failed messageId=${messageId}: ${failed}`);
        break;
      }
    }
    return { content, stopped: e.stopped, ...(failed ? { failed } : {}) };
  }

  /** 进度提示帧（A4：工具执行/接力轮次/自动重试用户可见）——进滚动窗+Redis 镜像，重放同口径 */
  emitNotice(messageId: string, text: string): void {
    const e = this.peek(messageId);
    if (!e || e.done) return;
    this.emit(e, { seq: 0, type: 'stream.notice', data: { text: text.slice(0, 200) } });
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
