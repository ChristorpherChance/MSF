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
};

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

/** M1 期项目来源：项目页属 M7，先取首个项目，无则建一个示例项目 */
export async function ensureProject(): Promise<ProjectRow> {
  const list = await api.get<ProjectRow[]>('/api/projects');
  if (list[0]) return list[0];
  return api.post<ProjectRow>('/api/projects', { name: '示例项目' });
}
