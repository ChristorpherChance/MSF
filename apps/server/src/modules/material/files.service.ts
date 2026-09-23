import { Inject, Injectable } from '@nestjs/common';
import { DomainError, type MatParseStatus } from '@msf/shared';
import { query } from '../../db/pool.js';
import { StorageService } from '../platform/storage.service.js';
import type { MatFile, MatFolderNode, MatParsed } from './types.js';

/**
 * 资料查询面（LLD-5 DSG-A03-5/6/7）：双目录树 / 文件列表 / 文件详情。
 * 纯读路径，不经 CommandBus（BR-04 命令事务只管写）；选择/折叠态属客户端会话不落库（DSG-D00）。
 */

export interface TreeNode {
  id: string;
  type: 'folder' | 'file';
  name: string;
  status?: MatParseStatus;
  /** 失败原因细化（needsOcr 带页码 / encrypted 拦截提示，DSG-U03-2 行内展示） */
  failMsg?: string | null;
  /** 内容面 ↳ 加工结果行（最新内容稿的附件名清单，M1 主稿+缩进行结构） */
  results?: string[] | undefined;
  children?: TreeNode[];
}

export interface FileListItem {
  id: string;
  code: string;
  name: string;
  ext: string;
  sizeBytes: number;
  status: MatParseStatus;
  source: string;
  unsupported: boolean;
  failMsg: string | null;
  folderId: string | null;
  uploadedAt: string;
}

@Injectable()
export class FilesService {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  /** A03-5 双目录树：原件树与解析稿树一一对应（mirror_id 互指；原件树只增不改 REQ-105） */
  async tree(projectId: string): Promise<{ originalTree: TreeNode[]; parsedTree: TreeNode[] }> {
    const folders = await query<MatFolderNode>(
      'SELECT * FROM mat_folder_tree WHERE project_id=$1 ORDER BY sort_no, created_at',
      [projectId],
    );
    const files = await query<MatFile>('SELECT * FROM mat_files WHERE project_id=$1', [projectId]);
    const parsed = await query<MatParsed & { file_name: string; parse_status: MatParseStatus }>(
      `SELECT p.*, f.name AS file_name, f.parse_status FROM mat_parsed p
       JOIN mat_files f ON f.id = p.file_id
       WHERE p.project_id=$1 AND p.kind='file_parse' AND p.status != 'discarded'`,
      [projectId],
    );
    // 内容稿附件（加工结果 ↳ 缩进行）：每文件取最新一条内容稿
    const contents = await query<{ file_id: string; attachments: unknown }>(
      `SELECT DISTINCT ON (file_id) file_id, attachments FROM mat_parsed
       WHERE project_id=$1 AND kind='content_parse' AND status != 'discarded'
       ORDER BY file_id, created_at DESC`,
      [projectId],
    );
    const resultsByFile = new Map(
      contents.rows.map((r) => [
        r.file_id,
        (Array.isArray(r.attachments) ? r.attachments : [])
          .map((a) => (a && typeof a === 'object' ? String((a as { name?: unknown }).name ?? '') : ''))
          .filter(Boolean),
      ]),
    );
    return {
      originalTree: buildTree(folders.rows.filter((f) => f.tree === 'original'), files.rows),
      parsedTree: buildTree(
        folders.rows.filter((f) => f.tree === 'parsed'),
        parsed.rows.map((p) => ({
          id: p.file_id,
          name: p.file_name,
          folder_id: p.folder_id,
          parse_status: p.parse_status,
          results: resultsByFile.get(p.file_id) ?? [],
        })),
      ),
    };
  }

  /** A03-6 文件列表：状态过滤（逗号多值）+ 目录过滤 + 分页（默认 20，N01-3） */
  async list(
    projectId: string,
    opts: { status?: string | undefined; folderId?: string | undefined; page?: number | undefined; pageSize?: number | undefined },
  ): Promise<{ items: FileListItem[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const conds = ['project_id = $1'];
    const params: unknown[] = [projectId];
    if (opts.status) {
      const statuses = opts.status.split(',').map((s) => s.trim());
      params.push(statuses);
      conds.push(`parse_status = ANY($${params.length})`);
    }
    if (opts.folderId) {
      params.push(opts.folderId);
      conds.push(`folder_id = $${params.length}`);
    }
    const where = conds.join(' AND ');
    const total = await query<{ n: string }>(`SELECT count(*) AS n FROM mat_files WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const rows = await query<MatFile>(
      `SELECT * FROM mat_files WHERE ${where} ORDER BY created_at DESC, code LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: rows.rows.map((f) => ({
        id: f.id,
        code: f.code,
        name: f.name,
        ext: f.ext,
        sizeBytes: Number(f.size_bytes),
        status: f.parse_status,
        source: f.source,
        unsupported: f.unsupported,
        failMsg: f.parse_error,
        folderId: f.folder_id,
        uploadedAt: f.created_at,
      })),
      total: Number(total.rows[0]?.n ?? 0),
      page,
      pageSize,
    };
  }

  /** A03-17 需求参考输入清单：仅 content_final 为合法参考输入（REQ-114/115） */
  async references(projectId: string): Promise<{ items: Array<{ fileId: string; name: string; status: string; contentFingerprint: string }> }> {
    const r = await query<{ file_id: string; name: string; content_fingerprint: string }>(
      `SELECT f.id AS file_id, f.name, p.content_fingerprint FROM mat_files f
       JOIN mat_parsed p ON p.file_id=f.id AND p.kind='content_parse' AND p.status='final'
       WHERE f.project_id=$1 AND f.parse_status='content_final' ORDER BY f.code`,
      [projectId],
    );
    return {
      items: r.rows.map((row) => ({
        fileId: row.file_id,
        name: row.name,
        status: 'content_final',
        contentFingerprint: `sha256:${row.content_fingerprint}`,
      })),
    };
  }

  /** REQ-115 基线校验：生成请求登记的参考指纹与现状比对，变化即拒绝提交（供 M2+ 生成命令内调用） */
  async verifyReferences(
    projectId: string,
    refs: Array<{ fileId: string; contentFingerprint: string }>,
  ): Promise<void> {
    const current = await this.references(projectId);
    const byId = new Map(current.items.map((i) => [i.fileId, i.contentFingerprint]));
    for (const ref of refs) {
      if (byId.get(ref.fileId) !== ref.contentFingerprint) {
        throw new DomainError('REFERENCE_STALE', '参考输入在执行期发生变化，拒绝提交', ref.fileId, {
          registered: ref.contentFingerprint,
          current: byId.get(ref.fileId) ?? null,
        });
      }
    }
  }

  /** A03-7 文件详情：parsed=文件解析稿 / content=内容整理稿 / source=MinIO 短时签名直链 */
  /** 原件下载（⬇ 工具栏；签名 URL 5 分钟） */
  async download(projectId: string, fileId: string): Promise<{ name: string; url: string }> {
    const r = await query<MatFile>('SELECT * FROM mat_files WHERE id=$1 AND project_id=$2', [fileId, projectId]);
    const file = r.rows[0];
    if (!file) throw new DomainError('NOT_FOUND', '文件不存在', fileId);
    return { name: file.name, url: await this.storage.presignedGet(file.object_key) };
  }

  async detail(
    projectId: string,
    fileId: string,
    view: 'parsed' | 'content' | 'source',
  ): Promise<Record<string, unknown>> {
    const r = await query<MatFile>('SELECT * FROM mat_files WHERE id=$1 AND project_id=$2', [
      fileId,
      projectId,
    ]);
    const file = r.rows[0];
    if (!file) throw new DomainError('NOT_FOUND', '文件不存在', fileId);
    if (view === 'source') {
      return { id: file.id, name: file.name, url: await this.storage.presignedGet(file.object_key) };
    }
    const kind = view === 'parsed' ? 'file_parse' : 'content_parse';
    const p = await query<MatParsed>(
      `SELECT * FROM mat_parsed WHERE file_id=$1 AND kind=$2 AND status != 'discarded'
       ORDER BY created_at DESC LIMIT 1`,
      [fileId, kind],
    );
    const row = p.rows[0];
    return {
      id: file.id,
      status: file.parse_status,
      parsedMd: view === 'parsed' ? (row?.body_md ?? null) : undefined,
      contentMd: view === 'content' ? (row?.body_md ?? null) : undefined,
      attachments: row?.attachments ?? [],
      ops: row?.ops ?? [],
      contentFingerprint: row ? `sha256:${row.content_fingerprint}` : null,
    };
  }
}

/** 目录节点 + 文件行装配为嵌套树（parent_id/folder_id 为 NULL 即根层） */
function buildTree(
  folders: MatFolderNode[],
  files: Array<{
    id: string;
    name: string;
    folder_id: string | null;
    parse_status: MatParseStatus;
    parse_error?: string | null;
    results?: string[];
  }>,
): TreeNode[] {
  const byParent = new Map<string | null, MatFolderNode[]>();
  for (const f of folders) {
    const list = byParent.get(f.parent_id) ?? [];
    list.push(f);
    byParent.set(f.parent_id, list);
  }
  const filesByFolder = new Map<string | null, typeof files>();
  for (const f of files) {
    const list = filesByFolder.get(f.folder_id) ?? [];
    list.push(f);
    filesByFolder.set(f.folder_id, list);
  }
  const assemble = (parentId: string | null): TreeNode[] => {
    const nodes: TreeNode[] = (byParent.get(parentId) ?? []).map((f) => ({
      id: f.id,
      type: 'folder',
      name: f.name,
      children: assemble(f.id),
    }));
    for (const file of filesByFolder.get(parentId) ?? []) {
      nodes.push({
        id: file.id,
        type: 'file',
        name: file.name,
        status: file.parse_status,
        failMsg: file.parse_error ?? null,
        results: file.results,
      });
    }
    return nodes;
  };
  return assemble(null);
}
