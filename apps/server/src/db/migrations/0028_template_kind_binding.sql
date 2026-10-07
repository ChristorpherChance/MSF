-- 模板套件·文档类别级绑定（2026-10-07 用户拍板：「每个阶段不同文档里可查看并选择其他套件/默认的模板」）。
-- 解析链三级：prj_template_kind_binding（项目×文档类别指定）→ prj_template_binding（项目套件）
-- → 代码默认。套件删除改级联解绑（绑定的项目自动回退默认，不再拒绝——「新增的都应该可以删除」）。
BEGIN;

CREATE TABLE IF NOT EXISTS prj_template_kind_binding (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL,                     -- 内置十类或 x- 自定义类别
  set_id uuid NOT NULL REFERENCES sys_template_sets(id) ON DELETE CASCADE,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind)
);

COMMIT;
