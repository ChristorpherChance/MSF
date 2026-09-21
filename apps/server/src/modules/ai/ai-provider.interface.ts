/**
 * M08 AI 编排层抽象（接口按 Pi SDK 0.86.0 实物事实建模；REQ-615/ADR-6）：
 * - Usage 附着于消息结果（非独立事件流）
 * - steering = 注入消息；stop = abort；pause/resume = 平台缓冲层（不委托 Pi）
 * mock 先行：M2 起文档生成链路即可跑通，M6 以 Pi SDK 真实现替换，本接口不变。
 */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** 自定义模型 cost 元数据可能缺失，由平台 price_table 兜底（ADR-6） */
  cost?: number;
}

export interface AiMessageResult {
  text: string;
  usage: AiUsage;
}

export interface AiSession {
  readonly sessionId: string;
  /** 流式输出：逐 delta 推送；结束（或 abort）时 resolve 消息结果（含 Usage） */
  stream(prompt: string): {
    deltas: AsyncIterable<string>;
    result: Promise<AiMessageResult>;
  };
  /** 注入消息（对齐 Pi steering 语义） */
  steer(message: string): void;
  /** 停止（对齐 Pi abort 语义） */
  stop(): void;
}

export interface AiProvider {
  createSession(options: { projectId: string; purpose: string }): Promise<AiSession>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
