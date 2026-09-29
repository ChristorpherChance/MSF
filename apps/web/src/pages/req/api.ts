import { api, postSse } from '../../api';

/**
 * 需求域 API 封装（LLD-5 DSG-A04-1~14；路径前缀 /api/v1/projects/:pid/requirements）。
 * 出参类型与服务端 ReqDocsService/RtmService/GenerateService/ReqExportService 一致。
 */

export type DocKind = 'crd' | 'prd';

export interface DocListItem {
  id: string;
  kind: string;
  cur: number;
  finalVer: number;
  finalized: boolean;
  modified: boolean;
  pendingCount: number;
}

export interface DocSec {
  id: string;
  title: string;
  md: string;
  pending: string | null;
}

export interface DocRef {
  fileId: string;
  name: string;
  fingerprint: string;
}

export interface DocView {
  id: string;
  kind: string;
  cur: number;
  viewing: number | null;
  finalized: boolean;
  finalVer: number;
  modified: boolean;
  genState: string;
  secs: DocSec[];
  refs: DocRef[];
  version: number;
  contentFingerprint: string;
}

export interface VersionItem {
  v: number;
  note: string | null;
  at: string;
  by: string;
  finalized: boolean;
  readonly: boolean;
}

export interface PatchItem {
  patchId: string;
  secId: string;
  type: 'add' | 'modify' | 'del';
  title?: string;
  old?: string;
  new?: string;
  status: 'pending' | 'accepted' | 'rejected';
  source: string;
  /** L2：处置理由（落库留痕；未填写为 null） */
  reason: string | null;
}

export interface RtmRow {
  r: string;
  cr: string[];
  req: string[];
  dsg: string[];
  state: 'covered' | 'partial' | 'uncovered' | 'deferred';
}

export interface RtmView {
  rows: RtmRow[];
  deferred: string[];
}

export interface HealthGap {
  code: string;
  target: string;
  message: string;
}

export interface HealthView {
  ok: boolean;
  l0a: number;
  l0b: number;
  l0c: number;
  l0d: number;
  thresholds: { l0a: number; l0b: number; l0c: number };
  warnings: string[];
  gaps: HealthGap[];
  deferredItems: Array<{ nodeId: string }>;
  basisFingerprint: string;
}

/** 资料域参考清单项（A03-17；仅 content_final 可挂接，REQ-114） */
export interface ReferenceCandidate {
  fileId: string;
  name: string;
  status: string;
  contentFingerprint: string;
}

const base = (pid: string) => `/api/v1/projects/${pid}/requirements`;

export const reqApi = {
  listDocs: (pid: string) => api.get<{ items: DocListItem[] }>(`${base(pid)}/docs`),
  getDoc: (pid: string, kind: DocKind, v?: number) =>
    api.get<DocView>(`${base(pid)}/docs/${kind}${v !== undefined ? `?v=${v}` : ''}`),
  saveDraft: (pid: string, kind: DocKind, secId: string, md: string, baseVersion: number, baseFingerprint: string) =>
    api.post(`${base(pid)}/docs/${kind}/draft`, { secId, md, baseVersion, baseFingerprint }),
  undo: (pid: string, kind: DocKind) => api.post(`${base(pid)}/docs/${kind}:undo`, {}),
  redo: (pid: string, kind: DocKind) => api.post(`${base(pid)}/docs/${kind}:redo`, {}),
  commit: (pid: string, kind: DocKind, note: string, baseVersion: number) =>
    api.post<{ v: number }>(`${base(pid)}/docs/${kind}/versions:commit`, { note, baseVersion }),
  finalize: (pid: string, kind: DocKind, v: number, baseVersion: number) =>
    api.post<{ finalVer: number; finalizationId: string }>(
      `${base(pid)}/docs/${kind}/versions/${v}:finalize`, { baseVersion, confirm: true }),
  unlock: (pid: string, kind: DocKind) => api.post(`${base(pid)}/docs/${kind}:unlock`, {}),
  listVersions: (pid: string, kind: DocKind) =>
    api.get<{ items: VersionItem[] }>(`${base(pid)}/docs/${kind}/versions`),
  switchVersion: (pid: string, kind: DocKind, v: number) =>
    api.post(`${base(pid)}/docs/${kind}/versions/${v}:switch`, {}),
  listPatches: (pid: string, kind: DocKind) =>
    api.get<{ items: PatchItem[] }>(`${base(pid)}/docs/${kind}/patches`),
  acceptPatch: (pid: string, kind: DocKind, patchId: string, reason?: string) =>
    api.post(`${base(pid)}/docs/${kind}/patches/${patchId}:accept`, reason ? { reason } : {}),
  rejectPatch: (pid: string, kind: DocKind, patchId: string, reason?: string) =>
    api.post(`${base(pid)}/docs/${kind}/patches/${patchId}:reject`, reason ? { reason } : {}),
  addReference: (pid: string, kind: DocKind, fileId: string) =>
    api.post(`${base(pid)}/docs/${kind}/references`, { fileId }),
  removeReference: (pid: string, kind: DocKind, fileId: string) =>
    api.post(`${base(pid)}/docs/${kind}/references:remove`, { fileId }),
  referenceCandidates: (pid: string) =>
    api.get<{ items: ReferenceCandidate[] }>(`/api/v1/projects/${pid}/materials/references`),
  rtm: (pid: string) => api.get<RtmView>(`${base(pid)}/rtm`),
  health: (pid: string) => api.get<HealthView>(`${base(pid)}/rtm/health`),
  defer: (pid: string, nodeKind: 'cr' | 'req', code: string, reason: string) =>
    api.post(`${base(pid)}/rtm/${nodeKind}/${code}:defer`, { reason }),
  undefer: (pid: string, nodeKind: 'cr' | 'req', code: string) =>
    api.post(`${base(pid)}/rtm/${nodeKind}/${code}:undefer`, {}),
  exportDoc: (pid: string, kind: DocKind, v: number, format: 'md' | 'html' | 'docx' | 'pdf') =>
    api.post<{ downloadUrl: string; format: string }>(
      `${base(pid)}/docs/${kind}/versions/${v}:export`, { format }),
  genControl: (pid: string, kind: DocKind, operationId: string, action: 'pause' | 'resume' | 'stop') =>
    api.post(`${base(pid)}/docs/${kind}/generations/${operationId}:${action}`, {}),
};

/** SSE 帧（A04-4：stream.start 首帧带 operationId / stream.delta / stream.done / stream.error） */
export interface GenFrame {
  type: 'stream.start' | 'stream.delta' | 'stream.done' | 'stream.error';
  text?: string;
  operationId?: string;
  /** #5 生成来源：model=真模型 / mock=桩（未配 MSF_AI_PROVIDER 或路由缺失时） */
  source?: string;
  proposedPatchIds?: string[];
  code?: string;
}

/** A04-4 文档 AI 生成（POST-SSE，fetch+ReadableStream） */
export async function generateDoc(
  pid: string,
  kind: DocKind,
  body: { referenceFileIds: string[]; referenceFingerprints: Record<string, string>; instruction?: string },
  onFrame: (f: GenFrame) => void,
): Promise<void> {
  await postSse(`${base(pid)}/docs/${kind}:generate`, body, (line) => {
    try {
      onFrame(JSON.parse(line) as GenFrame);
    } catch {
      /* 忽略非 JSON 心跳行 */
    }
  });
}
