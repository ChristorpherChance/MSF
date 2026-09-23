-- M7 平台补齐（M13）：projects 补 is_demo/stage_gates；evd_events（D09-3）/sys_notifications（D10-5）/sys_settings（D10-4）；sys_tasks_view 跨域只读视图（D00 注，REQ-704）
BEGIN;

-- 项目：示例数据隔离（BR-15/U06-7）+ 阶段准入求值快照（D03-1，REQ-702）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS stage_gates jsonb NOT NULL DEFAULT '{}';

-- 领域事件流（append-only；与 audit_log 分工：audit 管写操作，events 管业务事实）
CREATE TABLE IF NOT EXISTS evd_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  kind text NOT NULL,                          -- doc.finalized / batch.received / defect.reopened / delegation.finished…
  payload jsonb NOT NULL DEFAULT '{}',         -- 领域事实快照（对象身份+关键指纹，不复制大内容）
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','assistant','sub-agent','autopilot','system')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evd_events_project_idx ON evd_events (project_id, kind, created_at DESC);

-- 通知中心（REQ-703；本期站内，user_id 空=全员）
CREATE TABLE IF NOT EXISTS sys_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  user_id text,                                -- NULL=全员
  type text NOT NULL,
  text text NOT NULL,
  unread boolean NOT NULL DEFAULT true,
  source_command_id uuid,                      -- 效果 ledger 产生时回填（notify 类效果）
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sys_notifications_user_idx ON sys_notifications (user_id, unread);
CREATE INDEX IF NOT EXISTS sys_notifications_project_idx ON sys_notifications (project_id, created_at DESC);

-- 系统设置（REQ-705；密钥类不落本表，走 ai_models.api_key_enc）
CREATE TABLE IF NOT EXISTS sys_settings (
  key text PRIMARY KEY,                        -- 点分层级键，如 zip.limits.maxEntries
  value jsonb NOT NULL,
  updated_by text NOT NULL DEFAULT 'local',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 策略切换授权留痕（D10-7；F10-2：manual↔auto 切换含理由与操作者）
CREATE TABLE IF NOT EXISTS policy_gate_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  gate_key text NOT NULL,
  from_mode text NOT NULL,
  to_mode text NOT NULL,
  reason text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policy_gate_events_project_idx ON policy_gate_events (project_id, created_at DESC);

-- 任务中心跨域只读视图（REQ-704：视图非表；各阶段已产生 Task 归并）
CREATE OR REPLACE VIEW sys_tasks_view AS
  SELECT id, project_id, 'dev'::text AS stage, code, title, run_status AS status, owner,
         created_at, updated_at
  FROM dev_tasks WHERE NOT archived AND NOT excluded
  UNION ALL
  SELECT id, project_id, 'test'::text, code, title, status, coalesce(assignee, created_by) AS owner,
         created_at, updated_at
  FROM tst_defects
  UNION ALL
  SELECT id, project_id, 'dev'::text, code, task_desc AS title, status, target AS owner,
         created_at, finished_at AS updated_at
  FROM ai_delegations;

COMMIT;
