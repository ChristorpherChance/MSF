/**
 * API client + SSE 封装。
 * POST-SSE 端点用 fetch + ReadableStream（EventSource 仅 GET，R-02-16 / LLD-5 DSG-A01-6）；
 * 中断后同 Idempotency-Key 重发 + 查询端点补拉。
 */

import { useAuthStore } from './auth-store';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly target?: string,
    /** 结构化细节（门禁缺口 issues 等；W2-012：423 缺口清单须可达前端） */
    public readonly details?: unknown,
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
      error?: { code?: string; message?: string; target?: string; details?: unknown };
    } | null;
    // 部署态简易登录：401 统一翻转登录门（AuthGate 接住渲染登录卡片；登录接口自身的 401 幂等无害）
    if (res.status === 401 && body?.error?.code === 'UNAUTHENTICATED') {
      useAuthStore.getState().needLogin();
    }
    throw new ApiError(
      body?.error?.code ?? 'INTERNAL',
      // U-005：5xx 无响应体时不裸显英文 statusText，给可理解的人话
      body?.error?.message ?? (res.status >= 500 ? '服务暂时不可用，请稍后重试' : res.statusText),
      res.status,
      body?.error?.target,
      body?.error?.details,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  /** 分片上传等二进制体（A03-2；分片 PUT 服务端按天然键豁免幂等键） */
  putRaw: <T>(path: string, body: ArrayBuffer | Blob) =>
    request<T>(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    }),
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
  if (!res.ok || !res.body) {
    // W2-023：同步拒绝（423/422 等）携带 {error:{code,message}}——解析人话，不再只报状态码
    const err = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; target?: string; details?: unknown };
    } | null;
    if (res.status === 401 && err?.error?.code === 'UNAUTHENTICATED') {
      useAuthStore.getState().needLogin();
    }
    throw new ApiError(
      err?.error?.code ?? 'INTERNAL',
      err?.error?.message ?? `SSE 请求失败: ${res.status}`,
      res.status,
      err?.error?.target,
      err?.error?.details,
    );
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (line.startsWith('data:')) onDelta(line.slice(5).trimStart());
    }
  }
}
