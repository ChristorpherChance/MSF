import { api } from '../../api';

/** 测试验收域 API 封装（LLD-5 A07-1~14；路径前缀 /api/v1/projects/:pid/acceptance） */

export interface TstBatch {
  batchId: string; status: string; current: boolean;
  environment: Record<string, unknown>; environmentFingerprint: string;
  receivedBy: string; receivedAt: string;
  blockedReason: string | null; previousStatus: string | null;
}

export interface TstBatchDetail {
  batchId: string; status: string; immutable: boolean;
  blockedReason: string | null; previousStatus: string | null;
  snapshot: {
    handoff: Record<string, unknown>;
    build: { build_id: string; build_fingerprint: string };
    devReport: { report_id: string; report_fingerprint: string; status: string };
    designBaseline: { baseline_id: string; baseline_fingerprint: string };
    acceptanceTerms: Record<string, unknown>;
    environment: Record<string, unknown>; environmentFingerprint: string;
  };
  receivedBy: string; receivedAt: string;
  plans: Array<{ code: string; version_no: number; state: string }>;
  runs: Array<{ code: string; conclusion: string | null; is_simulated: boolean; created_at: string }>;
}

export interface PendingHandoff {
  handoffId: string; buildCode: string; reportCode: string; reportStatus: string;
  buildFingerprint: string; selftestReportFingerprint: string; createdAt: string;
}

export interface TstPlan {
  planId: string; state: string; versionNo: number;
  hasManualWalkthrough: boolean; approvedBy: string | null; approvedAt: string | null;
}

export interface TstCase {
  caseId: string; code: string; title: string; flowId: string | null;
  priority: string; mode: 'auto' | 'manual'; mustRun: boolean;
  steps: Array<{ action: string; expected: string }>; contentHash: string;
}

export interface TstRunItem {
  runId: string; conclusion: string | null; isSimulated: boolean; previousRunId: boolean; createdAt: string;
}

export interface TstCaseRun {
  code: string; title: string; mode: string; must_run: boolean; priority: string;
  result: string; is_simulated: boolean; executor_kind: string;
  evidence_ids: unknown[]; executed_by: string; note: string | null;
}

export interface TstDefect {
  defectId: string; title: string; severity: string | null; status: string;
  assignee: string | null; batchId: string; reworkTaskIds: unknown[];
  regression: { batchId?: string; runId?: string; caseId?: string } | null;
  reopenedCount: number; createdAt: string; updatedAt: string;
}

export interface TstReport {
  reportId: string; verdict: string | null; status: string; basisFingerprint: string;
  /** T6：basis 指纹实时比对——执行/缺陷已变化时为 true（定稿/放行置灰并提示重新汇总） */
  basisStale: boolean;
  summary: {
    runId?: string; runConclusion?: string | null; unclosedDefects?: string[];
    simulated?: boolean; simulationNote?: string | null;
    cases?: Array<Record<string, unknown>>; defects?: Array<Record<string, unknown>>;
  };
  finalizedBy: string | null; finalizedAt: string | null; createdAt: string;
}

export interface TstDecision {
  decisionId: string; type: 'normal' | 'conditional' | 'reject';
  reportId: string; batchId: string;
  exemptions: Array<{ defect_code: string; severity: string; reason: string }>;
  actor: string; at: string; decisionFingerprint: string;
}

const base = (pid: string) => `/api/v1/projects/${pid}/acceptance`;

export const tstApi = {
  // 批次
  listBatches: (pid: string) => api.get<{ items: TstBatch[] }>(`${base(pid)}/batches`),
  batchDetail: (pid: string, batchId: string) => api.get<TstBatchDetail>(`${base(pid)}/batches/${batchId}`),
  pendingHandoffs: (pid: string) => api.get<{ items: PendingHandoff[] }>(`${base(pid)}/handoffs/pending`),
  receive: (pid: string, body: {
    handoffId: string; buildFingerprint: string; selftestReportFingerprint: string;
    designBaselineFingerprint: string; environment: Record<string, unknown>;
  }) => api.post<{ batchId: string; status: string; deduplicated: boolean }>(`${base(pid)}/batches:receive`, body),
  exportSnapshot: (pid: string, batchId: string) =>
    api.post<{ downloadUrl: string }>(`${base(pid)}/batches/${batchId}:export-snapshot`, {}),
  block: (pid: string, batchId: string, reason: string) =>
    api.post(`${base(pid)}/batches/${batchId}:block`, { reason }),
  unblock: (pid: string, batchId: string, reason: string) =>
    api.post(`${base(pid)}/batches/${batchId}:unblock`, { reason }),

  // 计划
  draftPlan: (pid: string, batchId: string) =>
    api.post<{ planId: string; cases: Array<{ id: string; mode: string }> }>(`${base(pid)}/batches/${batchId}/plans:draft`, {}),
  approvePlan: (pid: string, batchId: string, planId: string) =>
    api.post<{ planId: string; status: string }>(`${base(pid)}/batches/${batchId}/plans/${planId}:approve`, { confirm: true }),
  currentPlan: (pid: string, batchId: string) =>
    api.get<{ plan: TstPlan | null; cases: TstCase[] }>(`${base(pid)}/batches/${batchId}/plan`),

  // 执行
  executeRun: (pid: string, batchId: string, planId: string) =>
    api.post<{ runId: string; conclusion: string }>(`${base(pid)}/batches/${batchId}/runs:execute`, { planId }),
  manualRecord: (pid: string, runId: string, caseId: string, body: { status: string; evidence: string }) =>
    api.put<{ runId: string; previousRunId: string }>(`${base(pid)}/runs/${runId}/results/${caseId}`, body),
  runsOfBatch: (pid: string, batchId: string) =>
    api.get<{ items: TstRunItem[]; latestRunId: string | null; cases: TstCaseRun[] }>(`${base(pid)}/batches/${batchId}/runs`),

  // T4 证据附件（DSG-U06/D10：原始字节 PUT + 签名直链查看）
  attachEvidence: (pid: string, runId: string, caseId: string, name: string, blob: Blob) =>
    api.putRaw<{ runId: string; caseCode: string; name: string }>(
      `${base(pid)}/runs/${runId}/results/${caseId}/evidence?name=${encodeURIComponent(name)}`, blob),
  evidenceDownload: (pid: string, runId: string, caseId: string, idx: number) =>
    api.get<{ name: string; url: string }>(
      `${base(pid)}/runs/${runId}/results/${caseId}/evidence/${idx}/download`),

  // 缺陷
  listDefects: (pid: string, batchId?: string) =>
    api.get<{ items: TstDefect[] }>(`${base(pid)}/defects${batchId ? `?batchId=${batchId}` : ''}`),
  createDefect: (pid: string, body: { batchId: string; runId: string; caseId: string; title: string; evidence: string }) =>
    api.post<{ defectId: string; status: string; deduplicated: boolean }>(`${base(pid)}/defects`, body),
  confirmDefect: (pid: string, defectId: string, severity: string, reason: string) =>
    api.post(`${base(pid)}/defects/${defectId}:confirm`, { severity, reason }),
  fixStart: (pid: string, defectId: string) => api.post(`${base(pid)}/defects/${defectId}:fix-start`, {}),
  markFixed: (pid: string, defectId: string, newBuildFingerprint: string, note?: string) =>
    api.post(`${base(pid)}/defects/${defectId}:mark-fixed`, { newBuildFingerprint, note }),
  linkRegression: (pid: string, defectId: string, body: { batchId: string; runId: string; caseId: string }) =>
    api.post(`${base(pid)}/defects/${defectId}:link-regression`, body),
  closeDefect: (pid: string, defectId: string) => api.post(`${base(pid)}/defects/${defectId}:close`, {}),
  reopenDefect: (pid: string, defectId: string, reason: string) =>
    api.post(`${base(pid)}/defects/${defectId}:reopen`, { reason }),

  // 报告与交付
  generateReport: (pid: string, batchId: string) =>
    api.post<{ reportId: string; conclusion: string; issues: string[]; basisFingerprint: string }>(
      `${base(pid)}/batches/${batchId}/report:generate`, {}),
  reportsOfBatch: (pid: string, batchId: string) =>
    api.get<{ items: TstReport[] }>(`${base(pid)}/batches/${batchId}/reports`),
  finalizeReport: (pid: string, reportId: string) =>
    api.post(`${base(pid)}/reports/${reportId}:finalize`, { confirm: true }),
  release: (pid: string, reportId: string, body: {
    type: 'normal' | 'conditional' | 'reject';
    waivers?: Array<{ defectId: string; justification: string }>;
  }) => api.post<{ decisionId: string; waiversAccepted: Array<{ defectId: string; severity: string }> }>(
    `${base(pid)}/reports/${reportId}:release`, { ...body, confirm: true }),
  exportReport: (pid: string, reportId: string) =>
    api.post<{ downloadUrl: string }>(`${base(pid)}/reports/${reportId}:export`, {}),
  decisions: (pid: string, batchId?: string) =>
    api.get<{ items: TstDecision[] }>(`${base(pid)}/decisions${batchId ? `?batchId=${batchId}` : ''}`),
};
