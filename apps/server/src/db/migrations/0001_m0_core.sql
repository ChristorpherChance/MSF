-- M0 核心表：projects（M13 最小集）/ audit_log + evd_records（M11）/ policy_gates（M12）
-- 口径：LLD-4 DSG-D11（append-only + UNIQUE(prev_hash) 双链）、DSG-D12-4、DSG-D10-6
BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'local'
);

-- 审计流水：append-only，哈希链（prev_hash 唯一约束兜底并发分叉，D11-2）
CREATE TABLE IF NOT EXISTS audit_log (
  seq bigserial PRIMARY KEY,
  project_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','assistant','sub-agent','autopilot','system')),
  actor_id text NOT NULL,
  command text NOT NULL,
  payload jsonb NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prev_hash)
);
CREATE INDEX IF NOT EXISTS audit_log_project_idx ON audit_log (project_id, seq DESC);

-- 证据记录：append-only，同双链纪律
CREATE TABLE IF NOT EXISTS evd_records (
  seq bigserial PRIMARY KEY,
  project_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  content_hash text NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prev_hash)
);

-- 策略门禁：7 确认点闭集（BR-06/统稿 A6；默认人工 REQ-711）
CREATE TABLE IF NOT EXISTS policy_gates (
  project_id uuid NOT NULL REFERENCES projects(id),
  gate_key text NOT NULL CHECK (gate_key IN ('req.doc.finalize','design.prototype.finalize','dev.plan.approve','dev.transfer','test.plan.approve','test.report.finalize','test.release')),
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','auto')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, gate_key)
);

COMMIT;
