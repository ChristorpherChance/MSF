import { api, postSse } from '../../api';
import { useStagesStore } from '../../ui/GateBanner';

/** 设计域 API 封装（LLD-5 DSG-A05-1~13；路径前缀 /api/v1/projects/:pid/design） */

/** U-015：定稿类写操作成功后立即刷新顶栏准入门禁 */
const refreshGates = (pid: string) => void useStagesStore.getState().load(pid);

export type DesignKind = 'hld' | 'mod' | 'alg' | 'cls' | 'db' | 'api' | 'ui' | 'nfr';

export interface DesignDocItem {
  id: string; kind: DesignKind; book: string; title: string;
  cur: number; finalVer: number; finalized: boolean; modified: boolean; pendingCount: number;
  /** 上游变更联动（2026-10-05）：PRD 已有更新版本提交，本册内容可能滞后 */
  upstreamStale?: boolean; upstreamVersionNo?: number;
}

export interface DesignDocView {
  id: string; kind: string; cur: number; viewing: number | null;
  finalized: boolean; finalVer: number; modified: boolean; genState: string;
  secs: Array<{ id: string; title: string; md: string; pending: string | null }>;
  version: number; contentFingerprint: string;
  /** W2-025：undo/redo 栈实态（与需求域同口径） */
  canUndo?: boolean; canRedo?: boolean;
  /** 上游变更联动：PRD 已提交更新版本，本册内容可能滞后（h1 徽标） */
  upstreamStale?: boolean; upstreamVersionNo?: number;
}

export interface PatchItem {
  patchId: string; secId: string; type: 'add' | 'modify' | 'del' | 'replace';
  title?: string; old?: string; new?: string; status: string; source: string;
}

export interface ReviewItem {
  id: string; severity: string; docKind: string; item: string;
  status: 'open' | 'done'; conclusion: string | null; at: string | null;
  /** 落项来源（created_by 透出）：'pi'=AI 自检评审产出（带来源标），其余=种子/人工 */
  by: string;
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
  /** 页级原型工作态（差异登记）：none=未生成 / pending=已生成待汇总 / assembled=已入当前汇总版本；
   *  uiRef/uiStale=结构化对应（覆盖检测 §2）：页依据的 ui 册章节锚点 + 时间基滞后（ui 册有新提交） */
  pages: Array<{
    code: string; title: string; state: 'none' | 'pending' | 'assembled'; source?: string;
    reqIds?: string[]; uiRef?: { sectionId: string | null; anchor: string | null } | null; uiStale?: boolean;
  }>;
  /** 存在「页已更新未汇总」 */
  pagesStale: boolean;
  /** 依据的 ui 册已变更的页码清单（时间基滞后；为顶层横幅预留——当前行内徽标消费 pages[].uiStale） */
  uiStalePages?: string[];
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
    api.post(`${base(pid)}/docs/${kind}/versions/${v}:finalize`, { baseVersion, confirm: true, allowOpenReviews })
      .then((r) => { refreshGates(pid); return r; }),
  /** 批量定稿（详细七册；逐册独立、失败跳过并列原因——2026-10-16 拍板） */
  finalizeAll: (pid: string, allowOpenReviews: boolean) =>
    api.post<{ finalized: Array<{ kind: DesignKind; v: number; finalizationId: string }>; skipped: Array<{ kind: DesignKind; reason: string }> }>(
      `${base(pid)}/docs:batch-finalize`, { confirm: true, allowOpenReviews })
      .then((r) => { refreshGates(pid); return r; }),
  unlock: (pid: string, kind: DesignKind) => api.post(`${base(pid)}/docs/${kind}:unlock`, {}),
  listVersions: (pid: string, kind: DesignKind) =>
    api.get<{ items: Array<{ v: number; note: string | null; at: string; finalized: boolean }> }>(`${base(pid)}/docs/${kind}/versions`),
  switchVersion: (pid: string, kind: DesignKind, v: number) =>
    api.post(`${base(pid)}/docs/${kind}/versions/${v}:switch`, {}),
  /** L1：服务端导出（md/docx/pdf，审计留痕；与 req 域同构） */
  exportDoc: (pid: string, kind: DesignKind, v: number, format: 'md' | 'html' | 'docx' | 'pdf') =>
    api.post<{ downloadUrl: string; format: string }>(`${base(pid)}/docs/${kind}/versions/${v}:export`, { format }),
  listPatches: (pid: string, kind: DesignKind) => api.get<{ items: PatchItem[] }>(`${base(pid)}/docs/${kind}/patches`),
  /** 处置留痕+改后接受（需求阶段模式推广：reason/newText 与 req 域同口径） */
  acceptPatch: (pid: string, kind: DesignKind, patchId: string, reason?: string, newText?: string) =>
    api.post(`${base(pid)}/docs/${kind}/patches/${patchId}:accept`, {
      ...(reason ? { reason } : {}),
      ...(newText !== undefined ? { newText } : {}),
    }),
  rejectPatch: (pid: string, kind: DesignKind, patchId: string, reason?: string) =>
    api.post(`${base(pid)}/docs/${kind}/patches/${patchId}:reject`, reason ? { reason } : {}),
  genControl: (pid: string, kind: DesignKind, operationId: string, action: 'pause' | 'resume' | 'stop') =>
    api.post(`${base(pid)}/docs/${kind}/generations/${operationId}:${action}`, {}),

  reviews: (pid: string) => api.get<{ items: ReviewItem[] }>(`${base(pid)}/reviews`),
  conclude: (pid: string, drId: string, conclusion: 'pass' | 'fail' | 'na', note: string) =>
    api.post(`${base(pid)}/reviews/${drId}:conclude`, { conclusion, note }),
  /** S8 🔁 重置种子项（幂等补齐三条内置种子条目；与 selfcheckReviews 的 AI 复核是两个动作） */
  reseedReviews: (pid: string) => api.post<{ seeded: boolean; count: number }>(`${base(pid)}/reviews:reseed`, {}),
  /** ✦ AI 自检评审（过度设计候选逐节复核落真实 DR 项；后台跑——返回候选码集，进度=轮询 DR 列表） */
  selfcheckReviews: (pid: string) =>
    api.post<{ started: boolean; candidates: string[] }>(`${base(pid)}/reviews:selfcheck`, {}),
  /** S8 已解决项重新打开 */
  reopenReview: (pid: string, drId: string) => api.post(`${base(pid)}/reviews/${drId}:reopen`, {}),

  catalog: (pid: string) => api.get<CatalogView>(`${base(pid)}/catalog`),
  addCatalogItem: (pid: string, input: { itemType: string; code: string; title: string; note?: string }) =>
    api.post(`${base(pid)}/catalog/items`, input),
  removeCatalogItem: (pid: string, itemId: string) => api.del(`${base(pid)}/catalog/items/${itemId}`),
  /** 目录条目字段修订（title/note/steps/exempt 白名单；改即新目录版本） */
  updateCatalogItem: (pid: string, itemId: string, input: { title?: string; note?: string; steps?: string[]; exempt?: boolean }) =>
    api.put(`${base(pid)}/catalog/items/${itemId}`, input),

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
      { prototypeVersionId, checkReportId, confirm: true })
      .then((r) => { refreshGates(pid); return r; }),
  /** W7-003 原型解除定稿（spec ⋯ 菜单「解锁定稿」；解锁后基线实时失效，可重新生成） */
  protoUnlock: (pid: string) =>
    api.post<{ unlocked: boolean }>(`${base(pid)}/prototype:unlock`, {})
      .then((r) => { refreshGates(pid); return r; }),
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
  type: 'stream.start' | 'stream.delta' | 'stream.done' | 'stream.error' | 'stream.notice';
  text?: string; operationId?: string; code?: string;
  /** #5 生成来源：model=真模型 / mock=桩 */
  source?: string;
  /** W2-002：error 帧携带的脱敏失败原因 */
  message?: string;
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

/** 页级 UI 原型 POST-SSE 生成（四帧协议同 generateDesignDoc；done 帧带 pageCode+fingerprint） */
export async function generateProtoPage(
  pid: string, pageCode: string,
  onFrame: (f: GenFrame & { pageCode?: string; fingerprint?: string; status?: string }) => void,
): Promise<void> {
  await postSse(`${base(pid)}/prototype/pages/${encodeURIComponent(pageCode)}:generate`, {}, (line) => {
    try { onFrame(JSON.parse(line) as GenFrame & { pageCode?: string; fingerprint?: string; status?: string }); } catch { /* 忽略非 JSON 心跳行 */ }
  });
}
