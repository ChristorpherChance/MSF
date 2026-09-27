import { api, postSse } from '../../api';

/** 设计域 API 封装（LLD-5 DSG-A05-1~13；路径前缀 /api/v1/projects/:pid/design） */

export type DesignKind = 'hld' | 'mod' | 'alg' | 'cls' | 'db' | 'api' | 'ui' | 'nfr';

export interface DesignDocItem {
  id: string; kind: DesignKind; book: string; title: string;
  cur: number; finalVer: number; finalized: boolean; modified: boolean; pendingCount: number;
}

export interface DesignDocView {
  id: string; kind: string; cur: number; viewing: number | null;
  finalized: boolean; finalVer: number; modified: boolean; genState: string;
  secs: Array<{ id: string; title: string; md: string; pending: string | null }>;
  version: number; contentFingerprint: string;
}

export interface PatchItem {
  patchId: string; secId: string; type: 'add' | 'modify' | 'del';
  title?: string; old?: string; new?: string; status: string; source: string;
}

export interface ReviewItem {
  id: string; severity: string; docKind: string; item: string;
  status: 'open' | 'done'; conclusion: string | null; at: string | null;
}

/** L8 追溯锚点（A05-4：每项可追溯到具体文档章节锚点） */
export interface CatalogAnchor { refKind: string; docKind: string | null; sectionId: string | null; anchor: string | null }

export interface CatalogGroup { itemId: string; code: string; payload: Record<string, unknown>; required: boolean; source: string; anchors: CatalogAnchor[] }

export interface CatalogView {
  catalogVersion: string | null;
  catalogFingerprint: string | null;
  groups: Record<string, CatalogGroup[]>;
}

export interface ProtoStatus {
  status: 'idle' | 'planning' | 'plan-ready' | 'generating' | 'generated' | 'checking' | 'ready' | 'finalized' | 'stale' | 'failed';
  plan: { planId: string; complete: boolean; fingerprint: string; catalogVersion: string; stale: boolean } | null;
  prototype: { docId: string; currentVersionId: string | null; finalized: boolean; modified: boolean } | null;
  latestCheck: {
    reportId: string; runNo: number; passed: boolean; prototypeVersionId: string;
    issues: Array<{ code: string; message: string; target: string }>;
    unverified: Array<{ code: string; message: string; target: string }>;
  } | null;
}

export interface GateResult { ok: boolean; issues: Array<{ code: string; message: string; target?: string }> }

export interface BaselineItem {
  baselineId: string; code: string; fingerprint: string; current: boolean;
  valid: boolean; staleReason: string | null; confirmedBy: string; confirmedAt: string;
  items: Array<{ artifact: string; version_id: string | null; fingerprint: string | null }>;
}

/** 资料域参考清单项（A03-17 同口径；仅 content_final 可挂接，REQ-114） */
export interface ReferenceCandidate {
  fileId: string;
  name: string;
  status: string;
  contentFingerprint: string;
}

/** 需求域文档清单项（L7 设计参考 popover「默认参考」区读上游 PRD/CRD 状态；HTTP 组合，非 import 跨域） */
export interface UpstreamDocItem {
  kind: string; cur: number; finalVer: number; finalized: boolean;
}

const base = (pid: string) => `/api/v1/projects/${pid}/design`;

export const designApi = {
  listDocs: (pid: string) => api.get<{ items: DesignDocItem[] }>(`${base(pid)}/docs`),
  getDoc: (pid: string, kind: DesignKind, v?: number) =>
    api.get<DesignDocView>(`${base(pid)}/docs/${kind}${v !== undefined ? `?v=${v}` : ''}`),
  saveDraft: (pid: string, kind: DesignKind, secId: string, md: string, baseVersion: number, baseFingerprint: string) =>
    api.post(`${base(pid)}/docs/${kind}/draft`, { secId, md, baseVersion, baseFingerprint }),
  undo: (pid: string, kind: DesignKind) => api.post(`${base(pid)}/docs/${kind}:undo`, {}),
  redo: (pid: string, kind: DesignKind) => api.post(`${base(pid)}/docs/${kind}:redo`, {}),
  commit: (pid: string, kind: DesignKind, note: string, baseVersion: number) =>
    api.post(`${base(pid)}/docs/${kind}/versions:commit`, { note, baseVersion }),
  finalize: (pid: string, kind: DesignKind, v: number, baseVersion: number, allowOpenReviews: boolean) =>
    api.post(`${base(pid)}/docs/${kind}/versions/${v}:finalize`, { baseVersion, confirm: true, allowOpenReviews }),
  unlock: (pid: string, kind: DesignKind) => api.post(`${base(pid)}/docs/${kind}:unlock`, {}),
  listVersions: (pid: string, kind: DesignKind) =>
    api.get<{ items: Array<{ v: number; note: string | null; at: string; finalized: boolean }> }>(`${base(pid)}/docs/${kind}/versions`),
  switchVersion: (pid: string, kind: DesignKind, v: number) =>
    api.post(`${base(pid)}/docs/${kind}/versions/${v}:switch`, {}),
  /** L1：服务端导出（md/docx/pdf，审计留痕；与 req 域同构） */
  exportDoc: (pid: string, kind: DesignKind, v: number, format: 'md' | 'html' | 'docx' | 'pdf') =>
    api.post<{ downloadUrl: string; format: string }>(`${base(pid)}/docs/${kind}/versions/${v}:export`, { format }),
  listPatches: (pid: string, kind: DesignKind) => api.get<{ items: PatchItem[] }>(`${base(pid)}/docs/${kind}/patches`),
  acceptPatch: (pid: string, kind: DesignKind, patchId: string) =>
    api.post(`${base(pid)}/docs/${kind}/patches/${patchId}:accept`, {}),
  rejectPatch: (pid: string, kind: DesignKind, patchId: string) =>
    api.post(`${base(pid)}/docs/${kind}/patches/${patchId}:reject`, {}),
  genControl: (pid: string, kind: DesignKind, operationId: string, action: 'pause' | 'resume' | 'stop') =>
    api.post(`${base(pid)}/docs/${kind}/generations/${operationId}:${action}`, {}),

  reviews: (pid: string) => api.get<{ items: ReviewItem[] }>(`${base(pid)}/reviews`),
  conclude: (pid: string, drId: string, conclusion: 'pass' | 'fail' | 'na', note: string) =>
    api.post(`${base(pid)}/reviews/${drId}:conclude`, { conclusion, note }),
  /** S8 🔁 重新自检评审（幂等补齐种子条目） */
  reseedReviews: (pid: string) => api.post<{ seeded: boolean; count: number }>(`${base(pid)}/reviews:reseed`, {}),
  /** S8 已解决项重新打开 */
  reopenReview: (pid: string, drId: string) => api.post(`${base(pid)}/reviews/${drId}:reopen`, {}),

  catalog: (pid: string) => api.get<CatalogView>(`${base(pid)}/catalog`),
  addCatalogItem: (pid: string, input: { itemType: string; code: string; title: string; note?: string }) =>
    api.post(`${base(pid)}/catalog/items`, input),
  removeCatalogItem: (pid: string, itemId: string) => api.del(`${base(pid)}/catalog/items/${itemId}`),

  plan: (pid: string) =>
    api.post<{ planId: string; complete: boolean; fingerprint: string }>(`${base(pid)}/prototype:plan`, {}),
  protoStatus: (pid: string) => api.get<ProtoStatus>(`${base(pid)}/prototype`),
  protoGenerate: (pid: string, planId: string, planFingerprint: string) =>
    api.post<{ prototypeVersionId: string; v: number }>(`${base(pid)}/prototype:generate`, { planId, planFingerprint }),
  protoCheck: (pid: string, prototypeVersionId: string) =>
    api.post<{ reportId: string; status: string; issues: unknown[]; unverified: unknown[] }>(
      `${base(pid)}/prototype:check`, { prototypeVersionId }),
  protoFinalize: (pid: string, prototypeVersionId: string, checkReportId: string) =>
    api.post<{ baselineId: string; code: string }>(`${base(pid)}/prototype:finalize`,
      { prototypeVersionId, checkReportId, confirm: true }),
  preview: (pid: string, pageId: string, v?: number) =>
    api.get<{ previewUrl: string; htmlFingerprint: string }>(
      `${base(pid)}/prototype/pages/${encodeURIComponent(pageId)}/preview${v !== undefined ? `?v=${v}` : ''}`),
  /** S6 上传 HTML 初稿入库（V1.3 上传通道，同一套对应性检查） */
  uploadPrototype: (pid: string, html: string, note?: string) =>
    api.post<{ prototypeVersionId: string; v: number }>(
      `${base(pid)}/prototype:upload`, { html, ...(note ? { note } : {}) }),
  /** S7 原型版本列表（旧版预览弹窗数据源） */
  protoVersions: (pid: string) =>
    api.get<{ items: Array<{ versionId: string; v: number; note: string | null; at: string; finalized: boolean }> }>(
      `${base(pid)}/prototype/versions`),
  /** L7 生成参考候选（资料域 content_final 清单；生成期勾选，指纹随版本快照 dsg_versions.refs） */
  referenceCandidates: (pid: string) =>
    api.get<{ items: ReferenceCandidate[] }>(`/api/v1/projects/${pid}/materials/references`),
  /** L7 上游 PRD/CRD 状态（默认参考自动装配显示用） */
  upstreamDocs: (pid: string) =>
    api.get<{ items: UpstreamDocItem[] }>(`/api/v1/projects/${pid}/requirements/docs`),
  /** L8 追溯区任务组（开发域任务 source_ids 反查目录条目；HTTP 组合，非 import 跨域） */
  devTasks: (pid: string) =>
    api.get<{ items: Array<{ code: string; title: string; sourceIds: string[] }> }>(`/api/v1/projects/${pid}/dev/tasks`),
  gates: (pid: string, action: 'generate' | 'check' | 'finalize' | 'develop') =>
    api.get<GateResult>(`${base(pid)}/gates/${action}`),
  baselines: (pid: string) => api.get<{ items: BaselineItem[] }>(`${base(pid)}/baselines`),
  sourceAudit: (pid: string) =>
    api.get<{ rulesVersion: string; ok: boolean; issues: Array<{ code: string; target: string; message: string }> }>(
      `${base(pid)}/source-audit`),
};

export interface GenFrame {
  type: 'stream.start' | 'stream.delta' | 'stream.done' | 'stream.error';
  text?: string; operationId?: string; code?: string;
  /** #5 生成来源：model=真模型 / mock=桩 */
  source?: string;
}

/** A05-2 POST-SSE 生成（同 A04-4 消费口径） */
export async function generateDesignDoc(
  pid: string, kind: DesignKind,
  body: { referenceFileIds: string[]; referenceFingerprints: Record<string, string>; instruction?: string },
  onFrame: (f: GenFrame) => void,
): Promise<void> {
  await postSse(`${base(pid)}/docs/${kind}:generate`, body, (line) => {
    try { onFrame(JSON.parse(line) as GenFrame); } catch { /* 忽略非 JSON 心跳行 */ }
  });
}
