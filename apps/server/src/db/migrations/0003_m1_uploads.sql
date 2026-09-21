-- M1 资料域第二批：mat_uploads 分片上传会话（LLD-4 DSG-D03-7）
-- 非 append-only（统稿裁决 M6：显式声明）——parts/status/updated_at 经命令事务受控更新；
-- 会话完成/中止/过期后行保留留痕，不物理删除。
BEGIN;

CREATE TABLE IF NOT EXISTS mat_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  upload_id text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime text,
  declared_size bigint NOT NULL,
  declared_sha256 char(64) NOT NULL,
  folder_id uuid REFERENCES mat_folder_tree(id),
  part_size bigint NOT NULL,
  parts_total int NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','completed','aborted','expired')),
  expires_at timestamptz NOT NULL,
  file_id uuid REFERENCES mat_files(id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS mat_uploads_project_status_idx ON mat_uploads (project_id, status);
CREATE INDEX IF NOT EXISTS mat_uploads_expires_idx ON mat_uploads (expires_at) WHERE status = 'uploading';

COMMIT;
