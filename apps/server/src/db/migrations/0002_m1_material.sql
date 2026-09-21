-- M1 资料域（M03）第一批：mat_files / mat_parsed / mat_folder_tree
-- 口径：LLD-4 DSG-D03-2/3/4；枚举值以 LLD-2 F02-3 状态机与 LLD-4 CHECK 为权威
BEGIN;

-- 双目录树（先建：mat_files.folder_id / mat_parsed.folder_id 引用它）
CREATE TABLE IF NOT EXISTS mat_folder_tree (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  tree text NOT NULL CHECK (tree IN ('original','parsed')),
  parent_id uuid REFERENCES mat_folder_tree(id),
  name text NOT NULL,
  mirror_id uuid REFERENCES mat_folder_tree(id),
  sort_no int NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mat_folder_tree_project_idx ON mat_folder_tree (project_id, tree, parent_id);

-- 资料原件（REQ-102/103/107/108；原件永久保留、只增不改 REQ-105）
CREATE TABLE IF NOT EXISTS mat_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,
  name text NOT NULL,
  ext text NOT NULL,
  size_bytes bigint NOT NULL,
  object_key text NOT NULL,
  content_fingerprint char(64) NOT NULL,
  source text NOT NULL CHECK (source IN ('upload','zip_extract','inline_extract')),
  zip_parent_id uuid REFERENCES mat_files(id),
  zip_check jsonb,
  parse_status text NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending','parsing','parsed','failed','file_final','content_final')),
  unsupported boolean NOT NULL DEFAULT false,
  parse_error text,
  finalized_by text,
  finalized_at timestamptz,
  folder_id uuid REFERENCES mat_folder_tree(id),
  audit_trail jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code),
  UNIQUE (project_id, object_key)
);
CREATE INDEX IF NOT EXISTS mat_files_status_idx ON mat_files (project_id, parse_status);
CREATE INDEX IF NOT EXISTS mat_files_folder_idx ON mat_files (project_id, folder_id);
CREATE INDEX IF NOT EXISTS mat_files_fingerprint_idx ON mat_files (content_fingerprint);

-- 解析稿 / 内容整理稿（REQ-109：解析行可独立删除=业务状态 discarded，非软删，原件永不受影响 D19）
CREATE TABLE IF NOT EXISTS mat_parsed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  file_id uuid NOT NULL REFERENCES mat_files(id),
  kind text NOT NULL CHECK (kind IN ('file_parse','content_parse')),
  body_md text NOT NULL,
  content_fingerprint char(64) NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  ops jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','discarded')),
  delete_guard jsonb,
  referenced_by jsonb NOT NULL DEFAULT '[]',
  folder_id uuid REFERENCES mat_folder_tree(id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS mat_parsed_file_idx ON mat_parsed (file_id, kind);
CREATE INDEX IF NOT EXISTS mat_parsed_status_idx ON mat_parsed (project_id, status);
CREATE INDEX IF NOT EXISTS mat_parsed_fingerprint_idx ON mat_parsed (content_fingerprint);

COMMIT;
