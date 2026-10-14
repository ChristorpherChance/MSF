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
 * purpose='reflection'（Agent 反思通道，设计 §4）产固定样例：报告 + 一条 req 主 Agent 修订提案。
 * purpose='review'（设计自检评审通道，设计覆盖检测 §1）产固定复核意见 JSON（fail 倾向一句话）。
 */
export class MockAiProvider implements AiProvider {
  readonly kind = 'mock' as const;

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
    if (this.options.purpose === 'reflection') return REFLECTION_SAMPLE;
    if (this.options.purpose === 'review') return REVIEW_SAMPLE;
    const extra = this.steered.length ? `\n\n（含 ${this.steered.length} 条注入消息）` : '';
    return `# mock 生成稿\n\n目的：${this.options.purpose}\n\n基于输入（${prompt.length} 字符）生成的占位文档。M6 真接 Pi SDK 后由真实模型产出。${extra}`;
  }
}

/** 自检评审通道固定样例（设计覆盖检测 §1，集成测试断言锚点）：fail 倾向一句话复核意见 */
const REVIEW_SAMPLE = JSON.stringify({
  verdict: 'fail',
  comment: '看似无需求依据：本节未回引任何 REQ 编号，疑为过度设计，请人工复核其需求来源（mock 复核意见）',
});

/** 反思通道固定样例（集成测试断言锚点）：markdown 报告 + 一条 req 主 Agent 整篇修订提案 */
const REFLECTION_SAMPLE = JSON.stringify({
  report: '# 🪞 反思报告（mock）\n\n- 窗口内消息量正常，工具误用率低。\n- req 主 Agent 补丁采纳率偏低，建议收紧单条提案粒度。',
  proposals: [
    {
      agentKey: 'req',
      name: '反思改进 20261013',
      summary: '提案采纳率偏低：收紧单条提案粒度，先读全文再改纪律前置',
      fullText: '① 角色定位：你是本项目的需求分析师（反思修订版）。\n② 职责边界：文档变更只走提案通道。\n⑦ 反模式：禁止未读全文即提案。',
    },
  ],
});
