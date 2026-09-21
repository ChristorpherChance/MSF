import { randomUUID } from 'node:crypto';
import type {
  AiMessageResult,
  AiProvider,
  AiSession,
  AiUsage,
} from './ai-provider.interface.js';

/**
 * M08 mock 实现（M0~M5 默认）：可控流式输出，接口形态与 Pi 真接一致。
 * Usage 附着消息结果返回（对齐 Pi 事实），便于计量链路先行落库。
 */
export class MockAiProvider implements AiProvider {
  async createSession(options: { projectId: string; purpose: string }): Promise<AiSession> {
    return new MockAiSession(options);
  }
}

class MockAiSession implements AiSession {
  readonly sessionId = randomUUID();
  private stopped = false;
  private steered: string[] = [];

  constructor(private readonly options: { projectId: string; purpose: string }) {}

  stream(prompt: string): { deltas: AsyncIterable<string>; result: Promise<AiMessageResult> } {
    const text = this.compose(prompt);
    const chunks = text.match(/.{1,24}/gs) ?? [];
    let resolveResult!: (r: AiMessageResult) => void;
    const result = new Promise<AiMessageResult>((res) => (resolveResult = res));
    const deltas = (async function* (this: MockAiSession) {
      let sent = 0;
      for (const c of chunks) {
        if (this.stopped) break;
        sent += c.length;
        yield c;
      }
      const usage: AiUsage = {
        inputTokens: Math.ceil(prompt.length / 2),
        outputTokens: Math.ceil(sent / 2),
      };
      resolveResult({ text: text.slice(0, sent), usage });
    }).call(this);
    return { deltas, result };
  }

  steer(message: string): void {
    this.steered.push(message);
  }

  stop(): void {
    this.stopped = true;
  }

  private compose(prompt: string): string {
    const extra = this.steered.length ? `\n\n（含 ${this.steered.length} 条注入消息）` : '';
    return `# mock 生成稿\n\n目的：${this.options.purpose}\n\n基于输入（${prompt.length} 字符）生成的占位文档。M6 真接 Pi SDK 后由真实模型产出。${extra}`;
  }
}
