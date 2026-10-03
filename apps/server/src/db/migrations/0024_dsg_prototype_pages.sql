-- 页级原型工件索引（单页 UI 原型 AI 生成 + 汇总完整原型）
-- 注：dsg_prototype_pages 为 LLD-4 未列的补充表（页级原型生成的工作工件索引；工件本体在 MinIO 内容寻址
--     sha256/<hex>，不可变；汇总版本 dsg_versions.content manifest 冻结当时 object_key/指纹，旧版预览永久有效），
--     差异登记于 doc/dev-plan，待 13 册下轮基线回补（同 0006 dsg_plans 先例）。
BEGIN;

CREATE TABLE IF NOT EXISTS dsg_prototype_pages (
  project_id uuid NOT NULL REFERENCES projects(id),
  page_code text NOT NULL,                -- 目录 page 条目 code（dsg_catalog_items.code）
  catalog_version text NOT NULL,          -- 生成依据：plan 锁定的目录版本（滞后判定对齐 plan 侧）
  object_key text NOT NULL,               -- MinIO 内容寻址 key（sha256/<hex>，不可变）
  html_fingerprint char(64) NOT NULL,     -- 页 HTML sha256（滞后实时比对依据）
  source text NOT NULL CHECK (source IN ('model','mock')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, page_code)
);

COMMIT;
