import { api } from '../../api';

/** 开发域 API 封装（LLD-5 A06-1~22；路径前缀 /api/v1/projects/:pid/dev） */

export interface DevTask {
  id: string; code: string; title: string; kind: string; owner: string; ownerType: string;
  col: 'queue' | 'ing' | 'review' | 'done'; runStatus: string; prog: number;
  blocked: boolean; blockedReason: string | null;
  rev: number; codeRev: number; batchNo: number | null; effort: string;
  deps: string[]; writeScopes: string[]; sourceIds: string[];
  quality: DevQuality | null;
  acceptance: Array<{ item: string; pass: boolean }>;
  /** W6：规格问题消息列表（SPEC_*；空数组=规格齐全） */
  specIssues: string[];
  /** W6：覆盖待核计数（status!=confirmed 或 task_rev 落后 rev） */
  coveragePending: number;
  coverageTotal: number;
  /** W6：最新单测/CI 证据摘要（无证据=null） */
  unit: { pass: boolean; line: number; branch: number; commitId: string; taskRev: number } | null;
  ci: { conclusion: string; commitSha: string } | null;
}

/** 质量场景行（正常/边界/异常；applicable=false 须带不适用理由） */
export interface DevScenario {
  type: string; applicable?: boolean; case?: string; expected?: string; pass?: string;
  notApplicableReason?: string;
}
export interface DevQuality { object: string; scenarios: DevScenario[]; line: number; branch: number }

export interface DevTaskDetail extends DevTask {
  goal: string; scope: string; boundary: string;
  work: unknown[]; inputs: unknown[]; deliverables: unknown[];
  inputArtifacts: Array<{ doc_kind: string; version_id: string | null; fingerprint: string | null }>;
  coverage: Array<{ item_id: string; status: string; task_rev: number }>;
  specIssuesFull: Array<{ code: string; field: string; message: string }>;
  prs: Array<{ code_rev: number; pr_ref: string; status: string; checklist: Record<string, boolean>; merge_basis: { type: string } | null; commit_id: string | null; created_at: string }>;
  evidence: Array<{ seq: number; kind: string; payload: Record<string, unknown>; created_at: string }>;
  ciReports: Array<{ commit_sha: string; conclusion: string; matched: boolean; received_at: string }>;
}

export interface GateIssue { code: string; message: string; target?: string }
export interface GateResult { ok: boolean; issues: GateIssue[] }

/** L4b 准备建议（LLD-3 DSG-C06-2 suggestions[] + 原型 v18 proposals；state 闭集，修订以 edited 标记） */
export interface PlanSuggestion {
  id: string; kind: 'create-task' | 'patch-task';
  state: 'pending' | 'accepted' | 'rejected'; edited?: boolean;
  targetCode: string; sourceFingerprint: string;
  task: {
    code?: string; title?: string; kind?: string; owner?: string; asgType?: string;
    goal?: string; scope?: string; boundary?: string; sourceIds?: string[];
    deliverables?: unknown[]; quality?: DevQuality | null; [k: string]: unknown;
  };
  reason: string; sourceRefs: string[]; confidence?: 'high' | 'medium'; humanRequired?: boolean;
}

export interface PlanItem {
  planId: string; revision: string; state: 'draft' | 'submitted' | 'approved' | 'invalidated';
  fingerprint: string; snapshot: { taskIds: string[]; note: string | null };
  coverageReport: { ok: boolean; uncoveredDesignItems: string[] };
  suggestions: PlanSuggestion[];
  preparationFingerprint: string | null;
  baselineFingerprint: string; approvedBy: string | null; approvedAt: string | null;
  invalidatedReason: string | null;
}

export interface AutopilotStatus {
  run: { runId: string; status: string; phase: string; blocker: { code: string; message: string } | null } | null;
  authorization: { authorizationId: string; status: string; scope: Record<string, boolean> } | null;
}

export interface BuildInfo {
  buildId: string; status: string; buildFingerprint: string; commits: string[];
  planRevision: number; uiArtifact: { htmlFingerprint: string; independent: boolean };
  createdAt: string;
}

export interface ReportItem {
  id: string; code: string; status: 'pass' | 'fail';
  based_on: Record<string, unknown>; report_fingerprint: string;
  export_object_key: string | null; created_at: string;
}

export interface ReportDetail {
  reportId: string; code: string; status: string; immutable: boolean; tampered: boolean;
  fingerprint: string; createdAt: string;
  gates: Record<string, { ok: boolean; issues?: GateIssue[] }>;
  pages: Array<{
    page_code: string; viewport_code: string; critical_total: number; critical_pass: number;
    general_total: number; general_pass: number; severe_deviations: number;
    skipped: number; not_run: number; passed: boolean;
  }>;
}

export interface ImpactItem {
  id: string; code: string; trigger: string; affected_tasks: string[];
  status: string; resolution: string | null; note: string | null;
  created_at: string; updated_at: string;
}

const base = (pid: string) => `/api/v1/projects/${pid}/dev`;

export const devApi = {
  identify: (pid: string, baselineId: string, baselineFingerprint: string) =>
    api.post<{ identified: number; taskIds: string[] }>(`${base(pid)}/tasks:identify`, { baselineId, baselineFingerprint }),
  listTasks: (pid: string) => api.get<{ items: DevTask[]; total: number }>(`${base(pid)}/tasks`),
  taskDetail: (pid: string, taskId: string) => api.get<DevTaskDetail>(`${base(pid)}/tasks/${taskId}`),
  saveTask: (pid: string, taskId: string, patch: Record<string, unknown>) =>
    api.post(`${base(pid)}/tasks/${taskId}`, patch),
  createTask: (pid: string, title: string, kind: string) =>
    api.post<{ id: string; code: string }>(`${base(pid)}/tasks`, { title, kind }),
  improveTasks: (pid: string) => api.post<{ improved: number }>(`${base(pid)}/tasks:improve`, {}),
  schedulePlan: (pid: string) =>
    api.post<{ batches: number; changed: number; conflicts: Array<{ scope: string; tasks: string[] }> }>(`${base(pid)}/plan:schedule`, {}),
  repoTree: (pid: string, path?: string) =>
    api.get<{
      tree: Array<{ path: string; kind: 'dir' | 'file'; taskCode?: string }>;
      file: { path: string; content: string; taskCode: string | null } | null;
      lint: { ok: boolean; issues: string[] };
    }>(`${base(pid)}/repo/tree${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  repoChanges: (pid: string, taskId?: string) =>
    api.get<{ changes: Array<{ commitId: string; taskCode: string; title: string; by: string; at: string; basis: string }> }>(
      `${base(pid)}/repo/changes${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
  conflicts: (pid: string) => api.get<{ conflicts: Array<{ writeScope: string; taskIds: string[] }> }>(`${base(pid)}/tasks/conflicts`),
  transition: (pid: string, taskId: string, to: string, note?: string) =>
    api.post(`${base(pid)}/tasks/${taskId}:transition`, { to, note }),
  progress: (pid: string, taskId: string, prog: number) =>
    api.post(`${base(pid)}/tasks/${taskId}:progress`, { prog }),
  runTask: (pid: string, taskId: string) => api.post(`${base(pid)}/tasks/${taskId}:run`, {}),
  startGate: (pid: string, taskId: string) => api.get<GateResult>(`${base(pid)}/tasks/${taskId}/start-gate`),
  toggleCheck: (pid: string, taskId: string, key: string, checked: boolean) =>
    api.post(`${base(pid)}/tasks/${taskId}/pr/checks`, { key, checked }),
  prSkip: (pid: string, taskId: string, reason: string) => api.post(`${base(pid)}/tasks/${taskId}/pr:skip`, { reason }),
  quality: (pid: string, taskId: string) => api.post(`${base(pid)}/tasks/${taskId}:quality`, {}),
  aiReview: (pid: string, taskId: string) => api.post(`${base(pid)}/tasks/${taskId}:ai-review`, {}),
  merge: (pid: string, taskId: string, basisType: string, skipReason?: string) =>
    api.post(`${base(pid)}/tasks/${taskId}/pr:merge`, { basisType, skipReason }),
  confirmCoverage: (pid: string, taskId: string) => api.post(`${base(pid)}/coverage:confirm`, { taskId }),

  coverage: (pid: string) =>
    api.get<{ ok: boolean; uncoveredDesignItems: string[]; unmatchedTasks: string[] }>(`${base(pid)}/plan/coverage`),
  plans: (pid: string) => api.get<{ items: PlanItem[] }>(`${base(pid)}/plan`),
  submitPlan: (pid: string, taskIds: string[], note?: string) =>
    api.post<{ revision: string; fingerprint: string }>(`${base(pid)}/plan:submit`, { taskIds, note }),
  /** L4b 准备两级流程（原型 devPreparePlan/devRevisePreparation；服务端差异登记端点） */
  preparePlan: (pid: string) =>
    api.post<{ revision: string; fingerprint: string; preparationFingerprint: string; suggestions: number }>(
      `${base(pid)}/plan:prepare`, {}),
  resolveSuggestion: (
    pid: string, revision: string, fingerprint: string,
    suggestionId: string, decision: 'accepted' | 'rejected' | 'pending', task?: Record<string, unknown>,
  ) =>
    api.post<{ revision: string; fingerprint: string; preparationFingerprint: string }>(
      `${base(pid)}/plan:suggestion-resolve`, { revision, fingerprint, suggestionId, decision, task }),
  approvePlan: (pid: string, revision: string, fingerprint: string) =>
    api.post(`${base(pid)}/plan:approve`, { revision, fingerprint, confirm: true }),

  autopilotStart: (pid: string, displayedRevisionId: string, displayedFingerprint: string) =>
    api.post<{ runId: string; authorizationId: string; status: string }>(
      `${base(pid)}/autopilot:start`, { displayedRevisionId, displayedFingerprint }),
  autopilotControl: (pid: string, action: 'pause' | 'stop' | 'takeover' | 'resume') =>
    api.post(`${base(pid)}/autopilot:${action}`, {}),
  autopilotStatus: (pid: string) => api.get<AutopilotStatus>(`${base(pid)}/autopilot`),

  buildRun: (pid: string) => api.post<{ buildId: string; status: string }>(`${base(pid)}/build:run`, {}),
  buildCurrent: (pid: string) => api.get<{ build: BuildInfo | null }>(`${base(pid)}/build`),

  selftestStart: (pid: string) => api.post<{ reportId: string; code: string; status: string }>(`${base(pid)}/selftest:start`, {}),
  selftestRetest: (pid: string, reason: string) => api.post(`${base(pid)}/selftest:retest`, { reason }),
  selftestGate: (pid: string) => api.get<GateResult & { report: ReportItem | null }>(`${base(pid)}/selftest/gate`),
  reports: (pid: string) => api.get<{ items: ReportItem[] }>(`${base(pid)}/selftest/reports`),
  reportDetail: (pid: string, reportId: string) => api.get<ReportDetail>(`${base(pid)}/selftest/reports/${reportId}`),
  reportExport: (pid: string, reportId: string, format: 'md' | 'html') =>
    api.post<{ downloadUrl: string }>(`${base(pid)}/selftest/reports/${reportId}:export`, { format }),
  comparison: (pid: string, pageId: string) =>
    api.get<{
      prototypePreviewUrl: string; buildPreviewUrl: string;
      sameObjectGuard: { prototypeHtmlFingerprint: string; buildHtmlFingerprint: string; distinct: boolean };
    }>(`${base(pid)}/selftest/comparison?pageId=${encodeURIComponent(pageId)}`),

  transferGate: (pid: string) => api.get<GateResult>(`${base(pid)}/transfer/gate`),
  transfer: (pid: string, reportId: string, reportFingerprint: string) =>
    api.post<{ handoffId: string; tokenRotated: boolean; deduplicated?: boolean }>(
      `${base(pid)}/transfer`, { reportId, reportFingerprint, confirm: true }),

  impacts: (pid: string, status?: string) =>
    api.get<{ items: ImpactItem[] }>(`${base(pid)}/impacts${status ? `?status=${status}` : ''}`),
  observe: (pid: string) => api.post<{ impacts: string[]; affectedTasks?: string[] }>(`${base(pid)}/impacts:observe`, {}),
  applyImpact: (pid: string, impactIds: string[], resolution: 'rework' | 'accept', note?: string) =>
    api.post(`${base(pid)}/baseline:confirm`, { impactIds, resolution, note }),
  confirmBaseline: (pid: string, note?: string) => api.post(`${base(pid)}/baseline:confirm`, { note }),

  setSecret: (pid: string, secret: string) =>
    api.put<{ enabled: boolean; secretMasked: string }>(`${base(pid)}/ci/webhook-secret`, { secret }),
  secretStatus: (pid: string) =>
    api.get<{ enabled: boolean; secretMasked?: string; rotatedAt?: string }>(`${base(pid)}/ci/webhook-secret`),

  /** L4 操作审计卡（A10-3 平台审计只读链；dev. 前缀命令客户端过滤） */
  audit: (pid: string, limit = 50) =>
    api.get<{ items: Array<{ eventId: string; actor: string; actorType: string; command: string; result: string; at: string; hash: string }> }>(
      `/api/v1/system/audit?projectId=${pid}&limit=${limit}`),
};

/** 编码规范（A08-7 提示词版本复用，kind='std'；与设置页 Agent 配置同源） */
export interface StdVersion {
  id: string; agent_key: string; agent_group: string; version_no: number;
  base_prompt: string; overlay_text: string | null; is_current: boolean;
  kind: 'prompt' | 'std'; skill_pack: unknown; created_by: string; created_at: string;
}
export const stdApi = {
  agents: () => api.get<{ items: StdVersion[] }>('/api/v1/ai/prompts'),
  versions: (agentKey: string) => api.get<{ items: StdVersion[] }>(`/api/v1/ai/prompts/${agentKey}/versions`),
  publish: (body: { agentKey: string; agentGroup?: string; basePrompt: string; overlayText?: string; kind?: 'prompt' | 'std' }) =>
    api.post<{ id: string; versionNo: number }>('/api/v1/ai/prompts', body),
};
