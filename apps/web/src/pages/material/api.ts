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
  /** 失败原因细化（needsOcr 带页码 / encrypted 提示） */
  failMsg?: string | null;
  /** 内容面 ↳ 加工结果行（内容稿附件名清单） */
  results?: string[];
  /** 内容稿状态（draft=已保存编辑中 / final=内容已定稿 / null=未起草）——内容面独立显示 */
  contentStatus?: 'draft' | 'final' | null;
  children?: TreeNode[];
}

export interface FileDetail {
  id: string;
  status?: MatParseStatus;
  name?: string;
  url?: string;
  parsedMd?: string | null;
  contentMd?: string | null;
  /** 内容稿状态：none=待整理（底稿=解析稿）/ draft=内容稿已保存 / final=内容已定稿 */
  contentStatus?: 'draft' | 'final' | 'none';
  attachments?: Array<{ name?: string; by?: string }>;
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
  /** 原文件下载（⬇ 工具栏；签名 URL 5 分钟） */
  download: (pid: string, fileId: string) =>
    api.get<{ name: string; url: string }>(`${base(pid)}/files/${fileId}/download`),
  /** 文件双向同步删除（LLD-6 §3.2 delFile；理由必填；引用守卫 GATE_BLOCKED） */
  deleteFile: (pid: string, fileId: string, reason: string) =>
    api.del<{ deleted: string; children: number; parsedDiscarded: number }>(
      `${base(pid)}/files/${fileId}`,
      { reason },
    ),
  extractZip: (pid: string, fileId: string, onConflict: 'reject' | 'rename' = 'reject') =>
    api.post(`${base(pid)}/files/${fileId}:extract`, { onConflict }),
  /** 空目录删除（非空目录服务端 INVALID_STATE 拒绝；双树镜像同行） */
  deleteFolder: (pid: string, folderId: string) =>
    api.del<{ deleted: string; mirror: string | null }>(`${base(pid)}/folders/${folderId}`),
  /** 新建目录（U-012；parentId 为空=根目录；双树镜像同建） */
  createFolder: (pid: string, parentId: string | null, name: string) =>
    api.post<{ folderId: string }>(`${base(pid)}/folders`, { parentId, name }),
  /** 重命名目录（U-012；双树镜像同行） */
  renameFolder: (pid: string, folderId: string, name: string) =>
    api.post(`${base(pid)}/folders/${folderId}:rename`, { name }),
  parse: (pid: string, fileId: string) => api.post(`${base(pid)}/files/${fileId}:parse`, {}),
  retryParse: (pid: string, fileId: string) =>
    api.post(`${base(pid)}/files/${fileId}:retry-parse`, {}),
  saveDraft: (pid: string, fileId: string, contentMd: string, baseFingerprint: string) =>
    api.put(`${base(pid)}/files/${fileId}/content-draft`, { contentMd, baseFingerprint }),
  finalizeFile: (pid: string, fileId: string) =>
    api.post(`${base(pid)}/files/${fileId}:finalize-file`, {}),
  unfinalizeFile: (pid: string, fileId: string, reason: string) =>
    api.post(`${base(pid)}/files/${fileId}:unfinalize-file`, { reason }),
  finalizeContent: (pid: string, fileId: string, contentMd?: string) =>
    api.post(`${base(pid)}/files/${fileId}:finalize-content`, contentMd !== undefined ? { contentMd } : {}),
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
  createJob: (pid: string, kind: 'translate' | 'mask' | 'index', fileIds: string[], params?: Record<string, unknown>) =>
    api.post<{ jobId: string; operationId: string; basisFingerprint: string }>(
      `${base(pid)}/jobs`,
      { kind, fileIds, ...(params ? { params } : {}) },
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
): Promise<{ fileId: string; deduped: boolean; code?: string | undefined; name?: string | undefined }> {
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
  const done = await api.post<{ file: { id: string; code?: string; name?: string }; deduped?: boolean }>(
    `${base(pid)}/uploads/${session.uploadId}:complete`,
    {},
  );
  return { fileId: done.file.id, deduped: done.deduped ?? false, code: done.file.code, name: done.file.name };
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
