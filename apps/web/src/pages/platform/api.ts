import { api } from '../../api';

/** 平台域 API（A02/A10；M7） */

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  is_demo: boolean;
  stage_gates: Array<{ stage: string; ok: boolean }>;
  created_at: string;
}

export interface StageIssue { code: string; message: string; target: string }
export interface StageGate { stage: string; ok: boolean; issues: StageIssue[] }

export interface TaskItem {
  id: string; stage: string; code: string; title: string; status: string;
  owner: string | null; createdAt: string; updatedAt: string;
}

export interface EventItem { id: string; type: string; text: string; at: string; actor: string }

export interface Notice {
  id: string; project_id: string | null; type: string; text: string;
  link: string | null;
  unread: boolean; created_at: string;
}

export interface UsageSummaryRow {
  project_id: string | null; project_name: string | null; model_name: string; purpose: string;
  calls: string; tokens_in: string; tokens_out: string; cost: string;
}

export interface GateRow { gateKey: string; mode: 'manual' | 'auto'; preconditions: string[]; updatedAt: string | null }
export interface GateEvent {
  gate_key: string; from_mode: string; to_mode: string; reason: string; actor_id: string; created_at: string;
}

export interface AuditItem {
  eventId: string; actor: string; actorType: string; command: string;
  inputFingerprint: string; result: string; at: string;
  hashChainPrev: string | null; projectId: string | null; hash: string;
}

export interface ModelPublic {
  id: string; name: string; provider: string; base_url: string; model_code: string;
  api_key_hint: string | null; enabled: boolean; conn_status: 'ok' | 'fail' | 'untested';
  supports_thinking: boolean; context_window: number; routes: string[];
}

export const PURPOSES = ['planning', 'generation', 'review', 'translation', 'chat'] as const;
export const PURPOSE_NAMES: Record<string, string> = {
  planning: '规划', generation: '生成', review: '评审', translation: '翻译', chat: '对话',
};

export const STAGE_NAMES: Record<string, string> = {
  material: '资料', req: '需求', design: '设计', dev: '开发', test: '测试验收',
};

const pid = (p: string) => `/api/v1/projects/${p}`;

export const platformApi = {
  // 项目（A02-1~3）
  listProjects: () => api.get<ProjectRow[]>('/api/projects'),
  createProject: (name: string, isDemo = false, description = '') =>
    api.post<{ id: string }>('/api/projects', { name, isDemo, description }),
  updateProject: (id: string, body: { name?: string; description?: string }) =>
    api.put(`/api/projects/${id}`, body),
  archiveProject: (id: string) => api.post(`/api/projects/${id}/archive`, {}),
  // 阶段准入/任务中心/事件流（A02-4/5/6）
  stages: (p: string) => api.get<{ stages: StageGate[] }>(`${pid(p)}/stages`),
  tasks: (p: string, q = '') => api.get<{ items: TaskItem[]; total: number; page: number; pageSize: number }>(`${pid(p)}/tasks${q}`),
  events: (p: string, q = '') => api.get<{ items: EventItem[]; nextCursor: string | null; total?: number }>(`${pid(p)}/events${q}`),
  // 放行策略（设置页策略组）
  gates: (p: string) => api.get<{ gates: GateRow[]; events: GateEvent[] }>(`${pid(p)}/policy-gates`),
  setGateMode: (p: string, gateKey: string, mode: string, reason: string) =>
    api.post(`${pid(p)}/policy-gates/${gateKey}:set-mode`, { mode, reason }),
  setGatePreconditions: (p: string, gateKey: string, preconditions: string[]) =>
    api.post(`${pid(p)}/policy-gates/${gateKey}:set-preconditions`, { preconditions }),
  // 通知（A10-2）
  notifications: (q = '') =>
    api.get<{ items: Notice[]; nextCursor: string | null; unreadCount: number }>(`/api/v1/system/notifications${q}`),
  readNotice: (id: string) => api.post(`/api/v1/system/notifications/${id}:read`, {}),
  readAllNotices: () => api.post<{ count: number }>('/api/v1/system/notifications:read-all', {}),
  // 审计（A10-3）
  audit: (q = '') => api.get<{ items: AuditItem[]; nextCursor: string | null }>(`/api/v1/system/audit${q}`),
  auditExport: (projectId?: string) =>
    api.get<{ exportedAt: string; count: number; items: unknown[] }>(
      `/api/v1/system/audit:export${projectId ? `?projectId=${projectId}` : ''}`),
  // 备份（A10-4 + §3.9 备份卡历史）
  backupExport: (projectId: string, includeEvidence = true) =>
    api.post<{ operationId: string }>('/api/v1/system/backups:export', { scope: 'project', projectId, includeEvidence }),
  backupList: (projectId: string) =>
    api.get<{ items: BackupRow[] }>(`/api/v1/system/backups?projectId=${encodeURIComponent(projectId)}`),
  // 设置（A10-1）
  settings: () => api.get<Record<string, unknown>>('/api/v1/system/settings'),
  putSettings: (values: Record<string, unknown>) => api.put<{ updated: string[] }>('/api/v1/system/settings', values),
  // 模型与用途路由（A08-9，设置页模型组）
  models: () => api.get<ModelPublic[]>('/api/v1/ai/models'),
  upsertModel: (body: Record<string, unknown>) => api.post<{ id: string }>('/api/v1/ai/models', body),
  testModel: (id: string) => api.post<{ id: string; connStatus: string; detail: string }>(`/api/v1/ai/models/${id}:test`, {}),
  routes: () => api.get<Record<string, { modelId: string; modelName: string } | null>>('/api/v1/ai/routes'),
  setRoute: (purpose: string, modelId: string | null) =>
    api.put(`/api/v1/ai/routes/${purpose}`, { modelId }),
  // 用量汇总（顶栏「本月成本」popover，A08-10）
  usageSummary: (month?: 'current') =>
    api.get<{ items: UsageSummaryRow[]; totals: { calls: string; tokens_in: string; tokens_out: string; cost: string } }>(
      `/api/v1/ai/usage/summary${month ? '?month=current' : ''}`),
  // 当前用户（顶栏标识，A10-5 本期最简）
  me: () => api.get<{ id: string; name: string; role: string; source: string }>('/api/v1/system/users/me'),
};

/** 备份历史行（§3.9 备份卡） */
export interface BackupRow {
  operationId: string; status: 'running' | 'completed' | 'failed';
  includeEvidence: boolean; tableCount: number; rowCount: number; error: string | null;
  createdBy: string; createdAt: string; finishedAt: string | null; downloadUrl: string | null;
}

/** Prompt 版本（A08-7；设置页 Agent 配置区 pver-row；kind=std 即编码规范叠加） */
export interface PromptVersionRow {
  id: string; agent_key: string; agent_group: string; version_no: number; name: string | null;
  base_prompt: string; overlay_text: string; is_current: boolean; kind: 'prompt' | 'std';
  skill_pack: unknown; created_by: string; created_at: string;
}

export const promptsApi = {
  agents: () => api.get<{ items: PromptVersionRow[] }>('/api/v1/ai/prompts'),
  versions: (agentKey: string) =>
    api.get<{ items: PromptVersionRow[] }>(`/api/v1/ai/prompts/${agentKey}/versions`),
  publish: (body: {
    agentKey: string; agentGroup?: string; basePrompt: string;
    overlayText?: string; kind?: 'prompt' | 'std'; name?: string; activate?: boolean;
  }) => api.post<{ id: string; versionNo: number }>('/api/v1/ai/prompts', body),
  /** 设为生效（后端复用 ai.prompt.rollback 语义） */
  setCurrent: (agentKey: string, versionNo: number) =>
    api.post(`/api/v1/ai/prompts/${agentKey}:rollback`, { versionNo }),
  rename: (agentKey: string, versionNo: number, name: string) =>
    api.post(`/api/v1/ai/prompts/${agentKey}/versions/${versionNo}:rename`, { name }),
  remove: (agentKey: string, versionNo: number) =>
    api.post(`/api/v1/ai/prompts/${agentKey}/versions/${versionNo}:delete`, {}),
};

/** 助手工具注册表（A08-5；设置页全局助手卡工具开关清单；项目级前缀） */
export const toolsApi = {
  list: (projectId: string) =>
    api.get<{ tools: Array<{ name: string; kind: string; description: string }>; denied: string[] }>(
      `${pid(projectId)}/ai/tools`),
};
