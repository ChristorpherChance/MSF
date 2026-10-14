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

/* —— ⇄ 模板重排批量刷新（设计 §1 四端点；帧闭集五型，未知帧前端忽略不报错） —— */

export interface RefreshPreflightItem {
  kind: string;
  domain: 'req' | 'design';
  hasContent: boolean;
  finalized: boolean;
  pending: number;
  /** 核对报告：issues 人话行（空=对版）+ upstreamStale；无内容/无模板=null 不评（mismatch 布尔已退役） */
  report: { issues: string[]; upstreamStale: boolean } | null;
}

/** 结构问题计数（默认勾选判定用）：滞后行恒在 issues 尾部（服务端钉死约定），剔除之——
 *  仅上游滞后的册不默认勾（规格 §3 软闸：重排是结构操作，滞后是内容问题）；
 *  Math.max(0,…) 收口：理论不存在的 stale=true+issues=[] 输入下不得返负（负数对调用方是意外形态） */
export function structuralIssueCount(report: { issues: string[]; upstreamStale: boolean }): number {
  return Math.max(0, report.issues.length - (report.upstreamStale ? 1 : 0));
}

export interface RefreshFrame {
  type: 'refresh.kind.started' | 'refresh.kind.done' | 'refresh.kind.failed' | 'refresh.kind.skipped' | 'refresh.done';
  seq?: number;
  kind?: string;
  patchCount?: number;
  reason?: string;
  domain?: 'req' | 'design';
  summary?: { done: number; failed: number; skipped: number };
}

export const templateRefreshApi = {
  preflight: (pid: string) =>
    api.get<{ items: RefreshPreflightItem[] }>(`/api/v1/projects/${pid}/template-refresh/preflight`).then((r) => r.items),
  start: (pid: string, kinds: string[]) =>
    api.post<{ operationId: string }>(`/api/v1/projects/${pid}/template-refresh/start`, { kinds }),
  stop: (pid: string, opId: string) =>
    api.post(`/api/v1/projects/${pid}/template-refresh/${opId}:stop`, {}),
};

/** SSE 进度逐帧回调（data: 行解析，注释帧/心跳天然跳过；镜像 sendMessageSse；signal 供组件卸载断流） */
export async function streamRefresh(
  pid: string,
  opId: string,
  onFrame: (f: RefreshFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/v1/projects/${pid}/template-refresh/${opId}/stream`, signal ? { signal } : {});
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (res.status === 401 && err?.error?.code === 'UNAUTHENTICATED') {
      useAuthStore.getState().needLogin();
    }
    throw new ApiError(
      err?.error?.code ?? 'INTERNAL',
      // 人话兜底同 request() 口径：5xx 无响应体不裸显英文
      err?.error?.message ?? (res.status >= 500 ? '服务暂时不可用，请稍后重试' : res.statusText),
      res.status,
    );
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
        try { onFrame(JSON.parse(line.slice(5).trimStart()) as RefreshFrame); } catch { /* 忽略坏帧 */ }
      }
    }
  }
}
