import { api } from '../../api';

/** 委派域 API 封装（LLD-5 A08-8；目标注册平台级 / 委派项目级） */

export interface DelegationTarget {
  key: string; name: string; description: string | null;
  adapter_kind: 'local-cli' | 'remote-agent' | 'builtin';
  endpoint: string | null; credential_ref: string | null; last_latency_ms: number | null;
  capabilities: string[]; status: 'available' | 'unconfigured' | 'disabled';
}

export interface Delegation {
  id: string; code: string; target: string; task_desc: string; task_id: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'failed_timeout' | 'cancelled';
  budget_limit: string | null;
  result: Record<string, unknown> | null; evidence_ids: number[]; cost: string | null;
  created_by: string;
  started_at: string | null; finished_at: string | null; created_at: string;
}

export interface DraftTestResult { ok: boolean; detail: string; latencyMs: number }

export const delegateApi = {
  targets: (pid: string) =>
    api.get<{ items: DelegationTarget[] }>(`/api/v1/projects/${pid}/ai/delegation-targets`)
      .then((r) => r.items),
  upsertTarget: (body: Record<string, unknown>) =>
    api.post('/api/v1/ai/delegation-targets', body),
  testTarget: (key: string) =>
    api.post<{ key: string; status: string; detail: string | null; latencyMs: number | null }>(
      `/api/v1/ai/delegation-targets/${key}:test`, {}),
  /** §3.8 注册向导：保存前连通测试（dry-run 不入册） */
  testDraft: (body: { adapterKind: string; endpoint?: string }) =>
    api.post<DraftTestResult>('/api/v1/ai/delegation-targets:test-draft', body),
  list: (pid: string) =>
    api.get<{ items: Delegation[]; concurrency: { max: number } }>(
      `/api/v1/projects/${pid}/ai/delegations`),
  create: (pid: string, body: { target: string; taskDesc: string; budgetLimit?: number }) =>
    api.post<{ id: string; code: string }>(`/api/v1/projects/${pid}/ai/delegations`, body),
  detail: (pid: string, id: string) =>
    api.get<Delegation>(`/api/v1/projects/${pid}/ai/delegations/${id}`),
  cancel: (pid: string, id: string) =>
    api.post(`/api/v1/projects/${pid}/ai/delegations/${id}:cancel`, {}),
};
