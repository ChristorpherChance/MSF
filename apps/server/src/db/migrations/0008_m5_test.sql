-- M5 测试验收域（LLD-4 DSG-D07-1~8；REQ-501~511）
-- 口径注记②：tst_batches 增补 previous_status/blocked_reason 两列（A07-13/14 阻断/恢复语义，D01-4 白名单扩展，差异登记待回补）

CREATE TABLE IF NOT EXISTS tst_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,                          -- TB-001
  handoff_fingerprint char(64) NOT NULL UNIQUE, -- 幂等接收键
  handoff jsonb NOT NULL,                      -- 交接快照
  build_snapshot jsonb NOT NULL,               -- {build_id, build_fingerprint, ui_artifact_fingerprint}
  dev_report_snapshot jsonb NOT NULL,          -- {report_id, report_fingerprint, status}
  baseline_snapshot jsonb NOT NULL,            -- {baseline_id, baseline_fingerprint}
  acceptance_terms jsonb NOT NULL,             -- 验收条款快照（目录流程/页面）
  environment jsonb NOT NULL,                  -- 环境描述（os/browser/...）
  environment_fingerprint char(64) NOT NULL,
  received_by text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','planned','approved','executing','reported','released','blocked')),
  previous_status text,                        -- 阻断前状态（A07-13 恢复语义，增补列）
  blocked_reason text,                         -- 阻断理由（增补列）
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS tst_batches_project_idx ON tst_batches (project_id, received_at DESC);

CREATE TABLE IF NOT EXISTS tst_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES tst_batches(id),
  code text NOT NULL,                          -- TP-001
  version_no int NOT NULL,
  scope jsonb NOT NULL,                        -- 用例范围快照
  has_manual_walkthrough boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved')),
  previous_id uuid REFERENCES tst_plans(id),   -- 批准追加新版本链
  approved_by text,
  approved_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, code),
  UNIQUE (batch_id, version_no)
);

CREATE TABLE IF NOT EXISTS tst_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES tst_plans(id),
  code text NOT NULL,                          -- AT-001 / AT-MANUAL
  title text NOT NULL,
  flow_id text,                                -- 来源目录流程
  req_codes jsonb NOT NULL DEFAULT '[]',
  priority text NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2')),
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('auto','manual')),
  must_run boolean NOT NULL DEFAULT true,
  steps jsonb NOT NULL DEFAULT '[]',           -- [{action, expected}]
  content_hash char(64) NOT NULL,              -- 用例内容哈希（回归证据同版用例校验）
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, code)
);
CREATE INDEX IF NOT EXISTS tst_cases_plan_idx ON tst_cases (plan_id);

CREATE TABLE IF NOT EXISTS tst_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  batch_id uuid NOT NULL REFERENCES tst_batches(id),
  plan_id uuid NOT NULL REFERENCES tst_plans(id),
  code text NOT NULL,                          -- TR-001
  previous_run_id uuid REFERENCES tst_runs(id),
  conclusion text CHECK (conclusion IN ('pass','fail','blocked')),
  is_simulated boolean NOT NULL DEFAULT false,
  environment_fingerprint char(64) NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, code)
);
CREATE INDEX IF NOT EXISTS tst_runs_batch_idx ON tst_runs (batch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tst_case_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES tst_runs(id),
  case_id uuid NOT NULL REFERENCES tst_cases(id),
  result text NOT NULL CHECK (result IN ('pass','fail','blocked','not-run','not-applicable')),
  is_simulated boolean NOT NULL DEFAULT false,
  executor_kind text NOT NULL CHECK (executor_kind IN ('human','auto')),
  evidence_ids jsonb NOT NULL DEFAULT '[]',
  executed_by text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tst_case_runs_run_idx ON tst_case_runs (run_id);
CREATE INDEX IF NOT EXISTS tst_case_runs_case_idx ON tst_case_runs (case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tst_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,                          -- DF-001
  batch_id uuid NOT NULL REFERENCES tst_batches(id), -- 源批次
  run_id uuid NOT NULL REFERENCES tst_runs(id),      -- 来源失败 run（幂等键之一）
  case_id uuid REFERENCES tst_cases(id),
  title text NOT NULL,
  severity text CHECK (severity IN ('P0','P1','P2','P3')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','confirmed','fixing','pending_regression','closed')),
  assignee text,
  rework_task_ids jsonb NOT NULL DEFAULT '[]', -- 关联开发返工任务
  linked_build_fingerprint char(64),           -- mark-fixed 新构建
  regression_evidence jsonb,                   -- {new_batch_id, run_id, case_id, case_content_hash}
  regression_fingerprint char(64),
  events jsonb NOT NULL DEFAULT '[]',          -- 状态流转事件流（含 reopened 事件）
  closed_by text,
  closed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code),
  UNIQUE (run_id, case_id)                     -- 同 runId+caseId 幂等去重
);
CREATE INDEX IF NOT EXISTS tst_defects_project_idx ON tst_defects (project_id, status);

CREATE TABLE IF NOT EXISTS tst_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES tst_batches(id),
  code text NOT NULL,                          -- AR-001
  previous_report_id uuid REFERENCES tst_reports(id),
  basis_fingerprint char(64) NOT NULL,         -- 执行+缺陷基线指纹
  summary jsonb NOT NULL,                      -- 自动汇总
  verdict text CHECK (verdict IN ('pass','fail','conditional')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  finalized_by text,
  finalized_at timestamptz,
  export_object_key text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, code)
);

CREATE TABLE IF NOT EXISTS tst_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES tst_batches(id),
  code text NOT NULL,                          -- AD-001
  report_id uuid NOT NULL REFERENCES tst_reports(id),
  report_fingerprint char(64) NOT NULL,
  decision text NOT NULL CHECK (decision IN ('release','conditional_release','reject')),
  exemptions jsonb NOT NULL DEFAULT '[]',      -- [{defect_code, severity, reason}]
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  decision_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, code)
);
