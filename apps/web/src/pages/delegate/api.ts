import { api } from '../../api';

/** 委派域 API 封装（LLD-5 A08-8；目标注册平台级 / 委派项目级） */

export interface DelegationTarget {
  key: string; name: string; description: string | null;
  adapter_kind: 'local-cli' | 'remote-agent' | 'builtin';
  capabilities: string[]; status: 'available' | 'unconfigured' | 'disabled';
}

export interface Delegation {
  id: string; code: string; target: string; task_desc: string; task_id: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'failed_timeout' | 'cancelled';
  result: Record<string, unknown> | null; evidence_ids: number[]; cost: string | null;
  started_at: string | null; finished_at: string | null; created_at: string;
}

export const delegateApi = {
  targets: (pid: string) =>
    api.get<{ items: DelegationTarget[] }>(`/api/v1/projects/${pid}/ai/delegation-targets`)
      .then((r) => r.items),
  upsertTarget: (pid: string, body: Record<string, unknown>) =>
    api.post('/api/v1/ai/delegation-targets', body),
  testTarget: (key: string) =>
    api.post<{ key: string; status: string; detail: string | null }>(
      `/api/v1/ai/delegation-targets/${key}:test`, {}),
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
