/**
 * API client + SSE 封装。
 * POST-SSE 端点用 fetch + ReadableStream（EventSource 仅 GET，R-02-16 / LLD-5 DSG-A01-6）；
 * 中断后同 Idempotency-Key 重发 + 查询端点补拉。
 */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly target?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.method && init.method !== 'GET'
        ? { 'Idempotency-Key': crypto.randomUUID() }
        : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; target?: string };
    } | null;
    throw new ApiError(
      body?.error?.code ?? 'INTERNAL',
      body?.error?.message ?? res.statusText,
      res.status,
      body?.error?.target,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};

/** POST-SSE 流式消费：onDelta 逐段回调，返回最终消息结果 */
export async function postSse(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new ApiError('INTERNAL', `SSE 请求失败: ${res.status}`, res.status);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (line.startsWith('data:')) onDelta(line.slice(5).trimStart());
    }
  }
}
