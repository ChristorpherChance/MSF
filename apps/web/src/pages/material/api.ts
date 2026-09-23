import { api } from '../../api';
import type { MatParseStatus } from '@msf/shared';

/**
 * 资料域 API 封装（LLD-5 DSG-A03-1~18；路径前缀 /api/v1/projects/:pid/materials）。
 * 树/详情类型与服务端 FilesService 出参一致。
 */

export interface TreeNode {
  id: string;
  type: 'folder' | 'file';
  name: string;
  status?: MatParseStatus;
  children?: TreeNode[];
}

export interface FileDetail {
  id: string;
  status?: MatParseStatus;
  name?: string;
  url?: string;
  parsedMd?: string | null;
  contentMd?: string | null;
  attachments?: unknown[];
  ops?: Array<{ op: string; at?: string }>;
  contentFingerprint?: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  status?: 'active' | 'archived';
  is_demo?: boolean;
  created_at?: string;
  stage?: number;
}

const base = (pid: string) => `/api/v1/projects/${pid}/materials`;

export const materialApi = {
  tree: (pid: string) =>
    api.get<{ originalTree: TreeNode[]; parsedTree: TreeNode[] }>(`${base(pid)}/tree`),
  detail: (pid: string, fileId: string, view: 'parsed' | 'content' | 'source') =>
    api.get<FileDetail>(`${base(pid)}/files/${fileId}?view=${view}`),
  extractZip: (pid: string, fileId: string, onConflict: 'reject' | 'rename' = 'reject') =>
    api.post(`${base(pid)}/files/${fileId}:extract`, { onConflict }),
  parse: (pid: string, fileId: string) => api.post(`${base(pid)}/files/${fileId}:parse`, {}),
  retryParse: (pid: string, fileId: string) =>
    api.post(`${base(pid)}/files/${fileId}:retry-parse`, {}),
  saveDraft: (pid: string, fileId: string, contentMd: string, baseFingerprint: string) =>
    api.put(`${base(pid)}/files/${fileId}/content-draft`, { contentMd, baseFingerprint }),
  finalizeFile: (pid: string, fileId: string) =>
    api.post(`${base(pid)}/files/${fileId}:finalize-file`, {}),
  unfinalizeFile: (pid: string, fileId: string) =>
    api.post(`${base(pid)}/files/${fileId}:unfinalize-file`, {}),
  finalizeContent: (pid: string, fileId: string) =>
    api.post(`${base(pid)}/files/${fileId}:finalize-content`, {}),
  batchParse: (pid: string, fileIds: string[], onlyPending = true) =>
    api.post<{ accepted: number; rejected: Array<{ fileId: string; reason: string }>; jobId?: string }>(
      `${base(pid)}/files:batch-parse`,
      { fileIds, onlyPending },
    ),
  batchFinalizeContent: (pid: string, fileIds: string[]) =>
    api.post<{ results: Array<{ fileId: string; ok: boolean; reason?: string }> }>(
      `${base(pid)}/files:batch-finalize-content`,
      { fileIds, confirm: true }, // INV-BULK-1：强制人工确认后才调用
    ),
  createJob: (pid: string, kind: 'translate' | 'mask' | 'index', fileIds: string[]) =>
    api.post<{ jobId: string; operationId: string; basisFingerprint: string }>(
      `${base(pid)}/jobs`,
      { kind, fileIds },
    ),
  confirmJob: (pid: string, jobId: string) =>
    api.post(`${base(pid)}/jobs/${jobId}:confirm`, {}),
  getJob: (pid: string, jobId: string) =>
    api.get<JobView>(`${base(pid)}/jobs/${jobId}`),
  stopJob: (pid: string, jobId: string) => api.post(`${base(pid)}/jobs/${jobId}:stop`, {}),
  retryItem: (pid: string, jobId: string, fileId: string) =>
    api.post(`${base(pid)}/jobs/${jobId}/items/${fileId}:retry`, {}),
};

/** 加工作业视图（A03-16 出参；作业五态 + 行级五态，F02-4 权威） */
export interface JobView {
  jobId: string;
  code: string;
  kind: string;
  processType: string | null;
  status: 'idle' | 'confirming' | 'running' | 'done' | 'stopped';
  items: Array<{
    fileId: string;
    status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';
    error: string | null;
  }>;
}

/** 上传会话三段式（A03-1/2/3）：声明 → 分片（小文件单片）→ 完成；>50MB 按 16MB 分片 */
export async function uploadFile(
  pid: string,
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<{ fileId: string }> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const PART = 16 * 1024 * 1024;
  const partSize = buf.byteLength > 50 * 1024 * 1024 ? PART : undefined;
  const session = await api.post<{ uploadId: string; parts: number }>(
    `${base(pid)}/uploads`,
    { fileName: file.name, size: buf.byteLength, sha256, ...(partSize ? { partSize } : {}) },
  );
  const total = session.parts;
  for (let i = 0; i < total; i++) {
    const chunk = buf.slice(i * (partSize ?? buf.byteLength), (i + 1) * (partSize ?? buf.byteLength));
    await api.putRaw(`${base(pid)}/uploads/${session.uploadId}/parts/${i + 1}`, chunk);
    onProgress?.(i + 1, total);
  }
  const done = await api.post<{ file: { id: string } }>(
    `${base(pid)}/uploads/${session.uploadId}:complete`,
    {},
  );
  return { fileId: done.file.id };
}

/** 项目来源：会话已选项目优先（项目页「进入」写入），否则首个活跃项目，无则建示例项目 */
export async function ensureProject(): Promise<ProjectRow> {
  const { useSession } = await import('../../store');
  const sid = useSession.getState().projectId;
  const list = await api.get<ProjectRow[]>('/api/projects');
  const active = list.filter((p) => p.status !== 'archived');
  if (sid) {
    const hit = active.find((p) => p.id === sid);
    if (hit) return hit;
    useSession.getState().setProject(null); // 已归档/不存在，清会话
  }
  if (active[0]) {
    useSession.getState().setProject(active[0].id, active[0].name);
    return active[0];
  }
  return api.post<ProjectRow>('/api/projects', { name: '示例项目', isDemo: true });
}
