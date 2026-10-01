import { api, ApiError } from '../api';

/** 助手 dock API 封装（A08-1~4/10；POST-SSE 帧协议） */

export interface AiSessionRow {
  id: string; code: string; ctx: string; name: string; think_level: string;
  model_id: string | null;
  created_at: string; updated_at: string;
}

/** 工具调用摘要（ai_tool_calls 按 message_id 聚合；W8 富消息卡 .toolcard 数据源） */
export interface ToolCallRow {
  toolName: string;
  args: unknown;
  resultSummary: unknown;
  status: string; // ok / failed / denied
}

export interface AiMessageRow {
  id: string; role: 'user' | 'ai' | 'system'; content: string; status: string; created_at: string;
  /** W8 富消息卡：ai 消息附耗时/成本（ai_usage）与工具调用摘要；user 消息为 null/[] */
  durationMs: number | null;
  cost: string | null;
  toolCalls: ToolCallRow[];
}

export interface StreamFrame {
  type: 'stream.start' | 'stream.delta' | 'stream.done' | 'stream.error';
  operationId?: string;
  seq?: number;
  text?: string;
  status?: string;
  code?: string;
  /** W2-002：error 帧携带的脱敏失败原因（后端 0022 起） */
  message?: string;
}

export const assistantApi = {
  sessions: (pid: string, ctx?: string) =>
    api.get<{ items: AiSessionRow[] }>(
      `/api/v1/projects/${pid}/ai/sessions${ctx ? `?ctx=${ctx}` : ''}`).then((r) => r.items),
  create: (pid: string, body: { ctx: string; name?: string; thinkLevel?: string; modelId?: string }) =>
    api.post<{ id: string; code: string }>(`/api/v1/projects/${pid}/ai/sessions`, body),
  switchTo: (pid: string, sessionId: string) =>
    api.post(`/api/v1/projects/${pid}/ai/sessions/${sessionId}:switch`, {}),
  /** 会话级模型切换（DSG-U02-4 #model-sel） */
  setModel: (pid: string, sessionId: string, modelId: string | null) =>
    api.post(`/api/v1/projects/${pid}/ai/sessions/${sessionId}:set-model`, { modelId }),
  /** dock ⋯ 菜单：会话重命名/删除（DSG-U02-4；W8 启用） */
  renameSession: (pid: string, sessionId: string, name: string) =>
    api.post(`/api/v1/projects/${pid}/ai/sessions/${sessionId}:rename`, { name }),
  deleteSession: (pid: string, sessionId: string) =>
    api.post(`/api/v1/projects/${pid}/ai/sessions/${sessionId}:delete`, {}),
  messages: (pid: string, sessionId: string) =>
    api.get<{ items: AiMessageRow[] }>(
      `/api/v1/projects/${pid}/ai/sessions/${sessionId}/messages`).then((r) => r.items.reverse()),
  control: (pid: string, messageId: string, action: 'pause' | 'resume' | 'stop') =>
    api.post(`/api/v1/projects/${pid}/ai/messages/${messageId}:${action}`, {}),
  usage: (pid: string) =>
    api.get<{ totals: { tokens_in: string; tokens_out: string; cost: string; calls: string } | null }>(
      `/api/v1/projects/${pid}/ai/usage`),
};

/** POST-SSE：逐帧回调（含 stream.start 的 operationId，流控寻址用） */
export async function sendMessageSse(
  pid: string,
  sessionId: string,
  body: { content: string; thinkLevel?: string; referenceFileIds?: string[]; referenceFingerprints?: Record<string, string> },
  onFrame: (f: StreamFrame) => void,
): Promise<void> {
  const res = await fetch(`/api/v1/projects/${pid}/ai/sessions/${sessionId}/messages:send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(err?.error?.code ?? 'INTERNAL', err?.error?.message ?? `SSE ${res.status}`, res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        try { onFrame(JSON.parse(line.slice(5).trimStart()) as StreamFrame); } catch { /* 忽略坏帧 */ }
      }
    }
  }
}
