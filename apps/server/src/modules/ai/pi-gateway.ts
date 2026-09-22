import { randomUUID } from 'node:crypto';
import { DomainError } from '@msf/shared';
import type {
  AiMessageResult,
  AiProvider,
  AiSession,
  AiUsage,
} from './ai-provider.interface.js';
import type { AiModelsService, ModelRow, Purpose } from './models.service.js';
import {
  loadAnthropicApi,
  loadOpenaiCompletionsApi,
  loadPiAi,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ThinkingLevel,
  type TranscriptContext,
  type UserMessage,
} from './pi-loader.js';

/**
 * Pi SDK 真接网关（REQ-615；锁 0.86.0）：
 * - provider=anthropic → anthropic-messages；openai/gateway → openai-completions（自定义 base_url 网关）
 * - Usage 附着消息结果（done.error 事件提取）；cost 由 pi 按 Model.cost（price_table×1000 转每 1M）计算，
 *   网关自报 0 时由 UsageCollector 按 price_table 兜底（T6-09）
 * - stop = AbortController.abort（无半截提交）；steer 消息并入下一轮 stream 的上下文
 * - 429/限流 → MODEL_RATE_LIMITED；其余供应商/网络错误 → MODEL_UNAVAILABLE
 */

export interface StreamExtra {
  /** 思考强度（三档映射 ThinkingLevel） */
  thinkLevel?: ThinkingLevel | undefined;
}

export class PiAiGateway implements AiProvider {
  constructor(private readonly models: AiModelsService) {}

  async createSession(options: { projectId: string; purpose: string }): Promise<AiSession> {
    const { row, apiKey } = await this.models.resolve(options.purpose as Purpose);
    return new PiAiSession(row, apiKey);
  }
}

/** price_table 为每 1k token 单价；pi Model.cost 为每 1M → ×1000 */
function buildModel(row: ModelRow): Model<never> {
  const price = row.price_table ?? {};
  return {
    id: row.model_code,
    name: row.name,
    api: (row.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions') as never,
    provider: row.provider as never,
    baseUrl: row.base_url,
    reasoning: row.supports_thinking,
    input: ['text'],
    cost: {
      input: (price.in ?? 0) * 1000,
      output: (price.out ?? 0) * 1000,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: row.context_window,
    maxTokens: 8192,
  };
}

function mapError(msg: AssistantMessage): DomainError {
  const m = msg.errorMessage ?? '未知供应商错误';
  if (/429|rate.?limit|quota/i.test(m)) {
    return new DomainError('MODEL_RATE_LIMITED', `模型限流：${m}`, msg.model);
  }
  return new DomainError('MODEL_UNAVAILABLE', `模型调用失败：${m}`, msg.model);
}

class PiAiSession implements AiSession {
  readonly sessionId = randomUUID();
  private controller: AbortController | null = null;
  private steered: string[] = [];

  constructor(
    private readonly row: ModelRow,
    private readonly apiKey: string | null,
  ) {}

  stream(prompt: string, extra?: StreamExtra): {
    deltas: AsyncIterable<string>;
    result: Promise<AiMessageResult>;
  } {
    let settle!: (r: AiMessageResult) => void;
    let fail!: (e: unknown) => void;
    const result = new Promise<AiMessageResult>((res, rej) => { settle = res; fail = rej; });
    result.catch(() => undefined); // 拒绝经由 deltas 迭代抛出；防 unhandled

    const deltas = (async function* (this: PiAiSession): AsyncGenerator<string> {
      try {
        const pi = await loadPiAi();
        const api = this.row.provider === 'anthropic'
          ? await loadAnthropicApi()
          : await loadOpenaiCompletionsApi();
        const messages: UserMessage[] = [
          ...this.steered.map((s): UserMessage => ({ role: 'user', content: s, timestamp: Date.now() })),
          { role: 'user', content: prompt, timestamp: Date.now() },
        ];
        this.steered = [];
        const context = pi.normalizeContext({ messages });
        this.controller = new AbortController();
        // 两 api 模块的 streamSimple 泛型实参互斥，联合类型不可直调；按 provider 分支后同形调用
        const streamSimple = api.streamSimple as unknown as (
          model: Model<never>,
          context: TranscriptContext,
          options?: Record<string, unknown>,
        ) => AsyncIterable<AssistantMessageEvent>;
        const evs = streamSimple(buildModel(this.row), context, {
          apiKey: this.apiKey ?? undefined,
          signal: this.controller.signal,
          maxRetries: 2,
          ...(extra?.thinkLevel ? { reasoning: extra.thinkLevel } : {}),
        });

        let text = '';
        let settled = false;
        for await (const ev of evs) {
          if (ev.type === 'text_delta') {
            text += ev.delta;
            yield ev.delta;
          } else if (ev.type === 'done') {
            settled = true;
            settle({ text, usage: toUsage(ev.message) });
          } else if (ev.type === 'error') {
            settled = true;
            if (ev.reason === 'aborted') {
              // stop 语义：resolve 部分结果，不抛错（接口事实：abort 时 resolve）
              settle({ text, usage: toUsage(ev.error) });
            } else {
              throw mapError(ev.error);
            }
          }
        }
        if (!settled) settle({ text, usage: { inputTokens: 0, outputTokens: 0 } });
      } catch (e) {
        const err = e instanceof DomainError
          ? e
          : /429|rate.?limit/i.test(e instanceof Error ? e.message : '')
            ? new DomainError('MODEL_RATE_LIMITED', `模型限流：${(e as Error).message}`)
            : new DomainError('MODEL_UNAVAILABLE', `模型调用失败：${e instanceof Error ? e.message : String(e)}`);
        fail(err);
        throw err;
      }
    }).call(this);

    return { deltas, result };
  }

  steer(message: string): void {
    this.steered.push(message);
  }

  stop(): void {
    this.controller?.abort();
  }
}

function toUsage(msg: AssistantMessage): AiUsage {
  const u = msg.usage;
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    ...(u.cost?.total ? { cost: u.cost.total } : {}),
  };
}
