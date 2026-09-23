-- W7 委派/设置/审计（E1-E6、C1-C8）：
-- - ai_prompt_versions.name：Prompt 版本可重命名（LLD-6 §3.9 pver-row ✏）
-- - ai_delegation_targets.endpoint/credential_ref/last_latency_ms：
--   注册向导端点字段 + 凭据引用（引用设置中已存凭据，不内嵌明文，DSG-U06-18）+ 连通测试延迟
-- - policy_gates.preconditions：放行策略前置条件编辑（§3.9 放行策略卡）
-- - sys_backups：备份历史列表（§3.9 备份卡历史下载，替代从通知文本正则解析 URL）

ALTER TABLE ai_prompt_versions ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE ai_delegation_targets ADD COLUMN IF NOT EXISTS endpoint text;
ALTER TABLE ai_delegation_targets ADD COLUMN IF NOT EXISTS credential_ref text;
ALTER TABLE ai_delegation_targets ADD COLUMN IF NOT EXISTS last_latency_ms int;

ALTER TABLE policy_gates ADD COLUMN IF NOT EXISTS preconditions jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS sys_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id text NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES projects(id),
  object_key text,                                -- 完成时落 MinIO 键；失败为 NULL
  include_evidence boolean NOT NULL DEFAULT true,
  table_count int NOT NULL DEFAULT 0,
  row_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS sys_backups_project_idx ON sys_backups (project_id, created_at DESC);
