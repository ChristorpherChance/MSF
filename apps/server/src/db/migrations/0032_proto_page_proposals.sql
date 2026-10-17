-- 0032：原型页 AI 对话提案（2026-10-17 用户拍板：页面可用 AI 对话修改，改前/改后双排对比，
-- 采用才落库——对齐「AI 只提不判」纪律）。dock 工具 design.proto.propose_page 生成提案页 HTML
-- 入 MinIO 内容寻址，本表登记提案（不写 dsg_prototype_pages）；人工「✓ 采用」才把提案对象
-- 提升为页工件行（复用 design.prototype.page_generate 的 upsert 语义），「✗ 放弃」标 discarded。
-- 部分唯一索引：同页同时最多一条 pending 提案（生成是分钟级长调用，重复提案浪费且对比视图歧义）。
BEGIN;

CREATE TABLE IF NOT EXISTS dsg_proto_page_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_code text NOT NULL,
  catalog_version text NOT NULL,          -- 生成时 plan 锁定的目录版本（采用时须与最新 plan 一致，防目录漂移后误提）
  object_key text NOT NULL,               -- MinIO 内容寻址对象（提案页 HTML）
  html_fingerprint text NOT NULL,
  instruction text NOT NULL DEFAULT '',   -- 触发提案的修改意见（对比视图顶条展示）
  source text NOT NULL DEFAULT 'model',   -- model=真模型 / mock=桩（采用时随页工件行落 source）
  status text NOT NULL DEFAULT 'pending'  -- pending|accepted|discarded
    CHECK (status IN ('pending','accepted','discarded')),
  session_id uuid NULL,                   -- 触发会话/消息（A6 usage 归因同口径，可空=非 dock 来源）
  message_id uuid NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS dsg_proto_page_proposals_pending_uq
  ON dsg_proto_page_proposals (project_id, page_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS dsg_proto_page_proposals_project_idx
  ON dsg_proto_page_proposals (project_id, status);

COMMIT;
