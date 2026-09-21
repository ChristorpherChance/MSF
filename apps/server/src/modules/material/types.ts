import type {
  MatParseStatus,
  MatParsedKind,
  MatParsedStatus,
  MatTreeKind,
  MaterialSource,
  UploadSessionStatus,
} from '@msf/shared';

/**
 * M03 资料域行类型——与 LLD-4 DSG-D03-2/3/4 逐字段对应（表与枚举以 LLD-4 为权威）。
 * 仅作查询/写入的类型承载，业务不变式在服务层与命令内维护。
 */

/** DSG-D03-2 mat_files：资料原件（永久保留、只增不改，REQ-105） */
export interface MatFile {
  id: string;
  project_id: string;
  code: string; // 业务编号 F-0001，UNIQUE(project_id, code)，永不复用（BR-05）
  name: string;
  ext: string;
  size_bytes: string; // pg bigint → string
  object_key: string; // MinIO 内容寻址 sha256/<hex>，UNIQUE(project_id, object_key)
  content_fingerprint: string;
  source: MaterialSource;
  zip_parent_id: string | null;
  zip_check: Record<string, unknown> | null;
  parse_status: MatParseStatus;
  unsupported: boolean;
  parse_error: string | null;
  finalized_by: string | null;
  finalized_at: string | null;
  folder_id: string | null;
  audit_trail: unknown[];
  created_by: string;
  created_at: string;
}

/** DSG-D03-3 mat_parsed：解析稿/内容整理稿 */
export interface MatParsed {
  id: string;
  project_id: string;
  file_id: string;
  kind: MatParsedKind;
  body_md: string;
  content_fingerprint: string;
  attachments: unknown[];
  ops: unknown[];
  status: MatParsedStatus;
  delete_guard: Record<string, unknown> | null;
  referenced_by: unknown[];
  folder_id: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
}

/** DSG-D03-4 mat_folder_tree：双目录树节点（原件/解析稿一一对应，mirror_id 互指） */
export interface MatFolderNode {
  id: string;
  project_id: string;
  tree: MatTreeKind;
  parent_id: string | null;
  name: string;
  mirror_id: string | null;
  sort_no: number;
  created_by: string;
  created_at: string;
}

/** DSG-D03-7 mat_uploads.parts 元素：已收分片清单项 */
export interface UploadPart {
  part_number: number;
  size_bytes: number;
  sha256: string;
  object_key: string;
}

/** DSG-D03-7 mat_uploads：分片上传会话（非 append-only，统稿裁决 M6 显式声明） */
export interface MatUpload {
  id: string;
  project_id: string;
  upload_id: string;
  file_name: string;
  mime: string | null;
  declared_size: string; // pg bigint → string
  declared_sha256: string;
  folder_id: string | null;
  part_size: string;
  parts_total: number;
  parts: UploadPart[];
  status: UploadSessionStatus;
  expires_at: string;
  file_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string | null;
}
