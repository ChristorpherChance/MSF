-- M6 AI/执行/集成域（LLD-4 DSG-D08-1~8；REQ-601~615/610/803）
-- ai_* 八表；委派目标种子四行（pi_native 先导 / claude_code_local / codex_cli / pi_builtin）

CREATE TABLE IF NOT EXISTS ai_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),          -- NULL 全局会话为扩展预留（本期不产生端点）
  code text NOT NULL,                               -- ss_N（原型 S.sessions 编号）
  ctx text NOT NULL,                                -- 上下文页签 material/req/design/proto/dev/test
  name text NOT NULL,
  refs jsonb NOT NULL DEFAULT '[]',                 -- 引用上下文快照 [{parsed_id, fingerprint}]（REQ-608）
  think_level text NOT NULL DEFAULT 'mid' CHECK (think_level IN ('low','mid','high')),
  tree_ref text,                                    -- Pi SessionManager JSONL 会话树引用（REQ-615；不复制会话内容）
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS ai_sessions_project_idx ON ai_sessions (project_id, ctx);

CREATE TABLE IF NOT EXISTS ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES ai_sessions(id),
  role text NOT NULL CHECK (role IN ('user','ai','system')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('streaming','done','stopped','failed')),
  prompt_version_id uuid,                           -- → ai_prompt_versions.id（后置 FK，见表后）
  model_id uuid,                                    -- → ai_models.id
  input_fingerprint char(64),                       -- 提示词版本+参考指纹组合（REQ-115）
  attachments jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_session_idx ON ai_messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS ai_tool_calls (           -- append-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES ai_messages(id),
  session_id uuid NOT NULL REFERENCES ai_sessions(id),
  tool_name text NOT NULL,
  args jsonb NOT NULL,
  result_summary jsonb,
  status text NOT NULL CHECK (status IN ('ok','denied','failed')),
  command_id uuid,                                  -- 触发写操作时关联 sys_commands.id
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_tool_calls_session_idx ON ai_tool_calls (session_id, created_at);
CREATE INDEX IF NOT EXISTS ai_tool_calls_name_idx ON ai_tool_calls (tool_name, status);

CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key text NOT NULL,                          -- ag-file/ag-crd/assistant…
  agent_group text NOT NULL,
  version_no int NOT NULL,
  base_prompt text NOT NULL,
  overlay_text text NOT NULL DEFAULT '',
  is_current boolean NOT NULL DEFAULT false,
  kind text NOT NULL DEFAULT 'prompt' CHECK (kind IN ('prompt','std')),
  skill_pack jsonb,                                 -- pi skills 能力包版本（REQ-609 扩展预留）
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_key, version_no)
);
-- 部分唯一：每 agent_key 至多一个 current
CREATE UNIQUE INDEX IF NOT EXISTS ai_prompt_current_idx ON ai_prompt_versions (agent_key) WHERE is_current;

CREATE TABLE IF NOT EXISTS ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  provider text NOT NULL,
  base_url text NOT NULL,                           -- 自定义网关 base_url（注⑤）
  model_code text NOT NULL,                         -- 供应商模型标识
  api_key_enc bytea,                                -- AES-256-GCM 密文（只写不读；REQ-710/803）
  api_key_hint text,                                -- 掩码回显（sk-…1234）
  enabled boolean NOT NULL DEFAULT true,
  conn_status text NOT NULL DEFAULT 'untested' CHECK (conn_status IN ('ok','fail','untested')),
  supports_thinking boolean NOT NULL DEFAULT false,
  context_window int NOT NULL DEFAULT 128000,
  routes jsonb NOT NULL DEFAULT '[]',               -- 用途路由数组（planning/generation/review/translation/chat；0011 修补默认）
  price_table jsonb NOT NULL DEFAULT '{}',          -- {in:number,out:number} 每 1k token 单价（REQ-612 兜底）
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (                -- append-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid,
  session_id uuid,
  message_id uuid,
  model_id uuid NOT NULL REFERENCES ai_models(id),
  purpose text NOT NULL,                            -- 生成/精修/翻译/索引/评审/对话/委派…
  tokens_in int NOT NULL,
  tokens_out int NOT NULL,
  duration_ms int NOT NULL,
  cost numeric(12,6) NOT NULL,
  delegation_id uuid,                               -- → ai_delegations.id（后置 FK）
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_project_idx ON ai_usage (project_id, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_model_idx ON ai_usage (model_id, created_at);

CREATE TABLE IF NOT EXISTS ai_delegation_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  adapter_kind text NOT NULL CHECK (adapter_kind IN ('local-cli','remote-agent','builtin')),
  capabilities jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('available','unconfigured','disabled')),
  config jsonb NOT NULL DEFAULT '{}',               -- 密钥类引用加密存储，不明文
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  code text NOT NULL,                               -- DLG-0001
  target text NOT NULL REFERENCES ai_delegation_targets(key),
  task_desc text NOT NULL,
  task_id text,                                     -- 关联开发任务编号（可选）
  workspace_scope jsonb NOT NULL DEFAULT '[]',
  budget_limit numeric(12,6),                       -- 预算上限（发起 modal 字段）
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','failed_timeout','cancelled')),
  sandbox_ref text,
  result jsonb,
  evidence_ids jsonb NOT NULL DEFAULT '[]',
  cost numeric(12,6),
  started_at timestamptz,
  finished_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS ai_delegations_project_idx ON ai_delegations (project_id, status);

-- 后置 FK（环引用：messages→prompt_versions/models；usage→delegations）
ALTER TABLE ai_messages
  ADD CONSTRAINT ai_messages_prompt_fk FOREIGN KEY (prompt_version_id) REFERENCES ai_prompt_versions(id),
  ADD CONSTRAINT ai_messages_model_fk FOREIGN KEY (model_id) REFERENCES ai_models(id);
ALTER TABLE ai_usage
  ADD CONSTRAINT ai_usage_delegation_fk FOREIGN KEY (delegation_id) REFERENCES ai_delegations(id);

-- 委派目标种子（pi_native 先导；状态 unconfigured 待配置/测试连通后转 available）
INSERT INTO ai_delegation_targets (key, name, description, adapter_kind, capabilities, status, created_by)
VALUES
  ('pi_native', 'Pi 原生运行时', 'pi RPC 模式（stdin/stdout JSONL）先导目标；执行体为 pi-coding-agent', 'builtin', '["codegen","review","general"]', 'available', 'system'),
  ('claude_code_local', '本机 Claude Code', '本机 Claude Code CLI 适配器', 'local-cli', '["codegen"]', 'unconfigured', 'system'),
  ('codex_cli', 'Codex CLI', '本机 Codex CLI 适配器', 'local-cli', '["codegen"]', 'unconfigured', 'system')
ON CONFLICT (key) DO NOTHING;
