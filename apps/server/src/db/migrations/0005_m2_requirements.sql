-- M2 需求域（M04）：req_documents / req_versions / req_drafts / req_pendings / rtm_links / rtm_health / req_doc_refs
-- 口径：LLD-4 DSG-D04-1~7 逐字段；append-only 清单（LLD-4 §4 总则）：req_versions、rtm_health
BEGIN;

-- D04-1 需求文档（CRD/PRD 两工作面；UNIQUE(project_id, doc_kind) 每类一份）
CREATE TABLE IF NOT EXISTS req_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  doc_kind text NOT NULL CHECK (doc_kind IN ('crd','prd')),
  current_version_id uuid,          -- FK 在 req_versions 建后补（循环引用）
  final_version_id uuid,
  modified boolean NOT NULL DEFAULT false,
  gen_state text NOT NULL DEFAULT 'idle' CHECK (gen_state IN ('idle','generating','paused','done','failed')),
  lock_owner text,
  lock_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  UNIQUE (project_id, doc_kind)
);

-- D04-2 需求文档版本（append-only：字节不可变、编号不复用，REQ-209/BR-05）
CREATE TABLE IF NOT EXISTS req_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES req_documents(id),
  version_no int NOT NULL,
  content text NOT NULL,
  content_object_key text,
  content_fingerprint char(64) NOT NULL,
  governing_fingerprint char(64) NOT NULL,
  refs jsonb NOT NULL DEFAULT '[]',
  note text,
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);
CREATE INDEX IF NOT EXISTS req_versions_fp_idx ON req_versions (content_fingerprint);

ALTER TABLE req_documents
  ADD CONSTRAINT req_documents_cur_fk FOREIGN KEY (current_version_id) REFERENCES req_versions(id),
  ADD CONSTRAINT req_documents_final_fk FOREIGN KEY (final_version_id) REFERENCES req_versions(id);

-- D04-3 单一工作草稿（每文档至多一条；undo/redo 栈上限 30 由服务层不变式保证）
CREATE TABLE IF NOT EXISTS req_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL UNIQUE REFERENCES req_documents(id),
  base_version_id uuid NOT NULL REFERENCES req_versions(id),
  base_content_fingerprint char(64) NOT NULL,
  content text NOT NULL,
  undo_stack jsonb NOT NULL DEFAULT '[]',
  redo_stack jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz
);

-- D04-4 待确认补丁（REQ-205：AI 提案不直接落稿，人工逐条裁决）
CREATE TABLE IF NOT EXISTS req_pendings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES req_documents(id),
  patch jsonb NOT NULL,
  target_fingerprint char(64) NOT NULL,
  proposed_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','stale')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS req_pendings_doc_idx ON req_pendings (document_id, status);

-- D04-5 RTM 追踪链（注册例外表名；deferred/dropped 显式 relation，不计 L0a/b/c 分母、计 L0d）
-- 实现口径：派生链（refines/implements）在版本提交同事务由内容锚点重建；人工标记行 from==to 自指，派生重建不动
CREATE TABLE IF NOT EXISTS rtm_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  from_kind text NOT NULL,
  from_code text NOT NULL,
  to_kind text NOT NULL,
  to_code text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('refines','implements','verifies','deferred','dropped')),
  basis_version_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rtm_links_from_idx ON rtm_links (project_id, from_kind, from_code);
CREATE INDEX IF NOT EXISTS rtm_links_to_idx ON rtm_links (project_id, to_kind, to_code);

-- D04-6 RTM 健康度（append-only 度量留痕；四指标口径权威 PRD REQ-208）
CREATE TABLE IF NOT EXISTS rtm_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  measured_at timestamptz NOT NULL DEFAULT now(),
  l0a numeric(5,4) NOT NULL,
  l0b numeric(5,4) NOT NULL,
  l0c numeric(5,4) NOT NULL,
  l0d int NOT NULL DEFAULT 0,
  deferred_items jsonb NOT NULL DEFAULT '[]',
  gaps jsonb NOT NULL DEFAULT '[]',
  passed boolean NOT NULL,
  basis_fingerprint char(64) NOT NULL,
  created_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS rtm_health_project_idx ON rtm_health (project_id, measured_at DESC);

-- D04-7 需求文档参考关联（REQ-114 门禁过滤后的引用清单；反查失效传播锚点）
CREATE TABLE IF NOT EXISTS req_doc_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES req_documents(id),
  parsed_id uuid NOT NULL REFERENCES mat_parsed(id),
  content_fingerprint char(64) NOT NULL,
  ref_kind text NOT NULL DEFAULT 'material' CHECK (ref_kind IN ('material','upload_ref')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS req_doc_refs_doc_idx ON req_doc_refs (document_id);
CREATE INDEX IF NOT EXISTS req_doc_refs_parsed_idx ON req_doc_refs (parsed_id);

COMMIT;
