-- 模板套件+版本管理（2026-10-07 用户拍板：「目前只是保存覆盖是不适合的」——按项目创建/保存/复用一整套模板）。
-- 架构：套件全局可复用（sys_template_sets 无 project_id，与 ai_models 同口径）；项目绑定活动套件
-- （prj_template_binding）；套件内按 kind 存条目（未存条目的 kind 回退代码默认——「基于默认模板
-- 创建一整套」= 空套件+逐项编辑，回退链保证无缺项）。
-- 取代前日 sys_settings['doc_template_overrides'] 单覆盖设施（该设施上线一天、无在途数据——
-- 实机验证后已复位，直接弃用；差异登记 doc/dev-plan 待 13 册下轮基线回补 LLD-4）。
BEGIN;

CREATE TABLE IF NOT EXISTS sys_template_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,              -- 套件名（用户可读的版本管理单位：一整套=一个版本）
  description text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sys_template_set_items (
  set_id uuid NOT NULL REFERENCES sys_template_sets(id) ON DELETE CASCADE,
  kind text NOT NULL,                     -- 内置 crd|prd|hld|mod|alg|cls|db|api|ui|nfr；自定义类别用 x- 前缀命名空间（x-xxx）
  label text NOT NULL DEFAULT '',         -- 显示名（自定义类别必填；内置类别由 KIND_LABELS 派生）
  standard text NOT NULL,
  quality text NOT NULL,
  writing_rules jsonb NOT NULL,
  chapters jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_id, kind)
);

CREATE TABLE IF NOT EXISTS prj_template_binding (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  set_id uuid NOT NULL REFERENCES sys_template_sets(id) ON DELETE CASCADE,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
