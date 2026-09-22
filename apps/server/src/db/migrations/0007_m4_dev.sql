-- M4 开发域（M06）：dev_tasks / dev_plans / dev_operations / dev_builds / dev_selftests /
--   dev_selftest_pages / dev_reports / dev_transfer / dev_ci_reports（LLD-4 DSG-D06-1~9）
--   + sys_webhook_secrets（D10-8）
--   + 补充表 dev_runs / dev_authorizations / dev_prs / dev_impacts（任务分解 M4 注②，
--     LLD-4 映射表将 autopilot 收据归 dev_operations，但 F02-6 七态/token 旋转/blocker、
--     授权 scope 深冻结、PR codeRev 链与合并依据深冻结、影响单处置需独立行语义），
--     差异登记于 doc/dev-plan/M4-验收.md，待 13 册下轮基线回补。
-- append-only（§4 总则+D01-4 清单）：dev_builds、dev_transfer、dev_ci_reports、dev_selftest_pages
BEGIN;

-- D06-1 开发任务池（REQ-401/402/403/405/420）
CREATE TABLE IF NOT EXISTS dev_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,                          -- T-201
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('frontend','backend','common','integration')),
  owner text NOT NULL,
  asg_type text NOT NULL DEFAULT 'agent' CHECK (asg_type IN ('human','agent')),
  goal text, scope text, boundary text,
  source_ids jsonb NOT NULL DEFAULT '[]',      -- 来源目录条目 → dsg_catalog_refs（任务反查设计项）
  input_artifacts jsonb NOT NULL DEFAULT '[]', -- [{doc_kind, version_id, fingerprint}]（REQ-420 绑定输入身份）
  work jsonb NOT NULL DEFAULT '[]',
  inputs jsonb NOT NULL DEFAULT '[]',
  deliverables jsonb NOT NULL DEFAULT '[]',
  acceptance jsonb NOT NULL DEFAULT '[]',
  quality jsonb NOT NULL,                      -- {object, scenarios[], line, branch}
  deps jsonb NOT NULL DEFAULT '[]',            -- 依赖任务 code 集
  write_scopes jsonb NOT NULL DEFAULT '[]',    -- 仓内相对路径写入范围（GIN 冲突检出）
  batch_no int,
  effort text,
  rev int NOT NULL DEFAULT 1,                  -- 任务修订号（taskRev）
  code_rev int NOT NULL DEFAULT 0,             -- 代码修订号（pr.submit/rework 递增）
  prog int NOT NULL DEFAULT 0 CHECK (prog BETWEEN 0 AND 100),
  col text NOT NULL DEFAULT 'queue' CHECK (col IN ('queue','ing','review','done')),
  run_status text NOT NULL DEFAULT 'manual' CHECK (run_status IN ('manual','running','paused','stopped','rework','merged')),
  blocked boolean NOT NULL DEFAULT false,      -- 阻塞是标记不是列（统稿 A4）
  blocked_reason text,
  archived boolean NOT NULL DEFAULT false,
  excluded boolean NOT NULL DEFAULT false,
  coverage jsonb NOT NULL DEFAULT '[]',        -- [{item_id, status, task_rev}]
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS dev_tasks_col_idx ON dev_tasks (project_id, col);
CREATE INDEX IF NOT EXISTS dev_tasks_batch_idx ON dev_tasks (project_id, batch_no);
CREATE INDEX IF NOT EXISTS dev_tasks_source_gin ON dev_tasks USING GIN (source_ids);
CREATE INDEX IF NOT EXISTS dev_tasks_scopes_gin ON dev_tasks USING GIN (write_scopes);

-- D06-2 开发计划修订（修订只增；REQ-404/409/420）
CREATE TABLE IF NOT EXISTS dev_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  revision int NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','submitted','approved','invalidated')),
  snapshot jsonb NOT NULL,
  coverage_report jsonb NOT NULL,
  suggestions jsonb NOT NULL DEFAULT '[]',
  deferred jsonb NOT NULL DEFAULT '{}',
  baseline_id uuid NOT NULL REFERENCES dsg_baselines(id),
  baseline_fingerprint char(64) NOT NULL,
  preparation_fingerprint char(64),
  plan_fingerprint char(64) NOT NULL,          -- 计划身份（批准/执行复核载体）
  submitted_by text, submitted_at timestamptz,
  approved_by text, approved_at timestamptz,   -- 人工批准（经 policy_gates，REQ-404）
  invalidated_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision)
);
CREATE INDEX IF NOT EXISTS dev_plans_rev_idx ON dev_plans (project_id, revision DESC);
CREATE INDEX IF NOT EXISTS dev_plans_state_idx ON dev_plans (project_id, state);

-- D06-3 异步操作与收据（BR-08 四元组；REQ-408/409/410/418）
CREATE TABLE IF NOT EXISTS dev_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  operation_id text NOT NULL UNIQUE,
  token text NOT NULL,                         -- 运行令牌（旋转式）
  action text NOT NULL,                        -- 封闭命令枚举成员（REQ-408）
  owner_kind text NOT NULL CHECK (owner_kind IN ('human','autopilot','ai')),
  run_id text,
  authorization_id text,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','cancelled','stale')),
  parent_fingerprint char(64) NOT NULL,
  receipt jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS dev_operations_status_idx ON dev_operations (project_id, status);
CREATE INDEX IF NOT EXISTS dev_operations_run_idx ON dev_operations (run_id);

-- D06-4 候选构建（append-only；REQ-412 独立 UI 工件禁止复制原型 HTML 冒充）
CREATE TABLE IF NOT EXISTS dev_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,                          -- B-0001
  plan_revision int NOT NULL,
  commit_refs jsonb NOT NULL,
  artifact_object_key text NOT NULL,
  ui_artifact_object_key text NOT NULL,
  build_fingerprint char(64) NOT NULL UNIQUE,
  ui_artifact_fingerprint char(64) NOT NULL,
  source_manifest jsonb NOT NULL,              -- 源文件哈希集合（证明非原型复制）
  status text NOT NULL DEFAULT 'pass' CHECK (status IN ('pass','fail')),
  supersedes uuid REFERENCES dev_builds(id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

-- D06-5 开发自测（四门：functional/integration/ui/review；REQ-413/414/416/420）
CREATE TABLE IF NOT EXISTS dev_selftests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  build_id uuid NOT NULL REFERENCES dev_builds(id),
  build_fingerprint char(64) NOT NULL,
  gate_function jsonb NOT NULL,
  gate_smoke jsonb NOT NULL,
  gate_ui jsonb NOT NULL,
  gate_review jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running','pass','fail','stale')),
  basis_fingerprint char(64) NOT NULL,         -- 启动时基线+构建组合指纹
  retest_of uuid REFERENCES dev_selftests(id), -- 复测链（REQ-416）
  remediation_fingerprint char(64),            -- 实质返工派生指纹（系统派生，调用方不可填）
  started_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dev_selftests_build_idx ON dev_selftests (build_id);
CREATE INDEX IF NOT EXISTS dev_selftests_status_idx ON dev_selftests (project_id, status);

-- D06-6 UI 符合度逐页明细（append-only；REQ-414/BR-09）
CREATE TABLE IF NOT EXISTS dev_selftest_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selftest_id uuid NOT NULL REFERENCES dev_selftests(id),
  page_code text NOT NULL,
  viewport_code text NOT NULL,
  critical_total int NOT NULL,
  critical_pass int NOT NULL,
  general_total int NOT NULL,
  general_pass int NOT NULL,
  severe_deviations int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  not_run int NOT NULL DEFAULT 0,
  passed boolean NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dev_selftest_pages_idx ON dev_selftest_pages (selftest_id, page_code);

-- D06-7 开发自测报告（不可变；REQ-417/418）
CREATE TABLE IF NOT EXISTS dev_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,                          -- SR-0001
  selftest_id uuid NOT NULL REFERENCES dev_selftests(id),
  based_on jsonb NOT NULL,                     -- {build_fingerprint, baseline_fingerprint, selftest_basis}
  summary jsonb NOT NULL,                      -- 四门汇总（自动汇总，不重复填报）
  status text NOT NULL CHECK (status IN ('pass','fail')),
  report_fingerprint char(64) NOT NULL,
  export_object_key text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

-- D06-8 转测试交接回执（append-only；REQ-418）
CREATE TABLE IF NOT EXISTS dev_transfer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  build_id uuid NOT NULL REFERENCES dev_builds(id),
  build_fingerprint char(64) NOT NULL,
  report_id uuid NOT NULL REFERENCES dev_reports(id),
  report_fingerprint char(64) NOT NULL,
  handoff_fingerprint char(64) NOT NULL UNIQUE,
  token_rotated text NOT NULL,
  authorization_consumed text,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- D06-9 CI 回传报告（append-only；A06-21，REQ-407/712、BR-11）
CREATE TABLE IF NOT EXISTS dev_ci_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  delivery_id text NOT NULL,                   -- X-MSF-Delivery 幂等键
  provider text NOT NULL,
  commit_sha text NOT NULL,
  pr_ref text,
  task_codes jsonb NOT NULL DEFAULT '[]',
  matched boolean NOT NULL,                    -- 无法匹配仍落库标 false（不拒绝真实回传，BR-11）
  conclusion text NOT NULL CHECK (conclusion IN ('pass','fail','unknown')),
  payload jsonb NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS dev_ci_reports_commit_idx ON dev_ci_reports (project_id, commit_sha, received_at DESC);
CREATE INDEX IF NOT EXISTS dev_ci_reports_tasks_gin ON dev_ci_reports USING GIN (task_codes);

-- 补充表：autopilot 运行（F02-6 七态 + runToken 旋转 + blocker；任务分解 M4 注②）
CREATE TABLE IF NOT EXISTS dev_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  run_id text NOT NULL UNIQUE,                 -- run_1
  run_token text NOT NULL,                     -- 旋转式运行令牌（pause/stop/takeover/block 必旋转）
  plan_id uuid NOT NULL REFERENCES dev_plans(id),
  plan_fingerprint char(64) NOT NULL,
  authorization_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','paused','blocked','taken-over','stopped','awaiting-transfer','transferred')),
  phase text,
  blocker jsonb,                               -- {code,message,taskId,category}（F07-4）
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS dev_runs_status_idx ON dev_runs (project_id, status);

-- 补充表：autopilot 授权（scope 深冻结；transferToTest 永 false——F07-3 放行上限）
CREATE TABLE IF NOT EXISTS dev_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  authorization_id text NOT NULL UNIQUE,
  plan_id uuid NOT NULL REFERENCES dev_plans(id),
  scope jsonb NOT NULL,                        -- {development,unitCi,aiReview,merge,integrationBuild:true,transferToTest:false}
  task_ids jsonb NOT NULL,                     -- 授权任务集（含修订号，F07-2.4 修订一致校验）
  status text NOT NULL CHECK (status IN ('active','revoked','consumed')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

-- 补充表：任务 PR（codeRev 链 + 合并依据深冻结；REQ-411、F02-5）
CREATE TABLE IF NOT EXISTS dev_prs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES dev_tasks(id),
  code_rev int NOT NULL,                       -- 对应 dev_tasks.code_rev
  pr_ref text NOT NULL,                        -- PR-<task>-r<rev>
  status text NOT NULL CHECK (status IN ('review','merged','changes','stale')),
  checklist jsonb NOT NULL DEFAULT '{}',       -- 人工 checklist（验收条件+规范+设计一致）
  merge_basis jsonb,                           -- 深冻结合并依据（四类之一，REQ-411）
  commit_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (task_id, code_rev)
);

-- 补充表：变更影响单（REQ-419；再定稿触发影响分析）
CREATE TABLE IF NOT EXISTS dev_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,                          -- IM-<序>
  trigger text NOT NULL,                       -- 触发源（baseline.change 等）
  affected_tasks jsonb NOT NULL DEFAULT '[]',  -- 受影响任务 code 集
  affected_evidence jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending-assessment'
    CHECK (status IN ('pending-assessment','rework','accepted','closed')),
  resolution text,                             -- rework|accept（A06-20）
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (project_id, code)
);

-- D10-8 项目级 webhook 密钥（只写不读，密文存储；A06-22）
CREATE TABLE IF NOT EXISTS sys_webhook_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  provider text NOT NULL DEFAULT 'ci',
  secret_enc bytea NOT NULL,
  secret_hint text NOT NULL,                   -- 掩码回显（前缀+尾 4）
  rotated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz,
  UNIQUE (project_id, provider)
);

COMMIT;
