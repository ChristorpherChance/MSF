-- M3 设计域（M05）：dsg_documents / dsg_versions / dsg_drafts / dsg_reviews /
--   dsg_catalog_items / dsg_catalog_refs / dsg_prototype_checks / dsg_baselines / dsg_plans
-- 口径：LLD-4 DSG-D05-1~8 逐字段；append-only（§4 总则）：dsg_versions、dsg_prototype_checks、dsg_baselines
-- 注：dsg_plans 为 LLD-4 未列的补充表（任务分解 M3 注②；A05-5 planId/fingerprint/basedOn 需要规划快照持久化），
--     差异登记于 doc/dev-plan/M3-验收.md，待 13 册下轮基线回补。
BEGIN;

-- D05-1 设计文档（HLD 一册 + LLD 七册 + 原型；UNIQUE(project_id, doc_kind)）
CREATE TABLE IF NOT EXISTS dsg_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  doc_kind text NOT NULL CHECK (doc_kind IN ('hld','mod','alg','cls','db','api','ui','nfr','prototype')),
  name text NOT NULL,
  chapter_prefix char(1) NOT NULL,     -- h/o/g/k/d/a/u/n（REQ-302；prototype 册占 'p' 不参与章节体系）
  current_version_id uuid,             -- FK 在 dsg_versions 建后补（循环引用）
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

-- D05-2 设计文档版本（append-only；prototype 册 content=manifest JSONB 序列化、content_object_key=HTML 对象）
CREATE TABLE IF NOT EXISTS dsg_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES dsg_documents(id),
  version_no int NOT NULL,
  content text NOT NULL,
  content_object_key text,
  content_fingerprint char(64) NOT NULL,
  governing_fingerprint char(64) NOT NULL,  -- 上游定稿组合（PRD→HLD→LLD 消费链，REQ-302 门禁）
  refs jsonb NOT NULL DEFAULT '[]',
  note text,
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);
CREATE INDEX IF NOT EXISTS dsg_versions_fp_idx ON dsg_versions (content_fingerprint);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dsg_documents_cur_fk') THEN
    ALTER TABLE dsg_documents
      ADD CONSTRAINT dsg_documents_cur_fk FOREIGN KEY (current_version_id) REFERENCES dsg_versions(id),
      ADD CONSTRAINT dsg_documents_final_fk FOREIGN KEY (final_version_id) REFERENCES dsg_versions(id);
  END IF;
END $$;

-- D05-3 设计单一草稿（与 req_drafts 同构）
CREATE TABLE IF NOT EXISTS dsg_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL UNIQUE REFERENCES dsg_documents(id),
  base_version_id uuid NOT NULL REFERENCES dsg_versions(id),
  base_content_fingerprint char(64) NOT NULL,
  content text NOT NULL,
  undo_stack jsonb NOT NULL DEFAULT '[]',
  redo_stack jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz
);

-- 设计待确认补丁（补充表：A05-1 声明补丁复用需求域形态，但 D05 未列表；同 dsg_plans 一并登记验收）
CREATE TABLE IF NOT EXISTS dsg_pendings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES dsg_documents(id),
  patch jsonb NOT NULL,
  target_fingerprint char(64) NOT NULL,
  proposed_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','stale')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dsg_pendings_doc_idx ON dsg_pendings (document_id, status);

-- D05-4 设计目录（REQ-304：从已定稿 PRD/HLD/LLD 识别的独立设计目录）
CREATE TABLE IF NOT EXISTS dsg_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  catalog_version text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('requirement','page','flow','state','control','field','role','viewport','non_ui')),
  code text NOT NULL,
  payload jsonb NOT NULL,
  required boolean NOT NULL DEFAULT false,   -- 必需页面/流程/状态（缺失阻断定稿，REQ-308）
  source text NOT NULL DEFAULT 'identified' CHECK (source IN ('identified','manual')),  -- A05-13 人工补充标记
  content_fingerprint char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  UNIQUE (project_id, catalog_version, item_type, code)
);
CREATE INDEX IF NOT EXISTS dsg_catalog_items_ver_idx ON dsg_catalog_items (project_id, catalog_version, item_type);
CREATE INDEX IF NOT EXISTS dsg_catalog_items_payload_gin ON dsg_catalog_items USING GIN (payload);

-- D05-5 目录追溯引用（REQ-304 追溯到章节锚点；REQ-312 双向审计：上游删除/锚点不符即失败）
CREATE TABLE IF NOT EXISTS dsg_catalog_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES dsg_catalog_items(id),
  ref_kind text NOT NULL CHECK (ref_kind IN ('hld','lld','prd','src','task')),
  doc_kind text,
  section_id text,
  anchor text,
  rule_text text,                  -- 被引用条款原文快照（审计比对依据）
  ref_fingerprint char(64) NOT NULL,
  ruleset_version text NOT NULL,   -- 来源审计规则集版本（REQ-312 版本化）
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dsg_catalog_refs_item_idx ON dsg_catalog_refs (item_id);
CREATE INDEX IF NOT EXISTS dsg_catalog_refs_anchor_idx ON dsg_catalog_refs (doc_kind, section_id);

-- D05-6 原型检查记录（append-only；REQ-306/311）
CREATE TABLE IF NOT EXISTS dsg_prototype_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  run_no int NOT NULL,
  catalog_fingerprint char(64) NOT NULL,  -- 被检目录指纹（BR-07：目录变则检查失效）
  prototype_version_id uuid NOT NULL REFERENCES dsg_versions(id),
  issues jsonb NOT NULL,
  auto_fixable jsonb NOT NULL DEFAULT '[]',
  unverified jsonb NOT NULL DEFAULT '[]',  -- 无法识别条款标「未验证/需人工」，不静默忽略（REQ-306）
  passed boolean NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, run_no)
);

-- D05-7 设计基线（append-only；工件版本组合+内容指纹，不复制内容，REQ-308/309）
CREATE TABLE IF NOT EXISTS dsg_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,
  finalization_id text NOT NULL,
  items jsonb NOT NULL,               -- [{artifact, version_id, fingerprint, required, status}]
  baseline_fingerprint char(64) NOT NULL,
  valid boolean NOT NULL DEFAULT true,  -- 失效标记（查询时仍实时比对，LLD-4 §14）
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  reconfirmed_of uuid REFERENCES dsg_baselines(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS dsg_baselines_project_idx ON dsg_baselines (project_id, confirmed_at DESC);

-- D05-8 设计评审项（DR 系列，REQ-303）
CREATE TABLE IF NOT EXISTS dsg_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('高','中','低')),
  doc_kind text NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  resolution text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  UNIQUE (project_id, code)
);

-- 原型规划快照（补充表，任务分解 M3 注②；A05-5 plan 身份+治理输入指纹+完整快照）
CREATE TABLE IF NOT EXISTS dsg_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  plan_no int NOT NULL,
  catalog_version text NOT NULL,
  catalog_fingerprint char(64) NOT NULL,
  governing_fingerprint char(64) NOT NULL,  -- 规划依据（已定稿 PRD/HLD 等组合）
  snapshot jsonb NOT NULL,                  -- 完整规划快照（目录条目+追溯）
  complete boolean NOT NULL,
  plan_fingerprint char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, plan_no)
);

COMMIT;
